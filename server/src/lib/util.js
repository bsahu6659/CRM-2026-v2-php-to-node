/** Small shared helpers with no I/O — safe to use anywhere. */

import crypto from 'node:crypto';

/**
 * Generates a cuid-like unique id: lowercase, URL-safe, roughly sortable by
 * time. Ids are strings rather than AUTO_INCREMENT so rows round-trip
 * identically to the existing database, whose keys were generated this way.
 */
export function gvId() {
  const time = Math.floor(Date.now()).toString(36);
  const rand = crypto.randomBytes(8).toString('hex');
  return 'c' + time.padStart(8, '0').slice(-8) + rand; // 1 + 8 + 16 = 25 chars
}

export function digitsOnly(v) {
  return String(v ?? '').replace(/\D+/g, '');
}

/** Phone normalisation for duplicate matching: keeps the last 10 digits. */
export function normalizePhone(phone) {
  const d = digitsOnly(phone);
  if (d === '') return null;
  return d.length > 10 ? d.slice(-10) : d;
}

export function normalizeEmail(email) {
  const e = String(email ?? '').trim().toLowerCase();
  return e !== '' && e.includes('@') ? e : null;
}

export function fullName(first, last) {
  return `${String(first ?? '').trim()} ${String(last ?? '').trim()}`.trim();
}

export function slugify(value) {
  const s = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s !== '' ? s.slice(0, 60) : 'item';
}

/**
 * Decodes a JSON column value. mysql2 already parses genuine JSON columns, but
 * several of these columns are TEXT holding JSON, so both shapes must be
 * accepted.
 */
export function safeJson(value, fallback = []) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    const decoded = JSON.parse(String(value));
    return decoded === null ? fallback : decoded;
  } catch {
    return fallback;
  }
}

export function toJson(value) {
  return JSON.stringify(value ?? null);
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj != null && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

/** Shallow field-by-field diff used for audit logs. */
export function gvDiff(before, after, keys = null) {
  const fields = keys ?? [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  const changes = {};
  for (const key of fields) {
    const from = before?.[key] ?? null;
    const to = after?.[key] ?? null;
    if (from === to) continue;
    if ((from === null && to === '') || (from === '' && to === null)) continue;
    changes[key] = { from, to };
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Dates. Every value handed to MySQL is a local-time 'YYYY-MM-DD HH:MM:SS'
// string, matching the session time zone pinned in lib/db.js — mixing Date
// objects and strings is what produces rows that are silently hours apart.
// ---------------------------------------------------------------------------
function two(n) {
  return String(n).padStart(2, '0');
}

export function toSqlDateTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
  );
}

export function toSqlDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export function nowSql() {
  return toSqlDateTime(new Date());
}

export function startOfDay(date = null) {
  return `${toSqlDate(date ? new Date(date) : new Date())} 00:00:00`;
}

export function endOfDay(date = null) {
  return `${toSqlDate(date ? new Date(date) : new Date())} 23:59:59`;
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return toSqlDateTime(d);
}

export function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : toSqlDateTime(d);
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function pct(part, whole) {
  const w = Number(whole);
  return w > 0 ? round2((Number(part) / w) * 100) : 0;
}

// ---------------------------------------------------------------------------
// camelCase <-> snake_case. The database is snake_case and the API is
// camelCase; these two functions are the only place that boundary is crossed.
// ---------------------------------------------------------------------------
export function toCamelCase(s) {
  return String(s).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

export function toSnakeCase(s) {
  return String(s).replace(/(?<!^)[A-Z]/g, (c) => `_${c}`).toLowerCase();
}

function mapKeysDeep(data, mapKey) {
  if (Array.isArray(data)) return data.map((v) => mapKeysDeep(v, mapKey));
  // Date and Buffer are values, not records to walk into.
  if (data instanceof Date || Buffer.isBuffer(data)) return data;
  if (data !== null && typeof data === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(data)) out[mapKey(k)] = mapKeysDeep(v, mapKey);
    return out;
  }
  return data;
}

/** Converts DB row(s) with snake_case keys to camelCase for the API. */
export function camelize(data) {
  return mapKeysDeep(data, toCamelCase);
}

/** Converts an API-shaped payload (camelCase) to snake_case for SQL binding. */
export function decamelize(data) {
  return mapKeysDeep(data, toSnakeCase);
}

export function chunkArray(arr, size) {
  const step = Math.max(1, size);
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr.slice(i, i + step));
  return out;
}

/** True/false out of a MySQL TINYINT(1), which can arrive as 0/1, "0"/"1" or boolean. */
export function gvBool(value) {
  return value === true || value === 1 || value === '1';
}

/** MySQL wants 1/0, not true/false, for TINYINT(1) columns. */
export function sqlBool(value) {
  return gvBool(value) ? 1 : 0;
}
