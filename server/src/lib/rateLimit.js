/**
 * DB-backed rate limiting.
 *
 * The counter lives in MySQL rather than in process memory because the API is
 * expected to run as several workers (PM2 cluster, containers, more than one
 * host). An in-process counter would give each worker the full allowance, so
 * the effective limit would silently be N times what was configured.
 */

import config from '../config/index.js';
import { dbExec, dbScalar } from './db.js';
import { tooMany } from './errors.js';
import { toSqlDateTime } from './util.js';
import { clientIp } from './auth.js';

export async function rateLimitCheck(bucket, key, max, windowSeconds) {
  if (max <= 0) return;

  const windowStart = toSqlDateTime(new Date(Date.now() - windowSeconds * 1000));

  // Opportunistic cleanup, cheap because it is indexed on hit_at.
  await dbExec('DELETE FROM rate_limit_hits WHERE hit_at < ?', [
    toSqlDateTime(new Date(Date.now() - 3600 * 1000)),
  ]);

  const count = Number(
    await dbScalar('SELECT COUNT(*) FROM rate_limit_hits WHERE bucket = ? AND rkey = ? AND hit_at >= ?', [
      bucket,
      key,
      windowStart,
    ])
  );
  if (count >= max) throw tooMany('Too many requests. Please slow down.');

  await dbExec('INSERT INTO rate_limit_hits (bucket, rkey, hit_at) VALUES (?, ?, NOW())', [bucket, key]);
}

export function rateLimitApi(req) {
  return rateLimitCheck('api', clientIp(req) ?? 'unknown', config.rateLimit.max, config.rateLimit.windowSeconds);
}

export function rateLimitAuth(req) {
  return rateLimitCheck('auth', clientIp(req) ?? 'unknown', config.rateLimit.authMax, config.rateLimit.windowSeconds);
}

export function rateLimitCapture(req) {
  return rateLimitCheck('capture', clientIp(req) ?? 'unknown', config.rateLimit.captureMax, 60);
}
