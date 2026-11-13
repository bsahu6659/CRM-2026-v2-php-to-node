/**
 * Small chainable request validator.
 *
 * Deliberately not a schema library: the error payload shape
 * ({ field, message }[] inside a 422 VALIDATION_ERROR) is part of the API
 * contract the client renders field-by-field, and every route needs only a
 * handful of checks, spelled out inline where they are read.
 */

import { validationError } from './errors.js';

// Deliberately permissive, matching what the service has always accepted:
// a local part, an @, a dotted domain with a 2+ character TLD.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export class Validator {
  constructor(data) {
    this.data = data ?? {};
    this.errors = [];
  }

  get(key, fallback = null) {
    const v = this.data[key];
    return v === undefined ? fallback : v;
  }

  required(key, label = null) {
    const v = this.data[key];
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
      this.errors.push({ field: key, message: `${label ?? key} is required` });
    }
    return this;
  }

  email(key) {
    const v = this.data[key];
    if (v !== null && v !== undefined && v !== '' && !EMAIL_RE.test(String(v))) {
      this.errors.push({ field: key, message: 'Enter a valid email address' });
    }
    return this;
  }

  in(key, allowed) {
    const v = this.data[key];
    if (v !== null && v !== undefined && v !== '' && !allowed.includes(v)) {
      this.errors.push({ field: key, message: `Must be one of: ${allowed.join(', ')}` });
    }
    return this;
  }

  maxLength(key, max) {
    const v = this.data[key];
    if (typeof v === 'string' && v.length > max) {
      this.errors.push({ field: key, message: `Must be ${max} characters or fewer` });
    }
    return this;
  }

  minLength(key, min) {
    const v = this.data[key];
    if (typeof v === 'string' && v.trim() !== '' && v.length < min) {
      this.errors.push({ field: key, message: `Must be at least ${min} characters` });
    }
    return this;
  }

  numeric(key) {
    const v = this.data[key];
    if (v !== null && v !== undefined && v !== '' && Number.isNaN(Number(v))) {
      this.errors.push({ field: key, message: 'Must be a number' });
    }
    return this;
  }

  add(field, message) {
    this.errors.push({ field, message });
    return this;
  }

  fails() {
    return this.errors.length > 0;
  }

  validate() {
    if (this.fails()) throw validationError(this.errors);
    return this;
  }
}

export function validate(data) {
  return new Validator(data);
}

/** Trims a string field, or returns null for empty/absent — the common "optional text" pattern. */
export function strOrNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

export function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

export function boolVal(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}
