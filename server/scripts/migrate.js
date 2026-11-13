/**
 * Applies database/schema.sql and then every database/migrations/*.sql in
 * filename order, recording what has run in `schema_migrations`.
 *
 *   npm run migrate
 *
 * Safe to re-run: a migration that is already recorded is skipped, and the
 * base schema is only applied to an empty database.
 *
 * Statements are sent with multipleStatements enabled on a dedicated
 * connection. That is safe here because the only SQL this script executes
 * comes from files in this repository — it never interpolates input — and
 * migration 008 relies on PREPARE/EXECUTE, which has to share one session.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import config, { PROJECT_ROOT } from '../src/config/index.js';

const DB_DIR = path.join(PROJECT_ROOT, 'database');

async function connect() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    charset: config.db.charset,
    ssl: config.db.ssl,
    multipleStatements: true,
  });
  // A hosted database (TiDB Cloud) starts with no `growvanta` database, so
  // create it here rather than send someone to a web console first. A user
  // without CREATE rights on an existing database is fine: USE still works.
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(config.db.database)}
      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch {
    // Fall through: USE below reports the real problem if there is one.
  }
  await conn.query(`USE ${mysql.escapeId(config.db.database)}`);
  // The same session mode the API runs in (see config.db.sqlMode).
  await conn.query('SET SESSION sql_mode = ?', [config.db.sqlMode]);
  return conn;
}

async function tableCount(conn) {
  const [rows] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?',
    [config.db.database]
  );
  return Number(rows[0].n);
}

async function main() {
  const conn = await connect();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(190) NOT NULL PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [doneRows] = await conn.query('SELECT filename FROM schema_migrations');
    const done = new Set(doneRows.map((r) => r.filename));

    // The base schema goes in only when the database is empty apart from our
    // bookkeeping table. Re-applying it over a populated database would fail
    // halfway and leave the schema in an unknown state.
    const existing = await tableCount(conn);
    if (!done.has('schema.sql')) {
      if (existing > 1) {
        console.log('• schema.sql  skipped (database already has tables)');
        await conn.query('INSERT IGNORE INTO schema_migrations (filename) VALUES (?)', ['schema.sql']);
      } else {
        const sql = await fs.readFile(path.join(DB_DIR, 'schema.sql'), 'utf8');
        await conn.query(sql);
        await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', ['schema.sql']);
        console.log('✓ schema.sql');
      }
    } else {
      console.log('• schema.sql  already applied');
    }

    const files = (await fs.readdir(path.join(DB_DIR, 'migrations')))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (done.has(file)) {
        console.log(`• ${file}  already applied`);
        continue;
      }
      const sql = await fs.readFile(path.join(DB_DIR, 'migrations', file), 'utf8');
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      console.log(`✓ ${file}`);
    }

    console.log(`\nDatabase "${config.db.database}" now has ${await tableCount(conn)} tables.`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('\n[migrate] failed:', err.sqlMessage ?? err.message);
  process.exit(1);
});
