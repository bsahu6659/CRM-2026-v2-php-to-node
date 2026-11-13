/**
 * /api/audit-logs/* — port of api/audit.php.
 *
 * Read and export only. There is deliberately no POST, PATCH or DELETE: the
 * trail is written by the server as a side effect of real operations and must
 * stay immutable to be worth anything in a dispute.
 */

import express from 'express';
import { dbAll, dbScalar } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { jsonOk, pageMeta, parsePaging } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { toCsv } from '../lib/csv.js';
import { camelize, parseDate, safeJson } from '../lib/util.js';

const router = express.Router();

const AUDIT_JOIN_FROM = 'audit_logs LEFT JOIN users u ON u.id = audit_logs.user_id';
const AUDIT_JOIN_SELECT =
  'audit_logs.*, u.first_name AS user_first_name, u.last_name AS user_last_name, u.email AS user_email, u.avatar_url AS user_avatar_url';

/** PHP empty() / falsiness: null, false, 0, '', '0' and an empty array. */
function phpEmpty(v) {
  if (v === undefined || v === null || v === false || v === 0 || v === '' || v === '0') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/**
 * PDO returns every column as a scalar, so the PHP edition saw `changes` as
 * JSON text — in the CSV export it is written out verbatim. mysql2 parses
 * native JSON into an object; re-serialising keeps the export's Changes column
 * JSON rather than "[object Object]", and keeps camelize() from renaming the
 * snake_case field names recorded inside it.
 */
function scalarRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v !== null && typeof v === 'object' && !Buffer.isBuffer(v) ? JSON.stringify(v) : v;
  }
  return out;
}

function auditRouteWhere(query, orgId) {
  const clauses = ['audit_logs.organization_id = ?'];
  const params = [orgId];
  for (const [key, col] of Object.entries({ userId: 'user_id', entityType: 'entity_type', entityId: 'entity_id' })) {
    if (!phpEmpty(query[key])) {
      clauses.push(`audit_logs.${col} = ?`);
      params.push(String(query[key]));
    }
  }
  if (!phpEmpty(query.action)) {
    clauses.push('audit_logs.action LIKE ?');
    params.push(`%${query.action}%`);
  }
  if (!phpEmpty(query.q)) {
    const term = `%${String(query.q).trim()}%`;
    clauses.push('(audit_logs.action LIKE ? OR audit_logs.entity_label LIKE ? OR audit_logs.actor_label LIKE ?)');
    params.push(term, term, term);
  }
  const from = parseDate(query.from ?? null);
  const to = parseDate(query.to ?? null);
  if (from) {
    clauses.push('audit_logs.created_at >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('audit_logs.created_at <= ?');
    params.push(to);
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
}

// ---------------------------------------------------------------------------
// GET /audit-logs
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('audit', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const { page, limit, offset } = parsePaging(req.query);
    const where = auditRouteWhere(req.query, a.organizationId);
    const rows = await dbAll(
      `SELECT ${AUDIT_JOIN_SELECT} FROM ${AUDIT_JOIN_FROM} ${where.sql} ORDER BY audit_logs.created_at DESC LIMIT ? OFFSET ?`,
      [...where.params, limit, offset]
    );
    const total = Number.parseInt(await dbScalar(`SELECT COUNT(*) FROM ${AUDIT_JOIN_FROM} ${where.sql}`, where.params), 10) || 0;
    return jsonOk(
      res,
      rows.map((r) => {
        const out = camelize(scalarRow(r));
        delete out.userFirstName;
        delete out.userLastName;
        delete out.userEmail;
        delete out.userAvatarUrl;
        out.changes = safeJson(r.changes ?? '{}', []);
        out.user = r.user_id
          ? {
              id: r.user_id,
              firstName: r.user_first_name,
              lastName: r.user_last_name,
              email: r.user_email,
              avatarUrl: r.user_avatar_url,
            }
          : null;
        return out;
      }),
      pageMeta(page, limit, total)
    );
  })
);

// ---------------------------------------------------------------------------
// GET /audit-logs/actions — the distinct actions, for the filter dropdown.
// ---------------------------------------------------------------------------
router.get(
  '/actions',
  requirePermission('audit', 'read'),
  ah(async (req, res) => {
    const rows = await dbAll(
      'SELECT action, COUNT(*) AS cnt FROM audit_logs WHERE organization_id = ? GROUP BY action ORDER BY cnt DESC LIMIT 100',
      [req.actor.organizationId]
    );
    return jsonOk(res, rows.map((r) => ({ action: r.action, count: Number.parseInt(r.cnt, 10) || 0 })));
  })
);

// ---------------------------------------------------------------------------
// GET /audit-logs/export — CSV of the filtered trail.
// ---------------------------------------------------------------------------
router.get(
  '/export',
  requirePermission('audit', 'export'),
  ah(async (req, res) => {
    const a = req.actor;
    const query = req.query;
    const where = auditRouteWhere(query, a.organizationId);
    const rows = (
      await dbAll(
        `SELECT ${AUDIT_JOIN_SELECT} FROM ${AUDIT_JOIN_FROM} ${where.sql} ORDER BY audit_logs.created_at DESC LIMIT 20000`,
        where.params
      )
    ).map(scalarRow);

    // Exporting the audit trail is itself an auditable event.
    await auditRecord(
      a.organizationId,
      a,
      'audit.exported',
      { entityLabel: `${rows.length} entries`, changes: { count: rows.length, filters: query } },
      req
    );

    const csv = await toCsv(rows, [
      { key: 'created_at', label: 'Timestamp' },
      {
        label: 'User',
        value: (r) =>
          r.user_id
            ? `${r.user_first_name ?? ''} ${r.user_last_name ?? ''}`.trim()
            : phpEmpty(r.actor_label)
              ? 'system'
              : r.actor_label,
      },
      { label: 'Email', value: (r) => r.user_email ?? '' },
      { key: 'action', label: 'Action' },
      { key: 'entity_type', label: 'Entity Type' },
      { key: 'entity_id', label: 'Entity ID' },
      { key: 'entity_label', label: 'Entity' },
      { label: 'Changes', value: (r) => r.changes },
      { key: 'ip', label: 'IP' },
      { key: 'user_agent', label: 'User Agent' },
    ]);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="growvanta-audit-${Math.floor(Date.now() / 1000)}.csv"`);
    return res.send(csv);
  })
);

router.use((req, res, next) => next(notFound('Unknown audit route')));

export default router;
