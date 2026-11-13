# Client UI reference (`client/src`)

The React client's shared foundation: the UI kit, charts, page helpers, the
session/permission layer, the shell and the routing contract. Everything here
is a port of the PHP edition's SPA (`index.html` + `js/app.js`, `js/router.js`,
`js/lib/*.js`, `js/views/shared.js`). Markup and class names are unchanged, so
`client/src/styles/app.css` (the PHP edition's stylesheet) applies as-is.

A page author needs this document and the vanilla view being ported. Every
signature below is copied from the code; if the two ever disagree, the code
wins and this file is the bug.

Paths in import examples are written **from `client/src/pages/`**.

---

## Contents

1. [Import map](#1-import-map)
2. [How to write a page](#2-how-to-write-a-page)
3. [Session, permissions and app state](#3-session-permissions-and-app-state)
4. [API client and formatting (existing)](#4-api-client-and-formatting-existing)
5. [Toasts and errors](#5-toasts-and-errors)
6. [Overlays: Modal, Drawer, openOverlay, confirm](#6-overlays-modal-drawer-openoverlay-confirm)
7. [Display blocks](#7-display-blocks)
8. [Form controls and busy buttons](#8-form-controls-and-busy-buttons)
9. [Menus, tabs, pagination](#9-menus-tabs-pagination)
10. [DataTable and SearchBox](#10-datatable-and-searchbox)
11. [Clipboard](#11-clipboard)
12. [Icons](#12-icons)
13. [Charts](#13-charts)
14. [Shared page pieces (`shared.jsx`)](#14-shared-page-pieces-sharedjsx)
15. [Query parameters (`query` / `onQuery`)](#15-query-parameters-query--onquery)
16. [Routing, page lifecycle and errors](#16-routing-page-lifecycle-and-errors)
17. [Forms the shell opens (contract for page authors)](#17-forms-the-shell-opens-contract-for-page-authors)
18. [The shell (what it already does for you)](#18-the-shell-what-it-already-does-for-you)
19. [Vanilla → React cheat sheet](#19-vanilla--react-cheat-sheet)

---

## 1. Import map

| What | Import from (relative to `src/pages/`) |
| --- | --- |
| HTTP client | `import api, { ApiError } from '../lib/api.js'` |
| Formatting | `import { number, money, date, relative, titleCase, … } from '../lib/format.js'` |
| Module labels | `import { MODULE_LABELS, SCOPE_LABELS, enumLabel } from '../lib/modules.js'` |
| Session + permissions (components) | `import { useAuth } from '../context/AuthContext.jsx'` |
| Session + permissions (plain functions) | `import { can, canAny, canRead, isSuperAdmin, scopeRank, isPlatformAdmin, onPlatform, getSession } from '../lib/session.js'` |
| Reference data | `import { useReference, loadReference, refreshReference, statusById, getReference } from '../lib/reference.js'` |
| Unread count | `import { useUnreadCount, refreshUnread, setUnreadCount, getUnreadCount } from '../lib/unread.js'` |
| Data-changed event | `import { emitDataChanged, useDataChanged, DATA_CHANGED } from '../lib/events.js'` |
| Tenant switching | `import { switchToClient, exitClientContext } from '../lib/tenant.js'` |
| Branding | `import { applyBranding } from '../lib/branding.js'` |
| Query params | `import { useQueryParams } from '../lib/query.js'` |
| Theme | `import { useTheme } from '../context/ThemeContext.jsx'` |
| UI kit (everything in §5–§11) | `import { … } from '../components/ui/index.js'` |
| Icons | `import Icon, { ACTIVITY_ICONS, iconNames } from '../components/Icon.jsx'` |
| Charts | `import { PALETTE, LineChart, BarList, DonutChart, FunnelChart, Sparkline, ScoreRing, ColumnChart } from '../components/charts.jsx'` |
| Shared page pieces | `import { PageHead, NoAccess, Panel, FilterBar, … } from '../components/shared.jsx'` |
| Error boundary | `import ErrorBoundary, { RouteError } from '../components/ErrorBoundary.jsx'` |
| Router | `import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'` |

The UI barrel `components/ui/index.js` exports exactly:
`Modal, Drawer, UIProvider, openOverlay, useOverlay, ConfirmDialog, confirmDialog,
useConfirm, Avatar, StatusBadge, EmptyState, SkeletonBlock, SkeletonTable,
PageLoader, KpiCard, ProgressBar, Field, Input, Textarea, Select, SwitchToggle,
Dropdown, MenuItem, MenuSeparator, MenuTitle, useDropdownClose, Tabs,
Pagination, DataTable, SearchBox, BusyButton, useBusy, copyToClipboard,
Spinner, Alert, toast, reportError, useToast, useReportError`.

No new npm dependencies were added. Do not add any for UI (charts are SVG).

---

## 2. How to write a page

### 2.1 Shape

- One file per route in `client/src/pages/`, **default export** a function
  component taking no props. Route params come from `useParams()`, query from
  `useQueryParams()` / `useSearchParams()`.
- The page renders inside the shell's `<main className="content">`; render the
  same top-level structure the vanilla view built (usually
  `<div><PageHead …/> …</div>`) with the same class names.
- The page is mounted fresh on every **pathname** change and **not** remounted
  when only the query string changes (§16). Errors thrown while rendering are
  caught by the route error boundary.
- Never touch `window.location.hash`, `document.querySelector` on the shell, or
  `js/lib/dom.js` patterns — state + JSX replace `h()`/`mount()`.

### 2.2 Permission gate

Vanilla views start with `if (!can('leads', 'read')) return { node: noAccess('leads') };`.
In React, gate **after** all hooks have been called (rules of hooks), or split
the gate into a wrapper:

```jsx
import { useAuth } from '../context/AuthContext.jsx';
import { NoAccess } from '../components/shared.jsx';

export default function Activities() {
  const { can } = useAuth();
  if (!can('activities', 'read')) return <NoAccess what="activities" />;
  return <ActivitiesPage />;
}

function ActivitiesPage() { /* all hooks live here */ }
```

### 2.3 Loading data

All HTTP goes through `lib/api.js`. The standard load pattern (initial load,
reload after a mutation, abort on unmount, query-driven reloads):

```jsx
import { useCallback, useEffect, useState } from 'react';
import api from '../lib/api.js';
import { EmptyState, PageLoader, reportError } from '../components/ui/index.js';

function useNotifications(page, unreadOnly) {
  const [state, setState] = useState({ status: 'loading', rows: [], meta: null, error: null });

  const load = useCallback(async (signal) => {
    setState((s) => ({ ...s, status: 'loading' }));
    try {
      const res = await api.get('/api/notifications',
        { page, limit: 30, ...(unreadOnly ? { unread: 'true' } : {}) }, { signal });
      setState({ status: 'ready', rows: res.data, meta: res.meta, error: null });
    } catch (err) {
      if (err.name === 'AbortError') return;
      reportError(err);
      setState({ status: 'error', rows: [], meta: null, error: err });
    }
  }, [page, unreadOnly]);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  return [state, () => load()];   // second value = the vanilla `load()` / router `reload()`
}
```

Rendering the three states the vanilla views had:

```jsx
if (state.status === 'loading') return <PageLoader />;
if (state.status === 'error') {
  return <div className="card"><EmptyState iconName="alert" title="Could not load notifications" message={state.error.message} /></div>;
}
```

`api.get(path, query, opts)` resolves to the full envelope `{ data, meta }`;
`api.data(path, query, opts)` resolves to `data` only. Both accept
`opts.signal`. Lists that page/sort/select should use `<DataTable>` (§10)
instead of hand-rolled state.

### 2.4 Mutations, toasts, errors

```jsx
import { BusyButton, reportError, toast, useConfirm } from '../components/ui/index.js';
import { emitDataChanged } from '../lib/events.js';

const confirm = useConfirm();

<BusyButton className="btn btn-danger" onClick={async () => {
  const ok = await confirm({ title: `Delete ${role.name}?`, message: '…', confirmLabel: 'Delete role', danger: true });
  if (!ok) return;
  try {
    await api.del(`/api/roles/${role.id}`);
    toast.success('Role deleted');
    reload();
  } catch (err) { reportError(err); }
}}>Delete</BusyButton>
```

- Success: `toast.success(title, body?)`. Warning: `toast.warn(title, body?)`.
- Any caught error: `reportError(err)` (shows the server message plus
  validation `details`; silent for aborts).
- Form validation errors inline: `err.fieldErrors[name]` → `<Field error=…>`.
  A form-level error box: `<Alert tone="danger" className="mb-16">{err.message}</Alert>`
  (it scrolls itself into view, like the vanilla `mount()` did).
- Where the vanilla view fired `window.dispatchEvent(new CustomEvent('gv:data-changed'))`,
  call `emitDataChanged()` (the shell re-reads the unread count).
- After editing statuses, sources, teams, users or projects call
  `refreshReference()` exactly where the vanilla view did.

### 2.5 Forms in drawers/modals

Two equivalent styles:

```jsx
// Declarative: the page owns the drawer's lifetime.
const [editing, setEditing] = useState(null);
{editing && <TeamForm team={editing} onClose={() => setEditing(null)} onSaved={reload} />}

// Imperative: like vanilla openX({ onSaved }) - survives the opener unmounting.
import { openOverlay } from '../components/ui/index.js';
openOverlay((close) => <TeamForm team={row} onClose={close} onSaved={reload} />);
```

A form component renders `<Drawer title=… onClose={onClose} footer=…>` and
owns its field state. Use `openOverlay` when a follow-up dialog must outlive
the form (e.g. users.js shows an "invite link" modal *after* closing the form)
or when a helper shared between pages opens it.

### 2.6 Navigation

```jsx
const navigate = useNavigate();
navigate(`/leads/${lead.id}`);                 // vanilla navigate(path)
navigate('/leads', { replace: true });         // vanilla navigate(path, { replace: true })
navigate(String(n.link).replace(/^#/, ''));    // server links may still start with '#'
<Link to="/imports">…</Link>   or   <LinkTo to="/imports">…</LinkTo>
```

### 2.7 Full example (port of `views/notifications.js`, abridged)

```jsx
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import { number, relative, titleCase, dateTime } from '../lib/format.js';
import { emitDataChanged } from '../lib/events.js';
import Icon from '../components/Icon.jsx';
import { PageHead } from '../components/shared.jsx';
import { EmptyState, PageLoader, Pagination, reportError, toast } from '../components/ui/index.js';

export default function Notifications() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [res, setRes] = useState(null);       // null = loading
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setRes(null); setError(null);
    try {
      setRes(await api.get('/api/notifications', { page, limit: 30, ...(unreadOnly ? { unread: 'true' } : {}) }));
    } catch (err) { reportError(err); setError(err); }
  }, [page, unreadOnly]);
  useEffect(() => { load(); }, [load]);

  const actions = [
    <button key="u" type="button" className="btn" onClick={() => { setUnreadOnly((v) => !v); setPage(1); }}>
      <Icon name="filter" size={15} />Unread only
    </button>,
    <button key="r" type="button" className="btn btn-primary" onClick={async () => {
      try {
        const r = await api.post('/api/notifications/read-all');
        toast.success(`${r.data.updated} marked as read`);
        load();
        emitDataChanged();
      } catch (err) { reportError(err); }
    }}><Icon name="check" size={15} />Mark all read</button>,
  ];

  let body;
  if (error) body = <div className="card"><EmptyState iconName="alert" title="Could not load notifications" message={error.message} /></div>;
  else if (!res) body = <PageLoader />;
  else if (!res.data.length) body = <div className="card"><EmptyState iconName="bell" title={unreadOnly ? 'Nothing unread' : 'No notifications yet'} message="Assignments, due tasks and deal outcomes will show up here." /></div>;
  else body = (
    <div className="card">
      <div className="card-head"><h3>{unreadOnly ? 'Unread' : 'All notifications'}</h3><span className="muted small">{`${number(res.meta.unread)} unread`}</span></div>
      <div>{res.data.map((n) => /* .notif-item row, see vanilla renderRow */ null)}</div>
      {res.meta.totalPages > 1 ? <Pagination meta={res.meta} onPage={setPage} /> : null}
    </div>
  );

  return (
    <div>
      <PageHead title="Notifications" subtitle="Assignments, due follow-ups, deal outcomes and system alerts." actions={actions} />
      {body}
    </div>
  );
}
```

---

## 3. Session, permissions and app state

### 3.1 `useAuth()` — `context/AuthContext.jsx`

Returns (re-renders the caller whenever the session changes):

| Member | Type | Meaning |
| --- | --- | --- |
| `status` | `'loading' \| 'signed-in' \| 'signed-out' \| 'error'` | Inside the shell it is always `'signed-in'`. |
| `error` | `ApiError \| null` | Set when `status === 'error'`. |
| `user` | object \| null | `/api/auth/me` user (below). Vanilla `store.user`. |
| `organization` | object \| null | Active organisation (below). Vanilla `store.organization`. |
| `teams` | `[{ id, name, role }]` | Vanilla `store.teams`. |
| `scope` | object \| null | Visibility scope info from the server. Vanilla `store.scope`. |
| `platform` | object \| null | Platform-admin data, `null` for everyone else. Vanilla `store.platform`. |
| `refresh()` | `() => Promise<me \| null>` | Re-reads `/api/auth/me`; re-applies formatting and branding. **Vanilla `loadSession()`.** |
| `signIn(credentials)` | `Promise<{ twoFactorRequired }>` | Used by the login page. |
| `signOut()` | `Promise<void>` | Posts logout, drops session, reference cache, unread count and branding. |
| `can(module, action)` | `boolean` | e.g. `can('leads', 'create')`. |
| `canAny(pairs)` | `boolean` | `canAny([['apikeys','read'], ['webhooks','read']])`. |
| `canRead(module)` | `boolean` | `can(module, 'read')`. |
| `isSuperAdmin()` | `boolean` | `user.role.key === 'super_admin'`. |
| `scopeRank()` | `number` | OWN 1, TEAM 2, TEAM_AND_BELOW 3, REGION 4, ORGANIZATION 5, ALL 6 (from `user.role.dataScope`, default 1). |
| `isPlatformAdmin()` | `boolean` | `user.isPlatformAdmin` (vanilla `clients.js isPlatformAdmin()`). |
| `onPlatform()` | `boolean` | Platform admin **not** currently inside a client (`!user.isImpersonating`). |

Note the last five are **functions**, as in the vanilla store.

`user` (from the Node server's `/api/auth/me`): `id, organizationId` (active
tenant), `homeOrganizationId, isPlatformAdmin, isImpersonating, firstName,
lastName, email, phone, avatarUrl, jobTitle, designation, region, managerId,
twoFactorEnabled, lastLoginAt, role: { id, key, name, level, dataScope },
permissions: { [module]: action[] }, inheritedPermissions, specialPermissions,
permissionScopes`.

`organization`: `id, name, slug, currency, timezone, companyType, isPlatform,
usesGlobalProjects, logoUrl, branding: { name, legalName, companyType, logoUrl,
faviconUrl, primary, accent, loginHeadline }, settings`.

`platform`: `{ homeOrganizationId, activeOrganizationId, isImpersonating,
clients: [{ id, name, companyType, status, logoUrl }] }`.

```jsx
const { user, organization, can } = useAuth();
<PageHead title={`Good ${greeting()}, ${user.firstName}`} subtitle={`${organization?.name} · ${user.role?.name}`} />
{can('leads', 'export') && <button className="btn">Export</button>}
```

### 3.2 `lib/session.js` — the same checks outside React

For plain helper functions (not components). Reads a snapshot that
`AuthProvider` updates on every session load; does **not** re-render anything.

| Export | Signature |
| --- | --- |
| `getSession()` | `() => { user, organization, teams, scope, platform }` (live object; read-only by convention) |
| `can` | `(module: string, action: string) => boolean` |
| `canAny` | `(pairs: [string, string][]) => boolean` |
| `canRead` | `(module: string) => boolean` |
| `isSuperAdmin` | `() => boolean` |
| `scopeRank` | `() => number` |
| `isPlatformAdmin` | `() => boolean` |
| `onPlatform` | `() => boolean` |
| `userCan, userCanAny, userIsSuperAdmin, userScopeRank, userIsPlatformAdmin, userOnPlatform` | same checks taking the user object first, e.g. `userCan(user, 'leads', 'read')` |
| `setSession(me)`, `clearSession()` | internal — called by `AuthProvider` only |

```js
import { can, getSession } from '../lib/session.js';
export function defaultDeveloperName(project) {
  return project?.developerName || getSession().organization?.name || '';
}
```

### 3.3 Reference data — `lib/reference.js`

Port of `reference()` / `refreshReference()` / `statusById()`. Shape:
`{ statuses, sources, teams, dimensions, users, projects }` (all arrays; from
`/api/reports/filters`, `/api/users/assignable`, and `/api/projects/options`
when the user can read projects; each falls back to `[]`/`{}` on failure).

| Export | Signature | Notes |
| --- | --- | --- |
| `useReference()` | `() => Reference \| null` | Hook. `null` until the first load lands (starts it if needed); re-renders on refresh. |
| `loadReference({ force = false } = {})` | `Promise<Reference>` | Vanilla `await reference()`. Cached; concurrent calls share one request; never rejects. |
| `refreshReference()` | `Promise<Reference>` | Forces a reload; every `useReference()` consumer re-renders. |
| `getReference()` | `() => Reference \| null` | Synchronous cache read. |
| `statusById(id)` | `(id) => status \| null` | Looks up `statuses` in the cache (ids compared as strings). `null` if not loaded. |
| `clearReference()` | `() => void` | Internal (sign-out). |

```jsx
const ref = useReference();
if (!ref) return <PageLoader />;
<Select options={ref.statuses.map((s) => ({ value: s.id, label: s.name }))} value={statusId} onChange={(e) => setStatusId(e.target.value)} />

// in an async handler, where vanilla did `const ref = await reference();`
const ref = await loadReference();
```

The shell warms the cache at boot.

### 3.4 Unread notification count — `lib/unread.js`

| Export | Signature |
| --- | --- |
| `useUnreadCount()` | `() => number` (hook, re-renders on change) |
| `getUnreadCount()` | `() => number` |
| `setUnreadCount(count)` | `(number) => void` — vanilla `setUnreadCount()` |
| `refreshUnread()` | `() => Promise<number>` — GET `/api/notifications/unread-count`; never throws |

The shell calls `refreshUnread()` at boot, every 60 s and on every
`emitDataChanged()`. A page changing read state normally just calls
`emitDataChanged()` (as the vanilla notifications view did).

### 3.5 Data-changed event — `lib/events.js`

| Export | Signature |
| --- | --- |
| `DATA_CHANGED` | `'gv:data-changed'` (same window event name as vanilla) |
| `emitDataChanged()` | `() => void` |
| `useDataChanged(handler)` | hook; calls the latest `handler()` on every emit; unsubscribes on unmount |

```jsx
useDataChanged(() => tableRef.current?.refresh());   // e.g. refresh a list when the topbar Create menu saved something
```

### 3.6 Tenant switching — `lib/tenant.js`

| Export | Signature | Behaviour |
| --- | --- | --- |
| `switchToClient(organizationId, name)` | `Promise<void>` | POST `/api/platform/switch { organizationId }`, toast "Now working inside {name}", full page load of `/`. Errors → `reportError`. |
| `exitClientContext()` | `Promise<void>` | POST `/api/platform/switch { organizationId: null }`, full page load of `/platform`. |

The full reload is deliberate (vanilla `loadSession()` + `reload()`): every
cache belongs to the tenant being left.

### 3.7 Branding — `lib/branding.js`

`applyBranding(branding)` — sets `--brand-500`, `--brand-600` (28% darker) and
`--on-brand` (WCAG-readable ink) on `<html>` from `branding.primary`; removes
them when `branding?.primary` is falsy. Called automatically by `AuthProvider`
on every session load and with `null` on sign-out. After saving branding in
Settings, call `useAuth().refresh()` (vanilla `loadSession()`), which re-applies it.

### 3.8 Theme — `context/ThemeContext.jsx`

`useTheme()` → `{ theme: 'light' | 'dark', setTheme(theme), toggle() }`.
Persists to `localStorage['gv.theme']`; default light (vanilla `getTheme()`).
Vanilla `getTheme()` → `theme`; `applyTheme(t)` → `setTheme(t)`;
`toggleTheme()` → `toggle()`.

---

## 4. API client and formatting (existing)

### `lib/api.js` (unchanged, identical contract to vanilla)

| Call | Resolves to |
| --- | --- |
| `api.get(path, query?, opts?)` | `{ data, meta }` |
| `api.data(path, query?, opts?)` | `data` |
| `api.post(path, body?, opts?)` / `api.patch` / `api.put` | `{ data, meta }` (or `null` on 204) |
| `api.del(path, opts?)` | `{ data, meta }` or `null` |
| `api.download(path, query?, filename?)` | triggers a browser download |
| `api.upload(path, formData)` | `{ data, meta }` |

`query` drops `''`/`null`/`undefined` and joins arrays with commas. `opts`:
`{ signal, headers, raw }`. Failures throw `ApiError { status, code, message,
details, fieldErrors }`. A 401 (except on sign-in) drops the session and the
router lands on `/login`.

### `lib/format.js` (identical to vanilla `format.js`)

`configureFormatting(org)`, `number(v)`, `money(v, { compact = false })`,
`currencySymbol()`, `compactNumber(v)`, `percent(v, digits = 1)`,
`date(v, opts)`, `dateTime(v)`, `time(v)`, `relative(v)`, `inputDate(v)`,
`inputDateTime(v)`, `duration(seconds)`, `initials(...parts)`,
`avatarColor(seed)`, `titleCase(v)`, `fileSize(bytes)`, `PRIORITY_TONE`,
`SCORE_TONE`, `TASK_TONE`.

### `lib/modules.js`

`MODULE_LABELS` (module key → label), `SCOPE_LABELS` (data scope → label),
`enumLabel(value)` (`CLOSED_WON` → `Closed won`).

---

## 5. Toasts and errors

From `components/ui/index.js` (implemented in `context/ToastContext.jsx`).
Markup: `.toasts > .toast.{type} > .grow > .t-title + .t-body` and a `.t-close` `×` button.

| Export | Signature | Notes |
| --- | --- | --- |
| `toast(title, { body = '', type = 'info', timeout = 4200 } = {})` | `=> id: number` | `type`: `'info' \| 'success' \| 'error' \| 'warning'`; `timeout: 0` = until dismissed. |
| `toast.success(title, body?)` | `=> id` | 4200 ms |
| `toast.error(title, body?)` | `=> id` | 6500 ms |
| `toast.warn(title, body?)` / `toast.warning(title, body?)` | `=> id` | 4200 ms |
| `toast.info(title, body?)` | `=> id` | 4200 ms |
| `reportError(err, fallback = 'Something went wrong')` | `=> void` | `AbortError` → silent. `ApiError` → `toast.error(err.message, details.map(d => d.message).join(' · '))`. Anything else → `toast.error(err.message \|\| fallback)` and `console.error(err)`. |
| `useToast()` | `=> toast` | Same object; asserts `<ToastProvider>`. |
| `useReportError()` | `=> reportError` | Same function; asserts `<ToastProvider>`. |

`toast` and `reportError` work from plain functions too (messages sent before
the provider mounts are queued).

```jsx
try { await api.patch(`/api/teams/${id}`, payload); toast.success('Team updated'); }
catch (err) { reportError(err); }
```

---

## 6. Overlays: Modal, Drawer, openOverlay, confirm

All overlays render into `<body>` via a portal, trap Tab focus, focus the
first `input, select, textarea, button` after 40 ms (same as vanilla), lock
body scroll (counted) and close on Escape — **only the top-most** overlay
closes per Escape.

### `Modal`

| Prop | Type | Default | |
| --- | --- | --- | --- |
| `open` | boolean | `true` | Renders nothing when false. |
| `title` | node | — | `h3` in `.modal-head`; a string title is also the `aria-label`. |
| `subtitle` | node | — | `.sub` under the title. |
| `footer` | node | — | `.modal-foot` (omitted when falsy). Vanilla passed `h('div', {class:'row'}, …buttons)`. |
| `size` | `'' \| 'wide' \| 'xwide'` | `''` | Extra class on `.modal`. |
| `onClose` | `() => void` | — | Close button, Escape, backdrop. **The parent must unmount/hide the modal here.** |
| `closeOnBackdrop` | boolean | `true` | `mousedown` on the backdrop closes. |
| `children` | node | — | `.modal-body` content. |

```jsx
{preview && (
  <Modal title="Preview" size="wide" onClose={() => setPreview(null)}
         footer={<div className="row"><button type="button" className="btn" onClick={() => setPreview(null)}>Close</button></div>}>
    <div className="code-block">{preview.body}</div>
  </Modal>
)}
```

### `Drawer`

| Prop | Type | Default | |
| --- | --- | --- | --- |
| `open` | boolean | `true` | |
| `title`, `subtitle` | node | — | Subtitle class `sub muted small`. |
| `footer` | node | — | `.drawer-foot` (omitted when falsy). |
| `wide` | boolean | `false` | `drawer wide` (760px). |
| `onClose` | `() => void` | — | Close button, Escape, click on `.drawer-overlay`. |
| `children` | node | — | `.drawer-body`. |

```jsx
<Drawer title={isEdit ? 'Edit team' : 'New team'} onClose={onClose}
        footer={<div className="row" style={{ gap: '8px' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <BusyButton className="btn btn-primary" onClick={save}>Save</BusyButton>
        </div>}>
  {error ? <Alert tone="danger" className="mb-16">{error}</Alert> : null}
  <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
</Drawer>
```

### `openOverlay(render)` / `useOverlay()` / `UIProvider`

- `openOverlay(render: (close: () => void) => ReactNode): close` — mounts
  `render(close)` at the app root (inside Router + Auth providers) until
  `close()` is called. Content keeps its own state; it does **not** re-render
  when the opener's state changes, and it survives the opener unmounting and
  route changes (vanilla body-mounted dialogs behaved the same). A render
  error inside it is reported with `reportError` and the overlay closed.
- `useOverlay()` — hook returning the same `open` function (asserts the provider).
- `UIProvider` — mounted once in `main.jsx`. Do not mount it again.

```jsx
openOverlay((close) => <PermissionsDrawer user={row} onClose={close} onSaved={refresh} />);
```

### Confirm

| Export | Signature |
| --- | --- |
| `confirmDialog(options)` | `=> Promise<boolean>` — usable anywhere (components or helpers) |
| `useConfirm()` | hook `=> confirmDialog` |
| `ConfirmDialog` | the component (`…options, onResolve(boolean)`), if you need to render it yourself |

`options` (all optional): `title = 'Are you sure?'`, `message = ''`,
`confirmLabel = 'Confirm'`, `cancelLabel = 'Cancel'`, `danger = false`
(`btn-danger` instead of `btn-primary`), `requireText = null` (confirm button
stays disabled until the user types this exact text into a
"Type “…” to confirm" field). Resolves `true` only for the confirm button;
Cancel, ×, Escape and the backdrop resolve `false`.

```jsx
const confirm = useConfirm();
const ok = await confirm({ title: `Suspend ${client.name}?`, message: 'Everyone at this company will be signed out…', confirmLabel: 'Suspend company', danger: true });
if (!ok) return;
```

---

## 7. Display blocks

| Component | Props (defaults) | Renders |
| --- | --- | --- |
| `Avatar` | `name`, `size = ''` (`'sm' \| 'lg' \| 'xl'`), `url = null` | `img.avatar` when `url`, else `div.avatar` with initials on `avatarColor(name)` and `title=name`. |
| `StatusBadge` | `name`, `color` (hex), `dot = true` | `span.badge.dot` tinted `${color}1f`; `span.badge` "—" when no name. |
| `EmptyState` | `iconName = 'search'`, `title`, `message`, `action` (node) | `div.empty > .e-icon + h3 + p? + action` |
| `SkeletonBlock` | `lines = 4` | `.card-body` with shrinking `.skeleton-line`s |
| `SkeletonTable` | `rows = 6`, `cols = 5` | `.card-body > table.data` of skeleton cells |
| `PageLoader` | `label = 'Loading'` | `div.page-loader > span.spinner.lg + span.muted` |
| `KpiCard` | `label`, `value` (node), `foot` (node), `accent = 'var(--brand-500)'`, `iconName`, `onClick` | `div.kpi` (`--accent` CSS var); with `onClick` it gets `.clickable`, `role=button`, `tabIndex=0`, Enter/Space activate. |
| `ProgressBar` | `value`, `max`, `tone = ''` (`'success' \| 'warning' \| 'danger'`) | `div.progress > div.p-fill` at `min(100, value/max*100)%` |
| `Spinner` | `large = false` | `span.spinner(.lg)` |
| `Alert` | `tone = 'info'` (`'info' \| 'success' \| 'warning' \| 'danger'`), `title`, `className`, `children` | `div.alert.{tone}` with icon. **Danger alerts scroll themselves into view** when shown or when their text/title changes (vanilla `mount()` behaviour). |

```jsx
<div className="kpi-grid mb-16">
  <KpiCard label="Interactions" value={number(total)} foot="Calls, emails, meetings and messages" accent={PALETTE[0]} />
  <KpiCard label="Open leads" value={number(open)} iconName="leads" onClick={() => navigate('/leads?converted=false')} />
</div>
<StatusBadge name={lead.status?.name} color={lead.status?.color} />
<Avatar name={`${u.firstName} ${u.lastName || ''}`} size="sm" url={u.avatarUrl} />
```

---

## 8. Form controls and busy buttons

### `Field`

Props: `label` (node; omitted when `null`/`undefined`), `required` (adds
`span.req-star " *"`), `error` (→ `div.err`), `hint` (→ `div.hint`, shown even
with an error, as vanilla), `htmlFor`, `className` (appended to `field`),
`children` (the control).

### `Input`, `Textarea`

Plain `<input className="input">` / `<textarea className="textarea">`. Every
prop passes through; `className` is appended; `ref` reaches the element.

### `Select`

| Prop | |
| --- | --- |
| `options` | array of plain values **or** `{ value, label }` (default `[]`) |
| `placeholder` | adds a first `<option value="">placeholder</option>` |
| `className` | appended to `select` |
| `value` / `defaultValue` / `onChange(event)` / anything else | passed through. A controlled `value` of `null`/`undefined` is rendered as `''`. |

`onChange` receives the DOM event (read `e.target.value`, a string), as in vanilla.

### `SwitchToggle`

Props: `label`, `checked` (controlled), `defaultChecked` (uncontrolled; used
when `checked` is `undefined`), `onChange(checked: boolean, event)`,
`disabled`, `name`. Markup `label.switch > input[checkbox] + span.track + span.small`.

```jsx
<Field label="Status" hint="Leads in a closed status stop counting as open.">
  <Select options={STATUSES} placeholder="Choose…" value={form.status} onChange={(e) => set('status', e.target.value)} />
</Field>
<SwitchToggle label="Active" checked={rule.isActive} onChange={(on) => toggleRule(rule, on)} />
```

### `BusyButton` / `useBusy`

Port of vanilla `busy(button, fn)`.

- `BusyButton` props: `onClick(event)` (async), `className = 'btn'`,
  `type = 'button'`, `disabled = false`, `children`, any other button prop.
  While `onClick`'s promise is pending: disabled, class `loading` added,
  `<span className="spinner" /> {children}` shown; further clicks ignored.
  It does **not** catch — handle errors inside `onClick`.
- `useBusy()` → `[busy: boolean, run(fn, ...args) => Promise]`; `run` skips
  (returns `undefined`) while a previous call is pending.

```jsx
const [saving, run] = useBusy();
<button type="button" className="btn btn-primary" disabled={saving} onClick={() => run(save)}>{saving ? 'Saving…' : 'Save'}</button>
```

---

## 9. Menus, tabs, pagination

### `Dropdown`

| Prop | | |
| --- | --- | --- |
| `trigger` | element | The clickable element (a `<button>` normally). Wrapped in `div.dropdown`; a click toggles the menu and does **not** propagate (so it never triggers a row click). |
| `align` | `'right' \| 'left'` | `'right'` — menu's right edge on the trigger's right edge; `'left'` aligns left edges (`dropdown-menu left`). |
| `children` | node or `(close) => node` | Menu content. |

The menu (`div.dropdown-menu`) is portalled to `<body>`, positioned with the
vanilla `place()` logic (flips above the trigger, clamps to the viewport,
caps height), and closes on outside mousedown, Escape (Escape closes only the
menu, not an enclosing modal), route change, or when the trigger disappears.

### `MenuItem`

Props: `iconName` (15px icon), `onClick`, `danger = false` (`dropdown-item
danger`), `disabled`, `close` (override), `children` (label). Clicking closes
the enclosing Dropdown automatically, then calls `onClick`.

`MenuSeparator` → `div.dropdown-sep`. `MenuTitle` (`children`) →
`div.dropdown-title`. `useDropdownClose()` → the enclosing menu's `close`
(or `null`), for custom menu content.

```jsx
<Dropdown trigger={<button type="button" className="icon-btn" aria-label="Actions"><Icon name="more" size={16} /></button>}>
  <MenuItem iconName="edit" onClick={() => openEdit(row)}>Edit</MenuItem>
  <MenuSeparator />
  <MenuItem iconName="trash" danger onClick={() => remove(row)}>Delete</MenuItem>
</Dropdown>
```

### `Tabs`

Props: `items: [{ key, label, count? }]` (a `count` that is not `undefined`
renders a `number(count)` badge), `active` (key), `onSelect(key)`.

```jsx
<Tabs items={[{ key: 'overview', label: 'Overview' }, { key: 'leads', label: 'Leads', count: meta.total }]} active={tab} onSelect={setTab} />
```

### `Pagination`

Props: `meta` (`{ page, totalPages, total, limit }` from the API), `onPage(page)`.
Renders `div.pagination` with "from–to of total" and a windowed page list
(‹ 1 … p-1 p p+1 … N ›). Renders an empty `<div/>` without `meta`.

---

## 10. DataTable and SearchBox

### `DataTable` (default import name from the barrel: `DataTable`)

Server-side table: owns paging, sorting, selection and its fetch loop.

| Prop | Type | Default | |
| --- | --- | --- | --- |
| `columns` | `Column[]` | required | See below. |
| `load` | `(params) => Promise<{ data, meta }>` | required | Called with `{ page, limit, sort, dir, ...filters }` (`sort` omitted when none). Typically `(p) => api.get('/api/users', p)`. The latest function is always used; changing its identity does not refetch. |
| `rowKey` | `(row) => key` | `(r) => r.id` | |
| `onRowClick` | `(row) => void` | — | Rows get `.clickable`. Ignored when the click is on/inside `input, button, a, .dropdown`, or comes from a portal (menus/modals opened from a cell). |
| `selectable` | boolean | `false` | Checkbox column + "select all on this page". Selection survives paging. |
| `bulkActions` | `(selectedKeys[], { refresh, clear }) => node` | `null` | Rendered in `.bulk-bar` after "N selected" and "Clear". |
| `toolbar` | node | `null` | Rendered above the table; wrapped in `div.toolbar` unless the element's own `className` already contains `toolbar`. |
| `emptyTitle` | string | `'Nothing here yet'` | |
| `emptyMessage` | string | `''` | |
| `emptyAction` | node | `null` | |
| `defaultSort` | string \| null | `null` | Initial `sort`. |
| `defaultDir` | `'asc' \| 'desc'` | `'desc'` | |
| `pageSize` | number | `25` | `limit`. |
| `initialParams` | object | `{}` | Initial filters. |
| `params` | object | — | **Declarative filters.** Whenever their *content* changes the table replaces its filters with `{ ...initialParams, ...params }` (empty values dropped) and reloads from page 1. |
| `ref` | — | — | Imperative handle, below. |

`Column`: `{ label, render: (row) => node, key?, sortKey?, cellClass?, width? }`.
`sortKey` makes the header clickable (first click `desc`, then toggles;
resets to page 1; shows ▲/▼). `cellClass` goes on both `th` and `td` (e.g.
`'hide-sm'`). Each `td` gets `data-label={label}` for the stacked mobile layout.

Ref handle (vanilla's returned object): `refresh()`, `setParams(patch, {
resetPage = true } = {})` (merges; `''`/`null`/`undefined` delete a key;
always refetches), `getParams()`, `getSelected()`, `clearSelection()`,
`getMeta()`.

States: loading → `SkeletonTable(6, columns + checkbox)`; error →
`EmptyState` "Could not load this list" with the error message and a
"Try again" button; no rows → `EmptyState(emptyTitle, emptyMessage, emptyAction)`.
Pager: `Pagination` when `meta.totalPages > 1`, else "N record(s)".

Use **either** `params` **or** `ref.setParams` for a given table.

```jsx
const [query, setQuery] = useQueryParams();
const filters = { q: query.q || '', roleId: query.roleId || '' };

<DataTable
  columns={[
    { label: 'Name', sortKey: 'name', render: (u) => <div className="cell-main">{u.fullName}</div> },
    { label: 'Role', cellClass: 'hide-sm', render: (u) => u.role?.name || '—' },
    { label: '', width: '48px', render: (u) => <RowMenu user={u} /> },
  ]}
  load={(p) => api.get('/api/users', p)}
  params={filters}
  defaultSort="name"
  onRowClick={(u) => navigate(`/users/${u.id}`)}
  toolbar={<>
    <SearchBox placeholder="Search people…" value={filters.q} onSearch={(q) => setQuery({ q })} />
    <Select options={roles} placeholder="All roles" value={filters.roleId} onChange={(e) => setQuery({ roleId: e.target.value })} />
  </>}
  emptyTitle="No users match"
/>
```

Imperative style (closest to vanilla):

```jsx
const tableRef = useRef(null);
<DataTable ref={tableRef} columns={cols} load={(p) => api.get('/api/clients', p)} initialParams={{ status: query.status || '' }} />
<button type="button" onClick={() => tableRef.current.refresh()}>…</button>
tableRef.current.setParams({ status: e.target.value });
```

### `SearchBox`

Props: `placeholder`, `onSearch(term)` (trimmed; fires `delay` ms after the
last keystroke), `value = ''` (the currently applied term — seeds the box and
re-seeds it whenever it changes from outside, e.g. "Clear"), `delay = 320`.
Markup `div.search-input > svg + input.input[type=search]`.

---

## 11. Clipboard

`copyToClipboard(text, label = 'Copied to clipboard')` — writes to the
clipboard, then `toast.success(label)`; on failure
`toast.error('Could not copy', 'Your browser blocked clipboard access.')`.

```jsx
<button type="button" className="btn" onClick={() => copyToClipboard(key.secret, 'API key copied')}>Copy</button>
```

---

## 12. Icons

`components/Icon.jsx`

- `default Icon({ name, size = 18, className = 'ico', strokeWidth = 2, ...svgProps })`
  — an unknown `name` draws `info` (vanilla behaviour). Vanilla
  `icon(name, { size, cls })` → `<Icon name={name} size={size} className={cls} />`.
- `ACTIVITY_ICONS` — `{ CALL: 'phone', EMAIL: 'mail', MEETING: 'calendar', SMS: 'message', WHATSAPP: 'message', NOTE: 'edit', TASK: 'tasks', STATUS_CHANGE: 'refresh', ASSIGNMENT: 'user', CONVERSION: 'star', SYSTEM: 'info', SCORE_CHANGE: 'trending', DOCUMENT: 'file', IMPORT: 'import', FORM: 'forms' }`.
- `iconNames` — array of every name.

Names (all of vanilla `icons.js` plus `monitor`): `dashboard leads contacts
accounts pipeline tasks calendar campaign reports forms users teams shield
settings automation audit integrations key webhook import export search bell
plus close check chevronDown chevronRight chevronLeft arrowUp arrowDown
arrowRight phone mail message clock edit trash filter refresh more menu sun
moon logout user building target file merge copy link eye alert info play grid
list trending star save upload download briefcase activity monitor`.

```jsx
<Icon name={ACTIVITY_ICONS[a.type] || 'activity'} size={15} />
```

---

## 13. Charts

`components/charts.jsx` — SVG ports of `charts.js`; options became props with
the same names and defaults.

| Export | Props (defaults) | Data shape |
| --- | --- | --- |
| `PALETTE` | — | 12 hex colours (brand green first). |
| `LineChart` | `series`, `labels`, `height = 240`, `area = true`, `formatValue = number` | `series: [{ key, label, color?, values: number[] }]`, `labels: string[]` (same length). Hover tooltip `"label · Series value · …"`; legend below. |
| `BarList` | `rows`, `formatValue = number`, `colorFn = null` (`(row, i) => colour`), `max = null` | `rows: [{ label, value, color?, key? }]`; bar width `max(2%, value/max)`. |
| `DonutChart` | `slices`, `size = 190`, `thickness = 26`, `centerLabel` (default text `'Total'`), `centerValue` (default `number(total)`) | `slices: [{ label, value, color? }]`; zero slices are skipped; legend at the side. |
| `FunnelChart` | `steps` | `steps: [{ label, value }]`; widths relative to the first step; drop-off % in the title. |
| `Sparkline` | `values`, `width = 96`, `height = 26`, `color = 'var(--brand-500)'` | `number[]`; renders `<span/>` when empty. |
| `ScoreRing` | `score` (0–100), `size = 68`, `color = 'var(--brand-600)'` | |
| `ColumnChart` | `groups`, `seriesDefs`, `height = 250`, `formatValue = compactNumber` | `groups: [{ label, [seriesKey]: number }]`, `seriesDefs: [{ key, label, color? }]` (vanilla 2nd argument). |

```jsx
<Panel title="Leads over time">
  <LineChart series={[{ key: 'created', label: 'New leads', values: trend.map((t) => t.count) }]} labels={trend.map((t) => date(t.day, { year: undefined }))} />
</Panel>
<ColumnChart groups={rows} seriesDefs={[{ key: 'target', label: 'Target', color: PALETTE[2] }, { key: 'actual', label: 'Actual' }]} formatValue={(v) => money(v, { compact: true })} />
```

Only difference from vanilla: a donut slice's default colour is taken from its
index in `slices` for both the arc and the legend (vanilla re-indexed the
legend after dropping empty slices, mismatching colours).

---

## 14. Shared page pieces (`shared.jsx`)

`components/shared.jsx` — port of `views/shared.js`.

| Export | Props / value | Notes |
| --- | --- | --- |
| `PageHead` | `title`, `subtitle`, `breadcrumbs` (`[{ label, path? }]`), `actions` (node or array of nodes; give array items keys) | `div.page-head`; crumbs with `path` are `<Link>`s separated by `span.sep "/"`; actions in `div.row.wrap` (gap 8). |
| `DATE_RANGES` | `[{ value, label }]` | `'' (All time), today, yesterday, last_7_days, last_30_days, last_90_days, this_month, last_month, this_quarter, this_year` |
| `RangeSelect` | `value`, `onChange(value: string)` | `Select` over `DATE_RANGES`, `aria-label="Date range"`. |
| `FilterBar` | `filters: string[]`, `current = {}`, `onChange(patch)` | Returns a **fragment** of controls (put it inside your `.toolbar`). Filter names → keys: `range`→`range`, `status`→`statusId`, `source`→`sourceId`, `project`→`projectId`, `owner`→`ownerId`, `team`→`teamId`, `priority`→`priority`, `scoreBand`→`scoreBand`. A picker is omitted when its reference list is empty; reference-backed pickers appear once `useReference()` has loaded. A "Clear" button appears when any key of `current` other than `page, limit, sort, dir, view` is truthy, and sends every key of `current` as `''`. |
| `OwnerCell` | `owner` (`{ firstName, lastName, avatarUrl }` \| null) | "Unassigned" badge or small avatar + name. |
| `ScoreCell` | `score`, `band` (`COLD/WARM/HOT/VERY_HOT`) | |
| `PriorityBadge` | `priority` | `PRIORITY_TONE` class, title-cased; default "Medium". |
| `LeadNameCell` | `lead` | `.cell-main` name + `.cell-sub` "company · code". |
| `TagList` | `tags` (`[{ id?, name, color }]`) | Up to 3 badges + `+N`; "—" when empty. |
| `StatusBadge` | re-export of the UI kit's `StatusBadge` | |
| `LinkTo` | `to`, `className = ''`, `children` | `<Link>`; vanilla `linkTo(path, label, { className })`. |
| `NoAccess` | `what = 'this section'` | The "No access" card. |
| `Panel` | `title`, `subtitle`, `action` (node), `flush = false`, `children` | `section.card` + optional `.card-head` + `.card-body(.flush)`. |

```jsx
<div className="toolbar">
  <SearchBox placeholder="Search name, email, phone, company…" value={query.q || ''} onSearch={(q) => setQuery({ q })} />
  <FilterBar filters={['range', 'project', 'status', 'source', 'owner', 'team', 'priority', 'scoreBand']} current={filters} onChange={(patch) => setQuery(patch)} />
</div>
```

---

## 15. Query parameters (`query` / `onQuery`)

Vanilla views received `query` (parsed from the hash) and could return
`onQuery(query)`, which the router called instead of re-rendering when only
the query changed. In React:

- The page is **not remounted** when only the query string changes (§16).
- Derive state from the URL on every render, and let effects that depend on
  those values re-run. That replaces `onQuery`.
- Write the URL with `replace: true` for filter changes (vanilla used
  `history.replaceState`).

### `useQueryParams()` — `lib/query.js`

`const [query, setQuery] = useQueryParams();`

- `query`: plain object `{ [key]: string }` of the current URL query; a new
  object only when the URL's query changes (safe as an effect dependency, or
  use individual keys).
- `setQuery(patch, { replace = true, merge = true } = {})`: merges `patch`
  into the current query (`merge: false` replaces it), drops keys whose value
  is `''`, `null`, `undefined` or `false`, and navigates (replace by default).

```jsx
const [query, setQuery] = useQueryParams();
const view = query.view === 'board' ? 'board' : 'list';
const { view: _v, page: _p, ...filters } = query;          // vanilla stripControlKeys()
useEffect(() => { loadSummary(query.range || 'last_30_days'); }, [query.range]);
<button className={view === 'list' ? 'active' : ''} onClick={() => setQuery({ view: '' })}>List</button>
```

Raw react-router equivalent, if preferred:

```jsx
const [searchParams, setSearchParams] = useSearchParams();
const q = searchParams.get('q') || '';
setSearchParams((prev) => { const n = new URLSearchParams(prev); n.set('q', value); return n; }, { replace: true });
```

To link to a filtered list: `navigate('/leads?statusId=3&range=this_month')`.

---

## 16. Routing, page lifecycle and errors

`App.jsx` holds the route table (paths = vanilla hash routes without `#`):

`/` Dashboard · `/leads` Leads · `/leads/:id` LeadDetail · `/projects` Projects
· `/projects/:id` ProjectDetail · `/communication` Communication · `/platform`
PlatformDashboard · `/clients` Clients · `/clients/:id` ClientDetail · `/forms`
Forms · `/reports` Reports · `/performance` Performance · `/activities`
Activities · `/notifications` Notifications · `/users` Users · `/teams` Teams ·
`/roles` Roles · `/automation` Automation · `/imports` Imports · `/settings`
Settings · `/developers` Developers · `/integrations` Integrations · `/audit`
Audit · `/profile` Profile · `/security` Security · `/sessions` Sessions · `*`
NotFound. Auth pages: `/login`, `/register`, `/forgot-password`,
`/reset-password`, `/accept-invite`, `/verify-email`; `/index.html` → `/`,
`/login.html` → `/login`.

Each shell page is `React.lazy(() => import('./pages/X.jsx'))` (default
export) inside `RouteView`:

- `Suspense` fallback: `<PageLoader />` while the chunk downloads.
- `ErrorBoundary` → `RouteError` (vanilla `renderRouteError`): a card with
  "This page could not be loaded", the error message and a Reload button;
  the error is logged as `[router] failed to render <path>`.
- Keyed by `pathname`: a new path (including `/leads/1` → `/leads/2`)
  remounts the page; a query-only change does not.
- The shell scrolls to top and closes the mobile nav on pathname change.

`ErrorBoundary` (default export of `components/ErrorBoundary.jsx`) is
reusable: props `fallback` (node or `(error) => node`), `onError(error)`,
`children`. `RouteError` takes `{ error }`.

---

## 17. Forms the shell opens (contract for page authors)

The topbar **Create** menu opens these forms lazily via `openOverlay`. The
named exports must exist exactly as written, because `QuickCreateMenu.jsx`
imports them:

| Module | Export | Props | Vanilla source |
| --- | --- | --- | --- |
| `pages/LeadForm.jsx` | **default** `LeadForm` | `{ lead = null, onSaved(savedLead), onClose() }` | `views/leadForm.js openLeadForm({ lead, onSaved })` |
| `pages/Projects.jsx` | named `ProjectForm` | `{ project = null, onSaved(savedProject), onClose() }` | `views/projects.js openProjectForm` |
| `pages/Users.jsx` | named `UserForm` | `{ user = null, onSaved(savedUser), onClose() }` | `views/users.js openUserForm` (vanilla never exported it, so its "New user" menu item failed; this contract fixes that) |
| `pages/Clients.jsx` | named `ClientWizard` | `{ onSaved(client), onClose() }` | `views/clients.js openClientWizard` |

Rules for these components:

- Render a `<Drawer onClose={onClose} …>` (wide where vanilla used `wide: true`).
- Call `onClose()` to close — including after a successful save (vanilla
  `ref_.close()`), then `onSaved(saved)`.
- Keep the vanilla side effects inside the form: toasts, `LeadForm` calling
  `emitDataChanged()` after save, `UserForm` showing the invite-link modal
  **via `openOverlay`** (the form itself is closing).
- Async preloading (vanilla `openLeadForm` awaited reference data and custom
  fields before opening) happens inside the component; show `<PageLoader />`
  in the drawer body until ready.
- Pages reuse the same components: Leads/LeadDetail import `LeadForm`,
  ProjectDetail imports `ProjectForm` from `./Projects.jsx`, PlatformDashboard
  imports `ClientWizard` from `./Clients.jsx`.

The shell passes: lead/project/user `onSaved = emitDataChanged`; client
`onSaved = () => navigate('/clients')`.

---

## 18. The shell (what it already does for you)

`components/AppShell.jsx` + `components/shell/*` port everything `app.js` did
outside the views. Pages must not reimplement any of it:

- Sidebar: tenant brand lockup (tenant logo with fallback to the Growvanta
  mark, else GROW**VANTA**), nav groups from `shell/nav.js` with the vanilla
  `show()` rules (Platform section only `onPlatform()`; Performance =
  reports or targets read; Teams = teams or users read; WhatsApp & Email =
  whatsapp or email read; Developers = apikeys or webhooks read; …), longest-
  prefix active highlight, user card menu (org name, My profile, theme
  toggle, Sign out).
- Topbar: mobile nav toggle, desktop collapse (persisted in
  `localStorage['gv.sidebar']`), search trigger (⌘K / Ctrl K, or `/` outside
  inputs) opening the command palette (pages + `/api/search` results),
  tenant switcher for platform admins (warning-coloured "Inside: X" plus
  "Exit to platform" while impersonating), Create menu (§17), notification
  bell with unread badge (99+) and panel (latest 12, mark all read, view
  all), theme toggle.
- Boot: warms reference data, polls unread every 60 s and on
  `emitDataChanged()`, lands a platform admin opening `/` on `/platform`, and
  a role without dashboard access but with leads access on `/leads`.
- Branding (`applyBranding`) and formatting are applied by `AuthProvider`.

The PHP edition's shell had no billing or email-verification banners; the
only "banner" is the coloured impersonation switcher above, which is ported.

---

## 19. Vanilla → React cheat sheet

| Vanilla | React |
| --- | --- |
| `export default async function render({ params, query })` | `export default function X()` + `useParams()` + `useQueryParams()` |
| `return { node, onQuery }` | return JSX; query-driven effects (§15) |
| `return { node, destroy }` | `useEffect(() => () => cleanup, [])` |
| `h('div', { class: 'card' }, …)` | `<div className="card">…</div>` |
| `mount(host, …)` / `clear(host)` | state + conditional JSX |
| `navigate(path, { replace })` (router.js) | `useNavigate()(path, { replace })` |
| `reload()` (router.js) | call your page's `load()` again |
| `parseHash()` | `useLocation()` / `useQueryParams()` |
| `store.user / organization / teams / scope / platform` | `useAuth().user / …` (or `getSession()` outside React) |
| `can / canAny / canRead / isSuperAdmin / scopeRank` | `useAuth().can …` (or `lib/session.js`) |
| `isPlatformAdmin()` (clients.js) | `useAuth().isPlatformAdmin()` |
| `loadSession()` | `await useAuth().refresh()` |
| `reference()` | `useReference()` or `await loadReference()` |
| `refreshReference()`, `statusById(id)` | same names, `lib/reference.js` |
| `setUnreadCount(n)` | `setUnreadCount(n)` (`lib/unread.js`) |
| `window.dispatchEvent(new CustomEvent('gv:data-changed'))` | `emitDataChanged()` |
| `getTheme() / applyTheme(t) / toggleTheme()` | `useTheme().theme / setTheme(t) / toggle()` |
| `switchToClient(id, name)`, `exitClientContext()` | same names, `lib/tenant.js` |
| `toast(…)`, `toast.success/error/warn`, `reportError(err)` | same names from the UI barrel |
| `modal({ title, subtitle, body, footer, size, onClose, closeOnBackdrop })` | `<Modal …>{body}</Modal>` (or inside `openOverlay`) |
| `drawer({ title, subtitle, body, footer, wide, onClose })` | `<Drawer …>{body}</Drawer>` |
| `ref.close()` | the `onClose`/`close` you were given |
| `await confirmDialog({...})` | `await confirm({...})` (`useConfirm()`) or `confirmDialog({...})` |
| `avatar(name, { size, url })` | `<Avatar name size url />` |
| `statusBadge(name, color, { dot })` | `<StatusBadge name color dot />` |
| `emptyState({ iconName, title, message, action })` | `<EmptyState … />` |
| `skeletonBlock(n)`, `skeletonTable(r, c)` | `<SkeletonBlock lines={n} />`, `<SkeletonTable rows={r} cols={c} />` |
| `pageLoader(label)` | `<PageLoader label={label} />` |
| `kpiCard({...})` | `<KpiCard … />` |
| `progressBar(value, max, tone)` | `<ProgressBar value max tone />` |
| `field(label, control, { hint, required, error })` | `<Field label hint required error>{control}</Field>` |
| `input(props)`, `textarea(props)` | `<Input …/>`, `<Textarea …/>` |
| `select(options, { value, placeholder, onChange })` | `<Select options value placeholder onChange />` |
| `switchToggle(label, checked, onChange)` | `<SwitchToggle label checked onChange />` |
| `dropdown(trigger, (close) => menu, { align })` | `<Dropdown trigger align>{(close) => menu}</Dropdown>` |
| `menuItem(label, { iconName, onClick, danger, close })` | `<MenuItem iconName onClick danger>{label}</MenuItem>` |
| `h('div', { class: 'dropdown-sep' })`, `h('div', { class: 'dropdown-title' }, t)` | `<MenuSeparator />`, `<MenuTitle>{t}</MenuTitle>` |
| `tabs(items, active, onSelect)` | `<Tabs items active onSelect />` |
| `pagination(meta, onPage)` | `<Pagination meta onPage />` |
| `dataTable({...})` → `table.refresh()/setParams()` | `<DataTable ref={tableRef} …/>` → `tableRef.current.refresh()/setParams()` |
| `searchBox(placeholder, onSearch, { value })` | `<SearchBox placeholder onSearch value />` |
| `copyToClipboard(text, label)` | same |
| `busy(button, fn)` | `<BusyButton onClick={fn}>` or `useBusy()` |
| `icon(name, { size, cls })` | `<Icon name size className />` |
| `lineChart(series, labels, opts)` etc. | `<LineChart series labels {...opts} />` etc. (§13) |
| `pageHead / rangeSelect / filterBar / ownerCell / scoreCell / priorityBadge / leadNameCell / tagList / linkTo / noAccess / panel` | `PageHead / RangeSelect / FilterBar / OwnerCell / ScoreCell / PriorityBadge / LeadNameCell / TagList / LinkTo / NoAccess / Panel` (§14) |
| `await filterBar(filters, current, onChange)` (array of nodes) | `<FilterBar filters current onChange />` (fragment) |
| `openLeadForm / openProjectForm / openUserForm / openClientWizard` | `LeadForm / ProjectForm / UserForm / ClientWizard` components (§17) |
