/**
 * /api/search — global search, port of api/search.php.
 *
 * Leads, projects and people are queried independently and capped, so one very
 * common term cannot make the endpoint expensive. Phone terms are normalised to
 * the same last-10-digit form used for duplicate matching, so "+91 98765 43210"
 * finds a lead stored as "9876543210".
 */

import express from 'express';
import { dbAll } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { jsonOk } from '../lib/response.js';
import { ah, scopeInfo } from '../middleware/index.js';
import { hasPermission } from '../lib/auth.js';
import { visibilityWhere } from '../lib/scope.js';
import { normalizePhone } from '../lib/util.js';
import { projectVisibleWhere } from '../services/projects.js';

const router = express.Router();

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

/** PHP truthiness, for the `?:` and array_filter() calls below. */
function truthy(value) {
  return !(value === undefined || value === null || value === false || value === 0 || value === '' || value === '0');
}

/** implode(' · ', array_filter($parts)) */
function subtitle(parts) {
  return parts.filter(truthy).join(' · ');
}

/** Appends a visibility fragment to a clause list, if the scope restricts anything. */
function applyVis(visibility, clauses, params) {
  if (visibility.sql !== '') {
    clauses.push(visibility.sql);
    params.push(...visibility.params);
  }
}

router.get(
  '/',
  ah(async (req, res) => {
    const a = req.actor;
    const scope = await scopeInfo(req);
    const query = req.query;
    const term = str(query.q ?? '').trim();

    // Byte length, as PHP's strlen() measured it.
    if (Buffer.byteLength(term, 'utf8') < 2) {
      return jsonOk(res, { query: term, results: [], total: 0 });
    }

    const orgId = a.organizationId;
    // An integer by construction, so it is safe to interpolate into LIMIT.
    const perType = Math.min(10, toInt(query.limit ?? 6) || 6);
    const like = `%${term}%`;
    const phone = normalizePhone(term);
    const results = [];

    if (hasPermission(a, 'leads', 'read')) {
      const clauses = ['leads.organization_id = ?', 'leads.is_duplicate = 0'];
      const params = [orgId];
      applyVis(visibilityWhere(scope, 'leads.owner_id', 'leads.team_id'), clauses, params);
      let match =
        'leads.first_name LIKE ? OR leads.last_name LIKE ? OR leads.email LIKE ? OR leads.company LIKE ? OR leads.code LIKE ? OR leads.phone LIKE ?';
      params.push(like, like, like, like, like, like);
      if (phone) {
        match += ' OR leads.phone_norm = ?';
        params.push(phone);
      }
      clauses.push(`(${match})`);
      const rows = await dbAll(
        `SELECT leads.id, leads.code, leads.first_name, leads.last_name, leads.company, leads.email, leads.phone,
                s.name AS status_name, s.color AS status_color
         FROM leads LEFT JOIN lead_statuses s ON s.id = leads.status_id
         WHERE ${clauses.join(' AND ')} ORDER BY leads.updated_at DESC LIMIT ${perType}`,
        params
      );
      for (const r of rows) {
        results.push({
          type: 'lead',
          id: r.id,
          title: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
          subtitle: subtitle([r.code, r.company, truthy(r.email) ? r.email : r.phone]),
          badge: r.status_name,
          badgeColor: r.status_color,
          link: `#/leads/${r.id}`,
        });
      }
    }

    if (hasPermission(a, 'projects', 'read')) {
      // Uses the same visibility predicate as the projects list, so search can
      // never surface a project another company keeps private.
      const vis = await projectVisibleWhere(orgId);
      const rows = await dbAll(
        `SELECT projects.id, projects.name, projects.code, projects.location, projects.city, projects.status
           FROM projects
          WHERE ${vis.sql} AND projects.is_archived = 0
            AND (projects.name LIKE ? OR projects.location LIKE ? OR projects.developer_name LIKE ? OR projects.code LIKE ?)
          ORDER BY projects.name ASC LIMIT ${perType}`,
        [...vis.params, like, like, like, like]
      );
      for (const r of rows) {
        results.push({
          type: 'project',
          id: r.id,
          title: r.name,
          subtitle: subtitle([r.code, truthy(r.location) ? r.location : r.city]),
          badge: r.status,
          link: `#/projects/${r.id}`,
        });
      }
    }

    if (hasPermission(a, 'users', 'read')) {
      const clauses = ['users.organization_id = ?', 'users.is_active = 1'];
      const params = [orgId];
      clauses.push('(users.first_name LIKE ? OR users.last_name LIKE ? OR users.email LIKE ?)');
      params.push(like, like, like);
      const rows = await dbAll(
        `SELECT users.id, users.first_name, users.last_name, users.email, roles.name AS role_name
           FROM users LEFT JOIN roles ON roles.id = users.role_id
          WHERE ${clauses.join(' AND ')} ORDER BY users.first_name ASC LIMIT ${perType}`,
        params
      );
      for (const r of rows) {
        results.push({
          type: 'user',
          id: r.id,
          title: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
          subtitle: subtitle([r.role_name, r.email]),
          link: '#/users',
        });
      }
    }

    return jsonOk(res, { query: term, results, total: results.length });
  })
);

router.use((req, res, next) => next(notFound('Unknown search route')));

export default router;
