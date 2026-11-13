# Growvanta CRM — React + Node

Multi-tenant real-estate CRM: lead capture, distribution, pipeline and
reporting. React (Vite) front end, Node/Express API, MySQL.

## What this is

A complete conversion of the PHP edition
([`php-edition/`](https://github.com/Harsh2104-bit/growvanta-crm/tree/main/php-edition)
of the original repository) to a React front end in `client/` and a
Node/Express API in `server/`. Every PHP service, API module, webhook
receiver, cron job and SPA view has a counterpart here; the database schema is
unchanged, so an existing PHP install's MySQL database can be pointed at this
API directly (keep the same `APP_KEY`).

- [`docs/PORT-STATUS.md`](docs/PORT-STATUS.md) — file-by-file map of what each
  PHP/JS file became, and every deliberate behaviour difference.
- [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) — naming and helper mapping
  used throughout the server port.
- [`docs/CLIENT-UI.md`](docs/CLIENT-UI.md) — the shared React components,
  hooks and page-writing pattern.

---

## Requirements

| | |
| --- | --- |
| Node | **20 or newer** (the server is ESM and uses `AsyncLocalStorage`) |
| MySQL | **8.0**, or MariaDB **10.4+** |
| npm | 9+ |

> The PHP edition exists because Hostinger shared hosting has no Node runtime.
> This build needs a host that runs a long-lived process: a VPS, a container,
> or any Node-capable platform. Shared PHP hosting will not run it.

---

## Layout

```
growvanta-crm-node/
├── client/                 React app (Vite)
│   ├── public/             favicons, brand art
│   └── src/
│       ├── components/     shell, route guard, shared UI
│       ├── context/        auth, theme, toasts
│       ├── lib/            API client, formatting, catalogues
│       ├── pages/          one file per route
│       └── styles/         the design system
├── server/                 Express API
│   ├── scripts/            migrate.js, seed.js
│   └── src/
│       ├── config/         environment resolution
│       ├── lib/            db, auth, permissions, scope, tenancy, security…
│       ├── middleware/     CSRF, rate limiting, auth and permission guards
│       ├── routes/         one file per API module
│       ├── services/       business logic shared by routes
│       └── jobs/           scheduled work
├── database/
│   ├── schema.sql          base schema
│   └── migrations/         ordered, applied by scripts/migrate.js
└── docs/                   PORT-STATUS.md and notes
```

---

## Setting it up

### 1. Database

Create an empty database and a user that owns it:

```sql
CREATE DATABASE growvanta CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'growvanta'@'127.0.0.1' IDENTIFIED BY 'a-strong-password';
GRANT ALL PRIVILEGES ON growvanta.* TO 'growvanta'@'127.0.0.1';
FLUSH PRIVILEGES;
```

### 2. API

```bash
cd server
cp .env.example .env     # then edit .env
npm install
npm run migrate          # schema + migrations, idempotent
npm run seed             # platform org + super admin
npm run dev              # or: npm start
```

`.env` must have at minimum `DB_*` and `APP_KEY`.

**`APP_KEY` is not a formality.** It derives session tokens and encrypts stored
integration secrets (Meta page access tokens). Generate it once with
`openssl rand -base64 48`, back it up with the database, and never rotate it
casually — every stored token becomes unreadable and every integration has to
be reconnected. The server refuses to start in production if it is missing or
shorter than 32 characters.

When migrating from an existing PHP install, carry **the same `APP_KEY`** over,
or the tokens already in the database cannot be decrypted. The encryption
layout and the TOTP implementation are byte-compatible with the PHP edition on
purpose.

`npm run seed -- --demo` additionally creates a demo tenant. Do not use it on
anything reachable from the internet.

### 3. Client

```bash
cd client
cp .env.example .env
npm install
npm run dev              # http://localhost:5173
npm run build            # production bundle in client/dist
```

In development, Vite proxies `/api` to the API server. That is not only
convenient: the session and CSRF cookies are `SameSite=Lax`, so a cross-origin
request from `:5173` to `:4000` would not carry them and every call would look
signed out.

In production, serve `client/dist` as static files and forward `/api` and
`/webhooks` to the Node process on the same origin:

```nginx
server {
  server_name crm.example.com;
  root /var/www/growvanta/client/dist;

  location / { try_files $uri /index.html; }

  # /f/KEY and /embed/KEY.js are the public web-form URLs, and the embed
  # snippet loads /public-form.js — all three are served by the API.
  location ~ ^/(api|webhooks|f|embed)/|^/public-form\.js$ {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

`X-Forwarded-For` matters: rate limiting and audit rows record the client IP,
and without it every request looks like it came from the proxy.

Set `COOKIE_SECURE=1` whenever the site is served over HTTPS.

---

## Scripts

### Project root — local database

On a Mac where Homebrew has no prebuilt MySQL (Intel Macs), the official
MySQL 8.4 LTS binary can live inside the project, in the git-ignored `.dev/`
folder (`.dev/mysql` = binaries, `.dev/mysql-data` = data, `.dev/my.cnf` =
config). `scripts/local-db.sh` drives it, and does nothing when `.dev/mysql`
is absent, so a machine with its own MySQL is unaffected.

| Command | Does |
| --- | --- |
| `npm run db:start` | Starts the local MySQL on 127.0.0.1:3306 (no-op if running) |
| `npm run db:stop` | Stops it cleanly |
| `npm run db:status` | Says whether it is running |

`npm run dev:server`, `npm run migrate` and `npm run seed` start it
automatically first.

### `server/`

| Command | Does |
| --- | --- |
| `npm start` | Runs the API |
| `npm run dev` | Runs the API with file watching |
| `npm run migrate` | Applies `database/schema.sql` then each migration, recording them in `schema_migrations`. Safe to re-run |
| `npm run seed` | Creates the platform organisation and super admin. Never resets an existing password |
| `npm run seed -- --demo` | Also creates a demo tenant |
| `npm test` | API tests against the real database — run `migrate` and `seed -- --demo` first |
| `npm run sweep` | One run of the follow-up / daily-summary sweep (the PHP edition's `cron/sweep.php`) |

The API already runs that sweep in-process every `SWEEP_INTERVAL_MIN` minutes
(default 15). Set `SWEEP_INTERVAL_MIN=0` and schedule `npm run sweep` from cron
instead when several API processes share one database.

### `client/`

| Command | Does |
| --- | --- |
| `npm run dev` | Vite dev server with the API proxy |
| `npm run build` | Production bundle into `client/dist` |
| `npm run preview` | Serves the built bundle locally |

---

## How the API is shaped

Every response uses one envelope:

```jsonc
// success
{ "data": … , "meta": { … } }

// failure
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [ … ] } }
```

Keys are camelCase. Timestamps are strings in `YYYY-MM-DD HH:MM:SS`, in the
organisation's time zone — not ISO, and not `Date` objects.

| Status | Code | Means |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | Malformed request |
| 401 | `UNAUTHENTICATED` | No session, or it was revoked or expired |
| 403 | `FORBIDDEN` | Signed in, but not permitted — including a missing CSRF token |
| 404 | `NOT_FOUND` | No such record, or not visible at this user's scope |
| 409 | `CONFLICT` | Duplicate or state clash |
| 422 | `VALIDATION_ERROR` | Field errors, each named in `details` |
| 429 | `RATE_LIMITED` | Too many requests in the window |

### Authentication

Sessions are **rows in the database**, not self-contained tokens. The browser
holds an opaque token in an httpOnly cookie; the server stores only its SHA-256
hash. Revoking a session therefore takes effect on that device's very next
request — there is no window in which a signed-out device still works because
its token has not expired yet.

Writes also require a double-submit CSRF token: the server sets a readable
`gv_csrf` cookie, and the client echoes it in `x-csrf-token`.

Machine callers use an API key on `/api/v1/*` instead, with no cookies.

### Authorisation

Two independent gates, and both must pass:

1. **Permission** — `requirePermission(module, action)`. Effective permissions
   are the role's grant plus the user's own GRANT/REVOKE overrides.
2. **Visibility scope** — how far the user can see: `OWN`, `TEAM`,
   `TEAM_AND_BELOW`, `REGION`, `ORGANIZATION`, `ALL`. Scope is resolved per
   permission, so a user can read their team's leads while exporting only
   their own.

A permission without the matching scope reaches nothing; a scope without the
permission is never consulted. Both are enforced server-side on every request.
The client's route guard is a redirect, nothing more.

### Multi-tenancy

Every row belongs to an organisation. Platform admins can switch into a client
company; `actor.organizationId` is the active tenant while
`actor.homeOrganizationId` stays the real one, so an audit row always records
who actually acted.

---

## Not configured in this repository

Nothing here invents credentials or pretends an integration works. These must
be supplied before the features that need them can run — they are listed with
empty values in `server/.env.example`:

- **SMTP** — without it, password-reset and invitation mail is not delivered.
  The API logs the link and reports `SMTP_NOT_CONFIGURED` rather than silently
  claiming success.
- **Meta (Facebook/Instagram)** app ID, app secret and verify token — for page
  connection and lead-ad ingestion.
- **WhatsApp Business** credentials.

See [`docs/PORT-STATUS.md`](docs/PORT-STATUS.md) for the full dependency list
and the current state of every module.

---

## Security notes for whoever deploys this

- Serve over HTTPS and set `COOKIE_SECURE=1`.
- Keep `APP_KEY` out of version control and back it up with the database.
- `npm run seed` prints a generated password **once** outside development.
  Store it immediately; it is not recoverable.
- `SEED_PASSWORD` in `.env.example` is public by definition. Change it before
  seeding anything reachable from the internet.
- Put the API behind a reverse proxy that sets `X-Forwarded-For`.
- Run `npm audit` before shipping.
