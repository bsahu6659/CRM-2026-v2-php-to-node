/**
 * Reporting and analytics — port of services/Reports.php.
 *
 * Everything here is aggregate-only and scope-aware: the same WHERE-clause
 * builders that power the list endpoints (services/filters.js) power the
 * reports, so a Team Leader's dashboard totals always reconcile with the rows
 * they can actually open. Aggregation is pushed into MySQL (COUNT/SUM/GROUP BY)
 * — no report pulls a full row set into Node just to count it.
 *
 * mysql2 returns DECIMAL and SUM() results as strings, so every figure is
 * coerced explicitly, exactly where the PHP cast it with (int)/(float).
 */

import { dbAll, dbInClause, dbScalar } from '../lib/db.js';
import { endOfDay, nowSql, pct, round2, startOfDay, toSqlDate, gvBool } from '../lib/util.js';
import { buildLeadWhere, dateRange } from './filters.js';

// ---------------------------------------------------------------------------
// Small local helpers standing in for PHP casts and array functions.
// ---------------------------------------------------------------------------
const toInt = (v) => Math.trunc(Number(v) || 0);
const toFloat = (v) => Number(v) || 0;

/** PHP's <=> for numbers. */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** PHP round() rounds halves away from zero; Math.round rounds them up. */
const phpRound = (n) => Math.sign(n) * Math.round(Math.abs(n));

/**
 * PHP array keys: a NULL group key becomes "" (PHP 8 array_column), and every
 * key compares as a string. Keeping that rule is what lets the "Not set" group
 * pick up its own converted/qualified counts.
 */
const keyOf = (k) => (k === null || k === undefined ? '' : String(k));

/** array_column($rows, $valueKey, $indexKey) as a Map keyed by keyOf(). */
function columnMap(rows, valueKey, indexKey) {
  const out = new Map();
  for (const r of rows) out.set(keyOf(r[indexKey]), r[valueKey]);
  return out;
}

/** array_column($rows, null, 'id'): rows indexed by id, with no prototype to collide with. */
function indexBy(rows, key = 'id') {
  const out = Object.create(null);
  for (const r of rows) out[keyOf(r[key])] = r;
  return out;
}

/**
 * 'YYYY-MM-DD HH:MM:SS' read as local time — PHP's strtotime() in the server's
 * zone. `new Date(string)` would read a bare date as UTC midnight and shift it
 * a day in any zone west of Greenwich.
 */
function sqlTime(value) {
  if (value instanceof Date) return value.getTime();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(value ?? ''));
  if (!m) return new Date(value).getTime();
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime();
}

/** date('Y-m-d', strtotime($value)) */
function dayKey(value) {
  if (value instanceof Date) return toSqlDate(value);
  return toSqlDate(new Date(sqlTime(value)));
}

export function gvUserLabel(u) {
  return u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() : 'Unassigned';
}

/** Small per-request lookup tables so grouped ids can be turned into labels. */
export async function gvLabelMaps(orgId) {
  const statuses = await dbAll('SELECT * FROM lead_statuses WHERE organization_id = ? ORDER BY sort_order ASC', [orgId]);
  const sources = await dbAll('SELECT * FROM lead_sources WHERE organization_id = ? ORDER BY sort_order ASC', [orgId]);
  const users = await dbAll('SELECT id, first_name, last_name, email, avatar_url FROM users WHERE organization_id = ?', [orgId]);
  const teams = await dbAll('SELECT id, name FROM teams WHERE organization_id = ?', [orgId]);
  // Any project this tenant's leads point at - including shared ones, which
  // is why this is not filtered by projects.organization_id.
  const projects = await dbAll(
    `SELECT DISTINCT projects.id, projects.name, projects.location
       FROM projects JOIN leads ON leads.project_id = projects.id
      WHERE leads.organization_id = ?`,
    [orgId]
  );

  return {
    statuses: indexBy(statuses),
    statusList: statuses,
    sources: indexBy(sources),
    sourceList: sources,
    users: indexBy(users),
    teams: indexBy(teams),
    projects: indexBy(projects),
    projectList: projects,
  };
}

/** maps.users[id] etc., treating a NULL id the way PHP does (no match). */
function lookup(table, id) {
  return table[keyOf(id)] ?? null;
}

export function gvLeaderboardRowInit(id, maps) {
  const u = lookup(maps.users, id);
  return {
    userId: id, name: gvUserLabel(u), email: u?.email ?? '', avatarUrl: u?.avatar_url ?? null,
    leads: 0, converted: 0, siteVisits: 0, revenue: 0.0, deals: 0, activities: 0, conversionRate: 0.0,
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/**
 * The dashboard, built on the real-estate funnel rather than a sales pipeline.
 *
 * There is no separate deal object here: an enquiry becomes a site visit,
 * a site visit becomes a booking, and a booking is a lead status carrying
 * `is_converted`. Everything below is therefore a query over `leads`.
 */
export async function reportsDashboard(orgId, scopeInfo, query) {
  const leadWhere = await buildLeadWhere(query, scopeInfo, orgId);
  const maps = await gvLabelMaps(orgId);

  const statusIdsWhere = (flag) => maps.statusList.filter((s) => gvBool(s[flag])).map((s) => s.id);
  const qualifiedStatusIds = statusIdsWhere('is_qualified');
  const lostStatusIds = statusIdsWhere('is_lost');
  const junkStatusIds = statusIdsWhere('is_junk');
  const newStatusIds = statusIdsWhere('is_default');

  /** Counts leads matching the base filter plus one extra clause. */
  const countLeads = async (extra = '', extraParams = []) =>
    toInt(
      await dbScalar(
        `SELECT COUNT(*) FROM leads ${leadWhere.sql}` + (extra ? ` AND ${extra}` : ''),
        [...leadWhere.params, ...extraParams]
      )
    );
  const countByStatusIds = async (ids) => {
    if (!ids.length) {
      return 0;
    }
    const [inSql, p] = dbInClause(ids);
    return countLeads(`status_id IN ${inSql}`, p);
  };

  const totalLeads = await countLeads();
  const newLeads = await countByStatusIds(newStatusIds);
  const assignedLeads = await countLeads('owner_id IS NOT NULL');
  const unassignedLeads = await countLeads('owner_id IS NULL');
  const lostLeads = await countByStatusIds(lostStatusIds);
  const junkLeads = await countByStatusIds(junkStatusIds);

  let qualifiedLeads;
  if (qualifiedStatusIds.length) {
    const [inSql, p] = dbInClause(qualifiedStatusIds);
    qualifiedLeads = await countLeads(`(status_id IN ${inSql} OR qualified_at IS NOT NULL)`, p);
  } else {
    qualifiedLeads = await countLeads('qualified_at IS NOT NULL');
  }

  const convertedLeads = await countLeads('is_converted = 1');
  const contacted = await countLeads('last_contacted_at IS NOT NULL');

  // The two metrics a real-estate sales head actually watches.
  const siteVisitsBooked = await countLeads('site_visit_at IS NOT NULL');
  const siteVisitsDone = await countLeads('site_visit_at IS NOT NULL AND site_visit_at <= ?', [nowSql()]);
  const siteVisitsUpcoming = await countLeads('site_visit_at > ?', [nowSql()]);

  const followUpsDue = await countLeads(
    'is_converted = 0 AND next_follow_up_at >= ? AND next_follow_up_at <= ?',
    [startOfDay(), endOfDay()]
  );
  const followUpsOverdue = await countLeads('is_converted = 0 AND next_follow_up_at < ?', [startOfDay()]);

  // Booking value comes off the lead's own budget, since there is no deal
  // record to carry an amount.
  const bookedValue = toFloat(
    (await dbScalar(
      `SELECT SUM(COALESCE(expected_value, budget_max)) FROM leads ${leadWhere.sql} AND is_converted = 1`,
      leadWhere.params
    )) ?? 0
  );
  const openValue = toFloat(
    (await dbScalar(
      `SELECT SUM(COALESCE(expected_value, budget_max)) FROM leads ${leadWhere.sql} AND is_converted = 0`,
      leadWhere.params
    )) ?? 0
  );

  const trend = await reportsLeadTrend(orgId, scopeInfo, query);
  const byStatusRows = await dbAll(`SELECT status_id, COUNT(*) AS cnt FROM leads ${leadWhere.sql} GROUP BY status_id`, leadWhere.params);
  const bySourceRows = await dbAll(`SELECT source_id, COUNT(*) AS cnt FROM leads ${leadWhere.sql} GROUP BY source_id`, leadWhere.params);
  const byOwnerRows = await dbAll(`SELECT owner_id, COUNT(*) AS cnt FROM leads ${leadWhere.sql} GROUP BY owner_id`, leadWhere.params);
  const byProjectRows = await dbAll(
    `SELECT project_id, COUNT(*) AS cnt FROM leads ${leadWhere.sql} AND project_id IS NOT NULL GROUP BY project_id`,
    leadWhere.params
  );

  // Qualified because users and leads are joined in below, and both also
  // carry an organization_id.
  let actSql;
  let actParams;
  if (scopeInfo.unrestricted) {
    actSql = 'activities.organization_id = ?';
    actParams = [orgId];
  } else {
    const [inSql, p] = dbInClause(scopeInfo.userIds);
    actSql = `activities.organization_id = ? AND (activities.user_id IN ${inSql} OR activities.user_id IS NULL)`;
    actParams = [orgId, ...p];
  }
  const activityRows = await dbAll(
    `SELECT activities.type, activities.subject, activities.occurred_at, activities.user_id, activities.lead_id,
            u.first_name AS u_first_name, u.last_name AS u_last_name, u.avatar_url AS u_avatar_url,
            l.code AS l_code, l.first_name AS l_first_name, l.last_name AS l_last_name
     FROM activities LEFT JOIN users u ON u.id = activities.user_id LEFT JOIN leads l ON l.id = activities.lead_id
     WHERE ${actSql} ORDER BY activities.occurred_at DESC LIMIT 12`,
    actParams
  );
  const recentActivities = activityRows.map((r) => ({
    type: r.type, subject: r.subject, occurredAt: r.occurred_at,
    lead: r.lead_id ? { id: r.lead_id, code: r.l_code, firstName: r.l_first_name, lastName: r.l_last_name } : null,
    user: r.user_id ? { id: r.user_id, firstName: r.u_first_name, lastName: r.u_last_name, avatarUrl: r.u_avatar_url } : null,
  }));

  // Replaces the old task list: the work queue is leads that are due, which
  // is what "follow-up" means now that tasks are gone.
  const followUpRows = await dbAll(
    `SELECT leads.id, leads.code, leads.first_name, leads.last_name, leads.phone,
            leads.next_follow_up_at, leads.site_visit_at, leads.owner_id,
            projects.name AS project_name,
            u.first_name AS o_first_name, u.last_name AS o_last_name
       FROM leads
       LEFT JOIN projects ON projects.id = leads.project_id
       LEFT JOIN users u ON u.id = leads.owner_id
       ${leadWhere.sql} AND leads.is_converted = 0 AND leads.next_follow_up_at IS NOT NULL
      ORDER BY leads.next_follow_up_at ASC LIMIT 8`,
    leadWhere.params
  );
  const upcomingFollowUps = followUpRows.map((r) => ({
    id: r.id,
    code: r.code,
    name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
    phone: r.phone,
    dueAt: r.next_follow_up_at,
    siteVisitAt: r.site_visit_at,
    projectName: r.project_name,
    owner: r.owner_id ? { id: r.owner_id, firstName: r.o_first_name, lastName: r.o_last_name } : null,
  }));

  const leaderboard = await reportsTeamLeaderboard(orgId, scopeInfo, query, maps);

  const byStatus = byStatusRows.map((r) => {
    const status = lookup(maps.statuses, r.status_id);
    return {
      id: r.status_id, label: status?.name ?? 'Unknown',
      color: status?.color ?? '#94a3b8',
      order: status?.sort_order ?? 99, count: toInt(r.cnt),
    };
  });
  byStatus.sort((a, b) => cmp(Number(a.order), Number(b.order)));

  let bySource = bySourceRows.map((r) => ({
    id: r.source_id, label: r.source_id ? (lookup(maps.sources, r.source_id)?.name ?? 'Unknown') : 'Direct / Unknown',
    count: toInt(r.cnt),
  }));
  bySource.sort((a, b) => cmp(b.count, a.count));
  bySource = bySource.slice(0, 10);

  let byOwner = byOwnerRows.map((r) => ({ id: r.owner_id, label: gvUserLabel(lookup(maps.users, r.owner_id)), count: toInt(r.cnt) }));
  byOwner.sort((a, b) => cmp(b.count, a.count));
  byOwner = byOwner.slice(0, 10);

  let byProject = byProjectRows.map((r) => ({
    id: r.project_id,
    label: lookup(maps.projects, r.project_id)?.name ?? 'Unknown',
    count: toInt(r.cnt),
  }));
  byProject.sort((a, b) => cmp(b.count, a.count));
  byProject = byProject.slice(0, 10);

  return {
    kpis: {
      totalLeads, newLeads,
      assignedLeads, unassignedLeads,
      qualifiedLeads, convertedLeads,
      lostLeads, junkLeads,
      followUpsDue, followUpsOverdue,
      siteVisitsBooked,
      siteVisitsDone,
      siteVisitsUpcoming,
      bookings: convertedLeads,
      bookedValue: round2(bookedValue),
      openValue: round2(openValue),
      conversionRate: pct(convertedLeads, totalLeads),
      qualificationRate: pct(qualifiedLeads, totalLeads),
      siteVisitRate: pct(siteVisitsBooked, totalLeads),
    },
    trend,
    byStatus,
    bySource,
    byOwner,
    byProject,
    funnel: [
      { label: 'Enquiries', value: totalLeads },
      { label: 'Contacted', value: contacted },
      { label: 'Qualified', value: qualifiedLeads },
      { label: 'Site visits', value: siteVisitsBooked },
      { label: 'Booked', value: convertedLeads },
    ],
    leaderboard,
    recentActivities,
    upcomingFollowUps,
  };
}

/** Daily lead / conversion counts for the trend chart. */
export async function reportsLeadTrend(orgId, scopeInfo, query) {
  const range = await dateRange(query);
  const to = range.to || endOfDay();
  const toTs = sqlTime(to);
  const from = range.from || startOfDay(new Date(toTs - 29 * 86400 * 1000));
  const fromTs = sqlTime(from);
  const days = Math.min(120, Math.max(1, Math.trunc(phpRound((toTs - fromTs) / 1000 / 86400)) + 1));

  const leadQuery = { ...query };
  delete leadQuery.range;
  delete leadQuery.from;
  delete leadQuery.to;
  const where = await buildLeadWhere(leadQuery, scopeInfo, orgId);
  const rows = await dbAll(
    `SELECT created_at, converted_at, qualified_at FROM leads ${where.sql} AND created_at >= ? AND created_at <= ?`,
    [...where.params, from, to]
  );

  const buckets = new Map();
  for (let i = 0; i < days; i++) {
    const day = toSqlDate(new Date(fromTs + i * 86400 * 1000));
    buckets.set(day, { date: day, leads: 0, qualified: 0, converted: 0 });
  }
  for (const row of rows) {
    const bucket = buckets.get(dayKey(row.created_at));
    if (!bucket) {
      continue;
    }
    bucket.leads++;
    if (row.qualified_at) {
      bucket.qualified++;
    }
    if (row.converted_at) {
      bucket.converted++;
    }
  }
  return [...buckets.values()];
}

export async function reportsTeamLeaderboard(orgId, scopeInfo, query, maps = null) {
  maps = maps ?? (await gvLabelMaps(orgId));
  const leadWhere = await buildLeadWhere(query, scopeInfo, orgId);

  const leadCounts = await dbAll(
    `SELECT owner_id, COUNT(*) AS cnt FROM leads ${leadWhere.sql} AND owner_id IS NOT NULL GROUP BY owner_id`,
    leadWhere.params
  );
  const convertedCounts = await dbAll(
    `SELECT owner_id, COUNT(*) AS cnt FROM leads ${leadWhere.sql} AND owner_id IS NOT NULL AND is_converted = 1 GROUP BY owner_id`,
    leadWhere.params
  );
  // A booking is the deal. Its value is the lead's own budget, since there
  // is no separate deal record to carry an amount.
  const wonAgg = await dbAll(
    `SELECT owner_id, SUM(COALESCE(expected_value, budget_max)) AS amt, COUNT(*) AS cnt
       FROM leads ${leadWhere.sql} AND owner_id IS NOT NULL AND is_converted = 1 GROUP BY owner_id`,
    leadWhere.params
  );
  const siteVisitCounts = await dbAll(
    `SELECT owner_id, COUNT(*) AS cnt FROM leads ${leadWhere.sql} AND owner_id IS NOT NULL AND site_visit_at IS NOT NULL GROUP BY owner_id`,
    leadWhere.params
  );

  let activityParams = [orgId];
  let activitySql = "organization_id = ? AND type IN ('CALL','MEETING','EMAIL','WHATSAPP') AND user_id IS NOT NULL";
  if (!scopeInfo.unrestricted) {
    const [inSql, p] = dbInClause(scopeInfo.userIds);
    activitySql += ` AND user_id IN ${inSql}`;
    activityParams = [...activityParams, ...p];
  }
  const activityCounts = await dbAll(`SELECT user_id, COUNT(*) AS cnt FROM activities WHERE ${activitySql} GROUP BY user_id`, activityParams);

  // Insertion-ordered, like the PHP associative array it replaces.
  const byUser = new Map();
  const rowFor = (id) => {
    if (!byUser.has(id)) byUser.set(id, gvLeaderboardRowInit(id, maps));
    return byUser.get(id);
  };
  for (const r of leadCounts) {
    rowFor(r.owner_id).leads = toInt(r.cnt);
  }
  for (const r of convertedCounts) {
    rowFor(r.owner_id).converted = toInt(r.cnt);
  }
  for (const r of wonAgg) {
    if (!r.owner_id) {
      continue;
    }
    const row = rowFor(r.owner_id);
    row.revenue = round2(toFloat(r.amt ?? 0));
    row.deals = toInt(r.cnt);
  }
  for (const r of siteVisitCounts) {
    rowFor(r.owner_id).siteVisits = toInt(r.cnt);
  }
  for (const r of activityCounts) {
    if (!r.user_id) {
      continue;
    }
    rowFor(r.user_id).activities = toInt(r.cnt);
  }

  const rows = [];
  for (const row of byUser.values()) {
    row.conversionRate = pct(row.converted, row.leads);
    rows.push(row);
  }
  rows.sort((a, b) => cmp(b.revenue, a.revenue) || cmp(b.converted, a.converted) || cmp(b.leads, a.leads));
  return rows.slice(0, 15);
}

// ---------------------------------------------------------------------------
// Lead reports
// ---------------------------------------------------------------------------

export const GV_LEAD_DIMENSIONS = {
  project: { field: 'project_id', label: 'Project' },
  source: { field: 'source_id', label: 'Lead source' },
  status: { field: 'status_id', label: 'Lead status' },
  owner: { field: 'owner_id', label: 'Owner' },
  team: { field: 'team_id', label: 'Team' },
  city: { field: 'city', label: 'City' },
  state: { field: 'state', label: 'State' },
  country: { field: 'country', label: 'Country' },
  priority: { field: 'priority', label: 'Priority' },
  scoreBand: { field: 'score_band', label: 'Score band' },
};

export async function leadReport(orgId, scopeInfo, query) {
  const requested = query?.dimension;
  const dimKey =
    requested !== undefined && requested !== null && Object.prototype.hasOwnProperty.call(GV_LEAD_DIMENSIONS, requested)
      ? requested
      : 'source';
  const dimension = GV_LEAD_DIMENSIONS[dimKey];
  const field = dimension.field;
  const where = await buildLeadWhere(query, scopeInfo, orgId);
  const maps = await gvLabelMaps(orgId);

  // `field` comes from the whitelist above, never from the request.
  const total = toInt(await dbScalar(`SELECT COUNT(*) FROM leads ${where.sql}`, where.params));
  const grouped = await dbAll(`SELECT \`${field}\` AS k, COUNT(*) AS cnt FROM leads ${where.sql} GROUP BY \`${field}\``, where.params);
  const converted = await dbAll(`SELECT \`${field}\` AS k, COUNT(*) AS cnt FROM leads ${where.sql} AND is_converted = 1 GROUP BY \`${field}\``, where.params);
  const qualified = await dbAll(`SELECT \`${field}\` AS k, COUNT(*) AS cnt FROM leads ${where.sql} AND qualified_at IS NOT NULL GROUP BY \`${field}\``, where.params);
  const values = await dbAll(`SELECT \`${field}\` AS k, SUM(expected_value) AS val FROM leads ${where.sql} GROUP BY \`${field}\``, where.params);
  const siteVisits = await dbAll(`SELECT \`${field}\` AS k, COUNT(*) AS cnt FROM leads ${where.sql} AND site_visit_at IS NOT NULL GROUP BY \`${field}\``, where.params);

  const convertedMap = columnMap(converted, 'cnt', 'k');
  const qualifiedMap = columnMap(qualified, 'cnt', 'k');
  const valueMap = columnMap(values, 'val', 'k');
  const siteVisitMap = columnMap(siteVisits, 'cnt', 'k');

  const resolveLabel = (key) => {
    if (key === null || key === undefined || key === '') {
      return 'Not set';
    }
    switch (field) {
      case 'source_id': return lookup(maps.sources, key)?.name ?? 'Unknown';
      case 'status_id': return lookup(maps.statuses, key)?.name ?? 'Unknown';
      case 'owner_id': return gvUserLabel(lookup(maps.users, key));
      case 'team_id': return lookup(maps.teams, key)?.name ?? 'Unknown';
      case 'project_id': return lookup(maps.projects, key)?.name ?? 'Unknown';
      default: return String(key);
    }
  };

  const rows = grouped.map((r) => {
    const key = r.k;
    const k = keyOf(key);
    const leads = toInt(r.cnt);
    const convertedCount = toInt(convertedMap.get(k) ?? 0);
    const qualifiedCount = toInt(qualifiedMap.get(k) ?? 0);
    return {
      key,
      label: resolveLabel(key),
      leads,
      qualified: qualifiedCount,
      converted: convertedCount,
      siteVisits: toInt(siteVisitMap.get(k) ?? 0),
      qualificationRate: pct(qualifiedCount, leads),
      conversionRate: pct(convertedCount, leads),
      siteVisitRate: pct(toInt(siteVisitMap.get(k) ?? 0), leads),
      expectedValue: round2(toFloat(valueMap.get(k) ?? 0)),
      share: pct(leads, total),
    };
  });
  rows.sort((a, b) => cmp(b.leads, a.leads));

  return { dimension: dimKey, dimensionLabel: dimension.label, total, rows };
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

export async function performanceReport(orgId, scopeInfo, query) {
  const maps = await gvLabelMaps(orgId);
  const range = await dateRange(query);

  let activityParams = [orgId];
  let activitySql = 'organization_id = ?';
  if (!scopeInfo.unrestricted) {
    const [inSql, p] = dbInClause(scopeInfo.userIds);
    activitySql += ` AND user_id IN ${inSql}`;
    activityParams = [...activityParams, ...p];
  }
  if (range.from) {
    activitySql += ' AND occurred_at >= ?';
    activityParams.push(range.from);
  }
  if (range.to) {
    activitySql += ' AND occurred_at <= ?';
    activityParams.push(range.to);
  }
  const byUserType = await dbAll(`SELECT user_id, type, COUNT(*) AS cnt FROM activities WHERE ${activitySql} GROUP BY user_id, type`, activityParams);

  const leadWhere = await buildLeadWhere(query, scopeInfo, orgId);
  const leadCounts = await dbAll(`SELECT owner_id, COUNT(*) AS cnt FROM leads ${leadWhere.sql} GROUP BY owner_id`, leadWhere.params);
  const convCounts = await dbAll(`SELECT owner_id, COUNT(*) AS cnt FROM leads ${leadWhere.sql} AND is_converted = 1 GROUP BY owner_id`, leadWhere.params);

  // A booking is the deal, and its value is the lead's own budget.
  const wonAgg = await dbAll(
    `SELECT owner_id, SUM(COALESCE(expected_value, budget_max)) AS amt, COUNT(*) AS cnt
       FROM leads ${leadWhere.sql} AND is_converted = 1 GROUP BY owner_id`,
    leadWhere.params
  );
  const siteVisitAgg = await dbAll(
    `SELECT owner_id, COUNT(*) AS cnt FROM leads ${leadWhere.sql} AND site_visit_at IS NOT NULL GROUP BY owner_id`,
    leadWhere.params
  );

  const targetParams = [orgId];
  let targetSql = 'organization_id = ? AND user_id IS NOT NULL';
  if (range.from) {
    targetSql += ' AND period_end >= ?';
    targetParams.push(String(range.from).slice(0, 10));
  }
  if (range.to) {
    targetSql += ' AND period_start <= ?';
    targetParams.push(String(range.to).slice(0, 10));
  }
  const targets = await dbAll(`SELECT * FROM targets WHERE ${targetSql}`, targetParams);

  const rows = new Map();
  const init = (id) => {
    const u = lookup(maps.users, id);
    return {
      userId: id, name: gvUserLabel(u), email: u?.email ?? '',
      calls: 0, emails: 0, meetings: 0, whatsapp: 0, notes: 0,
      leads: 0, converted: 0, revenue: 0.0, deals: 0,
      siteVisits: 0, conversionRate: 0.0, targets: {},
    };
  };
  const rowFor = (id) => {
    if (!rows.has(id)) rows.set(id, init(id));
    return rows.get(id);
  };
  const typeToField = { CALL: 'calls', EMAIL: 'emails', MEETING: 'meetings', WHATSAPP: 'whatsapp', NOTE: 'notes' };

  for (const r of byUserType) {
    if (!r.user_id) {
      continue;
    }
    const row = rowFor(r.user_id);
    const field = Object.prototype.hasOwnProperty.call(typeToField, r.type) ? typeToField[r.type] : null;
    if (field) {
      row[field] += toInt(r.cnt);
    }
  }
  for (const r of leadCounts) {
    if (!r.owner_id) {
      continue;
    }
    rowFor(r.owner_id).leads = toInt(r.cnt);
  }
  for (const r of convCounts) {
    if (!r.owner_id) {
      continue;
    }
    rowFor(r.owner_id).converted = toInt(r.cnt);
  }
  for (const r of wonAgg) {
    if (!r.owner_id) {
      continue;
    }
    const row = rowFor(r.owner_id);
    row.revenue = round2(toFloat(r.amt ?? 0));
    row.deals = toInt(r.cnt);
  }
  for (const r of siteVisitAgg) {
    if (!r.owner_id) {
      continue;
    }
    rowFor(r.owner_id).siteVisits = toInt(r.cnt);
  }

  const targetsByUser = new Map();
  for (const t of targets) {
    if (!targetsByUser.has(t.user_id)) targetsByUser.set(t.user_id, []);
    targetsByUser.get(t.user_id).push(t);
  }
  const metricField = {
    LEADS: 'leads', CALLS: 'calls', MEETINGS: 'meetings',
    QUALIFIED: 'converted', SITE_VISITS: 'siteVisits',
    BOOKINGS: 'deals', CONVERSIONS: 'converted', REVENUE: 'revenue',
  };

  for (const [uid, row] of rows) {
    row.conversionRate = pct(row.converted, row.leads);
    for (const t of targetsByUser.get(uid) ?? []) {
      const field = Object.prototype.hasOwnProperty.call(metricField, t.metric) ? metricField[t.metric] : null;
      const actual = field ? row[field] : 0;
      row.targets[t.metric] = { target: toFloat(t.target_value), actual, attainment: pct(actual, toFloat(t.target_value)) };
    }
  }

  const out = [...rows.values()];
  out.sort((a, b) => cmp(b.revenue, a.revenue) || cmp(b.leads, a.leads));
  return out;
}

// ---------------------------------------------------------------------------
// Marketing attribution
// ---------------------------------------------------------------------------

/**
 * Marketing performance by lead source and by project.
 *
 * Campaign objects are gone with the campaigns module, but the attribution
 * survives on the lead itself: `source_id` plus the UTM columns plus the Meta
 * ad/adset/campaign ids. Cost per lead comes from the source's own
 * `cost_per_lead`, which is where a real-estate team records what a portal or
 * an ad platform charges them.
 */
export async function marketingReport(orgId, scopeInfo, query) {
  const maps = await gvLabelMaps(orgId);
  const leadWhere = await buildLeadWhere(query, scopeInfo, orgId);

  const agg = (extra = '') =>
    dbAll(
      `SELECT source_id, COUNT(*) AS cnt FROM leads ${leadWhere.sql}` + (extra ? ` AND ${extra}` : '') + ' GROUP BY source_id',
      leadWhere.params
    );

  const bySourceRows = await agg();
  const qualifiedMap = columnMap(await agg('qualified_at IS NOT NULL'), 'cnt', 'source_id');
  const siteVisitMap = columnMap(await agg('site_visit_at IS NOT NULL'), 'cnt', 'source_id');
  const convertedMap = columnMap(await agg('is_converted = 1'), 'cnt', 'source_id');
  const valueMap = columnMap(
    await dbAll(
      `SELECT source_id, SUM(COALESCE(expected_value, budget_max)) AS amt
         FROM leads ${leadWhere.sql} AND is_converted = 1 GROUP BY source_id`,
      leadWhere.params
    ),
    'amt',
    'source_id'
  );

  const sources = bySourceRows.map((r) => {
    const key = r.source_id;
    const k = keyOf(key);
    const source = key ? lookup(maps.sources, key) : null;
    const leads = toInt(r.cnt);
    const qualified = toInt(qualifiedMap.get(k) ?? 0);
    const converted = toInt(convertedMap.get(k) ?? 0);
    const revenue = round2(toFloat(valueMap.get(k) ?? 0));
    const costPerLead = toFloat(source?.cost_per_lead ?? 0);
    const spend = round2(costPerLead * leads);
    return {
      sourceId: key,
      label: source?.name ?? 'Direct / Unknown',
      leads,
      qualified,
      siteVisits: toInt(siteVisitMap.get(k) ?? 0),
      converted,
      revenue,
      costPerLead: round2(costPerLead),
      spend,
      costPerQualified: qualified ? round2(spend / qualified) : 0,
      costPerBooking: converted ? round2(spend / converted) : 0,
      qualificationRate: pct(qualified, leads),
      conversionRate: pct(converted, leads),
      roi: spend > 0 ? round2(((revenue - spend) / spend) * 100) : null,
    };
  });
  sources.sort((a, b) => cmp(b.leads, a.leads));

  // UTM breakdown, which is what actually identifies an ad campaign now.
  const byUtm = await dbAll(
    `SELECT utm_source, utm_campaign, COUNT(*) AS cnt,
            SUM(CASE WHEN is_converted = 1 THEN 1 ELSE 0 END) AS converted
       FROM leads ${leadWhere.sql} AND utm_campaign IS NOT NULL AND utm_campaign <> ''
      GROUP BY utm_source, utm_campaign ORDER BY cnt DESC LIMIT 25`,
    leadWhere.params
  );
  const campaigns = byUtm.map((r) => ({
    label: r.utm_campaign,
    // PHP's ?: also treats "0" as empty.
    source: r.utm_source === null || r.utm_source === undefined || r.utm_source === '' || r.utm_source === '0'
      ? 'Unknown'
      : r.utm_source,
    leads: toInt(r.cnt),
    converted: toInt(r.converted),
    conversionRate: pct(toInt(r.converted), toInt(r.cnt)),
  }));

  const byProject = await dbAll(
    `SELECT project_id, COUNT(*) AS cnt,
            SUM(CASE WHEN is_converted = 1 THEN 1 ELSE 0 END) AS converted
       FROM leads ${leadWhere.sql} AND project_id IS NOT NULL GROUP BY project_id ORDER BY cnt DESC`,
    leadWhere.params
  );
  const projects = byProject.map((r) => ({
    projectId: r.project_id,
    label: lookup(maps.projects, r.project_id)?.name ?? 'Unknown',
    leads: toInt(r.cnt),
    converted: toInt(r.converted),
    conversionRate: pct(toInt(r.converted), toInt(r.cnt)),
  }));

  const totalLeads = sources.reduce((sum, s) => sum + s.leads, 0);
  const totalSpend = sources.reduce((sum, s) => sum + s.spend, 0);
  const totalRevenue = sources.reduce((sum, s) => sum + s.revenue, 0);

  return {
    sources,
    campaigns,
    projects,
    totals: {
      leads: totalLeads,
      spend: round2(totalSpend),
      revenue: round2(totalRevenue),
      costPerLead: totalLeads ? round2(totalSpend / totalLeads) : 0,
      roi: totalSpend > 0 ? round2(((totalRevenue - totalSpend) / totalSpend) * 100) : null,
    },
  };
}
