/**
 * MySQL access layer. Every query in the application goes through these
 * helpers with bound parameters — no query in this codebase concatenates user
 * input into SQL.
 *
 * Why AsyncLocalStorage: the PHP edition used a single PDO handle, so a
 * transaction opened anywhere automatically covered every nested query. A
 * connection pool breaks that assumption — a nested helper would silently
 * check out a *different* connection and run outside the transaction, so a
 * rollback would leave half the work committed. Storing the transaction's
 * connection in async context restores the old guarantee without threading a
 * `conn` argument through every service function.
 */

import mysql from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import config from '../config/index.js';
import { AppError } from './errors.js';

const txStorage = new AsyncLocalStorage();

let pool = null;

/**
 * MySQL's session clock is pinned to the Node process's clock.
 *
 * Some rows are timestamped by the application and some by MySQL (NOW(),
 * DEFAULT CURRENT_TIMESTAMP). If the two disagree — the app on UTC and MySQL
 * on the machine's local zone is the common case, and was off by 5.5 hours on
 * the production install — then "created today" filters, audit ordering and
 * follow-up sweeps all quietly compare timestamps from two different clocks.
 */
function sessionTimeZoneOffset() {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function getPool() {
  if (pool) return pool;

  pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    charset: config.db.charset,
    ssl: config.db.ssl,
    waitForConnections: true,
    connectionLimit: config.db.connectionLimit,
    queueLimit: 0,
    // Keep DATETIME columns as 'YYYY-MM-DD HH:MM:SS' strings rather than Date
    // objects. The API has always emitted those strings, and converting to
    // Date here would re-interpret them in the process time zone and shift
    // every timestamp the client renders.
    dateStrings: true,
    timezone: 'local',
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
    // Native JSON columns come back as the raw JSON text, exactly as PDO
    // returned them to the PHP edition. Every reader already decodes through
    // safeJson(); letting the driver pre-parse them would instead hand
    // camelize() a nested object to walk, and it would rename the tenant's
    // own custom-field and settings keys (site_visit -> siteVisit) on the way
    // out. MariaDB stores JSON as LONGTEXT, so it was already a string there.
    typeCast(field, next) {
      if (field.type === 'JSON') {
        const raw = field.buffer();
        return raw === null ? null : raw.toString('utf8');
      }
      return next();
    },
  });

  const offset = sessionTimeZoneOffset();
  pool.on('connection', (conn) => {
    // Not fatal if it fails: a host without the tz tables still works, it just
    // keeps its own clock. Logged so any drift is explainable rather than eerie.
    conn.query(`SET time_zone = '${offset}'`, (err) => {
      if (err) console.error('[db] could not align session time zone:', err.message);
    });
    // Same mode on every server, so a query behaves on TiDB or MySQL 8 the
    // way it did on the MariaDB the PHP edition ran on (config.db.sqlMode).
    conn.query('SET SESSION sql_mode = ?', [config.db.sqlMode], (err) => {
      if (err) console.error('[db] could not set sql_mode:', err.message);
    });
  });

  return pool;
}

/** The connection the current transaction (if any) is running on. */
function currentConn() {
  return txStorage.getStore()?.conn ?? null;
}

async function run(sql, params) {
  const conn = currentConn();
  try {
    const [rows] = conn ? await conn.query(sql, params) : await getPool().query(sql, params);
    return rows;
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error('[db] query failed:', err.code, err.sqlMessage ?? err.message);
    if (['ECONNREFUSED', 'ER_ACCESS_DENIED_ERROR', 'ENOTFOUND', 'ER_BAD_DB_ERROR', 'PROTOCOL_CONNECTION_LOST'].includes(err.code)) {
      throw new AppError(500, 'DATABASE_ERROR', 'Could not connect to the database.');
    }
    throw new AppError(500, 'DATABASE_ERROR', config.debug ? (err.sqlMessage ?? err.message) : 'A database error occurred.');
  }
}

/** Fetch a single row, or null. */
export async function dbOne(sql, params = []) {
  const rows = await run(sql, params);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/** Fetch all rows. */
export async function dbAll(sql, params = []) {
  const rows = await run(sql, params);
  return Array.isArray(rows) ? rows : [];
}

/** Execute an INSERT/UPDATE/DELETE; returns affected row count. */
export async function dbExec(sql, params = []) {
  const result = await run(sql, params);
  return result?.affectedRows ?? 0;
}

/** Execute an INSERT and return the driver result (for insertId, if ever needed). */
export async function dbInsert(sql, params = []) {
  return run(sql, params);
}

/** Fetch a single scalar value (e.g. COUNT(*)). */
export async function dbScalar(sql, params = []) {
  const row = await dbOne(sql, params);
  if (!row) return null;
  const first = Object.values(row)[0];
  return first === undefined ? null : first;
}

/**
 * Runs `fn` inside a transaction, committing on success and rolling back on
 * any error. Nested calls join the outer transaction rather than opening a
 * second one, which MySQL does not support.
 */
export async function dbTransaction(fn) {
  const existing = txStorage.getStore();
  if (existing) return fn(existing.conn);

  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await txStorage.run({ conn }, () => fn(conn));
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      console.error('[db] rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Runs `fn` with no transaction in scope. Deferred work (domain-event
 * handlers, after-response hooks) is scheduled from inside whatever async
 * context emitted it; if that was a transaction, the handler would otherwise
 * inherit a connection that has long since been committed and released.
 */
export function outsideTransaction(fn) {
  return txStorage.exit(fn);
}

/** Builds a safe `IN (?, ?, ...)` fragment plus the matching bind values. */
export function dbInClause(values) {
  if (!values || values.length === 0) return ['(NULL)', []];
  return [`(${values.map(() => '?').join(',')})`, [...values]];
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
