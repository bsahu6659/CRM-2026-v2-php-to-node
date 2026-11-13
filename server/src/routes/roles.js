/**
 * /api/roles/* — port of api/roles.php.
 *
 * Roles carry a level (lower = more authority), a blanket data scope and a
 * permission grant drawn from the catalogue in lib/permissions.js. Every
 * write is checked against the actor's own role so nobody can mint a role
 * more powerful than the one they hold.
 */

import express from 'express';
import { dbAll, dbExec, dbOne, dbScalar } from '../lib/db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { DATA_SCOPES, MODULES, isValidScope, sanitizePermissions, scopeRank } from '../lib/permissions.js';
import { isPlatformAdmin } from '../lib/tenancy.js';
import { camelize, gvBool, gvDiff, gvId, safeJson, slugify, toJson } from '../lib/util.js';
import { validate } from '../lib/validate.js';

const router = express.Router();

function has(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

/** PHP isset(): present and not null. */
function isSet(obj, key) {
  return has(obj, key) && obj[key] !== null && obj[key] !== undefined;
}

/** PHP empty() / falsiness: null, false, 0, '', '0' and an empty array. */
function phpEmpty(v) {
  if (v === undefined || v === null || v === false || v === 0 || v === '' || v === '0') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/** PHP `(int)` cast. */
function phpInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * PDO returns every column as a scalar, so the PHP edition only ever saw
 * `permissions` and `scope_overrides` as JSON text. mysql2 parses native JSON
 * columns into objects, which camelize() would walk (renaming `change_status`
 * inside the stored grant) and gvDiff() would always see as changed.
 * Re-serialising them first keeps both behaving as they did.
 */
function scalarRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v !== null && typeof v === 'object' && !Buffer.isBuffer(v) ? JSON.stringify(v) : v;
  }
  return out;
}

/** Last four base-36 digits of the Unix time — the PHP suffix for a clashing key. */
function keySuffix() {
  return Math.floor(Date.now() / 1000).toString(36).slice(-4);
}

/**
 * Guard rails on role writes: a payload can never outrank the actor's own
 * role, never grant a data scope wider than the actor's own, and never grant
 * a permission the actor does not themselves hold.
 */
async function rolesAssertWithinAuthority(actor, payload) {
  const actorRole = await dbOne('SELECT * FROM roles WHERE id = ?', [actor.role.id]);
  const level = payload.level ?? 50;
  if (phpInt(level) < phpInt(actorRole.level)) {
    throw forbidden('You cannot create a role with more authority than your own.');
  }
  if (!isValidScope(payload.dataScope)) {
    throw badRequest('Unknown data scope');
  }
  const ranks = scopeRank();
  if ((ranks[payload.dataScope] ?? 0) > (ranks[actorRole.data_scope] ?? 0)) {
    throw forbidden('You cannot grant a data scope wider than your own.');
  }

  const clean = sanitizePermissions(payload.permissions ?? []);
  const mine = safeJson(actorRole.permissions, []);
  for (const [moduleKey, actions] of Object.entries(clean)) {
    const held = Array.isArray(mine?.[moduleKey]) ? mine[moduleKey] : [];
    const excess = actions.filter((x) => !held.includes(x));
    if (excess.length) {
      throw forbidden(`You cannot grant ${moduleKey}:${excess.join(',')} because you do not hold it yourself.`);
    }
  }
  return clean;
}

function rolesShape(r) {
  const out = camelize(scalarRow(r));
  out.permissions = safeJson(r.permissions, []);
  return out;
}

// ---------------------------------------------------------------------------
// GET /roles/catalogue — the vocabulary the Roles screen is rendered from.
// ---------------------------------------------------------------------------
router.get(
  '/catalogue',
  ah(async (req, res) => {
    return jsonOk(res, { modules: MODULES, dataScopes: DATA_SCOPES });
  })
);

// ---------------------------------------------------------------------------
// GET /roles
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('roles', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    // Belt and braces alongside provisioning: a company admin never sees the
    // platform-owner role, even on an older install where the row still exists.
    const hidePlatformRole = isPlatformAdmin(a) ? '' : " AND r.`key` <> 'super_admin'";
    const rows = await dbAll(
      `SELECT r.*, pr.name AS parent_role_name, (SELECT COUNT(*) FROM users WHERE role_id = r.id) AS user_count
         FROM roles r LEFT JOIN roles pr ON pr.id = r.parent_role_id
        WHERE r.organization_id = ?${hidePlatformRole} ORDER BY r.level ASC, r.name ASC`,
      [a.organizationId]
    );
    return jsonOk(
      res,
      rows.map((r) => {
        const out = rolesShape(r);
        out.parentRole = r.parent_role_id ? { id: r.parent_role_id, name: r.parent_role_name } : null;
        out.userCount = phpInt(r.user_count);
        delete out.parentRoleName;
        return out;
      })
    );
  })
);

// ---------------------------------------------------------------------------
// POST /roles
// ---------------------------------------------------------------------------
router.post(
  '/',
  requirePermission('roles', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    validate(body)
      .required('name', 'Role name').maxLength('name', 80)
      .required('dataScope', 'Data scope')
      .validate();

    const permissions = await rolesAssertWithinAuthority(a, body);
    let key = slugify(String(body.name)).replace(/-/g, '_');
    if (await dbOne('SELECT id FROM roles WHERE organization_id = ? AND `key` = ?', [a.organizationId, key])) {
      key += `_${keySuffix()}`;
    }
    const roleId = gvId();
    await dbExec(
      `INSERT INTO roles (id, organization_id, \`key\`, name, description, parent_role_id, level, data_scope, permissions, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [
        roleId, a.organizationId, key, body.name, body.description ?? null, body.parentRoleId ?? null,
        body.level ?? 50, body.dataScope, toJson(permissions),
      ]
    );
    const role = await dbOne('SELECT * FROM roles WHERE id = ?', [roleId]);
    await auditRecord(
      a.organizationId,
      a,
      'role.created',
      {
        entityType: 'ROLE',
        entityId: roleId,
        entityLabel: role.name,
        changes: { dataScope: role.data_scope, permissions },
      },
      req
    );
    return jsonCreated(res, rolesShape(role));
  })
);

// ---------------------------------------------------------------------------
// GET /roles/:id
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  requirePermission('roles', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const role = await dbOne('SELECT * FROM roles WHERE id = ? AND organization_id = ?', [req.params.id, a.organizationId]);
    if (!role) throw notFound('Role not found');
    const userCount = phpInt(await dbScalar('SELECT COUNT(*) FROM users WHERE role_id = ?', [role.id]));
    return jsonOk(res, { ...rolesShape(role), userCount });
  })
);

// ---------------------------------------------------------------------------
// PATCH /roles/:id
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requirePermission('roles', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const before = await dbOne('SELECT * FROM roles WHERE id = ? AND organization_id = ?', [req.params.id, a.organizationId]);
    if (!before) throw notFound('Role not found');
    if (gvBool(before.is_system) && (isSet(body, 'dataScope') || isSet(body, 'permissions'))) {
      throw badRequest('Built-in Super Admin and Admin roles cannot have their access reduced. Create a custom role instead.');
    }
    // Editing your own role would let you widen the very access you are
    // using to make the edit.
    if (before.id === a.role.id) {
      throw forbidden('You cannot edit the role you are currently signed in with.');
    }

    const data = {};
    if (has(body, 'name')) {
      data.name = body.name;
    }
    if (has(body, 'description')) {
      data.description = phpEmpty(body.description) ? null : body.description;
    }
    if (has(body, 'parentRoleId')) {
      if (body.parentRoleId === before.id) {
        throw badRequest('A role cannot be its own parent.');
      }
      data.parent_role_id = phpEmpty(body.parentRoleId) ? null : body.parentRoleId;
    }
    if (has(body, 'isActive')) {
      data.is_active = phpEmpty(body.isActive) ? 0 : 1;
    }
    if (has(body, 'level') || has(body, 'dataScope') || has(body, 'permissions')) {
      const permissions = await rolesAssertWithinAuthority(a, {
        level: body.level ?? before.level,
        dataScope: body.dataScope ?? before.data_scope,
        permissions: body.permissions ?? safeJson(before.permissions, []),
      });
      if (has(body, 'level')) {
        data.level = body.level;
      }
      if (has(body, 'dataScope')) {
        data.data_scope = body.dataScope;
      }
      if (has(body, 'permissions')) {
        data.permissions = toJson(permissions);
      }
    }

    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE roles SET ${sets}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), before.id]);
    }
    const role = await dbOne('SELECT * FROM roles WHERE id = ?', [before.id]);
    const changes = gvDiff(scalarRow(before), scalarRow(role), ['name', 'level', 'data_scope', 'permissions', 'is_active']);
    await auditRecord(
      a.organizationId,
      a,
      data.permissions !== undefined ? 'role.permissions_changed' : 'role.updated',
      { entityType: 'ROLE', entityId: role.id, entityLabel: role.name, changes },
      req
    );
    return jsonOk(res, rolesShape(role));
  })
);

// ---------------------------------------------------------------------------
// DELETE /roles/:id
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requirePermission('roles', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const role = await dbOne('SELECT * FROM roles WHERE id = ? AND organization_id = ?', [req.params.id, a.organizationId]);
    if (!role) throw notFound('Role not found');
    if (gvBool(role.is_system)) {
      throw badRequest('Built-in roles cannot be deleted.');
    }
    const userCount = phpInt(await dbScalar('SELECT COUNT(*) FROM users WHERE role_id = ?', [role.id]));
    if (userCount > 0) {
      throw badRequest(`${userCount} user(s) still hold this role. Move them first.`);
    }
    await dbExec('DELETE FROM roles WHERE id = ?', [role.id]);
    await auditRecord(
      a.organizationId,
      a,
      'role.deleted',
      { entityType: 'ROLE', entityId: role.id, entityLabel: role.name },
      req
    );
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown roles route')));

export default router;
