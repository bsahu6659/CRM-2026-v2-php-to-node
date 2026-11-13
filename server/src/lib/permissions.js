/**
 * Permission catalogue — the single source of truth for what a role may be
 * granted. The React client renders the Roles screen straight from
 * /api/roles/catalogue, so this list is also the UI's vocabulary.
 */

import { dbAll } from './db.js';
import { safeJson } from './util.js';

export const MODULES = [
  { key: 'dashboard', label: 'Dashboard', group: 'CRM', actions: ['read'] },
  // Leads carry the finest-grained action list in the product because real
  // estate teams police attribution: who may move a lead between projects or
  // rewrite its source decides whose numbers a campaign report credits.
  // `assign` places an unowned lead; `reassign` takes one off somebody.
  {
    key: 'leads', label: 'Leads', group: 'CRM',
    actions: [
      'read', 'create', 'update', 'delete', 'export', 'assign', 'reassign',
      'import', 'merge', 'change_status', 'change_project', 'change_source',
    ],
  },
  { key: 'projects', label: 'Projects', group: 'Real Estate', actions: ['read', 'create', 'update', 'delete', 'manage', 'export'] },
  { key: 'activities', label: 'Activities', group: 'CRM', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'documents', label: 'Documents', group: 'CRM', actions: ['read', 'create', 'delete'] },
  { key: 'forms', label: 'Web Forms', group: 'Marketing', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'reports', label: 'Reports & Analytics', group: 'Insights', actions: ['read', 'export'] },
  { key: 'targets', label: 'Targets & Performance', group: 'Insights', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'imports', label: 'Import / Export', group: 'Data', actions: ['read', 'create', 'export'] },
  { key: 'users', label: 'Users', group: 'Administration', actions: ['read', 'create', 'update', 'delete', 'manage'] },
  { key: 'teams', label: 'Teams', group: 'Administration', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'roles', label: 'Roles & Permissions', group: 'Administration', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'settings', label: 'Organisation Settings', group: 'Administration', actions: ['read', 'update'] },
  { key: 'automation', label: 'Automation & Rules', group: 'Administration', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'integrations', label: 'Integrations', group: 'Administration', actions: ['read', 'update'] },
  { key: 'apikeys', label: 'API Keys', group: 'Administration', actions: ['read', 'create', 'delete'] },
  { key: 'webhooks', label: 'Webhooks', group: 'Administration', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'audit', label: 'Audit Logs', group: 'Administration', actions: ['read', 'export'] },
  { key: 'templates', label: 'Message Templates', group: 'Communication', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'whatsapp', label: 'WhatsApp', group: 'Communication', actions: ['read', 'update', 'test'] },
  { key: 'email', label: 'Email', group: 'Communication', actions: ['read', 'update', 'test'] },
  // Platform modules only ever resolve true for a platform admin; a tenant
  // role that somehow carried them would still be stopped by
  // requirePlatformAdmin() on every platform route.
  { key: 'clients', label: 'Client Companies', group: 'Platform', actions: ['read', 'create', 'update', 'delete', 'impersonate'] },
  { key: 'global_projects', label: 'Global Project Master', group: 'Platform', actions: ['read', 'create', 'update', 'delete', 'manage'] },
];

export const DATA_SCOPES = [
  { key: 'OWN', label: 'Own records only', rank: 1 },
  { key: 'TEAM', label: 'Own + direct team', rank: 2 },
  { key: 'TEAM_AND_BELOW', label: 'Own team and all teams below', rank: 3 },
  { key: 'REGION', label: 'Entire region', rank: 4 },
  { key: 'ORGANIZATION', label: 'Entire organisation', rank: 5 },
  { key: 'ALL', label: 'All organisations (platform owner)', rank: 6 },
];

const MODULE_MAP = Object.fromEntries(MODULES.map((m) => [m.key, m]));
const SCOPE_RANK = Object.fromEntries(DATA_SCOPES.map((s) => [s.key, s.rank]));

export function moduleMap() {
  return MODULE_MAP;
}

export function scopeRank() {
  return SCOPE_RANK;
}

/** Strips anything not in the catalogue so a crafted payload cannot invent a grant. */
export function sanitizePermissions(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [moduleKey, actions] of Object.entries(input)) {
    const mod = MODULE_MAP[moduleKey];
    if (!mod || !Array.isArray(actions)) continue;
    const clean = [...new Set(actions.filter((a) => mod.actions.includes(a)))];
    if (clean.length) out[moduleKey] = clean;
  }
  return out;
}

/** Modules that only ever belong to the platform organisation. */
export const PLATFORM_MODULES = ['clients', 'global_projects'];

/**
 * Every grantable permission.
 *
 * Platform modules are excluded by default so a tenant's own Admin role does
 * not claim `clients:create` in the Roles screen. The platform routes would
 * refuse them anyway — requirePlatformAdmin() is the real gate — but a
 * permission list that advertises access nobody has is a lie the UI repeats.
 */
export function allPermissions(includePlatform = false) {
  const out = {};
  for (const m of MODULES) {
    if (!includePlatform && PLATFORM_MODULES.includes(m.key)) continue;
    out[m.key] = [...m.actions];
  }
  return out;
}

export function grantPermissions(moduleKeys, actions) {
  const out = {};
  for (const key of moduleKeys) {
    const mod = MODULE_MAP[key];
    if (!mod) continue;
    out[key] = actions.filter((a) => mod.actions.includes(a));
  }
  return out;
}

export function isValidScope(scope) {
  return Object.prototype.hasOwnProperty.call(SCOPE_RANK, String(scope));
}

// ---------------------------------------------------------------------------
// Effective permissions = role grant + per-user overrides
//
// A Sales Executive whose role forbids reassignment can still be handed that
// one power individually. Both directions (GRANT and REVOKE) are stored, so
// the override table is also the answer to "why can this person do that?".
// ---------------------------------------------------------------------------

/** Loads a user's special permission rows, dropping any that have expired. */
export async function userPermissionOverrides(userId) {
  const rows = await dbAll(
    `SELECT module, action, effect, data_scope, reason, expires_at
       FROM user_permissions
      WHERE user_id = ? AND (expires_at IS NULL OR expires_at > NOW())`,
    [userId]
  );
  const out = {};
  for (const r of rows) out[`${r.module}:${r.action}`] = r;
  return out;
}

/**
 * Folds role permissions and user overrides into the set actually enforced.
 *
 * Returns:
 *   permissions - module => [actions]   (what requirePermission() checks)
 *   inherited   - module => [actions]   (from the role alone)
 *   special     - list of applied overrides, for the "effective permission" UI
 *   scopes      - module => action => data scope key
 */
export function effectivePermissions(rolePermissions, roleScope, scopeOverrides, overrides) {
  const inherited = sanitizePermissions(safeJson(rolePermissions, {}));
  const permissions = Object.fromEntries(Object.entries(inherited).map(([k, v]) => [k, [...v]]));
  const special = [];

  for (const [key, row] of Object.entries(overrides ?? {})) {
    const idx = key.indexOf(':');
    const module = key.slice(0, idx);
    const action = key.slice(idx + 1);
    // An override naming a module or action outside the catalogue is inert:
    // the catalogue, not the database, decides what is grantable.
    const mod = MODULE_MAP[module];
    if (!mod || !mod.actions.includes(action)) continue;

    const current = permissions[module] ?? [];
    if (row.effect === 'REVOKE') {
      const next = current.filter((a) => a !== action);
      if (next.length) permissions[module] = next;
      else delete permissions[module];
    } else {
      if (!current.includes(action)) current.push(action);
      permissions[module] = current;
    }
    special.push({
      module,
      action,
      effect: row.effect,
      dataScope: row.data_scope,
      reason: row.reason,
      expiresAt: row.expires_at,
    });
  }

  // Scope resolution, narrowest source first: a user override beats a role
  // override, which beats the role's own blanket data scope.
  const roleScopeMap = safeJson(scopeOverrides, {}) ?? {};
  const scopes = {};
  for (const [module, actions] of Object.entries(permissions)) {
    for (const action of actions) {
      const fromUser = overrides?.[`${module}:${action}`]?.data_scope ?? null;
      const fromRole = roleScopeMap?.[module]?.[action] ?? null;
      const chosen = fromUser || fromRole || roleScope;
      scopes[module] ??= {};
      scopes[module][action] = isValidScope(chosen) ? chosen : roleScope;
    }
  }

  return { permissions, inherited, special, scopes };
}
