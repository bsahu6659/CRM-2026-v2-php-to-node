/**
 * Hierarchy-based data visibility.
 *
 * Every list/read query is narrowed to the set of users the actor may see,
 * derived from two independent trees walked breadth-first in application code
 * rather than a recursive CTE, so the queries still run on MySQL 5.7:
 *
 *   - the reporting line   (users.manager_id)
 *   - the team tree        (teams.parent_team_id + team_members)
 *
 * Results are cached per request. The cache lives on the request object rather
 * than in a module-level map: a Node process is long-lived and shared by every
 * tenant, so a process-wide cache would hand one company's visibility set to
 * the next request that happened to hit the same key.
 */

import { dbAll, dbInClause } from './db.js';
import { scopeRank } from './permissions.js';

async function reportingDescendants(orgId, rootUserId) {
  const rows = await dbAll(
    'SELECT id, manager_id FROM users WHERE organization_id = ? AND manager_id IS NOT NULL',
    [orgId]
  );
  const childrenOf = new Map();
  for (const r of rows) {
    if (!childrenOf.has(r.manager_id)) childrenOf.set(r.manager_id, []);
    childrenOf.get(r.manager_id).push(r.id);
  }
  const out = new Set();
  const queue = [rootUserId];
  while (queue.length) {
    const current = queue.shift();
    for (const child of childrenOf.get(current) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return [...out];
}

async function teamsForUser(orgId, userId) {
  const memberships = await dbAll('SELECT team_id FROM team_members WHERE user_id = ?', [userId]);
  const managed = await dbAll('SELECT id FROM teams WHERE organization_id = ? AND manager_id = ?', [orgId, userId]);
  return [...new Set([...memberships.map((m) => m.team_id), ...managed.map((t) => t.id)])];
}

async function expandTeamTree(orgId, rootTeamIds) {
  const teams = await dbAll('SELECT id, parent_team_id FROM teams WHERE organization_id = ?', [orgId]);
  const childrenOf = new Map();
  for (const t of teams) {
    if (!t.parent_team_id) continue;
    if (!childrenOf.has(t.parent_team_id)) childrenOf.set(t.parent_team_id, []);
    childrenOf.get(t.parent_team_id).push(t.id);
  }
  const out = new Set(rootTeamIds);
  const queue = [...rootTeamIds];
  while (queue.length) {
    const current = queue.shift();
    for (const child of childrenOf.get(current) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return [...out];
}

async function usersInTeams(teamIds) {
  if (!teamIds.length) return [];
  const [inClause, params] = dbInClause(teamIds);
  const members = await dbAll(`SELECT user_id FROM team_members WHERE team_id IN ${inClause}`, params);
  const managers = await dbAll(
    `SELECT manager_id FROM teams WHERE id IN ${inClause} AND manager_id IS NOT NULL`,
    params
  );
  return [...new Set([...members.map((m) => m.user_id), ...managers.map((t) => t.manager_id)])];
}

/**
 * Resolves what the actor can see.
 *
 * `scopeKey` lets one actor resolve different visibility per permission —
 * read the whole region but export only your own rows.
 *
 * Returns { unrestricted, userIds, teamIds, canSeeUnassigned, scope, rank }.
 */
export async function resolveScope(actor, scopeKey = null, cache = null) {
  const scope = scopeKey || actor?.role?.dataScope || 'OWN';
  const cacheKey = `${actor.id}|${actor.organizationId}|${scope}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const ranks = scopeRank();
  const rank = ranks[scope] ?? 1;
  const orgId = actor.organizationId;

  const userIds = new Set([actor.id]);
  let teamIds = [];
  let unrestricted = false;

  if (rank >= ranks.ORGANIZATION) {
    unrestricted = true;
    const allTeams = await dbAll('SELECT id FROM teams WHERE organization_id = ?', [orgId]);
    teamIds = allTeams.map((t) => t.id);
  } else if (rank === ranks.REGION) {
    const region = actor.region ?? null;
    const peers = region
      ? await dbAll('SELECT id FROM users WHERE organization_id = ? AND region = ?', [orgId, region])
      : await dbAll('SELECT id FROM users WHERE organization_id = ? AND id = ?', [orgId, actor.id]);
    for (const u of peers) userIds.add(u.id);

    const regionTeams = region
      ? await dbAll('SELECT id FROM teams WHERE organization_id = ? AND region = ?', [orgId, region])
      : await dbAll('SELECT id FROM teams WHERE organization_id = ? AND manager_id = ?', [orgId, actor.id]);
    teamIds = await expandTeamTree(orgId, regionTeams.map((t) => t.id));

    for (const id of await reportingDescendants(orgId, actor.id)) userIds.add(id);
  } else if (rank === ranks.TEAM_AND_BELOW) {
    const own = await teamsForUser(orgId, actor.id);
    teamIds = await expandTeamTree(orgId, own);
    for (const id of await usersInTeams(teamIds)) userIds.add(id);
    for (const id of await reportingDescendants(orgId, actor.id)) userIds.add(id);
  } else if (rank === ranks.TEAM) {
    teamIds = await teamsForUser(orgId, actor.id);
    for (const id of await usersInTeams(teamIds)) userIds.add(id);
    const directs = await dbAll('SELECT id FROM users WHERE organization_id = ? AND manager_id = ?', [orgId, actor.id]);
    for (const u of directs) userIds.add(u.id);
  } else {
    teamIds = await teamsForUser(orgId, actor.id);
  }

  const perms = actor.permissions ?? {};
  const canSeeUnassigned =
    unrestricted || rank >= ranks.TEAM_AND_BELOW || (perms.leads ?? []).includes('assign');

  const value = {
    unrestricted,
    userIds: [...userIds],
    teamIds: [...new Set(teamIds)],
    canSeeUnassigned,
    scope,
    rank,
  };
  cache?.set(cacheKey, value);
  return value;
}

/**
 * Builds a SQL WHERE fragment (with `?` placeholders and matching params)
 * restricting rows to the actor's visibility. `sql` is either '' (no
 * restriction) or '(...)' ready to AND into a query.
 *
 * Column names come from the calling route, never from user input — they are
 * the only part interpolated rather than bound.
 */
export function visibilityWhere(scopeInfo, ownerColumn = 'owner_id', teamColumn = 'team_id', includeUnassigned = true) {
  if (scopeInfo.unrestricted) return { sql: '', params: [] };

  const clauses = [];
  let params = [];

  const [inUsers, userParams] = dbInClause(scopeInfo.userIds);
  clauses.push(`${ownerColumn} IN ${inUsers}`);
  params = params.concat(userParams);

  if (teamColumn && scopeInfo.teamIds.length) {
    const [inTeams, teamParams] = dbInClause(scopeInfo.teamIds);
    clauses.push(`${teamColumn} IN ${inTeams}`);
    params = params.concat(teamParams);
  }
  if (includeUnassigned && scopeInfo.canSeeUnassigned) {
    clauses.push(`${ownerColumn} IS NULL`);
  }
  return { sql: `(${clauses.join(' OR ')})`, params };
}

export async function canActOnUser(actor, targetUserId, cache = null) {
  if (actor.id === targetUserId) return true;
  const scopeInfo = await resolveScope(actor, null, cache);
  return scopeInfo.unrestricted || scopeInfo.userIds.includes(targetUserId);
}
