/**
 * /api/users/* — port of api/users.php.
 *
 * People management: listing, the reporting hierarchy, invitations,
 * per-person permission overrides, admin password control and deactivation.
 * Users are never hard-deleted — their leads, activities and audit trail must
 * still resolve to a name long after they have left.
 */

import express from 'express';
import config from '../config/index.js';
import { dbAll, dbExec, dbInClause, dbOne, dbScalar, dbTransaction } from '../lib/db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk, pageMeta, parsePaging, parseSort } from '../lib/response.js';
import { ah, requirePermission, scopeInfo } from '../middleware/index.js';
import { hasPermission } from '../lib/auth.js';
import { auditRecord } from '../lib/audit.js';
import { checkPasswordStrength, hashPassword, randomToken, sha256 } from '../lib/security.js';
import {
  DATA_SCOPES,
  MODULES,
  effectivePermissions,
  isValidScope,
  moduleMap,
  scopeRank,
  userPermissionOverrides,
} from '../lib/permissions.js';
import { isPlatformAdmin } from '../lib/tenancy.js';
import { camelize, gvBool, gvDiff, gvId, nowSql, parseDate, safeJson, toSqlDateTime } from '../lib/util.js';
import { boolVal, validate } from '../lib/validate.js';
import { sendSystemMail } from '../services/mailer.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// PHP semantics the handlers below depend on. JSON bodies reach PHP as arrays,
// so `array_key_exists`, `empty()`, `?:` and `(int)` decide what a field means;
// these keep the same answers for the same payloads.
// ---------------------------------------------------------------------------
function has(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

/** PHP empty() / falsiness: null, false, 0, '', '0' and an empty array. */
function phpEmpty(v) {
  if (v === undefined || v === null || v === false || v === 0 || v === '' || v === '0') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/** PHP `$v ?: null`. */
function orNull(v) {
  return phpEmpty(v) ? null : v;
}

/** PHP `(int)` cast. */
function phpInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

function fullNameOf(first, last) {
  return `${first ?? ''} ${last ?? ''}`.trim();
}

function usersShape(u) {
  const out = camelize(u);
  delete out.passwordHash;
  delete out.twoFactorSecret;
  out.fullName = fullNameOf(u.first_name, u.last_name);
  return out;
}

/** An admin may only grant a role at/below their own authority and data scope. */
async function usersAssertCanGrantRole(actor, roleId) {
  const role = await dbOne('SELECT * FROM roles WHERE id = ? AND organization_id = ?', [roleId, actor.organizationId]);
  if (!role) throw badRequest('Unknown role');
  const actorRole = await dbOne('SELECT * FROM roles WHERE id = ?', [actor.role.id]);
  if (phpInt(role.level) < phpInt(actorRole.level)) {
    throw forbidden('You cannot grant a role with more authority than your own.');
  }
  const ranks = scopeRank();
  if ((ranks[role.data_scope] ?? 0) > (ranks[actorRole.data_scope] ?? 0)) {
    throw forbidden('You cannot grant a data scope wider than your own.');
  }
  // Creating an administrator is the Super Admin's job alone. A company admin
  // can build their whole sales hierarchy but cannot mint a second admin, so
  // the account that controls a tenant is only ever granted by the platform.
  if (['admin', 'super_admin'].includes(role.key) && !isPlatformAdmin(actor)) {
    throw forbidden('Only a platform administrator can create another administrator.');
  }
  return role;
}

async function usersAssertCanManage(req, targetId) {
  const a = req.actor;
  if (targetId === a.id) return;
  const scope = await scopeInfo(req);
  if (scope.unrestricted) return;
  if (!scope.userIds.includes(targetId)) {
    throw forbidden('That user is outside your management scope.');
  }
}

async function loadOrgUser(req, id) {
  const user = await dbOne('SELECT * FROM users WHERE id = ? AND organization_id = ?', [id, req.actor.organizationId]);
  if (!user) throw notFound('User not found');
  return user;
}

// ---------------------------------------------------------------------------
// GET /users
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('users', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const query = req.query;
    const scope = await scopeInfo(req);
    const { page, limit, offset } = parsePaging(query);

    // Qualified with `users.` because roles and users both carry a name, and
    // the manager self-join brings a third set of ambiguous columns.
    const clauses = ['users.organization_id = ?'];
    let params = [a.organizationId];
    if (!scope.unrestricted && (query.scoped ?? null) !== 'false') {
      const [inSql, p] = dbInClause(scope.userIds);
      clauses.push(`users.id IN ${inSql}`);
      params = params.concat(p);
    }
    if (!phpEmpty(query.q)) {
      const term = `%${String(query.q).trim()}%`;
      clauses.push('(users.first_name LIKE ? OR users.last_name LIKE ? OR users.email LIKE ? OR users.job_title LIKE ?)');
      params.push(term, term, term, term);
    }
    if (!phpEmpty(query.roleId)) {
      clauses.push('users.role_id = ?');
      params.push(String(query.roleId));
    }
    if (!phpEmpty(query.region)) {
      clauses.push('users.region = ?');
      params.push(String(query.region));
    }
    if (query.isActive !== undefined && query.isActive !== null) {
      clauses.push('users.is_active = ?');
      params.push(query.isActive === 'true' ? 1 : 0);
    }
    if (!phpEmpty(query.teamId)) {
      clauses.push('users.id IN (SELECT user_id FROM team_members WHERE team_id = ?)');
      params.push(String(query.teamId));
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const [sortCol, dir] = parseSort(query, ['createdAt', 'firstName', 'lastLoginAt'], 'first_name', 'ASC');

    const rows = await dbAll(
      `SELECT users.*, roles.name AS role_name, roles.\`key\` AS role_key, roles.data_scope AS role_data_scope,
              mgr.first_name AS manager_first_name, mgr.last_name AS manager_last_name
         FROM users
         LEFT JOIN roles ON roles.id = users.role_id
         LEFT JOIN users mgr ON mgr.id = users.manager_id
       ${where} ORDER BY users.${sortCol} ${dir} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const total = phpInt(
      await dbScalar(`SELECT COUNT(*) FROM users LEFT JOIN roles ON roles.id = users.role_id ${where}`, params)
    );

    return jsonOk(
      res,
      rows.map((u) => {
        const out = usersShape(u);
        delete out.roleName;
        delete out.roleKey;
        delete out.roleDataScope;
        delete out.managerFirstName;
        delete out.managerLastName;
        out.role = u.role_id
          ? { id: u.role_id, name: u.role_name, key: u.role_key, dataScope: u.role_data_scope }
          : null;
        out.managerName = u.manager_id ? fullNameOf(u.manager_first_name, u.manager_last_name) : null;
        return out;
      }),
      pageMeta(page, limit, total)
    );
  })
);

// ---------------------------------------------------------------------------
// GET /users/assignable — the owner picker; any signed-in user, scoped.
// ---------------------------------------------------------------------------
router.get(
  '/assignable',
  ah(async (req, res) => {
    const a = req.actor;
    const scope = await scopeInfo(req);
    const clauses = ['organization_id = ?', 'is_active = 1', 'is_assignable = 1'];
    let params = [a.organizationId];
    if (!scope.unrestricted) {
      const [inSql, p] = dbInClause(scope.userIds);
      clauses.push(`id IN ${inSql}`);
      params = params.concat(p);
    }
    const rows = await dbAll(
      `SELECT id, first_name, last_name, email, avatar_url FROM users WHERE ${clauses.join(' AND ')} ORDER BY first_name ASC LIMIT 500`,
      params
    );
    return jsonOk(
      res,
      rows.map((u) => ({ ...camelize(u), fullName: fullNameOf(u.first_name, u.last_name) }))
    );
  })
);

// ---------------------------------------------------------------------------
// GET /users/hierarchy — the reporting tree, built from users.manager_id.
// ---------------------------------------------------------------------------
router.get(
  '/hierarchy',
  requirePermission('users', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const rows = await dbAll(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.avatar_url, u.manager_id, u.job_title, r.name AS role_name, r.\`key\` AS role_key, r.level AS role_level
         FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.organization_id = ? AND u.is_active = 1 ORDER BY u.first_name ASC`,
      [a.organizationId]
    );
    // A Map keeps the first_name ordering; node objects are shared by
    // reference, so a child appended later still shows under its manager.
    const byId = new Map();
    for (const u of rows) {
      byId.set(u.id, {
        id: u.id,
        firstName: u.first_name,
        lastName: u.last_name,
        email: u.email,
        avatarUrl: u.avatar_url,
        managerId: u.manager_id,
        jobTitle: u.job_title,
        fullName: fullNameOf(u.first_name, u.last_name),
        role: { name: u.role_name, key: u.role_key, level: phpInt(u.role_level) },
        children: [],
      });
    }
    const roots = [];
    for (const node of byId.values()) {
      if (node.managerId && byId.has(node.managerId)) {
        byId.get(node.managerId).children.push(node);
      } else {
        roots.push(node);
      }
    }
    return jsonOk(res, roots);
  })
);

// ---------------------------------------------------------------------------
// POST /users — create directly (with a password) or by invitation.
// ---------------------------------------------------------------------------
router.post(
  '/',
  requirePermission('users', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    validate(body)
      .required('firstName', 'First name').maxLength('firstName', 60)
      .required('email', 'Email').email('email')
      .required('roleId', 'Role')
      .validate();

    const email = String(body.email).trim().toLowerCase();
    await usersAssertCanGrantRole(a, body.roleId);
    if (await dbOne('SELECT id FROM users WHERE organization_id = ? AND email = ?', [a.organizationId, email])) {
      throw badRequest('A user with that email already exists in this organisation.');
    }

    let inviteToken = null;
    let passwordHash;
    if (!phpEmpty(body.password)) {
      const strength = checkPasswordStrength(String(body.password));
      if (!strength.ok) throw badRequest(strength.message);
      passwordHash = await hashPassword(String(body.password));
    } else {
      // An unguessable placeholder: the account cannot be signed into until
      // the invitee sets their own password through the invite link.
      inviteToken = randomToken(32);
      passwordHash = await hashPassword(randomToken(24));
    }

    const userId = gvId();
    await dbExec(
      `INSERT INTO users (id, organization_id, role_id, first_name, last_name, email, phone, job_title, region, manager_id, password_hash, is_assignable, assignment_weight, email_verified_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [
        userId, a.organizationId, body.roleId, String(body.firstName).trim(), String(body.lastName ?? '').trim(), email,
        body.phone ?? null, body.jobTitle ?? null, body.region ?? null, body.managerId ?? null, passwordHash,
        has(body, 'isAssignable') ? (boolVal(body.isAssignable) ? 1 : 0) : 1, phpInt(body.assignmentWeight ?? 1),
        !phpEmpty(body.password) ? nowSql() : null,
      ]
    );
    if (!phpEmpty(body.teamIds) && Array.isArray(body.teamIds)) {
      for (const teamId of body.teamIds) {
        await dbExec('INSERT INTO team_members (id, team_id, user_id, joined_at) VALUES (?,?,?,NOW())', [gvId(), teamId, userId]);
      }
    }

    let inviteUrl = null;
    if (inviteToken) {
      await dbExec(
        'INSERT INTO auth_tokens (id, user_id, type, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,NOW())',
        [gvId(), userId, 'INVITE', sha256(inviteToken), toSqlDateTime(new Date(Date.now() + 7 * 86400_000))]
      );
      // The link opens the React app's accept-invite page, not the API.
      inviteUrl = `${config.clientUrl}/accept-invite?token=${inviteToken}`;
      const sent = await sendSystemMail({
        to: email,
        subject: `You have been invited to ${a.organization?.name ?? 'Growvanta CRM'}`,
        text:
          `Hello ${String(body.firstName).trim()},\n\n` +
          `${fullNameOf(a.firstName, a.lastName)} has added you to ${a.organization?.name ?? 'their organisation'} on Growvanta CRM.\n\n` +
          `Open this link to set your password and sign in. It expires in 7 days.\n\n${inviteUrl}`,
      });
      // The link is also returned to the admin below, so a missing mail
      // server never strands the invitee.
      if (!sent.ok) console.error(`[users] invite email not sent (${sent.reason}). Invite link for ${email}: ${inviteUrl}`);
    }

    const user = await dbOne('SELECT * FROM users WHERE id = ?', [userId]);
    await auditRecord(
      a.organizationId,
      a,
      'user.created',
      {
        entityType: 'USER',
        entityId: userId,
        entityLabel: email,
        changes: { roleId: body.roleId, managerId: body.managerId ?? null },
      },
      req
    );
    return jsonCreated(res, { ...usersShape(user), inviteUrl });
  })
);

// ---------------------------------------------------------------------------
// PATCH /users/me/profile — self-service profile fields only.
// ---------------------------------------------------------------------------
router.patch(
  '/me/profile',
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const data = {};
    const fields = { firstName: 'first_name', lastName: 'last_name', phone: 'phone', jobTitle: 'job_title', avatarUrl: 'avatar_url' };
    for (const [camel, col] of Object.entries(fields)) {
      if (has(body, camel)) data[col] = orNull(body[camel]);
    }
    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE users SET ${sets}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), a.id]);
    }
    return jsonOk(res, usersShape(await dbOne('SELECT * FROM users WHERE id = ?', [a.id])));
  })
);

// ---------------------------------------------------------------------------
// GET /users/:id/permissions
//
// The "effective permission" view from spec section 11: what the role gives,
// what was granted or revoked for this person specifically, and the result
// the server actually enforces.
// ---------------------------------------------------------------------------
router.get(
  '/:id/permissions',
  requirePermission('users', 'read'),
  ah(async (req, res) => {
    const user = await loadOrgUser(req, req.params.id);
    const role = await dbOne('SELECT * FROM roles WHERE id = ?', [user.role_id]);
    const overrides = await userPermissionOverrides(user.id);
    const eff = effectivePermissions(
      safeJson(role.permissions, []),
      role.data_scope,
      role.scope_overrides ?? null,
      overrides
    );
    return jsonOk(res, {
      userId: user.id,
      role: { id: role.id, key: role.key, name: role.name, dataScope: role.data_scope },
      inherited: eff.inherited,
      special: eff.special,
      effective: eff.permissions,
      scopes: eff.scopes,
      catalogue: MODULES,
      dataScopes: DATA_SCOPES,
    });
  })
);

// ---------------------------------------------------------------------------
// PUT /users/:id/permissions — replace the person's override set.
// ---------------------------------------------------------------------------
router.put(
  '/:id/permissions',
  requirePermission('users', 'manage'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const user = await loadOrgUser(req, req.params.id);
    await usersAssertCanManage(req, user.id);

    const raw = body.permissions ?? null;
    const rows = Array.isArray(raw) ? raw : raw !== null && typeof raw === 'object' ? Object.values(raw) : [];
    const modules = moduleMap();
    const clean = [];
    for (const row of rows) {
      const module = String(row?.module ?? '');
      const action = String(row?.action ?? '');
      if (!has(modules, module) || !modules[module].actions.includes(action)) {
        throw badRequest(`Unknown permission: ${module}:${action}`);
      }
      const effect = String(row?.effect ?? 'GRANT').toUpperCase();
      if (!['GRANT', 'REVOKE'].includes(effect)) {
        throw badRequest('Effect must be GRANT or REVOKE.');
      }
      const scope = row?.dataScope ?? null;
      if (scope !== null && scope !== '' && !isValidScope(String(scope))) {
        throw badRequest(`Invalid data scope on ${module}:${action}`);
      }
      // Nobody may hand themselves a power they do not already hold - that
      // would make the permission system self-serve.
      if (user.id === a.id && effect === 'GRANT' && !hasPermission(a, module, action)) {
        throw forbidden('You cannot grant yourself a permission you do not already have.');
      }
      // Platform modules are not a tenant's to hand out.
      if (['clients', 'global_projects'].includes(module) && !isPlatformAdmin(a)) {
        throw forbidden('Platform permissions can only be granted by a platform administrator.');
      }
      clean.push({
        module,
        action,
        effect,
        dataScope: orNull(scope),
        reason: row?.reason ?? null,
        expiresAt: parseDate(row?.expiresAt ?? null),
      });
    }

    await dbTransaction(async () => {
      // Replace wholesale: the UI always sends the complete override set, so
      // removing a row from the payload is how an override is withdrawn.
      await dbExec('DELETE FROM user_permissions WHERE user_id = ?', [user.id]);
      for (const row of clean) {
        await dbExec(
          `INSERT INTO user_permissions
             (id, organization_id, user_id, module, action, effect, data_scope, reason, granted_by_id, expires_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
          [
            gvId(), user.organization_id, user.id, row.module, row.action,
            row.effect, row.dataScope, row.reason, a.id, row.expiresAt,
          ]
        );
      }
    });

    await auditRecord(
      a.organizationId,
      a,
      'user.permissions_changed',
      { entityType: 'USER', entityId: user.id, entityLabel: user.email, changes: { overrides: clean } },
      req
    );

    const role = await dbOne('SELECT * FROM roles WHERE id = ?', [user.role_id]);
    const eff = effectivePermissions(
      safeJson(role.permissions, []),
      role.data_scope,
      role.scope_overrides ?? null,
      await userPermissionOverrides(user.id)
    );
    return jsonOk(res, { special: eff.special, effective: eff.permissions, scopes: eff.scopes });
  })
);

// ---------------------------------------------------------------------------
// POST /users/:id/set-password
//
// An administrator setting a user's password outright, rather than emailing a
// reset link. Sales teams need this: somebody is locked out, standing at the
// desk, and the reset email goes to an address they cannot open.
//
// It is a powerful thing to hand out, so it is fenced on four sides.
// ---------------------------------------------------------------------------
router.post(
  '/:id/set-password',
  requirePermission('users', 'manage'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const user = await loadOrgUser(req, req.params.id);

    // 1. Not yourself. Changing your own password must go through the profile
    //    screen, which asks for the current one - otherwise anyone who finds an
    //    unlocked laptop can take the account without knowing the old password.
    if (user.id === a.id) {
      throw badRequest('Change your own password from your profile, where the current one is required.');
    }

    // 2. Inside the part of the organisation you manage.
    await usersAssertCanManage(req, user.id);

    // 3. Never upward. Scope alone would let anyone with organisation-wide
    //    reach - a business head, say - take the administrator's account.
    const targetRole = await dbOne('SELECT level, name FROM roles WHERE id = ?', [user.role_id]);
    const actorRole = await dbOne('SELECT level FROM roles WHERE id = ?', [a.role.id]);
    if (targetRole && actorRole && phpInt(targetRole.level) < phpInt(actorRole.level)) {
      throw forbidden('You cannot set the password of someone with more authority than you.');
    }

    // 4. A platform administrator's account is never reachable from inside a
    //    client company, whatever that company's own roles allow.
    if (gvBool(user.is_platform_admin) && !isPlatformAdmin(a)) {
      throw forbidden('That account is managed by the platform owner.');
    }

    const password = body.password === undefined || body.password === null ? '' : String(body.password);
    const strength = checkPasswordStrength(password);
    if (!strength.ok) throw badRequest(strength.message);

    await dbExec(
      'UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() WHERE id = ?',
      [await hashPassword(password), user.id]
    );

    // Any reset link already in flight is now stale, and every session the
    // person had is signed out - a forced password change that leaves the old
    // session working has not actually taken the account back.
    await dbExec("DELETE FROM auth_tokens WHERE user_id = ? AND type IN ('PASSWORD_RESET','INVITE')", [user.id]);
    const revoked = phpInt(await dbScalar('SELECT COUNT(*) FROM sessions WHERE user_id = ?', [user.id]));
    await dbExec('DELETE FROM sessions WHERE user_id = ?', [user.id]);

    await auditRecord(
      a.organizationId,
      a,
      'user.password_set',
      { entityType: 'USER', entityId: user.id, entityLabel: user.email, changes: { sessionsRevoked: revoked } },
      req
    );

    return jsonOk(res, {
      message: revoked > 0 ? `Password updated. ${revoked} active session(s) were signed out.` : 'Password updated.',
      sessionsRevoked: revoked,
    });
  })
);

// ---------------------------------------------------------------------------
// POST /users/:id/reset-password — issues a 24-hour reset link to hand over.
// ---------------------------------------------------------------------------
router.post(
  '/:id/reset-password',
  requirePermission('users', 'manage'),
  ah(async (req, res) => {
    const a = req.actor;
    const user = await loadOrgUser(req, req.params.id);
    await usersAssertCanManage(req, user.id);
    const token = randomToken(32);
    await dbExec(
      'INSERT INTO auth_tokens (id, user_id, type, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,NOW())',
      [gvId(), user.id, 'PASSWORD_RESET', sha256(token), toSqlDateTime(new Date(Date.now() + 86400_000))]
    );
    await auditRecord(
      a.organizationId,
      a,
      'user.password_reset_issued',
      { entityType: 'USER', entityId: user.id, entityLabel: user.email },
      req
    );
    return jsonOk(res, {
      message: 'Reset link generated.',
      resetUrl: `${config.clientUrl}/reset-password?token=${token}`,
    });
  })
);

// ---------------------------------------------------------------------------
// GET /users/:id
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  requirePermission('users', 'read'),
  ah(async (req, res) => {
    const user = await loadOrgUser(req, req.params.id);
    const leadCount = phpInt(await dbScalar('SELECT COUNT(*) FROM leads WHERE owner_id = ?', [user.id]));
    const siteVisits = phpInt(
      await dbScalar('SELECT COUNT(*) FROM leads WHERE owner_id = ? AND site_visit_at IS NOT NULL', [user.id])
    );
    const revenue = Number(
      (await dbScalar(
        'SELECT SUM(COALESCE(expected_value, budget_max)) FROM leads WHERE owner_id = ? AND is_converted = 1',
        [user.id]
      )) ?? 0
    );
    return jsonOk(res, { ...usersShape(user), stats: { leads: leadCount, siteVisits, revenue } });
  })
);

// ---------------------------------------------------------------------------
// PATCH /users/:id — profile, role, reporting line, teams, activation.
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requirePermission('users', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const before = await loadOrgUser(req, req.params.id);
    await usersAssertCanManage(req, before.id);

    const data = {};
    const fields = { firstName: 'first_name', lastName: 'last_name', phone: 'phone', jobTitle: 'job_title', region: 'region' };
    for (const [camel, col] of Object.entries(fields)) {
      if (has(body, camel)) data[col] = orNull(body[camel]);
    }
    if (has(body, 'email')) {
      data.email = String(body.email ?? '').trim().toLowerCase();
    }
    if (has(body, 'isAssignable')) {
      data.is_assignable = boolVal(body.isAssignable) ? 1 : 0;
    }
    if (has(body, 'assignmentWeight')) {
      data.assignment_weight = phpInt(body.assignmentWeight);
    }
    let deactivating = false;
    if (has(body, 'isActive')) {
      if (before.id === a.id && phpEmpty(body.isActive)) {
        throw badRequest('You cannot deactivate your own account.');
      }
      data.is_active = boolVal(body.isActive) ? 1 : 0;
      deactivating = !boolVal(body.isActive);
    }
    if (has(body, 'roleId') && body.roleId !== before.role_id) {
      await usersAssertCanGrantRole(a, body.roleId);
      if (before.id === a.id) {
        throw forbidden('You cannot change your own role.');
      }
      data.role_id = body.roleId;
    }
    if (has(body, 'managerId')) {
      if (body.managerId === before.id) {
        throw badRequest('A user cannot report to themselves.');
      }
      if (!phpEmpty(body.managerId)) {
        // Walk up the proposed manager's chain: meeting this user on the way
        // means the change would close a reporting loop.
        let cursor = body.managerId;
        const seen = new Set([before.id]);
        while (!phpEmpty(cursor)) {
          if (seen.has(cursor)) {
            throw badRequest('That would create a reporting loop.');
          }
          seen.add(cursor);
          cursor = await dbScalar('SELECT manager_id FROM users WHERE id = ?', [cursor]);
        }
      }
      data.manager_id = orNull(body.managerId);
    }

    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE users SET ${sets}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), before.id]);
    }
    if (has(body, 'teamIds') && Array.isArray(body.teamIds)) {
      if (body.teamIds.length) {
        const [inSql, p] = dbInClause(body.teamIds);
        await dbExec(`DELETE FROM team_members WHERE user_id = ? AND team_id NOT IN ${inSql}`, [before.id, ...p]);
      } else {
        await dbExec('DELETE FROM team_members WHERE user_id = ?', [before.id]);
      }
      for (const teamId of body.teamIds) {
        if (!(await dbOne('SELECT id FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, before.id]))) {
          await dbExec('INSERT INTO team_members (id, team_id, user_id, joined_at) VALUES (?,?,?,NOW())', [gvId(), teamId, before.id]);
        }
      }
    }
    if (deactivating) {
      // A deactivated account must stop working now, not when its session
      // happens to expire.
      await dbExec('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [before.id]);
    }

    const user = await dbOne('SELECT * FROM users WHERE id = ?', [before.id]);
    const changes = gvDiff(before, user, [
      'first_name', 'last_name', 'email', 'phone', 'job_title', 'region', 'role_id', 'manager_id', 'is_active',
    ]);
    if (Object.keys(changes).length) {
      await auditRecord(
        a.organizationId,
        a,
        data.role_id !== undefined && data.role_id !== null ? 'user.role_changed' : 'user.updated',
        { entityType: 'USER', entityId: user.id, entityLabel: user.email, changes },
        req
      );
    }
    return jsonOk(res, usersShape(user));
  })
);

// ---------------------------------------------------------------------------
// DELETE /users/:id — deactivation; the person's records are preserved.
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requirePermission('users', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const user = await loadOrgUser(req, req.params.id);
    if (user.id === a.id) {
      throw badRequest('You cannot delete your own account.');
    }
    await usersAssertCanManage(req, user.id);
    await dbExec('UPDATE users SET is_active = 0, is_assignable = 0 WHERE id = ?', [user.id]);
    await dbExec('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [user.id]);
    await auditRecord(
      a.organizationId,
      a,
      'user.deactivated',
      { entityType: 'USER', entityId: user.id, entityLabel: user.email },
      req
    );
    return jsonOk(res, { deactivated: true, message: 'User deactivated. Their records were preserved.' });
  })
);

// Anything else under /users answers like the PHP dispatcher's final branch.
router.use((req, res, next) => next(notFound('Unknown users route')));

export default router;
