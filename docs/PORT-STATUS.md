# Port status

This tree is a complete conversion of the PHP edition (`php-edition/` in
https://github.com/Harsh2104-bit/growvanta-crm) to a Node/Express API
(`server/`) and a React SPA (`client/`). Every PHP service, API module,
webhook receiver, cron job and SPA view has a counterpart below.

**Verification performed:** static only, at the user's request — no
`npm install`, no server, no database and no browser were run.

- Every server file passes `node --check` (Node 20).
- A cross-module scan confirms every relative named import on the server and
  client resolves to a real export.
- The whole client bundles cleanly with esbuild from `src/main.jsx`, with all
  27 lazy pages included and no errors or warnings.

Nothing has been exercised against a live MySQL yet. The first run should
follow the README: migrate, seed, then start the server.

---

## File map

### Server

| PHP edition | Node |
| --- | --- |
| `api/index.php`, `.htaccess` rewrites | `src/app.js` (route table, `/f/:key` + `/embed/:key.js` rewrites, `/public-form.js`) |
| `bootstrap.php` listener registration | `src/services/listeners.js` |
| `config.php` | `src/config/index.js` |
| `lib/*.php` | `src/lib/*.js` (`db`, `util`, `errors`, `response`, `security`, `permissions`, `scope`, `tenancy`, `auth`, `apikey`, `audit`, `rateLimit`, `validate`, `xlsx`, `csv`) + `src/lib/context.js` (request context replacing PHP globals) |
| `services/Events.php` | `src/services/events.js` |
| `services/Conditions, CustomFields, SequenceCodes, Scoring, Duplicates, Assignment, LeadService, Filters, Notifications, Automation, Webhooks` | `src/services/conditions.js, customFields.js, sequenceCodes.js, scoring.js, duplicates.js, assignment.js, leadService.js, filters.js, notifications.js, automation.js, webhooks.js` |
| `services/Reports, Projects, Comms, Provisioning` | `src/services/reports.js, projects.js, comms.js, provisioning.js` |
| `services/StaffNotify, MetaLeads, MetaConnect` | `src/services/staffNotify.js, metaLeads.js, metaConnect.js` |
| `api/auth.php` | `src/routes/auth.js` |
| `api/leads, activities, documents, search, savedViews, notifications, imports, reports, targets` | `src/routes/` same names (`savedViews.js` at `/api/saved-views`) |
| `api/users, roles, teams, settings, apikeys, webhooks, integrations, metaForms, templates, whatsapp, email, audit` | `src/routes/` same names (`apikeys.js` at `/api/api-keys`, `audit.js` at `/api/audit-logs`, `metaForms.js` at `/api/meta-forms`) |
| `api/platform, projects, automation, forms (+forms.inc), publicCapture, publicApi (+publicApi.inc)` | `src/routes/platform.js, projects.js, automation.js, forms.js, formsShared.js, publicCapture.js, publicApi.js, publicApiShared.js` |
| `webhooks/meta_leads.php`, `webhooks/meta_oauth.php` | `src/routes/metaInbound.js`, which serves both the original `.php` paths and the `/meta-leads` and `/meta-oauth` aliases |
| `cron/sweep.php` | `src/jobs/sweep.js` (runs in-process every `SWEEP_INTERVAL_MIN`) + `scripts/sweep.js` (`npm run sweep`) |
| `database/schema.sql`, `migrations/*` | unchanged; applied by `scripts/migrate.js` |
| `database/seed.php`, `scripts/seed-demo.php` | `scripts/seed.js` (`--demo` for the demo tenant) |
| `public-form.js` | `server/public/public-form.js` |
| `install-check.php`, `dev-server.php`, `scripts/package.php` | not ported (these are specific to Hostinger shared hosting) |

### Client

| Vanilla SPA | React |
| --- | --- |
| `index.html`, `js/app.js` shell | `index.html`, `src/main.jsx`, `src/App.jsx`, `src/components/AppShell.jsx` + `components/shell/*` (nav, command palette, notifications panel, tenant switcher, quick-create) |
| `js/router.js` | react-router-dom routes + `components/ErrorBoundary.jsx` + `lib/query.js` |
| `js/lib/ui.js` | `src/components/ui/*` |
| `js/lib/charts.js` | `src/components/charts.jsx` |
| `js/lib/store.js` | `context/AuthContext.jsx`, `lib/session.js`, `lib/reference.js`, `lib/branding.js`, `lib/unread.js`, `lib/tenant.js`, `lib/events.js` |
| `js/lib/icons.js` | `src/components/Icon.jsx` |
| `js/lib/api.js`, `js/lib/format.js` | `src/lib/api.js`, `src/lib/format.js` |
| `js/views/shared.js` | `src/components/shared.jsx` |
| `js/login.js`, `login.html` | `pages/Login, Register, ForgotPassword, ResetPassword, AcceptInvite, VerifyEmail` |
| `js/views/*.js` (26 views) | `src/pages/*.jsx`, one page per view; `leadForm` → `LeadForm.jsx`, `userPermissions` → `UserPermissionsDrawer.jsx`, and the automation builders live in `pages/automation/` |
| `home/terms/privacy/technology/presentation.html`, `css/site.css`, `js/site.js` | `client/public/` (the marketing home page is `/home.html`, because `/` is the app) |

---

## Behaviour that differs from the PHP edition

### Platform and runtime

- **Sessions and timers.** Transactions carry their connection through
  `AsyncLocalStorage`, and so does request context: the PHP `actor()` becomes
  `currentActor()`. Domain events still run after the response is sent, and
  always outside any transaction.
- **JSON columns** are returned as raw JSON text, the way PDO returned them,
  so `camelize()` never renames keys inside custom fields or settings.
- **The follow-up sweep** runs inside the API process. Set
  `SWEEP_INTERVAL_MIN=0` to use cron with `npm run sweep` instead. The HTTP
  trigger (`?token=CRON_TOKEN`) exists as `sweepHttpHandler` but is not
  mounted, which matches the PHP edition's deny-all `cron/` folder.
- **Links in email** (invite, reset, staff alerts, the Meta OAuth return) point
  at `CLIENT_URL/...` routes instead of `index.html#/...`. Notification rows
  still store `#/leads/…`, and the client strips the `#` before navigating.
- **Email transport.** Tenant SMTP uses nodemailer instead of PHP's raw socket
  dialogue. Error messages are mapped back to the PHP wording.
- **Uploads.** File-type checks inspect file headers, replacing libmagic and
  `getimagesize`. Upload errors return the PHP's 400 messages.
- **Bodies on `/api/public` and `/api/v1`** are decoded leniently from the raw
  text, as PHP read `php://input`: JSON sent as text/plain or form-urlencoded
  still works, and malformed JSON becomes an empty body.
- **Transactions.** `createLead`, `updateLead` and `assignLeads` write inside
  one transaction and emit their events after it commits.
- **Customer-facing integers.** Meta lead and page ids above 2^53 are kept as
  exact strings.

### Bugs in the PHP/vanilla edition that are fixed here

- The invite email is now actually sent. PHP only logged the link; it is still
  returned as `inviteUrl` too.
- `/api/auth/me` now includes `emailVerifiedAt`, so Profile no longer shows
  "Not verified" for every account.
- Project images and covers load. They were stored as bare file names in a
  folder that is never served, so they now resolve to
  `/api/projects/:id/images/:imageId/file` and the new `/api/projects/:id/cover`.
- `/api/templates` honours `?organizationId=` the way WhatsApp and Email do, so
  a Super Admin configuring a client's messaging edits that client's
  templates, not the platform's own.
- Quick-create "New user" works. Vanilla's `openUserForm` was never exported.
- LeadDetail's Documents tab works. Vanilla called `renderDocuments()`, which
  was never defined.
- The Imports "Done" button no longer re-posts `/execute`, which used to cause
  an "upload has expired" error.
- Workflow "Set priority" stores the value it displays.
- Editing a web form keeps its description. Vanilla showed and saved it empty.
- The "My leads" quick view now highlights when it is active.
- "Recalculate all" scores is shown only to roles with `automation:update`,
  which is what the server enforces.
- Escape now closes only the top-most dialog.
- The donut chart's legend colours now match its arcs.
- Links to the removed Campaigns and Contacts screens render as text instead
  of leading to NotFound.

### Known gaps carried over from the PHP edition

- `GET /api/users` returns no `teamMemberships`, so the Users table's Teams
  column shows "—". `UserForm` works around this by reading memberships from
  `/api/teams`, so saving a user no longer drops their teams.
- `GET /api/teams/:id` has no `stats.openTasks`, so that figure always shows 0.
- Performance's "By person" tab needs `reports:read`, even though the page
  itself opens with `targets:read`.
- The Leads bulk "Create tasks" button targets an endpoint that does not exist.
  It never appears, because `tasks` is not a module in the permission catalogue.
- `teamIds`, `memberIds`, `parentRoleId` and `managerId` in user, team and
  role writes are not checked to belong to the caller's organisation.

---

## External configuration still required

These need real values in `server/.env` before the matching features work.
Nothing in the code invents them.

| Setting | Needed for |
| --- | --- |
| `DB_*`, `APP_KEY` | Everything. Use the **same `APP_KEY`** as an existing PHP install, or the stored Meta tokens cannot be decrypted |
| `SMTP_*` | Invites, password resets, verification, staff lead alerts and daily summaries. Without it, mail is logged and reported as `SMTP_NOT_CONFIGURED` |
| `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN` | Facebook/Instagram page connection and lead-ad ingestion. The webhook URL is `APP_URL/webhooks/meta_leads.php` |
| Tenant WhatsApp/email settings | Entered per company in the app (Communication screen) |
| `CLIENT_URL`, `CORS_ORIGINS`, `COOKIE_SECURE` | Correct links in emails, and cookies over HTTPS |
| `SWEEP_INTERVAL_MIN` (optional) | The follow-up sweep schedule; 0 disables it in-process |
