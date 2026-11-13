/**
 * Session auth.
 *
 * Sessions are opaque random tokens in an httpOnly cookie, hashed and looked
 * up against the `sessions` table on every request — not JWTs. Revoking a
 * session (logout, "sign out everywhere", deactivation, a company being
 * blocked) therefore takes effect immediately, because the lookup is the
 * source of truth rather than a signature that stays valid until it expires.
 */

import config from '../config/index.js';
import { dbExec, dbOne } from './db.js';
import { forbidden, unauthenticated } from './errors.js';
import { effectivePermissions, userPermissionOverrides } from './permissions.js';
import { orgAccessDenial, orgBranding } from './tenancy.js';
import { gvId, gvBool, safeJson, toSqlDateTime } from './util.js';
import { randomToken, sha256 } from './security.js';

export function readToken(req) {
  const header = req.get('authorization') ?? '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return req.cookies?.[config.auth.cookieName] ?? null;
}

export function clientIp(req) {
  const fwd = req.get('x-forwarded-for');
  if (fwd) return String(fwd).split(',')[0].trim().slice(0, 60);
  return (req.ip ?? req.socket?.remoteAddress ?? '').slice(0, 60) || null;
}

export function userAgent(req) {
  const ua = req.get('user-agent');
  return ua ? String(ua).slice(0, 250) : null;
}

/**
 * Resolves the session actor, or null. A token alone is not enough: the
 * session row must exist, be unrevoked and unexpired, and belong to an active
 * user in an organisation that is allowed to sign in.
 */
export async function loadActor(req) {
  const token = readToken(req);
  if (!token) return null;

  const session = await dbOne('SELECT * FROM sessions WHERE token_hash = ?', [sha256(token)]);
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) return null;

  const user = await dbOne('SELECT * FROM users WHERE id = ?', [session.user_id]);
  if (!user || !gvBool(user.is_active)) return null;

  const org = await dbOne('SELECT * FROM organizations WHERE id = ?', [user.organization_id]);
  // Blocking access has to end sessions that are already open, otherwise a
  // company that stopped paying keeps working until everyone happens to log
  // out. Platform admins are exempt: they are the ones who unblock it.
  if (!org || (orgAccessDenial(org) !== null && !gvBool(user.is_platform_admin ?? 0))) return null;

  const role = await dbOne('SELECT * FROM roles WHERE id = ?', [user.role_id]);
  if (!role) return null;

  // Platform admins act inside whichever tenant their session points at;
  // everyone else is pinned to their own. This one resolution is what makes
  // every downstream `WHERE organization_id = ?` tenant-correct.
  const isPlatformAdmin = gvBool(user.is_platform_admin ?? 0);
  let activeOrg = org;
  if (isPlatformAdmin && session.active_organization_id) {
    const candidate = await dbOne('SELECT * FROM organizations WHERE id = ?', [session.active_organization_id]);
    // A tenant that was deleted mid-session drops the admin back to the
    // platform rather than leaving them in a dead context. A platform admin
    // may open a blocked client — that is precisely when they need to get in
    // and fix the billing.
    if (candidate) activeOrg = candidate;
  }

  const overrides = await userPermissionOverrides(user.id);
  const eff = effectivePermissions(
    safeJson(role.permissions, {}),
    role.data_scope,
    role.scope_overrides ?? null,
    overrides
  );

  const actor = {
    id: user.id,
    // The tenant this request operates on (see lib/tenancy.js).
    organizationId: activeOrg.id,
    // The tenant this user actually belongs to. Never use this for data
    // scoping — only for "who am I" style lookups.
    homeOrganizationId: user.organization_id,
    isPlatformAdmin,
    isImpersonating: isPlatformAdmin && activeOrg.id !== user.organization_id,
    organization: {
      id: activeOrg.id,
      name: activeOrg.name,
      slug: activeOrg.slug,
      currency: activeOrg.currency,
      timezone: activeOrg.timezone,
      companyType: activeOrg.company_type ?? 'DEVELOPER',
      isPlatform: gvBool(activeOrg.is_platform ?? 0),
      branding: orgBranding(activeOrg),
    },
    firstName: user.first_name,
    lastName: user.last_name,
    email: user.email,
    avatarUrl: user.avatar_url,
    jobTitle: user.job_title,
    designation: user.designation ?? null,
    region: user.region,
    managerId: user.manager_id,
    twoFactorEnabled: gvBool(user.two_factor_enabled),
    lastLoginAt: user.last_login_at,
    role: {
      id: role.id,
      key: role.key,
      name: role.name,
      level: Number(role.level),
      dataScope: role.data_scope,
      isSystem: gvBool(role.is_system),
    },
    permissions: eff.permissions,
    inheritedPermissions: eff.inherited,
    specialPermissions: eff.special,
    permissionScopes: eff.scopes,
  };

  // Cheap liveness ping, throttled so it is not a write on every request.
  if (Date.now() - new Date(session.last_seen_at).getTime() > 60_000) {
    await dbExec('UPDATE sessions SET last_seen_at = NOW() WHERE id = ?', [session.id]);
  }

  return { actor, session };
}

export function requireActor(req) {
  if (!req.actor) throw unauthenticated();
  return req.actor;
}

/** Server-side permission gate — the one that actually matters. */
export function assertPermission(req, module, action) {
  const actor = requireActor(req);
  const granted = actor.permissions[module] ?? [];
  if (!granted.includes(action)) throw forbidden(`Missing permission: ${module}:${action}`);
  return actor;
}

export function assertAnyPermission(req, pairs) {
  const actor = requireActor(req);
  for (const [module, action] of pairs) {
    if ((actor.permissions[module] ?? []).includes(action)) return actor;
  }
  throw forbidden('Missing permission');
}

export function hasPermission(actor, module, action) {
  return (actor?.permissions?.[module] ?? []).includes(action);
}

/**
 * The data scope that applies to one specific permission, after role overrides
 * and per-user special access. Falls back to the role's blanket scope.
 */
export function permissionScope(actor, module, action) {
  return actor?.permissionScopes?.[module]?.[action] ?? actor?.role?.dataScope ?? 'OWN';
}

// ---------------------------------------------------------------------------
// Session issuing / cookies
// ---------------------------------------------------------------------------
export async function issueSession(req, res, user, rememberMe) {
  const ttlSeconds = rememberMe
    ? config.auth.rememberMeTtlDays * 86400
    : config.auth.sessionTtlHours * 3600;

  const token = randomToken(32);
  const sessionId = gvId();
  const expiresAt = toSqlDateTime(new Date(Date.now() + ttlSeconds * 1000));

  await dbExec(
    'INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, remember_me, expires_at) VALUES (?,?,?,?,?,?,?)',
    [sessionId, user.id, sha256(token), userAgent(req), clientIp(req), rememberMe ? 1 : 0, expiresAt]
  );

  res.cookie(config.auth.cookieName, token, {
    maxAge: ttlSeconds * 1000,
    path: '/',
    secure: config.auth.cookieSecure,
    httpOnly: true,
    sameSite: config.auth.cookieSameSite,
    domain: config.auth.cookieDomain,
  });

  return { token, sessionId, expiresAt };
}

export function clearSessionCookie(res) {
  res.clearCookie(config.auth.cookieName, {
    path: '/',
    secure: config.auth.cookieSecure,
    httpOnly: true,
    sameSite: config.auth.cookieSameSite,
    domain: config.auth.cookieDomain,
  });
}
