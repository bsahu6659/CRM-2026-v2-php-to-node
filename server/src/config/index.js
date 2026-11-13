/**
 * Central configuration — the Node counterpart of the PHP edition's config.php.
 *
 * Every value the application reads at runtime is resolved here exactly once,
 * so a missing or malformed setting fails loudly at boot instead of halfway
 * through a request.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, '..', '..');
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

// ENV_FILE points one checkout at another set of settings without touching
// .env, e.g. migrating the hosted demo database from a laptop:
//   ENV_FILE=.env.tidb npm run migrate
// Variables already in the environment still win, as they always have.
dotenv.config({
  path: process.env.ENV_FILE
    ? path.resolve(SERVER_ROOT, process.env.ENV_FILE)
    : path.join(SERVER_ROOT, '.env'),
});

function env(key, fallback = undefined) {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

function intEnv(key, fallback) {
  const raw = env(key);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Hosted MySQL services (TiDB Cloud and most managed offerings) only accept
 * encrypted connections. DB_SSL=1 turns TLS on with full certificate checks
 * against the system's trusted CAs; DB_SSL_CA adds a PEM file for a provider
 * that signs with its own CA.
 */
function dbSsl() {
  if (env('DB_SSL', '0') !== '1') return undefined;
  const caPath = env('DB_SSL_CA');
  return {
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
    ...(caPath ? { ca: fs.readFileSync(path.resolve(SERVER_ROOT, caPath), 'utf8') } : {}),
  };
}

const appEnv = env('APP_ENV', 'production');

export const config = {
  env: appEnv,
  isProduction: appEnv === 'production',
  debug: env('APP_DEBUG', '0') === '1',
  appUrl: String(env('APP_URL', 'http://localhost:4000')).replace(/\/+$/, ''),
  // Where the React app is served from. Password-reset, invite and
  // verification links must point at the app, not at this API — the API has
  // no page to show a human.
  clientUrl: String(env('CLIENT_URL', env('CORS_ORIGINS', 'http://localhost:5173').split(',')[0]))
    .trim()
    .replace(/\/+$/, ''),
  port: intEnv('PORT', 4000),

  // Browsers that may call the API with credentials. The React dev server runs
  // on a different origin from the API, so this is required in development and
  // should be set to the deployed frontend origin in production.
  corsOrigins: String(env('CORS_ORIGINS', 'http://localhost:5173'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  db: {
    host: env('DB_HOST', '127.0.0.1'),
    port: intEnv('DB_PORT', 3306),
    database: env('DB_NAME', 'growvanta'),
    user: env('DB_USER', 'root'),
    password: env('DB_PASS', ''),
    charset: 'utf8mb4',
    connectionLimit: intEnv('DB_POOL_SIZE', 10),
    ssl: dbSsl(),
    // Every connection runs in this sql_mode. MySQL 8 and TiDB default to
    // ONLY_FULL_GROUP_BY, which the PHP edition never ran under (it was built
    // and verified on MariaDB), and the reports' GROUP BY queries assume that.
    sqlMode: env('DB_SQL_MODE', 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'),
  },

  auth: {
    // Derives session tokens and encrypts integration secrets (Meta page access
    // tokens) at rest. Must be 32+ random bytes.
    appKey: env('APP_KEY', ''),
    sessionTtlHours: intEnv('SESSION_TTL_HOURS', 12),
    rememberMeTtlDays: intEnv('REMEMBER_ME_TTL_DAYS', 30),
    cookieName: 'gv_session',
    csrfCookie: 'gv_csrf',
    // Cross-site cookies are required when the SPA is served from a different
    // origin than the API; they only work over HTTPS.
    cookieSameSite: env('COOKIE_SAMESITE', 'Lax'),
    cookieSecure: env('COOKIE_SECURE', appEnv === 'production' ? '1' : '0') === '1',
    cookieDomain: env('COOKIE_DOMAIN', undefined),
  },

  uploads: {
    dir: path.resolve(String(env('UPLOAD_DIR', path.join(SERVER_ROOT, 'uploads')))),
    maxBytes: intEnv('MAX_UPLOAD_MB', 10) * 1024 * 1024,
    allowedMime: [
      'image/png', 'image/jpeg', 'image/gif', 'image/webp',
      'application/pdf', 'text/csv', 'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  },

  rateLimit: {
    // Stored in a DB table (rate_limit_hits) rather than in memory: the API is
    // expected to run behind PM2/cluster or several containers, where an
    // in-process counter would let each worker grant the full allowance.
    windowSeconds: intEnv('RATE_LIMIT_WINDOW_MIN', 15) * 60,
    max: intEnv('RATE_LIMIT_MAX', 1000),
    authMax: intEnv('AUTH_RATE_LIMIT_MAX', 20),
    captureMax: intEnv('PUBLIC_CAPTURE_RATE_LIMIT_MAX', 60),
  },

  // The platform's own mailbox. It sends system mail - invites, password
  // resets - and every staff alert, for every company, so those never wait on
  // a customer configuring SMTP of their own.
  mail: {
    host: env('SMTP_HOST', ''),
    port: intEnv('SMTP_PORT', 587),
    encryption: env('SMTP_ENCRYPTION', 'TLS'),
    user: env('SMTP_USER', ''),
    pass: env('SMTP_PASS', ''),
    from: env('SMTP_FROM', 'Growvanta CRM <no-reply@localhost>'),
  },

  meta: {
    appId: env('META_APP_ID', ''),
    appSecret: env('META_APP_SECRET', ''),
    verifyToken: env('META_VERIFY_TOKEN', ''),
    graphVersion: env('META_GRAPH_VERSION', 'v19.0'),
  },

  seedPassword: env('SEED_PASSWORD', 'Growvanta@123'),

  pagination: { defaultLimit: 25, maxLimit: 200 },
};

/**
 * A short or missing APP_KEY would make session tokens guessable and stored
 * Meta secrets reversible, so production refuses to boot rather than run
 * insecurely. Development falls back to a fixed key so a fresh checkout runs.
 */
if (config.isProduction && String(config.auth.appKey).length < 32) {
  const looksLikeExample =
    config.appUrl === 'https://crm.yourdomain.com' ||
    String(config.db.database).startsWith('cpaneluser_');

  console.error(
    looksLikeExample
      ? '[config] Your .env still holds the example values that ship with the package, so your real settings have ' +
          'been overwritten. Put back your own APP_URL, APP_KEY and database details. Never rename .env.example ' +
          'over a working .env.'
      : '[config] APP_KEY is missing or too short. Set a 32+ character random value in .env.'
  );
  process.exit(1);
}

if (String(config.auth.appKey).length < 32) {
  config.auth.appKey = 'dev-only-insecure-key-do-not-use-in-prod!!';
}

export default config;
