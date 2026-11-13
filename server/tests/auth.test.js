/**
 * API tests for the authentication surface.
 *
 * These run against a **real database** — the same one `.env` points at — on a
 * throwaway port. There are no mocks and no fixtures invented here: the tests
 * sign in as a seeded account and assert what the server actually answers.
 *
 *   npm run migrate && npm run seed -- --demo && npm test
 *
 * Set TEST_EMAIL / TEST_PASSWORD to use a different account.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { closePool } from '../src/lib/db.js';
import config from '../src/config/index.js';

const EMAIL = process.env.TEST_EMAIL ?? 'admin@demorealty.test';
const PASSWORD = process.env.TEST_PASSWORD ?? config.seedPassword;

let server;
let base;

/** Keeps cookies across calls the way a browser would. */
class Session {
  constructor() {
    this.cookies = new Map();
  }

  get csrf() {
    return this.cookies.get(config.auth.csrfCookie) ?? '';
  }

  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || /Max-Age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async call(method, path, body) {
    const headers = { cookie: this.header() };
    if (this.csrf) headers['x-csrf-token'] = decodeURIComponent(this.csrf);
    if (body !== undefined) headers['content-type'] = 'application/json';

    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    const payload = await res.json().catch(() => null);
    return { status: res.status, payload };
  }
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('health', () => {
  it('reports the database as reachable', async () => {
    const res = await fetch(base + '/api/health');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.status, 'ok', 'the test database must be migrated and running');
    assert.equal(body.data.database, 'up');
  });
});

describe('sign-in', () => {
  it('rejects an empty body with per-field validation errors', async () => {
    const s = new Session();
    await s.call('GET', '/api/auth/me'); // picks up the CSRF cookie
    const { status, payload } = await s.call('POST', '/api/auth/login', {});
    assert.equal(status, 422);
    assert.equal(payload.error.code, 'VALIDATION_ERROR');
    const fields = payload.error.details.map((d) => d.field).sort();
    assert.deepEqual(fields, ['email', 'password']);
  });

  it('rejects a wrong password', async () => {
    const s = new Session();
    await s.call('GET', '/api/auth/me');
    const { status, payload } = await s.call('POST', '/api/auth/login', {
      email: EMAIL,
      password: 'definitely-not-the-password',
    });
    assert.equal(status, 401);
    assert.equal(payload.error.code, 'UNAUTHENTICATED');
  });

  it('accepts the seeded account and returns effective permissions', async () => {
    const s = new Session();
    await s.call('GET', '/api/auth/me');
    const { status, payload } = await s.call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.data.user.email, EMAIL);
    assert.ok(payload.data.user.role, 'the user must carry a role');
    assert.ok(Object.keys(payload.data.user.permissions).length > 0, 'effective permissions must be populated');
    assert.ok(s.cookies.has(config.auth.cookieName), 'a session cookie must be set');
  });
});

describe('session surface', () => {
  it('refuses /auth/me without a session', async () => {
    const res = await fetch(base + '/api/auth/me');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHENTICATED');
  });

  it('returns the organisation, scope and teams once signed in', async () => {
    const s = new Session();
    await s.call('GET', '/api/auth/me');
    await s.call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });

    const { status, payload } = await s.call('GET', '/api/auth/me');
    assert.equal(status, 200);
    assert.ok(payload.data.organization.id);
    assert.ok(payload.data.scope, 'a visibility scope must be resolved');
    assert.ok(Array.isArray(payload.data.teams));
  });

  it('lists the live session and marks the current one', async () => {
    const s = new Session();
    await s.call('GET', '/api/auth/me');
    await s.call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });

    const { status, payload } = await s.call('GET', '/api/auth/sessions');
    assert.equal(status, 200);
    assert.ok(payload.data.length >= 1);
    assert.ok(payload.data.some((row) => row.current === true));
  });
});

describe('CSRF', () => {
  it('refuses a write that carries the session cookie but no CSRF header', async () => {
    const s = new Session();
    await s.call('GET', '/api/auth/me');
    await s.call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });

    // Same cookies, header deliberately omitted.
    const res = await fetch(base + '/api/auth/logout-all', {
      method: 'POST',
      headers: { cookie: s.header() },
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'FORBIDDEN');
  });
});

describe('revocation', () => {
  it('invalidates the session immediately after logout-all', async () => {
    const s = new Session();
    await s.call('GET', '/api/auth/me');
    await s.call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });

    const revoked = await s.call('POST', '/api/auth/logout-all');
    assert.equal(revoked.status, 200);
    assert.ok(revoked.payload.data.sessionsRevoked >= 1);

    // Sessions are database rows, so the next request must already fail —
    // there is no window in which the old token still works.
    const after = await s.call('GET', '/api/auth/me');
    assert.equal(after.status, 401);
  });
});

describe('routing', () => {
  it('answers an unknown API path with NOT_FOUND, not HTML', async () => {
    const res = await fetch(base + '/api/this-does-not-exist');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'NOT_FOUND');
  });
});
