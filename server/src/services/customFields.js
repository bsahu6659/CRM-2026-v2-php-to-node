/** Admin-defined custom fields — port of services/CustomFields.php. */

import { dbAll } from '../lib/db.js';
import { validationError } from '../lib/errors.js';
import { gvBool, safeJson, toJson, toSqlDate } from '../lib/util.js';

export const GV_CUSTOM_FIELD_TYPES = ['TEXT', 'TEXTAREA', 'NUMBER', 'DECIMAL', 'DATE', 'BOOLEAN', 'SELECT', 'MULTISELECT', 'EMAIL', 'PHONE', 'URL'];

/**
 * The PHP edition threw InvalidArgumentException for a value that does not fit
 * its field. Only this class is turned into a per-field validation message;
 * anything else is a real fault and propagates.
 */
export class InvalidArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object';
}

function phpStr(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return '1';
  if (typeof value === 'object') return 'Array';
  return String(value);
}

/** PHP is_numeric(): numbers and numeric strings (surrounding whitespace allowed). */
function isNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(value);
}

/** A JSON list or object as a plain list of its values (PHP arrays are both). */
function listOf(value) {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.values(value);
  return [];
}

/** PHP's FILTER_VALIDATE_EMAIL, closely enough for form input. */
function isValidEmail(value) {
  if (value.length > 254) return false;
  const at = value.lastIndexOf('@');
  if (at < 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(domain);
}

/**
 * strtotime() for the shapes a date field realistically receives. A bare
 * YYYY-MM-DD is read as LOCAL midnight — JavaScript would read it as UTC and
 * shift the stored day for anyone west of Greenwich.
 */
function parseDateInput(raw) {
  const s = phpStr(raw).trim();
  const lower = s.toLowerCase();
  const now = new Date();
  if (lower === 'now' || lower === 'today') return now;
  if (lower === 'tomorrow' || lower === 'yesterday') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() + (lower === 'tomorrow' ? 1 : -1));
    return d;
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let d;
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    d = new Date(year, month - 1, day);
  } else {
    d = new Date(s);
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function customFieldDefinitions(orgId, entity) {
  return dbAll(
    'SELECT * FROM custom_fields WHERE organization_id = ? AND entity = ? AND is_active = 1 ORDER BY sort_order ASC, created_at ASC',
    [orgId, entity]
  );
}

export function customFieldCoerce(def, raw) {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  switch (def.type) {
    case 'NUMBER':
      if (!isNumeric(raw) || !Number.isInteger(Number(raw))) {
        throw new InvalidArgumentError(`${def.label} must be a whole number`);
      }
      return Math.trunc(Number(raw));
    case 'DECIMAL':
      if (!isNumeric(raw)) {
        throw new InvalidArgumentError(`${def.label} must be a number`);
      }
      return Number(raw);
    case 'BOOLEAN':
      return [true, 'true', 1, '1', 'yes'].includes(raw);
    case 'DATE': {
      const d = parseDateInput(raw);
      if (d === null) {
        throw new InvalidArgumentError(`${def.label} must be a valid date`);
      }
      return toSqlDate(d);
    }
    case 'SELECT': {
      const options = listOf(safeJson(def.options, []));
      const value = phpStr(raw);
      if (options.length && !options.includes(value)) {
        throw new InvalidArgumentError(`${def.label} must be one of: ${options.join(', ')}`);
      }
      return value;
    }
    case 'MULTISELECT': {
      const options = listOf(safeJson(def.options, []));
      // array_filter() drops '' and '0' alike; kept so stored values match.
      const values = isRecord(raw)
        ? listOf(raw).map(phpStr)
        : phpStr(raw).split(',').map((v) => v.trim()).filter((v) => v !== '' && v !== '0');
      if (options.length) {
        const bad = values.filter((v) => !options.map(phpStr).includes(v));
        if (bad.length) {
          throw new InvalidArgumentError(`${def.label}: unsupported option(s) ${bad.join(', ')}`);
        }
      }
      return values;
    }
    case 'EMAIL': {
      const value = phpStr(raw).trim();
      if (!isValidEmail(value)) {
        throw new InvalidArgumentError(`${def.label} must be a valid email`);
      }
      return value.toLowerCase();
    }
    case 'URL': {
      const value = phpStr(raw).trim();
      if (!/^https?:\/\//i.test(value)) {
        throw new InvalidArgumentError(`${def.label} must start with http:// or https://`);
      }
      return value;
    }
    default:
      return phpStr(raw).slice(0, 2000);
  }
}

/**
 * Returns the JSON-encoded value ready for the custom_fields column.
 *
 * `existing` may arrive already decoded (mysql2 parses JSON columns) or as a
 * string. Rows the PHP edition wrote with no custom values hold `[]` rather
 * than `{}`; both are read as an empty object here, because assigning named
 * keys onto a JS array would silently drop them on JSON.stringify.
 */
export async function validateCustomFieldValues(orgId, entity, input, existing = '{}') {
  const defs = await customFieldDefinitions(orgId, entity);
  const incomingRaw = isRecord(input) ? input : safeJson(input, []);
  const incoming = isRecord(incomingRaw) ? incomingRaw : {};
  const currentRaw = isRecord(existing) ? existing : safeJson(existing, []);
  const out = isRecord(currentRaw) ? Object.assign({}, currentRaw) : {};
  const errors = [];

  for (const def of defs) {
    const key = def.key;
    const provided = Object.prototype.hasOwnProperty.call(incoming, key);
    if (!provided) {
      if (gvBool(def.is_required) && (out[key] === undefined || out[key] === null)) {
        if (def.default_value && def.default_value !== '0') {
          out[key] = def.default_value;
        } else {
          errors.push({ field: `customFields.${key}`, message: `${def.label} is required` });
        }
      }
      continue;
    }
    try {
      const value = customFieldCoerce(def, incoming[key]);
      if (gvBool(def.is_required) && (value === null || (Array.isArray(value) && value.length === 0))) {
        errors.push({ field: `customFields.${key}`, message: `${def.label} is required` });
      }
      if (value === null) {
        delete out[key];
      } else {
        out[key] = value;
      }
    } catch (err) {
      if (!(err instanceof InvalidArgumentError)) throw err;
      errors.push({ field: `customFields.${key}`, message: err.message });
    }
  }

  const allowed = defs.map((d) => d.key);
  for (const key of Object.keys(out)) {
    if (!allowed.includes(key)) {
      delete out[key];
    }
  }

  if (errors.length) {
    throw validationError(errors);
  }
  return toJson(out);
}
