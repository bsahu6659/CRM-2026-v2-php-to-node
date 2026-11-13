/**
 * /api/leads/* — port of api/leads.php. Mounted behind requireAuth with the
 * actor's scope already resolved (see app.js).
 */

import express from 'express';
import { dbAll, dbExec, dbInClause, dbOne, dbScalar } from '../lib/db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk, pageMeta, parsePaging, parseSort } from '../lib/response.js';
import { ah, requirePermission, scopeFor, scopeInfo } from '../middleware/index.js';
import { hasPermission } from '../lib/auth.js';
import { visibilityWhere } from '../lib/scope.js';
import { auditRecord, exportRecord } from '../lib/audit.js';
import { addDays, camelize, gvBool, gvId, nowSql, parseDate, safeJson, toSqlDate } from '../lib/util.js';
import { validate } from '../lib/validate.js';
import { xlsxDownload } from '../lib/xlsx.js';
import { toCsv } from '../lib/csv.js';
import { emitDomainEvent } from '../services/events.js';
import { buildLeadWhere } from '../services/filters.js';
import { findDuplicates, mergeLeads } from '../services/duplicates.js';
import { assignLeads, createLead, leadBuildContext, leadResolveStatus, updateLead } from '../services/leadService.js';
import { computeScore, rescoreLead } from '../services/scoring.js';
import { projectVisibleWhere } from '../services/projects.js';

const router = express.Router();

const LEADS_SORTABLE = {
  createdAt: 'leads.created_at', updatedAt: 'leads.updated_at', score: 'leads.score',
  firstName: 'leads.first_name', company: 'leads.company', nextFollowUpAt: 'leads.next_follow_up_at',
  expectedValue: 'leads.expected_value', code: 'leads.code',
};

// ---------------------------------------------------------------------------
// PHP value semantics. Request bodies are judged the way the PHP edition
// judged them, so "0", "" and [] mean "not given" exactly where they did.
// ---------------------------------------------------------------------------

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

/** trim($first . ' ' . ($last ?? '')) */
function joinName(first, last) {
  return `${first ?? ''} ${last ?? ''}`.trim();
}

/** A JSON list or object, as PHP's is_array() sees a decoded body value; null otherwise. */
function asList(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return Object.values(value);
  return null;
}

/**
 * Field-level permission gates (spec section 10).
 *
 * Who may edit a lead and who may change which project, source or status it is
 * counted against are different questions in a real-estate org, because the
 * last three decide whose campaign gets credited and whose target moves.
 * `before` is null on create, where there is no previous value to compare.
 */
function leadsAssertFieldPermissions(actor, body, before) {
  const gates = {
    statusId: ['status_id', 'change_status', 'change the status of a lead'],
    projectId: ['project_id', 'change_project', 'move a lead to a different project'],
    sourceId: ['source_id', 'change_source', 'change the source of a lead'],
  };
  for (const [field, [column, action, description]] of Object.entries(gates)) {
    if (!Object.hasOwn(body, field)) {
      continue;
    }
    // Setting a value that is already there is not a change.
    if (before !== null && str(before[column] ?? '') === str(body[field] ?? '')) {
      continue;
    }
    // On create, choosing an initial value is part of creating; only an
    // edit of an existing lead needs the separate grant.
    if (before === null) {
      continue;
    }
    if (!hasPermission(actor, 'leads', action)) {
      throw forbidden(`You do not have permission to ${description}.`);
    }
  }
}

/**
 * A lead may only point at a project this tenant can actually see. Without this
 * check a crafted projectId would attach a lead to another company's private
 * stock, which is the one cross-tenant leak the project sharing model allows
 * for if it is not closed here.
 */
async function leadsAssertProjectUsable(orgId, projectId) {
  if (projectId === null || projectId === undefined || projectId === '') {
    return;
  }
  const vis = await projectVisibleWhere(orgId);
  const found = await dbScalar(
    `SELECT projects.id FROM projects WHERE projects.id = ? AND ${vis.sql}`,
    [projectId, ...vis.params]
  );
  if (!found) {
    throw badRequest('That project is not available to your company.');
  }
}

/** Shapes one row from the joined list/board query (aliases below) into the wire shape. */
function leadsRouteShapeJoined(r, tagsByLead = {}) {
  const lead = camelize(r);
  for (const k of [
    'statusName', 'statusColor', 'statusKey',
    'sourceName', 'sourceKey', 'campaignName', 'campaignCode',
    'ownerFirstName', 'ownerLastName', 'ownerAvatarUrl', 'teamName',
    'projectLocation', 'projectCity',
  ]) {
    delete lead[k];
  }
  lead.fullName = joinName(r.first_name, r.last_name);
  lead.customFields = safeJson(r.custom_fields ?? '{}', []);
  lead.status = r.status_id ? { id: r.status_id, name: r.status_name, color: r.status_color, key: r.status_key } : null;
  lead.source = r.source_id ? { id: r.source_id, name: r.source_name, key: r.source_key } : null;
  lead.campaign = r.campaign_id ? { id: r.campaign_id, name: r.campaign_name, code: r.campaign_code } : null;
  lead.owner = r.owner_id
    ? { id: r.owner_id, firstName: r.owner_first_name, lastName: r.owner_last_name, avatarUrl: r.owner_avatar_url }
    : null;
  lead.team = r.team_id ? { id: r.team_id, name: r.team_name } : null;
  // projectName is left flat as well as nested: the list table reads the flat
  // one, the detail view the nested object.
  lead.project = r.project_id
    ? { id: r.project_id, name: r.project_name, location: r.project_location, city: r.project_city }
    : null;
  lead.tags = tagsByLead[r.id] ?? [];
  return lead;
}

/** Fetches {leadId: [{id,name,color}, ...]} for a set of lead ids in one query. */
async function leadsRouteTagsMap(leadIds) {
  if (!leadIds.length) {
    return {};
  }
  const [inClause, p] = dbInClause(leadIds);
  const rows = await dbAll(
    `SELECT lt.lead_id, t.id, t.name, t.color FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.lead_id IN ${inClause}`,
    p
  );
  const out = {};
  for (const r of rows) {
    (out[r.lead_id] ??= []).push({ id: r.id, name: r.name, color: r.color });
  }
  return out;
}

const LEADS_JOIN_SELECT = `leads.*,
    s.name AS status_name, s.color AS status_color, s.\`key\` AS status_key,
    src.name AS source_name, src.\`key\` AS source_key,
    c.name AS campaign_name, c.code AS campaign_code,
    o.first_name AS owner_first_name, o.last_name AS owner_last_name, o.avatar_url AS owner_avatar_url,
    tm.name AS team_name,
    pj.name AS project_name, pj.location AS project_location, pj.city AS project_city`;
const LEADS_JOIN_FROM = `leads
    LEFT JOIN lead_statuses s ON s.id = leads.status_id
    LEFT JOIN lead_sources src ON src.id = leads.source_id
    LEFT JOIN campaigns c ON c.id = leads.campaign_id
    LEFT JOIN users o ON o.id = leads.owner_id
    LEFT JOIN teams tm ON tm.id = leads.team_id
    LEFT JOIN projects pj ON pj.id = leads.project_id`;

/** Ensures the actor may see this specific lead, not just leads in general (mirrors loadVisibleLead). */
async function leadsRouteLoadVisibleRow(req, id) {
  const a = req.actor;
  const row = await dbOne(
    `SELECT ${LEADS_JOIN_SELECT} FROM ${LEADS_JOIN_FROM} WHERE leads.id = ? AND leads.organization_id = ?`,
    [id, a.organizationId]
  );
  if (!row) {
    throw notFound('Lead not found');
  }
  const scope = await scopeInfo(req);
  if (!scope.unrestricted) {
    const visible =
      scope.userIds.includes(row.owner_id) ||
      Boolean(row.team_id && scope.teamIds.includes(row.team_id)) ||
      (row.owner_id === null && scope.canSeeUnassigned) ||
      row.created_by_id === a.id;
    if (!visible) {
      throw forbidden('This lead is outside your access scope.');
    }
  }
  return row;
}

/** Bulk-op id resolution: organization + visibility scoped, matching scopedLeadIds. */
async function leadsRouteScopedIds(req, ids) {
  const list = asList(ids);
  if (!list || !list.length) {
    throw badRequest('Select at least one lead');
  }
  const a = req.actor;
  const scope = await scopeInfo(req);
  const [inClause, p] = dbInClause(list.slice(0, 1000));
  let sql = `SELECT id FROM leads WHERE id IN ${inClause} AND organization_id = ?`;
  let params = [...p, a.organizationId];
  if (!scope.unrestricted) {
    const vis = visibilityWhere(scope, 'owner_id', 'team_id');
    if (vis.sql !== '') {
      sql += ` AND ${vis.sql}`;
      params = params.concat(vis.params);
    }
  }
  return (await dbAll(sql, params)).map((r) => r.id);
}

const LEADS_CREATE_MAX_LEN = {
  firstName: 80, lastName: 80, phone: 30, altPhone: 30, company: 150, jobTitle: 120,
  website: 200, country: 80, state: 80, city: 80, address: 400, pincode: 20,
  medium: 80, landingPage: 400, utmSource: 120, utmMedium: 120, utmCampaign: 120,
  utmTerm: 120, utmContent: 120, notes: 5000,
};

function leadsRouteValidateInput(body) {
  const v = validate(body);
  v.required('firstName', 'First name').maxLength('firstName', 80);
  if (!isEmpty(body.email)) {
    v.email('email');
  }
  for (const [field, max] of Object.entries(LEADS_CREATE_MAX_LEN)) {
    if (!isEmpty(body[field])) {
      v.maxLength(field, max);
    }
  }
  if (!isEmpty(body.priority)) {
    v.in('priority', ['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
  }
  v.validate();
}

/** The assign/reassign target check shared by create, bulk assign and PATCH. */
async function assertAssignableOwner(req, action, ownerId) {
  const assignScope = await scopeFor(req, 'leads', action);
  if (!assignScope.unrestricted && !assignScope.userIds.includes(ownerId)) {
    throw forbidden('You cannot assign leads to that user - they are outside the part of the organisation you manage.');
  }
}

// ---------------------------------------------------------------------------
// GET /leads — list
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('leads', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const query = req.query;
    const scope = await scopeInfo(req);
    const { page, limit, offset } = parsePaging(query);
    const where = await buildLeadWhere(query, scope, a.organizationId);
    // parseSort validates ?sort= against the allow-list (camelCase keys of
    // LEADS_SORTABLE) before returning it snake_cased, so sortCol is always
    // one of those trusted column names — safe to qualify and interpolate.
    const [sortCol, dir] = parseSort(query, Object.keys(LEADS_SORTABLE), 'created_at');
    const orderColumn = `leads.${sortCol}`;

    const rows = await dbAll(
      `SELECT ${LEADS_JOIN_SELECT} FROM ${LEADS_JOIN_FROM} ${where.sql} ORDER BY ${orderColumn} ${dir} LIMIT ? OFFSET ?`,
      [...where.params, limit, offset]
    );
    const total = toInt(await dbScalar(`SELECT COUNT(*) FROM ${LEADS_JOIN_FROM} ${where.sql}`, where.params));
    const tagsByLead = await leadsRouteTagsMap(rows.map((r) => r.id));

    return jsonOk(res, rows.map((r) => leadsRouteShapeJoined(r, tagsByLead)), pageMeta(page, limit, total));
  })
);

// ---------------------------------------------------------------------------
// GET /leads/board — kanban
// ---------------------------------------------------------------------------
router.get(
  '/board',
  requirePermission('leads', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const query = req.query;
    const scope = await scopeInfo(req);
    const where = await buildLeadWhere(query, scope, a.organizationId);
    // An integer by construction, so it is safe to interpolate into LIMIT.
    const perColumn = Math.min(50, toInt(query.perColumn ?? 20) || 20);

    const statuses = await dbAll(
      'SELECT * FROM lead_statuses WHERE organization_id = ? AND is_active = 1 ORDER BY sort_order ASC',
      [a.organizationId]
    );
    const columns = [];
    for (const status of statuses) {
      const colSql = `${where.sql} AND leads.status_id = ?`;
      const colParams = [...where.params, status.id];
      const items = await dbAll(
        `SELECT ${LEADS_JOIN_SELECT} FROM ${LEADS_JOIN_FROM} ${colSql} ORDER BY leads.updated_at DESC LIMIT ${perColumn}`,
        colParams
      );
      const total = toInt(await dbScalar(`SELECT COUNT(*) FROM ${LEADS_JOIN_FROM} ${colSql}`, colParams));
      const tagsByLead = await leadsRouteTagsMap(items.map((r) => r.id));
      columns.push({
        status: camelize(status),
        total,
        items: items.map((r) => leadsRouteShapeJoined(r, tagsByLead)),
      });
    }
    return jsonOk(res, columns);
  })
);

// ---------------------------------------------------------------------------
// GET /leads/export — XLSX by default, CSV on request
// ---------------------------------------------------------------------------
router.get(
  '/export',
  requirePermission('leads', 'export'),
  ah(async (req, res) => {
    const a = req.actor;
    const query = req.query;
    // Export gets its own visibility resolution: a manager may be allowed to
    // read the whole region but only to export their own team (spec section 12).
    const scope = await scopeFor(req, 'leads', 'export');
    const where = await buildLeadWhere(query, scope, a.organizationId);
    const rows = await dbAll(
      `SELECT ${LEADS_JOIN_SELECT} FROM ${LEADS_JOIN_FROM} ${where.sql} ORDER BY leads.created_at DESC LIMIT 20000`,
      where.params
    );
    const tagsByLead = await leadsRouteTagsMap(rows.map((r) => r.id));

    // Flatten the joined aliases into plain columns so both writers see the
    // same shape and the two formats cannot drift apart.
    for (const r of rows) {
      r.owner_name = r.owner_id ? joinName(r.owner_first_name, r.owner_last_name) : '';
      r.tags = (tagsByLead[r.id] ?? []).map((t) => t.name).join('; ');
    }

    const columns = [
      { key: 'code', label: 'Lead ID', type: 'string' },
      { key: 'first_name', label: 'First Name', type: 'string' },
      { key: 'last_name', label: 'Last Name', type: 'string' },
      { key: 'phone', label: 'Phone', type: 'string' },
      { key: 'alt_phone', label: 'Alternate Phone', type: 'string' },
      { key: 'email', label: 'Email', type: 'string' },
      { key: 'project_name', label: 'Project', type: 'string' },
      { key: 'configuration', label: 'Configuration', type: 'string' },
      { key: 'budget_min', label: 'Budget From', type: 'number' },
      { key: 'budget_max', label: 'Budget To', type: 'number' },
      { key: 'purpose', label: 'Purpose', type: 'string' },
      { key: 'funding', label: 'Funding', type: 'string' },
      { key: 'possession_timeline', label: 'Possession Timeline', type: 'string' },
      { key: 'source_name', label: 'Lead Source', type: 'string' },
      { key: 'campaign_name', label: 'Campaign', type: 'string' },
      { key: 'utm_source', label: 'UTM Source', type: 'string' },
      { key: 'utm_medium', label: 'UTM Medium', type: 'string' },
      { key: 'utm_campaign', label: 'UTM Campaign', type: 'string' },
      { key: 'status_name', label: 'Status', type: 'string' },
      { key: 'score', label: 'Score', type: 'number' },
      { key: 'priority', label: 'Priority', type: 'string' },
      { key: 'owner_name', label: 'Assigned To', type: 'string' },
      { key: 'team_name', label: 'Team', type: 'string' },
      { key: 'city', label: 'City', type: 'string' },
      { key: 'state', label: 'State', type: 'string' },
      { key: 'tags', label: 'Tags', type: 'string' },
      { key: 'site_visit_at', label: 'Site Visit', type: 'datetime' },
      { key: 'last_contacted_at', label: 'Last Contacted', type: 'datetime' },
      { key: 'next_follow_up_at', label: 'Next Follow-up', type: 'datetime' },
      { key: 'created_at', label: 'Created At', type: 'datetime' },
    ];

    const format = str(query.format ?? 'xlsx').toLowerCase();
    await exportRecord(a.organizationId, a, 'LEADS', format.toUpperCase(), rows.length, query, req);

    const today = toSqlDate(new Date());
    if (format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="growvanta-leads-${today}.csv"`);
      return res.send(toCsv(rows, columns));
    }
    return xlsxDownload(res, `growvanta-leads-${today}.xlsx`, columns, rows, 'Leads');
  })
);

// ---------------------------------------------------------------------------
// POST /leads/check-duplicates
// ---------------------------------------------------------------------------
router.post(
  '/check-duplicates',
  requirePermission('leads', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    return jsonOk(res, await findDuplicates(a.organizationId, body, body.excludeId ?? null));
  })
);

// ---------------------------------------------------------------------------
// POST /leads — create
// ---------------------------------------------------------------------------
router.post(
  '/',
  requirePermission('leads', 'create'),
  ah(async (req, res) => {
    const body = { ...(req.body ?? {}) };
    leadsRouteValidateInput(body);
    const a = req.actor;
    if (!isEmpty(body.email)) {
      const trimmed = str(body.email).trim();
      body.email = isEmpty(trimmed) ? null : trimmed;
    }
    if (!isEmpty(body.ownerId)) {
      if (!hasPermission(a, 'leads', 'assign')) {
        throw forbidden('You do not have permission to assign leads to another user.');
      }
      await assertAssignableOwner(req, 'assign', body.ownerId);
    }
    leadsAssertFieldPermissions(a, body, null);

    // A property enquiry is always about something. Required here, where a
    // person is typing and can choose, rather than inside createLead() - a
    // form, an import or a Meta lead that arrives without one must still be
    // accepted, because a lead nobody can attribute beats a lead that was
    // refused at the door. Those land in the "No project" filter instead.
    if (isEmpty(body.projectId) && isEmpty(body.project)) {
      throw badRequest('Choose the project this enquiry is about.');
    }

    await leadsAssertProjectUsable(a.organizationId, body.projectId ?? null);
    const settings = safeJson(await dbScalar('SELECT settings FROM organizations WHERE id = ?', [a.organizationId]), {});
    const policy = !isEmpty(body.allowDuplicate) ? 'ALLOW' : (settings?.duplicatePolicy ?? 'FLAG');

    const result = await createLead(body, {
      organizationId: a.organizationId,
      actor: a,
      origin: 'MANUAL',
      duplicatePolicy: policy,
    });
    return jsonCreated(res, {
      ...result.lead,
      fullName: joinName(result.lead.firstName, result.lead.lastName),
      duplicates: result.duplicates,
      assignment: result.assignment,
    });
  })
);

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------
router.post(
  '/bulk/assign',
  requirePermission('leads', 'assign'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const ids = await leadsRouteScopedIds(req, body.leadIds ?? null);
    const ownerId = body.ownerId ?? null;
    const teamId = body.teamId ?? null;
    if (isEmpty(ownerId) && isEmpty(teamId)) {
      throw badRequest('Choose a user or a team');
    }
    // Any lead in the selection that already has an owner turns this into a
    // reassignment, which needs the stronger permission.
    const [inSel, selParams] = dbInClause(ids);
    const alreadyOwned = toInt(
      await dbScalar(
        `SELECT COUNT(*) FROM leads WHERE organization_id = ? AND owner_id IS NOT NULL AND id IN ${inSel}`,
        [a.organizationId, ...selParams]
      )
    );
    if (alreadyOwned > 0 && !hasPermission(a, 'leads', 'reassign')) {
      throw forbidden(
        `You do not have permission to reassign leads, and ${alreadyOwned} of the selected leads already have an owner.`
      );
    }
    if (!isEmpty(ownerId)) {
      await assertAssignableOwner(req, alreadyOwned > 0 ? 'reassign' : 'assign', ownerId);
    }
    const count = await assignLeads(
      a.organizationId,
      ids,
      isEmpty(ownerId) ? null : ownerId,
      isEmpty(teamId) ? null : teamId,
      a
    );
    return jsonOk(res, { updated: count });
  })
);

// change_status as well as update: without it this route is a way around the
// dedicated grant, since a tick-box selection of one lead does exactly what
// PATCH /api/leads/:id does under a weaker permission.
router.post(
  '/bulk/status',
  requirePermission('leads', 'update'),
  requirePermission('leads', 'change_status'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const ids = await leadsRouteScopedIds(req, body.leadIds ?? null);
    const status = await leadResolveStatus(a.organizationId, body.statusId ?? null);
    const extra = [];
    const extraParams = [];
    if (gvBool(status.is_qualified)) {
      extra.push('qualified_at = NOW()');
    }
    if (gvBool(status.is_lost)) {
      extra.push('lost_at = NOW()');
      extra.push('lost_reason = ?');
      extraParams.push(str(body.lostReason ?? ''));
    }
    if (ids.length) {
      const [inClause, p] = dbInClause(ids);
      await dbExec(
        `UPDATE leads SET status_id = ?${extra.length ? `, ${extra.join(', ')}` : ''} WHERE id IN ${inClause}`,
        [status.id, ...extraParams, ...p]
      );
      for (const leadId of ids) {
        await dbExec(
          'INSERT INTO activities (id, organization_id, type, subject, lead_id, user_id, occurred_at, created_at) VALUES (?,?,?,?,?,?,NOW(),NOW())',
          [gvId(), a.organizationId, 'STATUS_CHANGE', `Bulk status change to ${status.name}`, leadId, a.id]
        );
        emitDomainEvent('lead.status_changed', {
          organizationId: a.organizationId,
          entityType: 'LEAD',
          data: { id: leadId, statusId: status.id, status: camelize(status) },
        });
      }
    }
    await auditRecord(
      a.organizationId,
      a,
      'lead.bulk_status_changed',
      {
        entityType: 'LEAD',
        entityLabel: `${ids.length} leads`,
        changes: { statusId: status.id, statusName: status.name, leadIds: ids },
      },
      req
    );
    return jsonOk(res, { updated: ids.length });
  })
);

router.post(
  '/bulk/tag',
  requirePermission('leads', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const ids = await leadsRouteScopedIds(req, body.leadIds ?? null);
    const names = (asList(body.tags ?? []) ?? [])
      .map((t) => str(t).trim())
      .filter((t) => !isEmpty(t));
    if (!names.length) {
      throw badRequest('Provide at least one tag');
    }
    const tagRows = [];
    for (const name of names) {
      let tag = await dbOne('SELECT * FROM tags WHERE organization_id = ? AND name = ?', [a.organizationId, name]);
      if (!tag) {
        const tagId = gvId();
        await dbExec('INSERT INTO tags (id, organization_id, name, created_at) VALUES (?,?,?,NOW())', [
          tagId,
          a.organizationId,
          name,
        ]);
        tag = { id: tagId, name };
      }
      tagRows.push(tag);
    }
    for (const leadId of ids) {
      for (const tag of tagRows) {
        if (!(await dbOne('SELECT id FROM lead_tags WHERE lead_id = ? AND tag_id = ?', [leadId, tag.id]))) {
          await dbExec('INSERT INTO lead_tags (id, lead_id, tag_id) VALUES (?,?,?)', [gvId(), leadId, tag.id]);
        }
      }
    }
    return jsonOk(res, { updated: ids.length, tags: tagRows.map((t) => t.name) });
  })
);

router.post(
  '/bulk/fields',
  requirePermission('leads', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const ids = await leadsRouteScopedIds(req, body.leadIds ?? null);
    const fields = body.fields !== null && typeof body.fields === 'object' ? body.fields : {};
    const allowed = {
      priority: 'priority', sourceId: 'source_id', campaignId: 'campaign_id',
      city: 'city', state: 'state', country: 'country', medium: 'medium',
    };
    const data = {};
    for (const [camel, col] of Object.entries(allowed)) {
      if (Object.hasOwn(fields, camel)) {
        data[col] = isEmpty(fields[camel]) ? null : fields[camel];
      }
    }
    if (Object.hasOwn(fields, 'nextFollowUpAt')) {
      data.next_follow_up_at = parseDate(fields.nextFollowUpAt);
    }
    if (!Object.keys(data).length) {
      throw badRequest('No supported fields to update');
    }
    if (ids.length) {
      const [inClause, p] = dbInClause(ids);
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE leads SET ${sets} WHERE id IN ${inClause}`, [...Object.values(data), ...p]);
    }
    await auditRecord(
      a.organizationId,
      a,
      'lead.bulk_updated',
      { entityType: 'LEAD', entityLabel: `${ids.length} leads`, changes: data },
      req
    );
    return jsonOk(res, { updated: ids.length });
  })
);

// Replaces bulk task creation: the follow-up lives on the lead, so setting it
// in bulk is a single UPDATE rather than a row per lead.
router.post(
  '/bulk/follow-up',
  requirePermission('leads', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const ids = await leadsRouteScopedIds(req, body.leadIds ?? null);
    const dueInDays = toInt(body.dueInDays ?? 1);
    const dueAt = addDays(new Date(), dueInDays || 1);
    let count = 0;
    if (ids.length) {
      const [inClause, p] = dbInClause(ids);
      count = await dbExec(
        `UPDATE leads SET next_follow_up_at = ?, updated_at = NOW() WHERE organization_id = ? AND id IN ${inClause}`,
        [dueAt, a.organizationId, ...p]
      );
    }
    await auditRecord(
      a.organizationId,
      a,
      'lead.bulk_follow_up_set',
      { entityType: 'LEAD', entityLabel: `${ids.length} leads`, changes: { nextFollowUpAt: dueAt } },
      req
    );
    return jsonOk(res, { updated: count });
  })
);

router.post(
  '/bulk/delete',
  requirePermission('leads', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const ids = await leadsRouteScopedIds(req, body.leadIds ?? null);
    let leads = [];
    if (ids.length) {
      const [inClause, p] = dbInClause(ids);
      leads = await dbAll(`SELECT id, code FROM leads WHERE id IN ${inClause}`, p);
      await dbExec(`DELETE FROM leads WHERE id IN ${inClause}`, p);
    }
    await auditRecord(
      a.organizationId,
      a,
      'lead.bulk_deleted',
      { entityType: 'LEAD', entityLabel: `${leads.length} leads`, changes: { codes: leads.map((l) => l.code) } },
      req
    );
    return jsonOk(res, { deleted: leads.length });
  })
);

// ---------------------------------------------------------------------------
// POST /leads/merge
// ---------------------------------------------------------------------------
router.post(
  '/merge',
  requirePermission('leads', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const targetId = body.targetId ?? null;
    const sourceIds = asList(body.sourceIds ?? null);
    if (isEmpty(targetId) || !sourceIds || !sourceIds.length) {
      throw badRequest('Provide a target lead and at least one source lead');
    }
    await leadsRouteLoadVisibleRow(req, targetId);
    const result = await mergeLeads(a.organizationId, targetId, sourceIds, a.id);
    await auditRecord(
      a.organizationId,
      a,
      'lead.merged',
      { entityType: 'LEAD', entityId: targetId, changes: { mergedIds: sourceIds } },
      req
    );
    emitDomainEvent('lead.merged', {
      organizationId: a.organizationId,
      entityType: 'LEAD',
      data: camelize(result.merged),
    });
    const merged = camelize(result.merged);
    merged.fullName = joinName(merged.firstName, merged.lastName);
    return jsonOk(res, { merged: result.mergedCount, lead: merged });
  })
);

// ---------------------------------------------------------------------------
// GET /leads/:id — single lead 360 view
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  requirePermission('leads', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const row = await leadsRouteLoadVisibleRow(req, req.params.id);
    const tagsByLead = await leadsRouteTagsMap([row.id]);

    const activities = await dbAll(
      `SELECT a.*, u.id AS u_id, u.first_name AS u_first_name, u.last_name AS u_last_name, u.avatar_url AS u_avatar_url
         FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = ? ORDER BY a.occurred_at DESC LIMIT 200`,
      [row.id]
    );
    const documents = await dbAll(
      `SELECT d.*, u.id AS ub_id, u.first_name AS ub_first_name, u.last_name AS ub_last_name
         FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by_id WHERE d.lead_id = ? ORDER BY d.created_at DESC`,
      [row.id]
    );
    const duplicates = await findDuplicates(a.organizationId, camelize(row), row.id);
    const score = await computeScore(a.organizationId, await leadBuildContext(row));

    const auditTrail = hasPermission(a, 'audit', 'read')
      ? await dbAll(
          'SELECT * FROM audit_logs WHERE organization_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT 100',
          [a.organizationId, 'LEAD', row.id]
        )
      : [];

    return jsonOk(res, {
      lead: leadsRouteShapeJoined(row, tagsByLead),
      activities: activities.map((r) => ({
        ...camelize(r),
        meta: safeJson(r.meta ?? '{}', []),
        user: r.user_id
          ? { id: r.u_id, firstName: r.u_first_name, lastName: r.u_last_name, avatarUrl: r.u_avatar_url }
          : null,
      })),
      documents: documents.map((r) => ({
        ...camelize(r),
        uploadedBy: r.uploaded_by_id ? { id: r.ub_id, firstName: r.ub_first_name, lastName: r.ub_last_name } : null,
      })),
      duplicates,
      score,
      auditTrail: auditTrail.map((r) => ({ ...camelize(r), changes: safeJson(r.changes ?? '{}', []) })),
    });
  })
);

// ---------------------------------------------------------------------------
// PATCH /leads/:id
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requirePermission('leads', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const id = req.params.id;
    const existing = await leadsRouteLoadVisibleRow(req, id);

    if (Object.hasOwn(body, 'ownerId')) {
      // Taking a lead off somebody is a different act from placing an
      // unowned one, and the spec (section 16) gates them separately. The
      // permission is checked BEFORE the target scope so the refusal names
      // the real reason rather than blaming the chosen user.
      const isReassign = !isEmpty(existing.owner_id) && existing.owner_id !== body.ownerId;
      const needed = isReassign ? 'reassign' : 'assign';
      if (!hasPermission(a, 'leads', needed)) {
        throw forbidden(
          isReassign
            ? 'You do not have permission to reassign leads.'
            : 'You do not have permission to assign leads.'
        );
      }
      if (!isEmpty(body.ownerId)) {
        await assertAssignableOwner(req, needed, body.ownerId);
      }
    }
    leadsAssertFieldPermissions(a, body, existing);
    await leadsAssertProjectUsable(a.organizationId, body.projectId ?? null);

    const lead = await updateLead(id, body, { organizationId: a.organizationId, actor: a });
    lead.fullName = joinName(lead.firstName, lead.lastName);
    return jsonOk(res, lead);
  })
);

// ---------------------------------------------------------------------------
// DELETE /leads/:id
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requirePermission('leads', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const row = await leadsRouteLoadVisibleRow(req, req.params.id);
    await dbExec('DELETE FROM leads WHERE id = ?', [row.id]);
    await auditRecord(
      a.organizationId,
      a,
      'lead.deleted',
      { entityType: 'LEAD', entityId: row.id, entityLabel: `${row.code ?? ''} ${row.first_name ?? ''}` },
      req
    );
    emitDomainEvent('lead.deleted', { organizationId: a.organizationId, entityType: 'LEAD', data: camelize(row) });
    return jsonOk(res, { deleted: true });
  })
);

// ---------------------------------------------------------------------------
// POST /leads/:id/activities — log a call, meeting, note …
// ---------------------------------------------------------------------------
router.post(
  '/:id/activities',
  requirePermission('activities', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const row = await leadsRouteLoadVisibleRow(req, req.params.id);
    validate(body)
      .required('type', 'Activity type')
      .in('type', ['CALL', 'EMAIL', 'MEETING', 'SMS', 'WHATSAPP', 'NOTE'])
      .validate();

    const occurredAt = parseDate(body.occurredAt ?? null) ?? nowSql();
    const activityId = gvId();
    await dbExec(
      `INSERT INTO activities (id, organization_id, type, subject, body, direction, outcome, duration_sec, meta, occurred_at, lead_id, user_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        activityId, a.organizationId, body.type, body.subject ?? null, body.body ?? null,
        body.direction ?? null, body.outcome ?? null,
        body.durationSec !== undefined && body.durationSec !== null ? toInt(body.durationSec) : null,
        '{}', occurredAt, row.id, a.id,
      ]
    );

    const leadPatch = {};
    if (['CALL', 'EMAIL', 'MEETING', 'WHATSAPP', 'SMS'].includes(body.type)) {
      leadPatch.last_contacted_at = occurredAt;
    }
    const nextFollowUp = parseDate(body.nextFollowUpAt ?? null);
    if (nextFollowUp) {
      leadPatch.next_follow_up_at = nextFollowUp;
    }
    if (Object.keys(leadPatch).length) {
      const sets = Object.keys(leadPatch).map((k) => `${k} = ?`).join(', ');
      await dbExec(`UPDATE leads SET ${sets} WHERE id = ?`, [...Object.values(leadPatch), row.id]);
    }
    await rescoreLead(a.organizationId, row.id, a.id);
    await auditRecord(
      a.organizationId,
      a,
      'activity.logged',
      { entityType: 'LEAD', entityId: row.id, changes: { type: body.type, subject: body.subject ?? null } },
      req
    );

    const activity = await dbOne('SELECT * FROM activities WHERE id = ?', [activityId]);
    const activityOut = camelize(activity);
    activityOut.meta = safeJson(activity.meta ?? '{}', []);
    activityOut.user = { id: a.id, firstName: a.firstName, lastName: a.lastName, avatarUrl: a.avatarUrl };
    return jsonCreated(res, activityOut);
  })
);

// ---------------------------------------------------------------------------
// POST /leads/:id/rescore
// ---------------------------------------------------------------------------
router.post(
  '/:id/rescore',
  requirePermission('leads', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const id = req.params.id;
    await leadsRouteLoadVisibleRow(req, id);
    const updated = await rescoreLead(a.organizationId, id, a.id);
    return jsonOk(res, updated ? camelize(updated) : { unchanged: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown leads route')));

export default router;
