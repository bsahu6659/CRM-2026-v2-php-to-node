/**
 * Request pipeline: async error plumbing, session loading, CSRF, permission
 * gates and the single error responder.
 */

import config from '../config/index.js';
import { AppError, forbidden, notFound, unauthenticated } from '../lib/errors.js';
import { jsonError } from '../lib/response.js';
import { assertAnyPermission, assertPermission, loadActor, permissionScope } from '../lib/auth.js';
import { resolveScope } from '../lib/scope.js';
import { randomToken, safeEqual } from '../lib/security.js';
import { rateLimitApi } from '../lib/rateLimit.js';

/**
 * Express 4 does not catch rejected promises from route handlers: an async
 * handler that throws would hang the request until the client gave up. Every
 * async route is wrapped in this so a thrown AppError reaches errorHandler.
 */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Security headers applied to every API response. */
export function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // The API only ever returns JSON or a file download; it loads nothing itself.
  res.set('Content-Security-Policy', "default-src 'none'");
  next();
}

export const attachActor = ah(async (req, res, next) => {
  const loaded = await loadActor(req);
  req.actor = loaded?.actor ?? null;
  req.session = loaded?.session ?? null;
  // Per-request scope cache (see lib/scope.js for why it must not be global).
  req.scopeCache = new Map();
  next();
});

export const apiRateLimit = ah(async (req, res, next) => {
  await rateLimitApi(req);
  next();
});

/** Double-submit CSRF cookie: readable by JS so the client can echo it back. */
export function issueCsrfCookie(req, res, next) {
  if (!req.cookies?.[config.auth.csrfCookie]) {
    const token = randomToken(24);
    res.cookie(config.auth.csrfCookie, token, {
      path: '/',
      httpOnly: false,
      secure: config.auth.cookieSecure,
      sameSite: config.auth.cookieSameSite,
      domain: config.auth.cookieDomain,
    });
    req.cookies[config.auth.csrfCookie] = token;
  }
  next();
}

export function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // API-key callers and bearer-token callers are exempt: neither is sent
  // automatically by a browser, so there is nothing for a third-party site to
  // forge.
  if (req.apiKey) return next();
  const authHeader = req.get('authorization') ?? '';
  if (authHeader.toLowerCase().startsWith('bearer ')) return next();
  // Unauthenticated: nothing to forge.
  if (!req.cookies?.[config.auth.cookieName]) return next();

  const cookieToken = req.cookies?.[config.auth.csrfCookie] ?? '';
  const headerToken = req.get('x-csrf-token') ?? '';
  if (cookieToken === '' || headerToken === '' || !safeEqual(cookieToken, headerToken)) {
    return next(forbidden('Invalid or missing CSRF token. Reload the page and try again.'));
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.actor) return next(unauthenticated());
  next();
}

/** Route guard: `requirePermission('leads', 'read')`. */
export const requirePermission = (module, action) => (req, res, next) => {
  try {
    assertPermission(req, module, action);
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAnyPermission = (pairs) => (req, res, next) => {
  try {
    assertAnyPermission(req, pairs);
    next();
  } catch (err) {
    next(err);
  }
};

/** The actor's role-wide visibility, resolved once per request. */
export async function scopeInfo(req) {
  return resolveScope(req.actor, null, req.scopeCache);
}

/**
 * Visibility for one specific permission. Use this wherever the reach differs
 * per action — reading team leads but exporting only your own, say.
 */
export async function scopeFor(req, module, action) {
  return resolveScope(req.actor, permissionScope(req.actor, module, action), req.scopeCache);
}

export function notFoundHandler(req, res, next) {
  next(notFound('Unknown API route'));
}

/**
 * The single place an error becomes a response. Anything that is not an
 * AppError is a bug: it is logged in full server-side and reported as a
 * generic 500, so a stack trace never reaches the browser.
 */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    return jsonError(res, err.status, err.errorCode, err.message, err.details);
  }

  // express.json() rejects malformed bodies with a SyntaxError carrying a status.
  if (err?.type === 'entity.parse.failed') {
    return jsonError(res, 400, 'BAD_PAYLOAD', 'Body was not valid JSON.');
  }
  if (err?.type === 'entity.too.large') {
    return jsonError(res, 413, 'PAYLOAD_TOO_LARGE', 'That request body is too large.');
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return jsonError(res, 413, 'FILE_TOO_LARGE', 'That file is larger than the upload limit.');
  }

  console.error('[api] unhandled exception:', err);
  return jsonError(
    res,
    500,
    'INTERNAL_ERROR',
    config.debug ? String(err?.message ?? err) : 'Something went wrong. Please try again.'
  );
}
