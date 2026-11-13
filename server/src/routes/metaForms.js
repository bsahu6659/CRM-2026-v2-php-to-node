/**
 * /api/meta-forms/* — port of api/metaForms.php.
 *
 * Connects a Meta (Facebook/Instagram) Lead Ads form to this CRM and decides
 * how its leads are routed. The inbound webhook receiver
 * (routes/metaInbound.js) reads exactly the rows this endpoint writes.
 */

import express from 'express';
import config from '../config/index.js';
import { dbAll, dbExec, dbOne, dbScalar } from '../lib/db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk, pageMeta, parsePaging } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { gvEncrypt } from '../lib/security.js';
import { camelize, gvId, safeJson } from '../lib/util.js';
import { boolVal, validate } from '../lib/validate.js';
import {
  metaConnectAttach,
  metaConnectDiagnose,
  metaConnectPages,
  metaConnectPending,
  metaConnectStart,
  metaRedirectUri,
} from '../services/metaConnect.js';
import { projectVisibleWhere } from '../services/projects.js';

const router = express.Router();

const TOKEN_REDACTED = '••••••••';

/**
 * The Meta receiver's public path. The PHP edition served it as
 * webhooks/meta_leads.php and every connected Meta app is configured with that
 * URL, so the Node receiver keeps answering on it.
 */
const META_LEADS_WEBHOOK_PATH = '/webhooks/meta_leads.php';

function has(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

/** PHP empty() / falsiness: null, false, 0, '', '0' and an empty array. */
function phpEmpty(v) {
  if (v === undefined || v === null || v === false || v === 0 || v === '' || v === '0') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/** PHP `$v ?: null`. */
function orNull(v) {
  return phpEmpty(v) ? null : v;
}

/**
 * PDO returns every column as a scalar, so the PHP edition saw JSON columns
 * (a webhook event's `raw_payload`) as text except where it decoded them on
 * purpose. mysql2 parses native JSON into objects; re-serialising keeps
 * camelize() from renaming the keys inside Meta's payload.
 */
function scalarRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v !== null && typeof v === 'object' && !Buffer.isBuffer(v) ? JSON.stringify(v) : v;
  }
  return out;
}

function metaFormsShape(r) {
  const out = camelize(scalarRow(r));
  // The page access token is write-only: admins can replace it, never read it back.
  out.pageAccessToken = !phpEmpty(r.page_access_token) ? TOKEN_REDACTED : null;
  out.hasToken = !phpEmpty(r.page_access_token);
  return out;
}

/**
 * A project picked for a form must be one this company can actually see, or
 * its leads would be attributed to somebody else's inventory.
 */
async function visibleProjectId(orgId, projectId) {
  const vis = await projectVisibleWhere(orgId);
  return dbScalar(`SELECT projects.id FROM projects WHERE projects.id = ? AND ${vis.sql}`, [projectId, ...vis.params]);
}

// ---------------------------------------------------------------------------
// Connect Facebook - the flow a client company uses to attach its OWN page.
//
// Kept in this file because it writes the same meta_lead_forms rows the manual
// route below does; the difference is only who supplies the token. A customer
// should never have to see a Page ID, let alone a Graph API Explorer.
// ---------------------------------------------------------------------------
router.post(
  '/connect',
  requirePermission('integrations', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    return jsonOk(res, await metaConnectStart(a.organizationId, a.id));
  })
);

router.get(
  '/connect/pages',
  requirePermission('integrations', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    return jsonOk(res, { pages: await metaConnectPages(a.organizationId, a.id) });
  })
);

router.post(
  '/connect/pages',
  requirePermission('integrations', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const pageIds = (req.body ?? {}).pageIds ?? [];
    if (!Array.isArray(pageIds) || pageIds.length === 0) {
      throw badRequest('Choose at least one page to connect.');
    }
    return jsonOk(res, await metaConnectAttach(a.organizationId, a.id, pageIds.map((p) => String(p)), a));
  })
);

router.get(
  '/connect/status',
  requirePermission('integrations', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    // Drives the screen: is the app set up at all, and is an authorisation
    // sitting here waiting for the admin to pick their pages?
    return jsonOk(res, {
      configured: String(config.meta.appId ?? '') !== '' && String(config.meta.appSecret ?? '') !== '',
      awaitingPageChoice: (await metaConnectPending(a.id)) != null,
      redirectUri: await metaRedirectUri(),
      webhookUrl: `${config.appUrl.replace(/\/+$/, '')}${META_LEADS_WEBHOOK_PATH}`,
    });
  })
);

router.get(
  '/diagnose',
  requirePermission('integrations', 'read'),
  ah(async (req, res) => {
    // Read-only, but it reaches Facebook with the app's own credentials, so it
    // is gated like everything else and scoped to the caller's organisation.
    return jsonOk(res, await metaConnectDiagnose(req.actor.organizationId));
  })
);

// ---------------------------------------------------------------------------
// Connected forms
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('integrations', 'read'),
  ah(async (req, res) => {
    const rows = await dbAll(
      `SELECT f.*, s.name AS source_name, p.name AS project_name, c.name AS campaign_name, u.first_name AS owner_first_name, u.last_name AS owner_last_name, t.name AS team_name,
              (SELECT COUNT(*) FROM leads WHERE leads.meta_form_id = f.meta_form_id AND leads.organization_id = f.organization_id) AS lead_count
         FROM meta_lead_forms f
         LEFT JOIN lead_sources s ON s.id = f.source_id
         LEFT JOIN projects p ON p.id = f.project_id
         LEFT JOIN campaigns c ON c.id = f.campaign_id
         LEFT JOIN users u ON u.id = f.assign_to_user_id
         LEFT JOIN teams t ON t.id = f.assign_to_team_id
        WHERE f.organization_id = ? ORDER BY f.created_at DESC`,
      [req.actor.organizationId]
    );
    return jsonOk(res, {
      forms: rows.map((r) => {
        const out = metaFormsShape(r);
        out.leadCount = Number.parseInt(r.lead_count, 10) || 0;
        return out;
      }),
      webhookUrl: `${config.appUrl}${META_LEADS_WEBHOOK_PATH}`,
      verifyTokenConfigured: String(config.meta.verifyToken ?? '') !== '',
      appSecretConfigured: String(config.meta.appSecret ?? '') !== '',
      setupNote: 'Add the webhook URL in your Meta app under Webhooks > Page > leadgen, using META_VERIFY_TOKEN from .env as the verify token.',
    });
  })
);

router.get(
  '/events',
  requirePermission('integrations', 'read'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const { page, limit, offset } = parsePaging(req.query);
    const rows = await dbAll(
      'SELECT * FROM meta_webhook_events WHERE organization_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [orgId, limit, offset]
    );
    const total = Number.parseInt(await dbScalar('SELECT COUNT(*) FROM meta_webhook_events WHERE organization_id = ?', [orgId]), 10) || 0;
    return jsonOk(
      res,
      rows.map((r) => ({ ...camelize(scalarRow(r)), rawPayload: safeJson(r.raw_payload ?? '{}', []) })),
      pageMeta(page, limit, total)
    );
  })
);

router.post(
  '/',
  requirePermission('integrations', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    validate(body)
      .required('metaPageId', 'Page ID').maxLength('metaPageId', 64)
      .required('metaFormId', 'Form ID').maxLength('metaFormId', 64)
      .required('pageAccessToken', 'Page access token')
      .validate();

    // Page + form ids are globally unique at Meta, so one connection row
    // serves exactly one tenant.
    const existing = await dbOne('SELECT * FROM meta_lead_forms WHERE meta_page_id = ? AND meta_form_id = ?', [
      body.metaPageId, body.metaFormId,
    ]);
    if (existing && existing.organization_id !== orgId) {
      throw conflict('That Meta form is already connected to another organisation.');
    }

    // Optional by design: a Meta lead form cannot ask which tower the buyer
    // means, so this is the one place that answer can be given. When it is
    // given it must be a project this company can actually see, or its leads
    // would be attributed to somebody else's inventory.
    let projectId = null;
    if (!phpEmpty(body.projectId)) {
      projectId = await visibleProjectId(orgId, body.projectId);
      if (!projectId) {
        throw badRequest('That project is not available to your company.');
      }
    }

    const token = gvEncrypt(String(body.pageAccessToken));
    let formId;
    if (existing) {
      await dbExec(
        'UPDATE meta_lead_forms SET form_name = ?, page_access_token = ?, source_id = ?, project_id = ?, campaign_id = ?, assign_to_user_id = ?, assign_to_team_id = ?, is_active = 1, last_error = NULL, updated_at = NOW() WHERE id = ?',
        [
          body.formName ?? existing.form_name, token, body.sourceId ?? null, projectId, body.campaignId ?? null,
          body.assignToUserId ?? null, body.assignToTeamId ?? null, existing.id,
        ]
      );
      formId = existing.id;
    } else {
      formId = gvId();
      await dbExec(
        `INSERT INTO meta_lead_forms (id, organization_id, meta_page_id, meta_form_id, form_name, page_access_token, source_id, project_id, campaign_id, assign_to_user_id, assign_to_team_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [
          formId, orgId, body.metaPageId, body.metaFormId, body.formName ?? null, token, body.sourceId ?? null,
          projectId, body.campaignId ?? null, body.assignToUserId ?? null, body.assignToTeamId ?? null,
        ]
      );
    }

    await auditRecord(
      orgId,
      a,
      existing ? 'meta_form.updated' : 'meta_form.connected',
      {
        entityType: 'META_FORM',
        entityId: formId,
        entityLabel: body.formName ?? body.metaFormId,
        changes: { metaPageId: body.metaPageId, metaFormId: body.metaFormId },
      },
      req
    );
    return jsonCreated(res, metaFormsShape(await dbOne('SELECT * FROM meta_lead_forms WHERE id = ?', [formId])));
  })
);

router.patch(
  '/:id',
  requirePermission('integrations', 'update'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const body = req.body ?? {};
    const before = await dbOne('SELECT * FROM meta_lead_forms WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!before) throw notFound('Connected form not found');

    const data = {};
    const fields = {
      formName: 'form_name', sourceId: 'source_id', projectId: 'project_id', campaignId: 'campaign_id',
      assignToUserId: 'assign_to_user_id', assignToTeamId: 'assign_to_team_id',
    };
    for (const [camel, col] of Object.entries(fields)) {
      if (has(body, camel)) data[col] = orNull(body[camel]);
    }
    // Same rule as connecting a form: a project must be one this company can see,
    // or its leads would be filed against somebody else's inventory.
    if (!phpEmpty(data.project_id)) {
      if (!(await visibleProjectId(orgId, data.project_id))) {
        throw badRequest('That project is not available to your company.');
      }
    }
    if (has(body, 'isActive')) {
      data.is_active = boolVal(body.isActive) ? 1 : 0;
    }
    // An empty/redacted token means "leave the stored one alone".
    if (!phpEmpty(body.pageAccessToken) && body.pageAccessToken !== TOKEN_REDACTED) {
      data.page_access_token = gvEncrypt(String(body.pageAccessToken));
    }
    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE meta_lead_forms SET ${sets}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), before.id]);
    }
    return jsonOk(res, metaFormsShape(await dbOne('SELECT * FROM meta_lead_forms WHERE id = ?', [before.id])));
  })
);

router.delete(
  '/:id',
  requirePermission('integrations', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const row = await dbOne('SELECT * FROM meta_lead_forms WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!row) throw notFound('Connected form not found');
    await dbExec('DELETE FROM meta_lead_forms WHERE id = ?', [row.id]);
    await auditRecord(
      orgId,
      a,
      'meta_form.disconnected',
      { entityType: 'META_FORM', entityId: row.id, entityLabel: orNull(row.form_name) ?? row.meta_form_id },
      req
    );
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown meta-forms route')));

export default router;
