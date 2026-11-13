/**
 * /api/activities/* — port of api/activities.php: the cross-lead timeline,
 * the communication summary, and edits to entries a user logged themselves.
 */

import express from 'express';
import { dbAll, dbExec, dbInClause, dbOne, dbScalar } from '../lib/db.js';
import { forbidden, notFound } from '../lib/errors.js';
import { jsonOk, pageMeta, parsePaging } from '../lib/response.js';
import { ah, requirePermission, scopeInfo } from '../middleware/index.js';
import { camelize, parseDate, safeJson } from '../lib/util.js';
import { dateFilterClause, dateRange } from '../services/filters.js';

const router = express.Router();

const ACTIVITIES_COMMUNICATION_TYPES = ['CALL', 'EMAIL', 'MEETING', 'SMS', 'WHATSAPP'];
// Written by the system, not by a person: they are the lead's audit trail, so
// nobody gets to rewrite or remove them.
const ACTIVITIES_IMMUTABLE_TYPES = ['SYSTEM', 'STATUS_CHANGE', 'ASSIGNMENT', 'CONVERSION', 'SCORE_CHANGE'];

const ACTIVITIES_JOIN_SELECT = `activities.*,
    u.first_name AS user_first_name, u.last_name AS user_last_name, u.avatar_url AS user_avatar_url,
    l.code AS lead_code, l.first_name AS lead_first_name, l.last_name AS lead_last_name,
    op.code AS opportunity_code, op.name AS opportunity_name,
    ct.first_name AS contact_first_name, ct.last_name AS contact_last_name`;
const ACTIVITIES_JOIN_FROM = `activities
    LEFT JOIN users u ON u.id = activities.user_id
    LEFT JOIN leads l ON l.id = activities.lead_id
    LEFT JOIN opportunities op ON op.id = activities.opportunity_id
    LEFT JOIN contacts ct ON ct.id = activities.contact_id`;

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

function activitiesShape(r) {
  const a = camelize(r);
  for (const k of [
    'userFirstName', 'userLastName', 'userAvatarUrl', 'leadCode', 'leadFirstName', 'leadLastName',
    'opportunityCode', 'opportunityName', 'contactFirstName', 'contactLastName',
  ]) {
    delete a[k];
  }
  a.meta = safeJson(r.meta ?? '{}', []);
  a.user = r.user_id
    ? { id: r.user_id, firstName: r.user_first_name, lastName: r.user_last_name, avatarUrl: r.user_avatar_url }
    : null;
  a.lead = r.lead_id
    ? { id: r.lead_id, code: r.lead_code, firstName: r.lead_first_name, lastName: r.lead_last_name }
    : null;
  a.opportunity = r.opportunity_id
    ? { id: r.opportunity_id, code: r.opportunity_code, name: r.opportunity_name }
    : null;
  a.contact = r.contact_id
    ? { id: r.contact_id, firstName: r.contact_first_name, lastName: r.contact_last_name }
    : null;
  return a;
}

// ---------------------------------------------------------------------------
// GET /activities — timeline across every lead the actor can see
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('activities', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const query = req.query;
    const scope = await scopeInfo(req);
    const { page, limit, offset } = parsePaging(query);

    const clauses = ['activities.organization_id = ?'];
    let params = [a.organizationId];
    if (!scope.unrestricted) {
      const [inClause, p] = dbInClause(scope.userIds);
      clauses.push(`(activities.user_id IN ${inClause} OR activities.user_id IS NULL)`);
      params = params.concat(p);
    }
    if (!isEmpty(query.channel) && query.channel === 'communication') {
      const [inClause, p] = dbInClause(ACTIVITIES_COMMUNICATION_TYPES);
      clauses.push(`activities.type IN ${inClause}`);
      params = params.concat(p);
    } else if (!isEmpty(query.type)) {
      const types = str(query.type)
        .split(',')
        .map((t) => t.trim())
        .filter((t) => !isEmpty(t));
      if (types.length) {
        const [inClause, p] = dbInClause(types);
        clauses.push(`activities.type IN ${inClause}`);
        params = params.concat(p);
      }
    }
    for (const [key, col] of Object.entries({
      userId: 'user_id', leadId: 'lead_id', opportunityId: 'opportunity_id', direction: 'direction',
    })) {
      if (!isEmpty(query[key])) {
        clauses.push(`activities.${col} = ?`);
        params.push(str(query[key]));
      }
    }
    const range = await dateRange(query);
    const [dateSql, dateParams] = await dateFilterClause('activities.occurred_at', range);
    if (dateSql) {
      clauses.push(dateSql);
      params = params.concat(dateParams);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;

    const rows = await dbAll(
      `SELECT ${ACTIVITIES_JOIN_SELECT} FROM ${ACTIVITIES_JOIN_FROM} ${where} ORDER BY activities.occurred_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const total = toInt(await dbScalar(`SELECT COUNT(*) FROM ${ACTIVITIES_JOIN_FROM} ${where}`, params));
    return jsonOk(res, rows.map(activitiesShape), pageMeta(page, limit, total));
  })
);

// ---------------------------------------------------------------------------
// GET /activities/communication-summary
// ---------------------------------------------------------------------------
router.get(
  '/communication-summary',
  requirePermission('activities', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const query = req.query;
    const scope = await scopeInfo(req);
    const clauses = ['organization_id = ?'];
    const [inClause, p] = dbInClause(ACTIVITIES_COMMUNICATION_TYPES);
    clauses.push(`type IN ${inClause}`);
    let params = [a.organizationId, ...p];
    if (!scope.unrestricted) {
      const [in2, p2] = dbInClause(scope.userIds);
      clauses.push(`user_id IN ${in2}`);
      params = params.concat(p2);
    }
    const range = await dateRange(query);
    const [dateSql, dateParams] = await dateFilterClause('occurred_at', range);
    if (dateSql) {
      clauses.push(dateSql);
      params = params.concat(dateParams);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;

    const byType = await dbAll(`SELECT type, COUNT(*) AS cnt FROM activities ${where} GROUP BY type`, params);
    const byDirection = await dbAll(`SELECT direction, COUNT(*) AS cnt FROM activities ${where} GROUP BY direction`, params);
    const byOutcome = await dbAll(
      `SELECT outcome, COUNT(*) AS cnt FROM activities ${where} AND type = 'CALL' GROUP BY outcome`,
      params
    );
    const durations = await dbOne(
      `SELECT SUM(duration_sec) AS sum_sec, AVG(duration_sec) AS avg_sec FROM activities ${where} AND type = 'CALL'`,
      params
    );

    return jsonOk(res, {
      byChannel: byType.map((r) => ({ channel: r.type, count: toInt(r.cnt) })),
      byDirection: byDirection.map((r) => ({ direction: r.direction ?? 'UNSPECIFIED', count: toInt(r.cnt) })),
      callOutcomes: byOutcome.map((r) => ({ outcome: r.outcome ?? 'Not recorded', count: toInt(r.cnt) })),
      totalCallSeconds: toInt(durations?.sum_sec ?? 0),
      averageCallSeconds: Math.round(toFloat(durations?.avg_sec ?? 0)),
    });
  })
);

// ---------------------------------------------------------------------------
// PATCH /activities/:id — only the person who logged it, never a system entry
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requirePermission('activities', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const activity = await dbOne('SELECT * FROM activities WHERE id = ? AND organization_id = ?', [
      req.params.id,
      a.organizationId,
    ]);
    if (!activity) {
      throw notFound('Activity not found');
    }
    if (activity.user_id !== a.id) {
      throw forbidden('You can only edit activities you logged.');
    }
    if (ACTIVITIES_IMMUTABLE_TYPES.includes(activity.type)) {
      throw forbidden('System timeline entries cannot be edited.');
    }
    const data = {};
    for (const [camel, col] of Object.entries({ subject: 'subject', body: 'body', outcome: 'outcome', direction: 'direction' })) {
      if (Object.hasOwn(body, camel)) {
        data[col] = isEmpty(body[camel]) ? null : body[camel];
      }
    }
    if (Object.hasOwn(body, 'durationSec')) {
      data.duration_sec = body.durationSec !== null && body.durationSec !== '' ? toInt(body.durationSec) : null;
    }
    if (Object.hasOwn(body, 'occurredAt')) {
      data.occurred_at = parseDate(body.occurredAt) ?? activity.occurred_at;
    }
    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE activities SET ${sets} WHERE id = ?`, [...Object.values(data), activity.id]);
    }
    return jsonOk(
      res,
      activitiesShape(
        await dbOne(`SELECT ${ACTIVITIES_JOIN_SELECT} FROM ${ACTIVITIES_JOIN_FROM} WHERE activities.id = ?`, [activity.id])
      )
    );
  })
);

// ---------------------------------------------------------------------------
// DELETE /activities/:id
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requirePermission('activities', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const activity = await dbOne('SELECT * FROM activities WHERE id = ? AND organization_id = ?', [
      req.params.id,
      a.organizationId,
    ]);
    if (!activity) {
      throw notFound('Activity not found');
    }
    if (ACTIVITIES_IMMUTABLE_TYPES.includes(activity.type)) {
      throw forbidden('System timeline entries cannot be deleted - they are the audit trail.');
    }
    await dbExec('DELETE FROM activities WHERE id = ?', [activity.id]);
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown activities route')));

export default router;
