/**
 * Response envelope + pagination helpers.
 *
 * The shape ({ data, meta } for success, { error } for failure) is the API's
 * public contract: the React client, the embeddable web forms and any
 * customer integration built against /api/v1 all parse it, so it is kept
 * identical to what the service has always returned.
 */

import config from '../config/index.js';
import { toSnakeCase } from './util.js';

export function jsonOk(res, data, meta = null) {
  const body = { data };
  if (meta !== null) body.meta = meta;
  return res.json(body);
}

export function jsonCreated(res, data, meta = null) {
  res.status(201);
  return jsonOk(res, data, meta);
}

export function jsonError(res, status, code, message, details = null) {
  const error = { code, message };
  if (details !== null) error.details = details;
  return res.status(status).json({ error });
}

/** Reads and clamps ?page=&limit= from the query string. */
export function parsePaging(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requested = Number.parseInt(query.limit, 10) || config.pagination.defaultLimit;
  const limit = Math.min(Math.max(1, requested), config.pagination.maxLimit);
  return { page, limit, offset: (page - 1) * limit };
}

export function pageMeta(page, limit, total) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, limit)));
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page * limit < total,
    hasPrev: page > 1,
  };
}

/**
 * Validates `?sort=field&dir=asc|desc` against an allow-list. The client can
 * never reach an arbitrary column: anything not on the list falls back to the
 * caller's default, so the value is always safe to interpolate into ORDER BY.
 */
export function parseSort(query, allowed, fallbackColumn, fallbackDir = 'DESC') {
  const dir = String(query?.dir ?? '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const field = query?.sort ?? null;
  if (field !== null && allowed.includes(field)) {
    return [toSnakeCase(field), dir];
  }
  return [fallbackColumn, fallbackDir];
}
