/**
 * CSV parsing/serialising — port of lib/csv.php.
 *
 * A state-machine parser rather than a split on commas and newlines, so quoted
 * fields, escaped quotes and embedded newlines from a real Excel export
 * round-trip correctly.
 */

import { badRequest } from './errors.js';

/**
 * PHP's trim() strips exactly " \t\n\r\0\x0B". JavaScript's trim() also eats
 * non-breaking and other Unicode spaces, which would silently change what a
 * cell from a spreadsheet compares equal to.
 */
function phpTrim(value) {
  return String(value).replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

/**
 * Header names come straight out of an uploaded file. Defining the property
 * (rather than assigning it) keeps a column literally called "__proto__" an
 * ordinary key instead of a write to the object's prototype.
 */
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** PHP's (string) cast: null is '', booleans are '1' / ''. */
function cellString(value) {
  if (value === true) return '1';
  if (value === false) return '';
  return String(value);
}

/**
 * @param {string|Buffer} text
 * @returns {string[][]} rows of raw (untrimmed) cells
 */
export function parseCsv(text, maxRows = 50000) {
  let src = Buffer.isBuffer(text) ? text.toString('utf8') : String(text ?? '');
  // The UTF-8 byte-order mark Excel writes; decoded, it is a single U+FEFF.
  src = src.replace(/^﻿/, '');

  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const len = src.length;

  for (let i = 0; i < len; i++) {
    const char = src[i];
    if (inQuotes) {
      if (char === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\r') {
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      if (rows.length > maxRows) {
        throw badRequest(`CSV exceeds the ${maxRows} row limit`);
      }
      continue;
    }
    field += char;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Spreadsheets love to leave a run of empty lines at the bottom.
  while (rows.length && rows[rows.length - 1].filter((c) => phpTrim(c) !== '').length === 0) {
    rows.pop();
  }
  return rows;
}

/** @returns {{ headers: string[], records: object[] }} one object per data row, keyed by header */
export function parseCsvObjects(text, maxRows = 50000) {
  const rows = parseCsv(text, maxRows);
  if (!rows.length) {
    return { headers: [], records: [] };
  }
  const headers = rows[0].map((h) => phpTrim(h));
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    headers.forEach((h, j) => {
      setOwn(obj, h, phpTrim(rows[i][j] ?? ''));
    });
    records.push(obj);
  }
  return { headers, records };
}

/** Prefixes formula-leading characters so an exported note can't execute in Excel (CSV injection). */
export function escapeCsvCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  let str = cellString(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * @param {object[]} rows
 * @param {Array<{key: string, label?: string, value?: (row: object) => any}>} columns
 */
export function toCsv(rows, columns) {
  const header = columns.map((c) => escapeCsvCell(c.label ?? c.key)).join(',');
  const body = [];
  for (const row of rows) {
    const cells = columns.map((c) => {
      const value = c.value !== undefined && c.value !== null ? c.value(row) : (row?.[c.key] ?? null);
      return escapeCsvCell(value);
    });
    body.push(cells.join(','));
  }
  // The BOM is what makes Excel open the file as UTF-8 rather than mangling
  // every name with an accent in it.
  return '﻿' + header + '\r\n' + body.join('\r\n');
}
