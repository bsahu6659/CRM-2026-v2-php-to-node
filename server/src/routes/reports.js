/**
 * /api/reports/* — thin HTTP layer over services/reports.js, port of
 * api/reports.php. Every report is computed inside the actor's visibility
 * scope, resolved once at the top of each request.
 */

import express from 'express';
import { dbAll, dbInClause } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { jsonOk } from '../lib/response.js';
import { ah, requirePermission, scopeInfo } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { camelize } from '../lib/util.js';
import { toCsv } from '../lib/csv.js';
import {
  GV_LEAD_DIMENSIONS,
  leadReport,
  marketingReport,
  performanceReport,
  reportsDashboard,
  reportsLeadTrend,
  reportsTeamLeaderboard,
} from '../services/reports.js';

const router = express.Router();

/** Runs a report with the actor's org and scope, the way every PHP branch did. */
const report = (module, action, fn) => [
  requirePermission(module, action),
  ah(async (req, res) => {
    const scope = await scopeInfo(req);
    return jsonOk(res, await fn(req.actor.organizationId, scope, req.query));
  }),
];

router.get('/dashboard', ...report('dashboard', 'read', reportsDashboard));
router.get('/leads', ...report('reports', 'read', leadReport));
router.get('/performance', ...report('reports', 'read', performanceReport));
router.get('/marketing', ...report('reports', 'read', marketingReport));
router.get('/trend', ...report('reports', 'read', reportsLeadTrend));
router.get('/leaderboard', ...report('dashboard', 'read', reportsTeamLeaderboard));

// ---------------------------------------------------------------------------
// GET /reports/filters — filter options for the report toolbars, scoped to
// what the actor can see.
// ---------------------------------------------------------------------------
router.get(
  '/filters',
  requirePermission('dashboard', 'read'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const scope = await scopeInfo(req);
    const statuses = await dbAll(
      'SELECT id, name, color, `key`, is_lost, is_qualified FROM lead_statuses WHERE organization_id = ? ORDER BY sort_order ASC',
      [orgId]
    );
    const sources = await dbAll('SELECT id, name, `key` FROM lead_sources WHERE organization_id = ? ORDER BY sort_order ASC', [orgId]);

    let teams;
    let users;
    if (scope.unrestricted) {
      teams = await dbAll('SELECT id, name FROM teams WHERE organization_id = ?', [orgId]);
      users = await dbAll('SELECT id, first_name, last_name FROM users WHERE organization_id = ? AND is_active = 1 ORDER BY first_name ASC', [orgId]);
    } else {
      const [tIn, tP] = dbInClause(scope.teamIds);
      teams = await dbAll(`SELECT id, name FROM teams WHERE organization_id = ? AND id IN ${tIn}`, [orgId, ...tP]);
      const [uIn, uP] = dbInClause(scope.userIds);
      users = await dbAll(
        `SELECT id, first_name, last_name FROM users WHERE organization_id = ? AND is_active = 1 AND id IN ${uIn} ORDER BY first_name ASC`,
        [orgId, ...uP]
      );
    }

    const dimensions = Object.entries(GV_LEAD_DIMENSIONS).map(([key, dim]) => ({ key, label: dim.label }));

    return jsonOk(res, {
      statuses: statuses.map((s) => camelize(s)),
      sources: sources.map((s) => camelize(s)),
      teams: teams.map((t) => camelize(t)),
      users: users.map((u) => ({ id: u.id, name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() })),
      dimensions,
    });
  })
);

// ---------------------------------------------------------------------------
// GET /reports/export/:sub — CSV of the leads, performance or marketing report
// ---------------------------------------------------------------------------
router.get(
  '/export/:sub',
  requirePermission('reports', 'export'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const query = req.query;
    const sub = req.params.sub;
    const scope = await scopeInfo(req);
    let rows = [];
    let columns = [];

    if (sub === 'leads') {
      const result = await leadReport(orgId, scope, query);
      rows = result.rows;
      columns = [
        { key: 'label', label: result.dimensionLabel },
        { key: 'leads', label: 'Leads' }, { key: 'qualified', label: 'Qualified' }, { key: 'converted', label: 'Converted' },
        { key: 'qualificationRate', label: 'Qualification %' }, { key: 'conversionRate', label: 'Conversion %' },
        { key: 'expectedValue', label: 'Expected Value' }, { key: 'share', label: 'Share %' },
      ];
    } else if (sub === 'performance') {
      rows = await performanceReport(orgId, scope, query);
      columns = [
        { key: 'name', label: 'User' }, { key: 'email', label: 'Email' },
        { key: 'leads', label: 'Leads' }, { key: 'calls', label: 'Calls' },
        { key: 'meetings', label: 'Meetings' }, { key: 'emails', label: 'Emails' },
        { key: 'converted', label: 'Converted' }, { key: 'conversionRate', label: 'Conversion %' },
        { key: 'siteVisits', label: 'Site Visits' },
        { key: 'deals', label: 'Bookings' }, { key: 'revenue', label: 'Booking Value' },
      ];
    } else if (sub === 'marketing') {
      const result = await marketingReport(orgId, scope, query);
      rows = result.sources;
      columns = [
        { key: 'label', label: 'Lead Source' },
        { key: 'leads', label: 'Leads' }, { key: 'qualified', label: 'Qualified' },
        { key: 'siteVisits', label: 'Site Visits' }, { key: 'converted', label: 'Bookings' },
        { key: 'revenue', label: 'Booking Value' },
        { key: 'costPerLead', label: 'Cost / Lead' }, { key: 'spend', label: 'Spend' },
        { key: 'costPerBooking', label: 'Cost / Booking' },
        { key: 'conversionRate', label: 'Conversion %' }, { key: 'roi', label: 'ROI %' },
      ];
    } else {
      throw notFound(`Unknown report "${sub}"`);
    }

    await auditRecord(
      orgId,
      a,
      'report.exported',
      { entityLabel: sub, changes: { report: sub, rows: rows.length, filters: query } },
      req
    );
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="growvanta-${sub}-report-${Math.floor(Date.now() / 1000)}.csv"`);
    return res.send(toCsv(rows, columns));
  })
);

router.use((req, res, next) => next(notFound('Unknown reports route')));

export default router;
