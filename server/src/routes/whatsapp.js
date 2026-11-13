/**
 * /api/whatsapp/* — port of api/whatsapp.php.
 *
 * Per-tenant WhatsApp configuration and welcome automation. Secrets are
 * write-only: the access token is stored AES-256-GCM encrypted and this
 * endpoint never returns it, only whether one is present. A Super Admin may
 * configure a client by passing ?organizationId=, which resolveTenantParam()
 * allows only for platform admins (spec section 27).
 */

import express from 'express';
import { dbAll, dbExec, dbScalar } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { jsonOk, pageMeta, parsePaging } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { gvEncrypt } from '../lib/security.js';
import { resolveTenantParam } from '../lib/tenancy.js';
import { camelize, gvBool, safeJson, toJson } from '../lib/util.js';
import {
  checkWhatsappConfiguration,
  commsInvalidateVerification,
  commsTestWhatsapp,
  whatsappSettings,
} from '../services/comms.js';

const router = express.Router();

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

/** PHP `(string)` cast. */
function str(v) {
  if (v === undefined || v === null || v === false) return '';
  if (v === true) return '1';
  if (Array.isArray(v) || typeof v === 'object') return 'Array';
  return String(v);
}

/**
 * The tenant every handler below works on, resolved before routing exactly as
 * the PHP file did at its top: a crafted organizationId is refused before any
 * permission or route is even considered.
 */
router.use(
  ah(async (req, res, next) => {
    const body = req.body ?? {};
    req.commsOrgId = await resolveTenantParam(req, req.query.organizationId ?? body.organizationId ?? null);
    next();
  })
);

// ---------------------------------------------------------------------------
// GET /whatsapp
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('whatsapp', 'read'),
  ah(async (req, res) => {
    const orgId = req.commsOrgId;
    const s = await whatsappSettings(orgId);
    const verdict = await checkWhatsappConfiguration(orgId);

    return jsonOk(res, {
      organizationId: orgId,
      provider: s.provider,
      isEnabled: gvBool(s.is_enabled),
      welcomeEnabled: gvBool(s.welcome_enabled),
      // Presence, never the value.
      hasAccessToken: !phpEmpty(s.access_token_enc),
      phoneNumberId: s.phone_number_id,
      wabaId: s.waba_id,
      senderNumber: s.sender_number,
      apiBaseUrl: s.api_base_url,
      welcomeTemplateId: s.welcome_template_id,
      variableMap: safeJson(s.variable_map, []),
      verifiedAt: s.verified_at,
      lastTestAt: s.last_test_at,
      lastTestStatus: s.last_test_status,
      lastTestError: s.last_test_error,
      configuration: verdict,
      templates: camelize(
        await dbAll(
          `SELECT id, name, \`key\`, status, body, provider_name FROM message_templates
            WHERE organization_id = ? AND channel = 'WHATSAPP' AND is_active = 1 ORDER BY name ASC`,
          [orgId]
        )
      ),
    });
  })
);

// ---------------------------------------------------------------------------
// PATCH /whatsapp
// ---------------------------------------------------------------------------
router.patch(
  '/',
  requirePermission('whatsapp', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = req.commsOrgId;
    const body = req.body ?? {};
    const s = await whatsappSettings(orgId);

    const data = {};
    let credentialChanged = false;

    const fields = { phoneNumberId: 'phone_number_id', wabaId: 'waba_id', senderNumber: 'sender_number', apiBaseUrl: 'api_base_url' };
    for (const [camel, col] of Object.entries(fields)) {
      if (has(body, camel)) {
        data[col] = body[camel] === '' ? null : str(body[camel]).trim();
        if (data[col] !== s[col]) credentialChanged = true;
      }
    }
    // An empty string clears the stored token; a missing key leaves it alone.
    if (has(body, 'accessToken')) {
      const token = str(body.accessToken);
      data.access_token_enc = token === '' ? null : gvEncrypt(token);
      credentialChanged = true;
    }
    if (has(body, 'welcomeTemplateId')) {
      const templateId = phpEmpty(body.welcomeTemplateId) ? null : body.welcomeTemplateId;
      if (
        templateId &&
        !(await dbScalar(
          "SELECT id FROM message_templates WHERE id = ? AND organization_id = ? AND channel = 'WHATSAPP'",
          [templateId, orgId]
        ))
      ) {
        throw badRequest('That WhatsApp template does not exist.');
      }
      data.welcome_template_id = templateId;
    }
    if (has(body, 'variableMap')) {
      data.variable_map = toJson(body.variableMap !== null && typeof body.variableMap === 'object' ? body.variableMap : []);
    }
    if (has(body, 'isEnabled')) {
      data.is_enabled = gvBool(body.isEnabled) ? 1 : 0;
    }
    if (has(body, 'welcomeEnabled')) {
      // Turning the switch on is always allowed. It produces ORANGE, not
      // GREEN, until the checklist passes - refusing the toggle outright
      // would leave the admin with no way to see what is still missing.
      data.welcome_enabled = gvBool(body.welcomeEnabled) ? 1 : 0;
    }

    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE whatsapp_settings SET ${sets}, updated_at = NOW() WHERE organization_id = ?`, [
        ...Object.values(data),
        orgId,
      ]);
    }
    if (credentialChanged) {
      await commsInvalidateVerification(orgId, 'WHATSAPP');
    }

    // Never log the token itself, only that it moved.
    const { access_token_enc: tokenEnc, ...loggable } = data;
    await auditRecord(
      orgId,
      a,
      'whatsapp.settings_updated',
      {
        entityType: 'INTEGRATION',
        entityLabel: 'WhatsApp',
        changes: {
          ...loggable,
          ...(has(data, 'access_token_enc') ? { accessToken: tokenEnc ? 'set' : 'cleared' } : {}),
        },
      },
      req
    );
    return jsonOk(res, await checkWhatsappConfiguration(orgId));
  })
);

// ---------------------------------------------------------------------------
// POST /whatsapp/test
// ---------------------------------------------------------------------------
router.post(
  '/test',
  requirePermission('whatsapp', 'test'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = req.commsOrgId;
    const body = req.body ?? {};
    const to = str(body.phone ?? '').trim();
    if (to === '') {
      throw badRequest('Enter a WhatsApp number to send the test to.');
    }
    const result = await commsTestWhatsapp(orgId, to, a.id);
    await auditRecord(
      orgId,
      a,
      'whatsapp.test_sent',
      { entityType: 'INTEGRATION', entityLabel: 'WhatsApp', changes: { to, ok: result.ok } },
      req
    );
    return jsonOk(res, {
      ok: result.ok,
      error: result.ok ? null : result.error,
      configuration: await checkWhatsappConfiguration(orgId),
    });
  })
);

// ---------------------------------------------------------------------------
// GET /whatsapp/logs
// ---------------------------------------------------------------------------
router.get(
  '/logs',
  requirePermission('whatsapp', 'read'),
  ah(async (req, res) => {
    const orgId = req.commsOrgId;
    const { page, limit, offset } = parsePaging(req.query);
    const total =
      Number.parseInt(
        await dbScalar("SELECT COUNT(*) FROM message_logs WHERE organization_id = ? AND channel = 'WHATSAPP'", [orgId]),
        10
      ) || 0;
    // limit/offset are integers clamped by parsePaging, so interpolating them
    // is safe (and is what the PHP query did).
    const rows = await dbAll(
      `SELECT message_logs.*, leads.code AS lead_code
         FROM message_logs LEFT JOIN leads ON leads.id = message_logs.lead_id
        WHERE message_logs.organization_id = ? AND message_logs.channel = 'WHATSAPP'
        ORDER BY message_logs.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      [orgId]
    );
    return jsonOk(res, camelize(rows), pageMeta(page, limit, total));
  })
);

router.use((req, res, next) => next(notFound('Unknown WhatsApp route.')));

export default router;
