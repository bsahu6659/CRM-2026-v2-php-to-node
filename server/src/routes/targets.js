/**
 * /api/targets/* — port of api/targets.php. One target per (owner, metric,
 * period start); attainment is measured live against the same tables the
 * reports read, so the two numbers can never disagree.
 */

import express from 'express';
import { dbAll, dbExec, dbInClause, dbOne, dbScalar } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk } from '../lib/response.js';
import { ah, requirePermission, scopeInfo } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { camelize, gvId, pct, round2 } from '../lib/util.js';
import { validate } from '../lib/validate.js';

const router = express.Router();

const TARGET_METRICS = ['LEADS', 'CALLS', 'MEETINGS', 'QUALIFIED', 'OPPORTUNITIES', 'CONVERSIONS', 'REVENUE'];
const TARGET_PERIODS = ['MONTH', 'QUARTER', 'YEAR'];

/** PHP's empty(). */
function isEmpty(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '' || value === '0') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** PHP's (string) cast. */
function str(value) {
  if (value === undefined || value === null || value === false) return '';
  if (value === true) return '1';
  return String(value);
}

/** PHP's (int) cast. */
function toInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = Number.parseInt(str(value), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** PHP's (float) cast. */
function toFloat(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = Number.parseFloat(str(value));
  return Number.isNaN(n) ? 0 : n;
}

/** PHP's is_numeric(): numbers and numeric strings, never booleans. */
function isNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(value);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Last day of a 1-based month: day 0 of the next month. */
function lastDayOf(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * strtotime() reads a bare 'YYYY-MM-DD' (or 'YYYY-MM') as local midnight;
 * JavaScript's Date reads it as UTC, which lands on the previous day anywhere
 * west of Greenwich. Bare dates are built in local time here to match.
 */
function parseStart(startInput) {
  if (!startInput) return new Date();
  const s = String(startInput).trim();
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(s);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1) : new Date(s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** @returns {{start: string, end: string}} DATE bounds for the period containing startInput. */
function targetsPeriodBounds(period, startInput) {
  const d = parseStart(startInput);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;

  if (period === 'MONTH') {
    return { start: `${year}-${pad2(month)}-01`, end: `${year}-${pad2(month)}-${pad2(lastDayOf(year, month))}` };
  }
  if (period === 'QUARTER') {
    const startMonth = Math.floor((month - 1) / 3) * 3 + 1;
    const endMonth = startMonth + 2;
    return {
      start: `${String(year).padStart(4, '0')}-${pad2(startMonth)}-01`,
      end: `${year}-${pad2(endMonth)}-${pad2(lastDayOf(year, endMonth))}`,
    };
  }
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

/** Resolves the achieved value for a target's metric, scope and window. */
async function targetsMeasureActual(orgId, target) {
  const from = `${target.period_start} 00:00:00`;
  const to = `${target.period_end} 23:59:59`;

  let memberIds = null;
  if (target.user_id) {
    memberIds = [target.user_id];
  } else if (target.team_id) {
    memberIds = (await dbAll('SELECT user_id FROM team_members WHERE team_id = ?', [target.team_id])).map((r) => r.user_id);
    if (!memberIds.length) {
      return 0;
    }
  }

  let ownerSql = '';
  let userSql = '';
  let memberParams = [];
  if (memberIds && memberIds.length) {
    const [inClause, p] = dbInClause(memberIds);
    ownerSql = ` AND owner_id IN ${inClause}`;
    userSql = ` AND user_id IN ${inClause}`;
    memberParams = p;
  }
  const params = [orgId, from, to, ...memberParams];

  switch (target.metric) {
    case 'LEADS':
      return toInt(await dbScalar(`SELECT COUNT(*) FROM leads WHERE organization_id = ? AND created_at >= ? AND created_at <= ?${ownerSql}`, params));
    case 'QUALIFIED':
      return toInt(await dbScalar(`SELECT COUNT(*) FROM leads WHERE organization_id = ? AND qualified_at >= ? AND qualified_at <= ?${ownerSql}`, params));
    case 'CONVERSIONS':
      return toInt(await dbScalar(`SELECT COUNT(*) FROM leads WHERE organization_id = ? AND converted_at >= ? AND converted_at <= ?${ownerSql}`, params));
    case 'CALLS':
      return toInt(await dbScalar(`SELECT COUNT(*) FROM activities WHERE organization_id = ? AND type = 'CALL' AND occurred_at >= ? AND occurred_at <= ?${userSql}`, params));
    case 'MEETINGS':
      return toInt(await dbScalar(`SELECT COUNT(*) FROM activities WHERE organization_id = ? AND type = 'MEETING' AND occurred_at >= ? AND occurred_at <= ?${userSql}`, params));
    case 'SITE_VISITS':
      return toInt(await dbScalar(`SELECT COUNT(*) FROM leads WHERE organization_id = ? AND site_visit_at >= ? AND site_visit_at <= ?${ownerSql}`, params));
    case 'BOOKINGS':
      return toInt(await dbScalar(`SELECT COUNT(*) FROM leads WHERE organization_id = ? AND is_converted = 1 AND converted_at >= ? AND converted_at <= ?${ownerSql}`, params));
    case 'REVENUE':
      // Booking value: the lead's own budget, since there is no deal record.
      return round2(
        toFloat(
          (await dbScalar(
            `SELECT SUM(COALESCE(expected_value, budget_max)) FROM leads WHERE organization_id = ? AND is_converted = 1 AND converted_at >= ? AND converted_at <= ?${ownerSql}`,
            params
          )) ?? 0
        )
      );
    default:
      return 0;
  }
}

/** Upserts one target row: one target per (owner, metric, periodStart). */
async function targetsUpsert(orgId, userId, teamId, metric, period, bounds, value) {
  const existing = await dbOne(
    'SELECT * FROM targets WHERE organization_id = ? AND metric = ? AND period_start = ?' +
      (userId ? ' AND user_id = ?' : ' AND user_id IS NULL') +
      (teamId ? ' AND team_id = ?' : ' AND team_id IS NULL'),
    [orgId, metric, bounds.start, ...(userId ? [userId] : []), ...(teamId ? [teamId] : [])]
  );
  if (existing) {
    await dbExec('UPDATE targets SET period = ?, period_end = ?, target_value = ?, updated_at = NOW() WHERE id = ?', [
      period,
      bounds.end,
      value,
      existing.id,
    ]);
    return { row: await dbOne('SELECT * FROM targets WHERE id = ?', [existing.id]), existed: true };
  }
  const targetId = gvId();
  await dbExec(
    `INSERT INTO targets (id, organization_id, user_id, team_id, metric, period, period_start, period_end, target_value, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
    [targetId, orgId, userId, teamId, metric, period, bounds.start, bounds.end, value]
  );
  return { row: await dbOne('SELECT * FROM targets WHERE id = ?', [targetId]), existed: false };
}

// ---------------------------------------------------------------------------
// GET /targets/metrics
// ---------------------------------------------------------------------------
router.get(
  '/metrics',
  requirePermission('targets', 'read'),
  (req, res) => jsonOk(res, { metrics: TARGET_METRICS, periods: TARGET_PERIODS })
);

// ---------------------------------------------------------------------------
// GET /targets
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('targets', 'read'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const query = req.query;
    const scope = await scopeInfo(req);
    const clauses = ['t.organization_id = ?'];
    let params = [orgId];
    for (const [key, col] of Object.entries({ userId: 'user_id', teamId: 'team_id', period: 'period' })) {
      if (!isEmpty(query[key])) {
        clauses.push(`t.${col} = ?`);
        params.push(str(query[key]));
      }
    }
    if (!scope.unrestricted) {
      const [uIn, uP] = dbInClause(scope.userIds);
      const [tIn, tP] = dbInClause(scope.teamIds);
      clauses.push(`(t.user_id IN ${uIn} OR t.team_id IN ${tIn})`);
      params = params.concat(uP, tP);
    }
    const rows = await dbAll(
      `SELECT t.*, u.first_name AS user_first_name, u.last_name AS user_last_name, tm.name AS team_name
         FROM targets t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN teams tm ON tm.id = t.team_id
         WHERE ${clauses.join(' AND ')} ORDER BY t.period_start DESC, t.metric ASC`,
      params
    );

    // Attainment is computed live so the number always matches the reports.
    const out = [];
    for (const r of rows) {
      const item = camelize(r);
      delete item.userFirstName;
      delete item.userLastName;
      delete item.teamName;
      item.user = r.user_id ? { id: r.user_id, firstName: r.user_first_name, lastName: r.user_last_name } : null;
      item.team = r.team_id ? { id: r.team_id, name: r.team_name } : null;
      item.ownerLabel = r.user_id
        ? `${r.user_first_name ?? ''} ${r.user_last_name ?? ''}`.trim()
        : (r.team_name || 'Organisation');
      const actual = await targetsMeasureActual(orgId, r);
      item.actual = actual;
      item.attainment = pct(actual, toFloat(r.target_value));
      out.push(item);
    }
    return jsonOk(res, out);
  })
);

// ---------------------------------------------------------------------------
// POST /targets/bulk — the same target for many users at once
// ---------------------------------------------------------------------------
router.post(
  '/bulk',
  requirePermission('targets', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    const rawUserIds = body.userIds ?? null;
    const userIds = Array.isArray(rawUserIds)
      ? rawUserIds
      : rawUserIds !== null && typeof rawUserIds === 'object'
        ? Object.values(rawUserIds)
        : null;
    const metric = body.metric ?? '';
    const period = body.period ?? '';
    if (!userIds || !userIds.length) {
      throw badRequest('Select at least one user');
    }
    if (!TARGET_METRICS.includes(metric)) {
      throw badRequest('Unknown metric');
    }
    if (!TARGET_PERIODS.includes(period)) {
      throw badRequest('Unknown period');
    }
    const bounds = targetsPeriodBounds(period, body.periodStart ?? null);
    const value = toFloat(body.targetValue ?? 0);
    let count = 0;
    for (const userId of userIds) {
      await targetsUpsert(orgId, userId, null, metric, period, bounds, value);
      count++;
    }
    await auditRecord(
      orgId,
      a,
      'target.bulk_set',
      { entityType: 'TARGET', entityLabel: `${count} users`, changes: { metric, period, targetValue: value } },
      req
    );
    return jsonOk(res, { updated: count });
  })
);

// ---------------------------------------------------------------------------
// POST /targets
// ---------------------------------------------------------------------------
router.post(
  '/',
  requirePermission('targets', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    const v = validate(body);
    v.required('metric', 'Metric').in('metric', TARGET_METRICS);
    v.required('period', 'Period').in('period', TARGET_PERIODS);
    v.required('periodStart', 'Period start');
    v.validate();

    const userId = body.userId ?? null;
    const teamId = body.teamId ?? null;
    if (isEmpty(userId) && isEmpty(teamId)) {
      throw badRequest('Set the target on a user or a team.');
    }
    if (!isEmpty(userId) && !isEmpty(teamId)) {
      throw badRequest('A target belongs to either a user or a team, not both.');
    }
    const bounds = targetsPeriodBounds(body.period, body.periodStart);
    const result = await targetsUpsert(
      orgId,
      isEmpty(userId) ? null : userId,
      isEmpty(teamId) ? null : teamId,
      body.metric,
      body.period,
      bounds,
      toFloat(body.targetValue ?? 0)
    );
    const row = result.row;
    await auditRecord(
      orgId,
      a,
      result.existed ? 'target.updated' : 'target.created',
      {
        entityType: 'TARGET',
        entityId: row.id,
        entityLabel: `${row.metric} ${row.period}`,
        changes: { targetValue: row.target_value },
      },
      req
    );
    return jsonCreated(res, camelize(row));
  })
);

// ---------------------------------------------------------------------------
// PATCH /targets/:id — the value is the only thing that changes in place
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requirePermission('targets', 'update'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const body = req.body ?? {};
    const target = await dbOne('SELECT * FROM targets WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!target) {
      throw notFound('Target not found');
    }
    if (body.targetValue === undefined || body.targetValue === null || !isNumeric(body.targetValue)) {
      throw badRequest('targetValue must be a number');
    }
    await dbExec('UPDATE targets SET target_value = ?, updated_at = NOW() WHERE id = ?', [toFloat(body.targetValue), target.id]);
    return jsonOk(res, camelize(await dbOne('SELECT * FROM targets WHERE id = ?', [target.id])));
  })
);

// ---------------------------------------------------------------------------
// DELETE /targets/:id
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requirePermission('targets', 'delete'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const target = await dbOne('SELECT * FROM targets WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!target) {
      throw notFound('Target not found');
    }
    await dbExec('DELETE FROM targets WHERE id = ?', [target.id]);
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown targets route')));

export default router;
