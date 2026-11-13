# Porting conventions (PHP edition → Node + React)

This is the contract every ported file follows, so modules written separately
fit together without guesswork. The PHP edition is the reference: behaviour,
SQL, URLs, JSON shapes and error messages are kept the same. Only the
language changes.

Reference source (read-only): the `php-edition/` folder of
https://github.com/Harsh2104-bit/growvanta-crm.

## Server (`server/`, ESM, Node 20+, Express 4, mysql2)

### Files and names

| PHP | Node |
| --- | --- |
| `services/LeadService.php` | `server/src/services/leadService.js` (file basename lowerCamelCased) |
| `services/StaffNotify.php` | `server/src/services/staffNotify.js` |
| `services/MetaConnect.php` / `MetaLeads.php` | `services/metaConnect.js` / `services/metaLeads.js` |
| `services/CustomFields.php` / `SequenceCodes.php` | `services/customFields.js` / `services/sequenceCodes.js` |
| other `services/Foo.php` | `services/foo.js` |
| `api/foo.php` | `server/src/routes/foo.js` — `export default router` (an `express.Router()`) |
| `api/forms.inc.php` | `server/src/routes/formsShared.js` |
| `api/publicApi.inc.php` | `server/src/routes/publicApiShared.js` |
| `webhooks/meta_leads.php`, `webhooks/meta_oauth.php` | `server/src/routes/metaInbound.js` (mounted at `/webhooks`) |
| `cron/sweep.php` | `server/src/jobs/sweep.js` (`export async function runSweep()`) + `server/scripts/sweep.js` CLI |
| `lib/csv.php` | `server/src/lib/csv.js` (`parseCsv`, `parseCsvObjects`, `escapeCsvCell`, `toCsv`) |

**Function names:** PHP `snake_case` → JS `camelCase`, mechanically and
exactly: `create_lead` → `createLead`, `gv_get_path` → `gvGetPath`,
`register_automation_listeners` → `registerAutomationListeners`,
`project_visible_where` → `projectVisibleWhere`. Every PHP function that other
files call is exported under that name, so a module can import from a sibling
that is being written at the same time.

**Signatures:** same parameters, same order, same defaults. A PHP associative
array becomes a plain object **with the same keys** — do not rename keys
(`['sql' => …, 'params' => …]` stays `{ sql, params }`; `$opts['skipAssign']`
stays `opts.skipAssign`). A PHP list used for destructuring
(`[$a, $b] = f()`) is returned as a JS array.

**Async:** every function that touches the database, the network or the disk
is `async`. Pure helpers (condition evaluation, template rendering, score
bands) stay synchronous. When calling a function from another module, always
`await` it unless it is plainly pure — awaiting a sync value is harmless,
forgetting to await a promise is a bug.

### PHP helper → Node equivalent

| PHP | Node (import from) |
| --- | --- |
| `db_one/db_all/db_exec/db_scalar/db_transaction/db_in_clause` | `dbOne/dbAll/dbExec/dbScalar/dbTransaction/dbInClause` (`lib/db.js`) — all async; `dbInClause` returns `[sql, params]` |
| `gv_id, digits_only, normalize_phone, normalize_email, full_name, slugify, safe_json, to_json, pick, gv_diff, start_of_day, end_of_day, add_days, parse_date, round2, pct, camelize, decamelize, chunk_array, gv_bool, to_camel_case, to_snake_case` | same names camelCased (`lib/util.js`); `toSqlDateTime(date)`, `toSqlDate(date)`, `nowSql()` replace PHP `date('Y-m-d H:i:s', …)` |
| `bad_request, validation_error, unauthenticated, forbidden, not_found, conflict, too_many` | `badRequest, validationError, unauthenticated, forbidden, notFound, conflict, tooMany` (`lib/errors.js`) — **`throw` them**; `new AppError(status, code, msg, details)` for anything else (`gv_fail`) |
| `json_ok($d, $meta)` / `json_created` / `json_error` | `return jsonOk(res, d, meta)` / `jsonCreated` / `jsonError` (`lib/response.js`) |
| `parse_paging, page_meta, parse_sort` | `parsePaging(req.query)`, `pageMeta`, `parseSort(req.query, allowed, col, dir)` (`lib/response.js`) |
| `request_body()` | `req.body ?? {}` |
| `$_GET` | `req.query` |
| `$_FILES['file']` | `uploadSingle('file')` middleware from `middleware/upload.js`, then `req.file` (`{ originalname, mimetype, size, buffer }`); write with `fs.promises.writeFile` |
| `actor()` inside a route | `req.actor` |
| `actor()` inside a service | `currentActor()` (`lib/context.js`) |
| `require_auth()` | already applied to every guarded router in `app.js`; `requireActor(req)` if needed |
| `require_permission('leads','read')` | middleware `requirePermission('leads','read')` (`middleware/index.js`) or inline `assertPermission(req,'leads','read')` (`lib/auth.js`) |
| `require_any_permission([[m,a],…])` | `requireAnyPermission([[m,a],…])` / `assertAnyPermission(req, pairs)` |
| `has_permission($actor, m, a)` | `hasPermission(actor, m, a)` (`lib/auth.js`) |
| `scope_info()` | `await scopeInfo(req)` (`middleware/index.js`) |
| `scope_for(m, a)` | `await scopeFor(req, m, a)` (`middleware/index.js`) |
| `permission_scope($actor, m, a)` | `permissionScope(actor, m, a)` (`lib/auth.js`) |
| `resolve_scope`, `visibility_where`, `can_act_on_user` | `resolveScope(actor, key, req.scopeCache)`, `visibilityWhere(...)` (returns `{ sql, params }`), `canActOnUser(actor, id, req.scopeCache)` (`lib/scope.js`) |
| `client_ip()`, `user_agent()` | `clientIp(req)`, `userAgent(req)` (`lib/auth.js`) |
| `audit_record($org, $actor, $action, [...])` | `await auditRecord(org, actor, action, { entityType, entityId, entityLabel, changes }, req)` (`lib/audit.js`) — `req` last; the opts keys are the camelCase of the PHP keys |
| `export_record(...)` | `await exportRecord(org, actor, entity, format, rowCount, filters, req)` |
| `rate_limit_check / rate_limit_capture / rate_limit_auth` | `rateLimitCheck / rateLimitCapture(req) / rateLimitAuth(req)` (`lib/rateLimit.js`) |
| `api_key_auth($scope)` | `await apiKeyAuth(req, scope)` (`lib/apikey.js`) — sets `req.apiKey`, returns `{ organizationId, apiKey }` |
| `hash_password, verify_password, check_password_strength, random_token, sha256, safe_equal, sign_webhook_payload, generate_api_key, gv_encrypt, gv_decrypt, totp_*` | camelCased (`lib/security.js`); `hashPassword`/`verifyPassword` are async |
| `effective_permissions, all_permissions, grant_permissions, sanitize_permissions, is_valid_scope, user_permission_overrides, gv_module_map, gv_scope_rank` | `effectivePermissions, allPermissions, grantPermissions, sanitizePermissions, isValidScope, userPermissionOverrides (async), moduleMap, scopeRank` + `MODULES`, `DATA_SCOPES`, `PLATFORM_MODULES` (`lib/permissions.js`) |
| tenancy helpers (`active_org_id`, `tenant_guard`, `require_platform_admin`, `is_platform_admin`, `resolve_tenant_param`, `switch_active_tenant`, `org_branding`, `org_billing`, `org_access_denial`, `delete_organization`, `platform_organization_id`, `org_uses_global_projects`, `is_valid_company_type`, `is_valid_billing_status`) | camelCased (`lib/tenancy.js`); functions that took no args but read the actor now take `req` first (`activeOrgId(req)`, `tenantGuard(req, orgId)`, `requirePlatformAdmin(req)`, `resolveTenantParam(req, id)`) |
| `validate($data)->required()->email()->in()->maxLength()->numeric()->validate()` | `validate(data).required(...)...validate()`; `strOrNull, numOrNull, boolVal` (`lib/validate.js`) |
| `xlsx_download($filename, $columns, $rows, $sheet)` | `xlsxDownload(res, filename, columns, rows, sheet)` (`lib/xlsx.js`) |
| `gv_config('app_url')`, `'uploads.dir'`, `'meta.app_secret'`, `'mail.host'` … | `config.appUrl`, `config.uploads.dir`, `config.meta.appSecret`, `config.mail.host` … (`config/index.js`, camelCase keys) |
| `env('CRON_TOKEN')` | `process.env.CRON_TOKEN` |
| `emit_domain_event`, `on_domain_event`, `flush_domain_events` | `emitDomainEvent`, `onDomainEvent`, `flushDomainEvents` (`services/events.js`) |
| PHP `mail()`/SMTP sockets | `sendSystemMail({ to, subject, html, text })` (`services/mailer.js`, nodemailer) — or a per-tenant `nodemailer.createTransport` where the PHP used tenant SMTP settings |
| `file_get_contents($url)` / curl | global `fetch` (Node 20) |
| `json_decode/json_encode` | `safeJson(value, fallback)` / `toJson(value)` or `JSON.stringify` |
| `htmlspecialchars` | a local `escapeHtml()` helper |
| `$GLOBALS['GV_SESSION']` | `req.session` |
| `strtotime`, `date()` | `new Date(...)`, `toSqlDateTime`, `toSqlDate` |

### Route files

```js
import express from 'express';
import { ah, requirePermission, scopeInfo } from '../middleware/index.js';
import { jsonOk, jsonCreated, parsePaging, pageMeta } from '../lib/response.js';

const router = express.Router();

router.get('/', requirePermission('leads', 'read'), ah(async (req, res) => {
  const scope = await scopeInfo(req);
  …
  return jsonOk(res, rows, pageMeta(page, limit, total));
}));

export default router;
```

- Every async handler is wrapped in `ah()`.
- Paths, methods, query parameters, request body keys, response shapes, status
  codes, error codes and messages are identical to the PHP file. The prefix
  (`/leads`, `/api-keys` …) is mounted in `app.js`; a route file only declares
  what follows it. `$rest[0]` is `req.params.id` etc.
- Declare literal sub-paths (`/export`, `/board`, `/bulk`) **before** `/:id`
  so Express does not swallow them as an id.
- Keep the PHP's SQL as it is. MySQL is unchanged (same `database/schema.sql`).
- Keep the explanatory comments where they explain *why*.

## Client (`client/`, React 18, Vite, react-router-dom 6)

- Routes use `BrowserRouter` paths identical to the PHP edition's hash routes
  (`#/leads/42` → `/leads/42`).
- All HTTP goes through `client/src/lib/api.js` (`api.get/post/patch/put/del/data/download/upload`).
- Styling uses the existing class names in `client/src/styles/app.css` (it is
  the PHP edition's stylesheet), so markup mirrors the vanilla views'
  `h('div', { class: 'card' }, …)` structure with `className`.
- Shared UI lives in `client/src/components/ui/` and `client/src/lib/` — see
  `docs/CLIENT-UI.md` once written. Pages live in `client/src/pages/`.
