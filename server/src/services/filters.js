/**
 * WHERE-clause builders — port of services/Filters.php.
 *
 * Each builder returns raw SQL (with `?` placeholders) plus its bound params:
 * { sql: 'WHERE ...', params: [...] }. Every list, export and report funnels
 * through here so a filter behaves identically wherever it's applied, and so
 * the visibility clause from lib/scope.js is never accidentally left off.
 *
 * Nothing here touches the database, so the builders stay synchronous.
 */

import { dbInClause } from '../lib/db.js';
import { visibilityWhere } from '../lib/scope.js';
import { endOfDay, parseDate, startOfDay, toSqlDate } from '../lib/util.js';

/** PHP empty(): '', '0', 0, null, false and [] are all "empty". */
function phpEmpty(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '' || value === '0') {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function phpStr(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return '1';
  if (typeof value === 'object') return 'Array';
  return String(value);
}

function phpFloat(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = Number.parseFloat(phpStr(value).trim());
  return Number.isNaN(n) ? 0 : n;
}

/**
 * strtotime()-compatible parse_date(). A bare YYYY-MM-DD is local midnight in
 * PHP but UTC midnight to `new Date()`, which would move a "from" date back a
 * day on any server west of Greenwich, so that one shape is pinned to local.
 */
function parseDateLocal(value) {
  if (phpEmpty(value)) return null;
  const s = phpStr(value).trim();
  return parseDate(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s} 00:00:00` : s);
}

/** Today shifted by `days`, as a local Date (strtotime('-N days')). */
function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function two(n) {
  return String(n).padStart(2, '0');
}

export function gvQueryArray(value) {
  if (value === null || value === undefined || value === '') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((v) => phpStr(v).trim()).filter((v) => v !== '');
  }
  return phpStr(value).split(',').map((v) => v.trim()).filter((v) => v !== '');
}

/** Returns { from, to }: 'Y-m-d H:i:s' bounds, or nulls for "no filter". */
export function dateRange(query) {
  const from = !phpEmpty(query?.from) ? parseDateLocal(query.from) : null;
  const to = !phpEmpty(query?.to) ? parseDateLocal(query.to) : null;
  if (from || to) {
    return { from: from ? startOfDay(from) : null, to: to ? endOfDay(to) : null };
  }

  const now = new Date();
  switch (query?.range ?? null) {
    case 'today':
      return { from: startOfDay(), to: endOfDay() };
    case 'yesterday': {
      const y = daysFromNow(-1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case 'last_7_days':
      return { from: startOfDay(daysFromNow(-6)), to: endOfDay() };
    case 'last_30_days':
      return { from: startOfDay(daysFromNow(-29)), to: endOfDay() };
    case 'last_90_days':
      return { from: startOfDay(daysFromNow(-89)), to: endOfDay() };
    case 'this_month':
      return { from: `${now.getFullYear()}-${two(now.getMonth() + 1)}-01 00:00:00`, to: endOfDay() };
    case 'last_month': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: `${toSqlDate(first)} 00:00:00`, to: `${toSqlDate(last)} 23:59:59` };
    }
    case 'this_quarter': {
      const month = now.getMonth() + 1;
      const startMonth = Math.floor((month - 1) / 3) * 3 + 1;
      return { from: `${now.getFullYear()}-${two(startMonth)}-01 00:00:00`, to: endOfDay() };
    }
    case 'this_year':
      return { from: `${now.getFullYear()}-01-01 00:00:00`, to: endOfDay() };
    default:
      return { from: null, to: null };
  }
}

/** Returns [sqlFragment|null, params]. */
export function dateFilterClause(column, range) {
  const parts = [];
  const params = [];
  if (range.from) {
    parts.push(`${column} >= ?`);
    params.push(range.from);
  }
  if (range.to) {
    parts.push(`${column} <= ?`);
    params.push(range.to);
  }
  return [parts.length ? parts.join(' AND ') : null, params];
}

export const GV_LEAD_DATE_FIELDS = {
  createdAt: 'created_at', updatedAt: 'updated_at', convertedAt: 'converted_at',
  lastContactedAt: 'last_contacted_at', nextFollowUpAt: 'next_follow_up_at', qualifiedAt: 'qualified_at',
};
export const GV_OPP_DATE_FIELDS = {
  createdAt: 'created_at', expectedCloseDate: 'expected_close_date', actualCloseDate: 'actual_close_date', updatedAt: 'updated_at',
};
export const GV_TASK_DATE_FIELDS = { dueAt: 'due_at', createdAt: 'created_at', completedAt: 'completed_at' };

/**
 * Lead list / report filter. Supported query keys: q, statusId, sourceId,
 * projectId, purpose, configuration,
 * ownerId, teamId, priority, scoreBand, country, state, city,
 * tag, converted, unassigned, noProject, followUp, range/from/to, dateField,
 * minScore, maxScore.
 *
 * Every column is qualified with `leads.` so this stays valid whether the
 * caller queries `leads` alone or joins in owner/status/source/etc. labels —
 * an unqualified `organization_id` would be ambiguous the moment a joined
 * table (they all have one) is added to the query.
 *
 * Returns { sql, params }.
 */
export function buildLeadWhere(query, scopeInfo, orgId, ignoreVisibility = false) {
  const q = query ?? {};
  const clauses = ['leads.organization_id = ?', 'leads.is_duplicate = 0'];
  let params = [orgId];

  if (!ignoreVisibility && scopeInfo) {
    const vis = visibilityWhere(scopeInfo, 'leads.owner_id', 'leads.team_id');
    if (vis.sql !== '') {
      clauses.push(vis.sql);
      params = params.concat(vis.params);
    }
  }

  if (!phpEmpty(q.q)) {
    const term = `%${phpStr(q.q).trim()}%`;
    clauses.push('(leads.first_name LIKE ? OR leads.last_name LIKE ? OR leads.email LIKE ? OR leads.phone LIKE ? OR leads.company LIKE ? OR leads.code LIKE ? OR leads.city LIKE ?)');
    params.push(term, term, term, term, term, term, term);
  }

  const inFilters = {
    statusId: 'status_id', sourceId: 'source_id',
    projectId: 'project_id',
    priority: 'priority', scoreBand: 'score_band', ownerId: 'owner_id', teamId: 'team_id',
    purpose: 'purpose', configuration: 'configuration',
  };
  for (const [key, col] of Object.entries(inFilters)) {
    const vals = gvQueryArray(q[key] ?? null);
    if (vals.length) {
      const [inSql, p] = dbInClause(vals);
      clauses.push(`leads.${col} IN ${inSql}`);
      params = params.concat(p);
    }
  }

  for (const [key, col] of Object.entries({ country: 'country', state: 'state', city: 'city' })) {
    if (!phpEmpty(q[key])) {
      clauses.push(`leads.${col} = ?`);
      params.push(phpStr(q[key]));
    }
  }

  const unassigned = q.unassigned ?? null;
  if (unassigned === 'true' || unassigned === true) {
    clauses.push('leads.owner_id IS NULL');
  }
  // Enquiries that arrived without a project - from an older form, an import,
  // or Meta. Typing a lead in by hand now requires one, but the ones already
  // here still need finding, and an enquiry nobody can attribute to a tower is
  // worth chasing rather than hiding.
  if ((q.noProject ?? null) === 'true') {
    clauses.push('leads.project_id IS NULL');
  }
  if ((q.converted ?? null) === 'true') {
    clauses.push('leads.is_converted = 1');
  }
  if ((q.converted ?? null) === 'false') {
    clauses.push('leads.is_converted = 0');
  }

  if (!phpEmpty(q.minScore)) {
    clauses.push('leads.score >= ?');
    params.push(phpFloat(q.minScore));
  }
  if (!phpEmpty(q.maxScore)) {
    clauses.push('leads.score <= ?');
    params.push(phpFloat(q.maxScore));
  }

  if (!phpEmpty(q.tag)) {
    const tags = gvQueryArray(q.tag);
    if (tags.length) {
      const [inSql, p] = dbInClause(tags);
      clauses.push(`leads.id IN (SELECT lt.lead_id FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE t.name IN ${inSql})`);
      params = params.concat(p);
    }
  }

  switch (q.followUp ?? null) {
    case 'overdue':
      clauses.push('leads.next_follow_up_at < ?');
      params.push(startOfDay());
      clauses.push('leads.is_converted = 0');
      break;
    case 'today':
      clauses.push('leads.next_follow_up_at >= ? AND leads.next_follow_up_at <= ?');
      params.push(startOfDay(), endOfDay());
      break;
    case 'upcoming':
      clauses.push('leads.next_follow_up_at > ?');
      params.push(endOfDay());
      break;
    case 'due':
      clauses.push('leads.next_follow_up_at <= ?');
      params.push(endOfDay());
      clauses.push('leads.is_converted = 0');
      break;
    default:
      break;
  }

  const range = dateRange(q);
  // Own-property lookup only: a dateField of "constructor" must fall back to
  // created_at, not resolve to something on Object.prototype.
  const dateField = typeof q.dateField === 'string' ? q.dateField : '';
  const column = `leads.${Object.prototype.hasOwnProperty.call(GV_LEAD_DATE_FIELDS, dateField) ? GV_LEAD_DATE_FIELDS[dateField] : 'created_at'}`;
  const [dateSql, dateParams] = dateFilterClause(column, range);
  if (dateSql) {
    clauses.push(dateSql);
    params = params.concat(dateParams);
  }

  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
}
