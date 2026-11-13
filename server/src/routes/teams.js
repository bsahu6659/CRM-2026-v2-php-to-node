/**
 * /api/teams/* — port of api/teams.php.
 *
 * Teams nest (parent_team_id) and the TEAM / TEAM_AND_BELOW data scopes walk
 * that tree, so the loop check on re-parenting is what keeps visibility
 * resolution from spinning forever.
 */

import express from 'express';
import { dbAll, dbExec, dbInClause, dbOne, dbScalar } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { camelize, gvDiff, gvId, round2, safeJson, toJson } from '../lib/util.js';
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

/**
 * PDO returns every column as a scalar, so the PHP edition saw `territory` as
 * JSON text everywhere except where it decoded it on purpose. mysql2 parses
 * native JSON columns into objects; re-serialising keeps camelize() out of
 * the stored JSON and gvDiff() comparing like with like.
 */
function scalarRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v !== null && typeof v === 'object' && !Buffer.isBuffer(v) ? JSON.stringify(v) : v;
  }
  return out;
}

function teamsShape(t, members, leadCount) {
  const out = camelize(scalarRow(t));
  delete out.managerFirstName;
  delete out.managerLastName;
  delete out.managerEmail;
  delete out.managerAvatarUrl;
  delete out.parentTeamName;
  out.territory = safeJson(t.territory ?? null, { countries: [], states: [], cities: [] });
  out.manager = t.manager_id
    ? {
        id: t.manager_id,
        firstName: t.manager_first_name,
        lastName: t.manager_last_name,
        email: t.manager_email,
        avatarUrl: t.manager_avatar_url,
      }
    : null;
  out.parentTeam = t.parent_team_id ? { id: t.parent_team_id, name: t.parent_team_name } : null;
  out.members = members.map((m) => ({
    teamRole: m.team_role,
    user: {
      id: m.id,
      firstName: m.first_name,
      lastName: m.last_name,
      email: m.email,
      avatarUrl: m.avatar_url,
      role: { name: m.role_name },
    },
  }));
  out.memberCount = members.length;
  out.leadCount = leadCount;
  return out;
}

/** The full team record; an empty array (as the PHP returned) when it is gone. */
async function teamsLoadFull(id) {
  const team = await dbOne(
    `SELECT t.*, m.first_name AS manager_first_name, m.last_name AS manager_last_name, m.email AS manager_email, m.avatar_url AS manager_avatar_url,
            pt.name AS parent_team_name
       FROM teams t LEFT JOIN users m ON m.id = t.manager_id LEFT JOIN teams pt ON pt.id = t.parent_team_id WHERE t.id = ?`,
    [id]
  );
  if (!team) return [];
  const members = await dbAll(
    `SELECT tm.team_role, u.id, u.first_name, u.last_name, u.email, u.avatar_url, r.name AS role_name
       FROM team_members tm JOIN users u ON u.id = tm.user_id LEFT JOIN roles r ON r.id = u.role_id WHERE tm.team_id = ?`,
    [id]
  );
  const leadCount = phpInt(await dbScalar('SELECT COUNT(*) FROM leads WHERE team_id = ?', [id]));
  return teamsShape(team, members, leadCount);
}

async function loadOrgTeam(req, id) {
  const team = await dbOne('SELECT * FROM teams WHERE id = ? AND organization_id = ?', [id, req.actor.organizationId]);
  if (!team) throw notFound('Team not found');
  return team;
}

// ---------------------------------------------------------------------------
// GET /teams — any signed-in user.
// ---------------------------------------------------------------------------
router.get(
  '/',
  ah(async (req, res) => {
    const a = req.actor;
    const query = req.query;
    let sql = 'SELECT * FROM teams WHERE organization_id = ?';
    const params = [a.organizationId];
    if (query.isActive !== undefined && query.isActive !== null) {
      sql += ' AND is_active = ?';
      params.push(query.isActive === 'true' ? 1 : 0);
    }
    sql += ' ORDER BY name ASC';
    const teams = await dbAll(sql, params);
    const out = [];
    for (const t of teams) out.push(await teamsLoadFull(t.id));
    return jsonOk(res, out);
  })
);

// ---------------------------------------------------------------------------
// GET /teams/tree
// ---------------------------------------------------------------------------
router.get(
  '/tree',
  ah(async (req, res) => {
    const a = req.actor;
    const teams = await dbAll('SELECT * FROM teams WHERE organization_id = ? ORDER BY name ASC', [a.organizationId]);
    // A Map keeps the name ordering; nodes are shared by reference, so a
    // child attached later still appears under its parent.
    const byId = new Map();
    for (const t of teams) {
      byId.set(t.id, { ...(await teamsLoadFull(t.id)), children: [] });
    }
    const roots = [];
    for (const node of byId.values()) {
      if (node.parentTeamId && byId.has(node.parentTeamId)) {
        byId.get(node.parentTeamId).children.push(node);
      } else {
        roots.push(node);
      }
    }
    return jsonOk(res, roots);
  })
);

// ---------------------------------------------------------------------------
// POST /teams
// ---------------------------------------------------------------------------
router.post(
  '/',
  requirePermission('teams', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    validate(body).required('name', 'Team name').maxLength('name', 100).validate();

    const teamId = gvId();
    await dbExec(
      'INSERT INTO teams (id, organization_id, name, description, parent_team_id, manager_id, region, territory, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())',
      [
        teamId, a.organizationId, body.name, body.description ?? null, body.parentTeamId ?? null,
        body.managerId ?? null, body.region ?? null, isSet(body, 'territory') ? toJson(body.territory) : null,
      ]
    );
    if (!phpEmpty(body.memberIds) && Array.isArray(body.memberIds)) {
      for (const userId of body.memberIds) {
        await dbExec('INSERT INTO team_members (id, team_id, user_id, joined_at) VALUES (?,?,?,NOW())', [gvId(), teamId, userId]);
      }
    }
    await auditRecord(a.organizationId, a, 'team.created', { entityType: 'TEAM', entityId: teamId, entityLabel: body.name }, req);
    return jsonCreated(res, await teamsLoadFull(teamId));
  })
);

// ---------------------------------------------------------------------------
// POST /teams/:id/members — add a member, or change their team role.
// ---------------------------------------------------------------------------
router.post(
  '/:id/members',
  requirePermission('teams', 'update'),
  ah(async (req, res) => {
    const body = req.body ?? {};
    const team = await loadOrgTeam(req, req.params.id);
    const userId = body.userId ?? null;
    const user = !phpEmpty(userId)
      ? await dbOne('SELECT id FROM users WHERE id = ? AND organization_id = ?', [userId, team.organization_id])
      : null;
    if (!user) throw badRequest('Unknown user');
    const existing = await dbOne('SELECT id FROM team_members WHERE team_id = ? AND user_id = ?', [team.id, userId]);
    const teamRole = body.teamRole ?? 'MEMBER';
    if (existing) {
      await dbExec('UPDATE team_members SET team_role = ? WHERE id = ?', [teamRole, existing.id]);
    } else {
      await dbExec('INSERT INTO team_members (id, team_id, user_id, team_role, joined_at) VALUES (?,?,?,?,NOW())', [
        gvId(), team.id, userId, teamRole,
      ]);
    }
    return jsonOk(res, { added: true });
  })
);

// ---------------------------------------------------------------------------
// DELETE /teams/:id/members/:userId
// ---------------------------------------------------------------------------
router.delete(
  '/:id/members/:userId',
  requirePermission('teams', 'update'),
  ah(async (req, res) => {
    const team = await loadOrgTeam(req, req.params.id);
    await dbExec('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', [team.id, req.params.userId]);
    return jsonOk(res, { removed: true });
  })
);

// ---------------------------------------------------------------------------
// GET /teams/:id — the team plus its pipeline figures.
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  ah(async (req, res) => {
    const team = await loadOrgTeam(req, req.params.id);
    const memberIds = (await dbAll('SELECT user_id FROM team_members WHERE team_id = ?', [team.id])).map((r) => r.user_id);
    // A sentinel keeps `IN (...)` valid for a team with no members yet.
    memberIds.push('__none__');
    const [inSql, p] = dbInClause(memberIds);
    const base = [team.organization_id, team.id, ...p];

    const leads = phpInt(
      await dbScalar(`SELECT COUNT(*) FROM leads WHERE organization_id = ? AND (team_id = ? OR owner_id IN ${inSql})`, base)
    );
    const converted = phpInt(
      await dbScalar(
        `SELECT COUNT(*) FROM leads WHERE organization_id = ? AND is_converted = 1 AND (team_id = ? OR owner_id IN ${inSql})`,
        base
      )
    );
    const revenue = Number(
      (await dbScalar(
        `SELECT SUM(COALESCE(expected_value, budget_max)) FROM leads WHERE organization_id = ? AND is_converted = 1 AND (team_id = ? OR owner_id IN ${inSql})`,
        base
      )) ?? 0
    );
    const siteVisits = phpInt(
      await dbScalar(
        `SELECT COUNT(*) FROM leads WHERE organization_id = ? AND site_visit_at IS NOT NULL AND (team_id = ? OR owner_id IN ${inSql})`,
        base
      )
    );
    return jsonOk(res, {
      ...(await teamsLoadFull(team.id)),
      stats: { leads, converted, revenue: round2(revenue), siteVisits },
    });
  })
);

// ---------------------------------------------------------------------------
// PATCH /teams/:id
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requirePermission('teams', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const before = await loadOrgTeam(req, req.params.id);

    const data = {};
    const fields = { name: 'name', description: 'description', region: 'region', managerId: 'manager_id' };
    for (const [camel, col] of Object.entries(fields)) {
      if (has(body, camel)) data[col] = orNull(body[camel]);
    }
    if (has(body, 'isActive')) {
      data.is_active = phpEmpty(body.isActive) ? 0 : 1;
    }
    if (has(body, 'territory')) {
      data.territory = phpEmpty(body.territory) ? null : toJson(body.territory);
    }
    if (has(body, 'parentTeamId')) {
      if (body.parentTeamId === before.id) {
        throw badRequest('A team cannot be its own parent.');
      }
      if (!phpEmpty(body.parentTeamId)) {
        let cursor = body.parentTeamId;
        const seen = new Set([before.id]);
        while (!phpEmpty(cursor)) {
          if (seen.has(cursor)) {
            throw badRequest('That would create a loop in the team tree.');
          }
          seen.add(cursor);
          cursor = await dbScalar('SELECT parent_team_id FROM teams WHERE id = ?', [cursor]);
        }
      }
      data.parent_team_id = orNull(body.parentTeamId);
    }
    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE teams SET ${sets}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), before.id]);
    }
    if (has(body, 'memberIds') && Array.isArray(body.memberIds)) {
      if (body.memberIds.length) {
        const [inSql, p] = dbInClause(body.memberIds);
        await dbExec(`DELETE FROM team_members WHERE team_id = ? AND user_id NOT IN ${inSql}`, [before.id, ...p]);
      } else {
        await dbExec('DELETE FROM team_members WHERE team_id = ?', [before.id]);
      }
      for (const userId of body.memberIds) {
        if (!(await dbOne('SELECT id FROM team_members WHERE team_id = ? AND user_id = ?', [before.id, userId]))) {
          await dbExec('INSERT INTO team_members (id, team_id, user_id, joined_at) VALUES (?,?,?,NOW())', [gvId(), before.id, userId]);
        }
      }
    }
    const team = await dbOne('SELECT * FROM teams WHERE id = ?', [before.id]);
    const changes = gvDiff(scalarRow(before), scalarRow(team), Object.keys(data));
    await auditRecord(
      a.organizationId,
      a,
      'team.updated',
      { entityType: 'TEAM', entityId: team.id, entityLabel: team.name, changes },
      req
    );
    return jsonOk(res, await teamsLoadFull(team.id));
  })
);

// ---------------------------------------------------------------------------
// DELETE /teams/:id
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requirePermission('teams', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const team = await loadOrgTeam(req, req.params.id);
    const childCount = phpInt(await dbScalar('SELECT COUNT(*) FROM teams WHERE parent_team_id = ?', [team.id]));
    if (childCount > 0) {
      throw badRequest('Move or delete the child teams first.');
    }
    // Leads keep their owner; only the team attribution is cleared.
    await dbExec('UPDATE leads SET team_id = NULL WHERE team_id = ?', [team.id]);
    await dbExec('DELETE FROM teams WHERE id = ?', [team.id]);
    await auditRecord(a.organizationId, a, 'team.deleted', { entityType: 'TEAM', entityId: team.id, entityLabel: team.name }, req);
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown teams route')));

export default router;
