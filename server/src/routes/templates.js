/**
 * /api/templates/* — port of api/templates.php.
 *
 * WhatsApp and email message templates, tenant-scoped. Validation here is
 * what stops a template from silently rendering blanks in production: every
 * {{variable}} must either be a known context variable or be explicitly
 * mapped, and that same check feeds the ORANGE/GREEN verdict in
 * services/comms.js.
 */

import crypto from 'node:crypto';
import express from 'express';
import { dbAll, dbExec, dbOne, dbScalar } from '../lib/db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { resolveTenantParam } from '../lib/tenancy.js';
import { camelize, fullName, gvBool, gvDiff, gvId, slugify, toJson } from '../lib/util.js';
import { GV_TEMPLATE_VARIABLES, templateRender, templateVariables } from '../services/comms.js';

const router = express.Router();

function has(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

/** PHP `(string)` cast. */
function str(v) {
  if (v === undefined || v === null || v === false) return '';
  if (v === true) return '1';
  if (Array.isArray(v) || typeof v === 'object') return 'Array';
  return String(v);
}

/**
 * PDO returns every column as a scalar, so the PHP edition saw the JSON
 * `variables` column as text. mysql2 parses native JSON into an array;
 * re-serialising keeps gvDiff() comparing like with like.
 */
function scalarRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v !== null && typeof v === 'object' && !Buffer.isBuffer(v) ? JSON.stringify(v) : v;
  }
  return out;
}

async function templatesShape(row) {
  const out = camelize(scalarRow(row));
  out.variables = await templateVariables(`${str(row.body)} ${str(row.subject ?? '')}`);
  out.unknownVariables = out.variables.filter((v) => !GV_TEMPLATE_VARIABLES.includes(v));
  return out;
}

async function orgName(orgId) {
  return str(await dbScalar('SELECT name FROM organizations WHERE id = ?', [orgId]));
}

async function loadOrgTemplate(req, id) {
  const row = await dbOne('SELECT * FROM message_templates WHERE id = ? AND organization_id = ?', [id, req.commsOrgId]);
  if (!row) throw notFound('Template not found.');
  return row;
}

/**
 * The tenant whose templates are read and written. A Super Admin configuring
 * a client's messaging passes ?organizationId= exactly as the WhatsApp and
 * email screens do; without this the templates panel on that same screen
 * showed and edited the platform's own templates instead of the client's.
 * Tenant users can only ever resolve to their own organisation.
 */
router.use(
  ah(async (req, res, next) => {
    const body = req.body ?? {};
    req.commsOrgId = await resolveTenantParam(req, req.query.organizationId ?? body.organizationId ?? null);
    next();
  })
);

// ---------------------------------------------------------------------------
// GET /templates
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('templates', 'read'),
  ah(async (req, res) => {
    const query = req.query;
    const where = ['organization_id = ?'];
    const params = [req.commsOrgId];
    if (query.channel !== undefined && query.channel !== null && query.channel !== '' && query.channel !== '0') {
      where.push('channel = ?');
      params.push(str(query.channel).toUpperCase());
    }
    if ((query.activeOnly ?? '') === 'true') {
      where.push('is_active = 1');
    }
    const rows = await dbAll(
      `SELECT * FROM message_templates WHERE ${where.join(' AND ')} ORDER BY channel ASC, name ASC`,
      params
    );
    const out = [];
    for (const row of rows) out.push(await templatesShape(row));
    return jsonOk(res, out);
  })
);

// ---------------------------------------------------------------------------
// GET /templates/variables
// ---------------------------------------------------------------------------
router.get(
  '/variables',
  requirePermission('templates', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    return jsonOk(res, {
      supported: GV_TEMPLATE_VARIABLES,
      sample: {
        customer_name: 'Rahul Sharma',
        project_name: 'ABC Residency',
        project_location: 'Sector 84, Gurugram',
        company_name: await orgName(req.commsOrgId),
        sales_person_name: fullName(a.firstName, a.lastName).trim(),
      },
    });
  })
);

// ---------------------------------------------------------------------------
// POST /templates/preview
// ---------------------------------------------------------------------------
router.post(
  '/preview',
  requirePermission('templates', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    // Renders against sample data so an author can see the result before the
    // template ever touches a customer.
    const context = body.context ?? null;
    const sample = {
      ...Object.fromEntries(GV_TEMPLATE_VARIABLES.map((k) => [k, ''])),
      customer_name: 'Rahul Sharma',
      first_name: 'Rahul',
      last_name: 'Sharma',
      phone: '+91 98765 43210',
      email: 'rahul@example.com',
      project_name: 'ABC Residency',
      project_location: 'Sector 84, Gurugram',
      company_name: await orgName(req.commsOrgId),
      sales_person_name: fullName(a.firstName, a.lastName).trim(),
      sales_person_phone: '+91 90000 00000',
      lead_code: 'LD-1001',
      budget: '75,00,000',
      configuration: '3 BHK',
      lead_source: 'Meta Ads',
      ...(context !== null && typeof context === 'object' ? context : {}),
    };

    return jsonOk(res, {
      subject: await templateRender(str(body.subject ?? ''), sample),
      body: await templateRender(str(body.body ?? ''), sample),
      variables: await templateVariables(`${str(body.body ?? '')} ${str(body.subject ?? '')}`),
    });
  })
);

// ---------------------------------------------------------------------------
// GET /templates/:id
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  requirePermission('templates', 'read'),
  ah(async (req, res) => {
    return jsonOk(res, await templatesShape(await loadOrgTemplate(req, req.params.id)));
  })
);

// ---------------------------------------------------------------------------
// POST /templates
// ---------------------------------------------------------------------------
router.post(
  '/',
  requirePermission('templates', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = req.commsOrgId;
    const body = req.body ?? {};
    const channel = str(body.channel ?? '').trim().toUpperCase();
    if (!['WHATSAPP', 'EMAIL'].includes(channel)) {
      throw badRequest('Channel must be WHATSAPP or EMAIL.');
    }
    const name = str(body.name ?? '').trim();
    const text = str(body.body ?? '').trim();
    if (name === '' || text === '') {
      throw badRequest('Template name and body are required.');
    }
    if (channel === 'EMAIL' && str(body.subject ?? '').trim() === '') {
      throw badRequest('Email templates need a subject line.');
    }

    let key = slugify(str(body.key ?? name)) || `tpl-${crypto.randomBytes(3).toString('hex')}`;
    if (await dbScalar('SELECT id FROM message_templates WHERE organization_id = ? AND `key` = ?', [orgId, key])) {
      key += `-${crypto.randomBytes(2).toString('hex')}`;
    }

    const templateId = gvId();
    await dbExec(
      `INSERT INTO message_templates
         (id, organization_id, channel, name, \`key\`, provider_name, language, subject, body,
          variables, category, status, is_active, created_by_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [
        templateId, orgId, channel, name, key, body.providerName ?? null,
        body.language ?? 'en', body.subject ?? null, text,
        toJson(await templateVariables(`${text} ${str(body.subject ?? '')}`)),
        body.category ?? 'UTILITY',
        // WhatsApp templates need provider approval; claiming APPROVED here
        // would be the exact "fake green" the spec forbids.
        channel === 'WHATSAPP' ? 'DRAFT' : (body.status ?? 'DRAFT') === 'APPROVED' ? 'APPROVED' : 'DRAFT',
        // A new template always starts active (the PHP expression yielded 1
        // on both branches).
        1,
        a.id,
      ]
    );
    await auditRecord(
      orgId,
      a,
      'template.created',
      { entityType: 'TEMPLATE', entityId: templateId, entityLabel: name, changes: { channel } },
      req
    );
    return jsonCreated(res, await templatesShape(await dbOne('SELECT * FROM message_templates WHERE id = ?', [templateId])));
  })
);

// ---------------------------------------------------------------------------
// PATCH /templates/:id
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requirePermission('templates', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = req.commsOrgId;
    const body = req.body ?? {};
    const id = req.params.id;
    const row = await loadOrgTemplate(req, id);

    const map = {
      name: 'name', providerName: 'provider_name', language: 'language',
      subject: 'subject', body: 'body', category: 'category',
    };
    const data = {};
    for (const [camel, col] of Object.entries(map)) {
      if (has(body, camel)) data[col] = body[camel];
    }
    if (has(body, 'isActive')) {
      data.is_active = gvBool(body.isActive) ? 1 : 0;
    }
    if (has(body, 'status')) {
      const status = str(body.status).toUpperCase();
      if (!['DRAFT', 'PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
        throw badRequest('Invalid template status.');
      }
      data.status = status;
    }
    if ((data.body !== undefined && data.body !== null) || (data.subject !== undefined && data.subject !== null)) {
      const text = `${str(data.body ?? row.body)} ${str(data.subject ?? row.subject ?? '')}`;
      data.variables = toJson(await templateVariables(text));
      // Editing the wording of an approved WhatsApp template invalidates the
      // provider's approval, so it drops back to DRAFT unless explicitly set.
      if (row.channel === 'WHATSAPP' && row.status === 'APPROVED' && !has(body, 'status')) {
        data.status = 'DRAFT';
      }
    }

    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE message_templates SET ${sets}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), id]);
    }
    const after = await dbOne('SELECT * FROM message_templates WHERE id = ?', [id]);
    await auditRecord(
      orgId,
      a,
      'template.updated',
      {
        entityType: 'TEMPLATE',
        entityId: id,
        entityLabel: after.name,
        changes: gvDiff(scalarRow(row), scalarRow(after), Object.keys(data)),
      },
      req
    );
    return jsonOk(res, await templatesShape(after));
  })
);

// ---------------------------------------------------------------------------
// DELETE /templates/:id
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requirePermission('templates', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = req.commsOrgId;
    const id = req.params.id;
    const row = await loadOrgTemplate(req, id);
    // A template wired into a live welcome automation cannot just vanish -
    // that would silently drop the channel to ORANGE with no explanation.
    const inUse =
      (await dbScalar('SELECT id FROM whatsapp_settings WHERE welcome_template_id = ?', [id])) ||
      (await dbScalar('SELECT id FROM email_settings WHERE welcome_template_id = ?', [id]));
    if (inUse) {
      throw conflict('This template is used by a welcome automation. Pick a different template there first.');
    }
    await dbExec('DELETE FROM message_templates WHERE id = ?', [id]);
    await auditRecord(
      orgId,
      a,
      'template.deleted',
      { entityType: 'TEMPLATE', entityId: id, entityLabel: row.name, changes: [] },
      req
    );
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown templates route.')));

export default router;
