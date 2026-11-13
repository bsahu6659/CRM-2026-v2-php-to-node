/**
 * Lead distribution engine — port of services/Assignment.php. Rules run in
 * `priority` order; the first match wins unless it opts to keep going.
 * Round-robin fairness survives restarts and spans every worker process
 * because the rotation cursor lives on the rule row in MySQL, not in memory.
 */

import { dbAll, dbExec, dbInClause, dbOne, dbTransaction } from '../lib/db.js';
import { gvBool, safeJson } from '../lib/util.js';
import { evaluateGroup } from './conditions.js';

export const GV_ASSIGNMENT_STRATEGIES = [
  { key: 'ROUND_ROBIN', label: 'Round robin across selected users' },
  { key: 'LOAD_BALANCED', label: 'Least open leads first' },
  { key: 'USER', label: 'Always a specific user' },
  { key: 'TEAM', label: 'Team queue (team set, owner left open)' },
  { key: 'TEAM_ROUND_ROBIN', label: 'Round robin inside a team' },
  { key: 'MANAGER', label: 'The team manager' },
];

/** A JSON list or object as a plain list of its values (PHP arrays are both). */
function listOf(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return Object.values(value);
  return [];
}

export async function assignableUsers(orgId, userIds) {
  const ids = listOf(userIds);
  if (!ids.length) {
    return [];
  }
  const [inSql, p] = dbInClause(ids);
  const users = await dbAll(
    `SELECT id, assignment_weight FROM users WHERE organization_id = ? AND id IN ${inSql} AND is_active = 1 AND is_assignable = 1 ORDER BY created_at ASC`,
    [orgId, ...p]
  );
  const expanded = [];
  for (const u of users) {
    const weight = Math.max(1, Math.min(10, Math.trunc(Number(u.assignment_weight) || 0)));
    for (let i = 0; i < weight; i++) {
      expanded.push(u.id);
    }
  }
  return expanded;
}

export async function teamMemberIds(teamId) {
  const rows = await dbAll('SELECT user_id FROM team_members WHERE team_id = ?', [teamId]);
  return rows.map((r) => r.user_id);
}

export async function leastLoadedUser(orgId, candidateIds) {
  const unique = [...new Set(candidateIds)];
  if (!unique.length) {
    return null;
  }
  const [inSql, p] = dbInClause(unique);
  const rows = await dbAll(
    `SELECT l.owner_id, COUNT(*) AS cnt FROM leads l
     JOIN lead_statuses s ON s.id = l.status_id
     WHERE l.organization_id = ? AND l.owner_id IN ${inSql} AND l.is_converted = 0 AND l.is_duplicate = 0
       AND s.is_lost = 0 AND s.is_junk = 0
     GROUP BY l.owner_id`,
    [orgId, ...p]
  );
  const byUser = {};
  for (const r of rows) {
    byUser[r.owner_id] = Math.trunc(Number(r.cnt) || 0);
  }
  let best = unique[0];
  let bestCount = byUser[best] ?? 0;
  for (const id of unique) {
    const count = byUser[id] ?? 0;
    if (count < bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Advances a rule's rotation cursor atomically and returns the index consumed.
 *
 * The increment and the read-back share one connection (a transaction) so the
 * row lock taken by the UPDATE covers the SELECT — from a pool they could
 * otherwise run on different connections and two simultaneous leads could
 * read the same cursor and land on the same person.
 */
export async function nextCursor(ruleId) {
  return dbTransaction(async () => {
    await dbExec('UPDATE assignment_rules SET cursor_pos = cursor_pos + 1, assigned_count = assigned_count + 1 WHERE id = ?', [ruleId]);
    const row = await dbOne('SELECT cursor_pos FROM assignment_rules WHERE id = ?', [ruleId]);
    return Math.trunc(Number(row?.cursor_pos) || 0) - 1;
  });
}

export async function resolveAssignmentTarget(rule, lead) {
  const targetUserIds = listOf(safeJson(rule.target_user_ids, []));
  const orgId = lead.organizationId;

  switch (rule.strategy) {
    case 'USER': {
      const pool = await assignableUsers(orgId, targetUserIds.slice(0, 1));
      return { ownerId: pool[0] ?? null, teamId: rule.target_team_id || null };
    }

    case 'TEAM':
      return { ownerId: null, teamId: rule.target_team_id || null };

    case 'MANAGER': {
      if (!rule.target_team_id) {
        return { ownerId: null, teamId: null };
      }
      const team = await dbOne('SELECT manager_id FROM teams WHERE id = ?', [rule.target_team_id]);
      return { ownerId: team?.manager_id ?? null, teamId: rule.target_team_id };
    }

    case 'TEAM_ROUND_ROBIN': {
      if (!rule.target_team_id) {
        return { ownerId: null, teamId: null };
      }
      const pool = await assignableUsers(orgId, await teamMemberIds(rule.target_team_id));
      if (!pool.length) {
        return { ownerId: null, teamId: rule.target_team_id };
      }
      const idx = await nextCursor(rule.id);
      return { ownerId: pool[idx % pool.length] ?? null, teamId: rule.target_team_id };
    }

    case 'LOAD_BALANCED': {
      const base = targetUserIds.length
        ? targetUserIds
        : (rule.target_team_id ? await teamMemberIds(rule.target_team_id) : []);
      const pool = await assignableUsers(orgId, base);
      if (!pool.length) {
        return { ownerId: null, teamId: rule.target_team_id || null };
      }
      await dbExec('UPDATE assignment_rules SET assigned_count = assigned_count + 1 WHERE id = ?', [rule.id]);
      return { ownerId: await leastLoadedUser(orgId, pool), teamId: rule.target_team_id || null };
    }

    case 'ROUND_ROBIN':
    default: {
      const base = targetUserIds.length
        ? targetUserIds
        : (rule.target_team_id ? await teamMemberIds(rule.target_team_id) : []);
      const pool = await assignableUsers(orgId, base);
      if (!pool.length) {
        return { ownerId: null, teamId: rule.target_team_id || null };
      }
      const idx = await nextCursor(rule.id);
      return { ownerId: pool[idx % pool.length] ?? null, teamId: rule.target_team_id || null };
    }
  }
}

/** Returns { ownerId, teamId, ruleId, ruleName } or null. */
export async function resolveAssignment(lead) {
  const rules = await dbAll(
    'SELECT * FROM assignment_rules WHERE organization_id = ? AND is_active = 1 ORDER BY priority ASC, created_at ASC',
    [lead.organizationId]
  );
  let result = null;
  for (const rule of rules) {
    if (!evaluateGroup(lead, rule.conditions)) {
      continue;
    }
    const target = await resolveAssignmentTarget(rule, lead);
    if (!target.ownerId && !target.teamId) {
      continue;
    }
    result = { ...target, ruleId: rule.id, ruleName: rule.name };
    if (gvBool(rule.stop_on_match)) {
      break;
    }
  }
  return result;
}

/** Org-wide load-balanced fallback used when no rule matched. */
export async function fallbackRoundRobin(orgId) {
  const org = await dbOne('SELECT settings FROM organizations WHERE id = ?', [orgId]);
  const settings = safeJson(org?.settings ?? '{}', []);
  if ((settings?.autoAssignFallback ?? true) === false) {
    return null;
  }
  const users = await dbAll(
    'SELECT id FROM users WHERE organization_id = ? AND is_active = 1 AND is_assignable = 1 ORDER BY created_at ASC',
    [orgId]
  );
  if (!users.length) {
    return null;
  }
  return { ownerId: await leastLoadedUser(orgId, users.map((u) => u.id)), teamId: null, ruleName: 'Default load balancing' };
}
