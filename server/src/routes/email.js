/**
 * /api/email/* — port of api/email.php.
 *
 * Per-tenant outgoing email configuration, welcome automation and staff
 * alerts. Same contract as the WhatsApp endpoint: credentials are write-only,
 * a credential change invalidates the previous successful test, and the GREEN
 * verdict is only ever produced by services/comms.js.
 */

import express from 'express';
import { dbAll, dbExec, dbScalar } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { jsonOk, pageMeta, parsePaging } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { gvEncrypt } from '../lib/security.js';
import { resolveTenantParam } from '../lib/tenancy.js';
import { camelize, gvBool, normalizeEmail, safeJson, toJson } from '../lib/util.js';
import {
  checkEmailConfiguration,
  commsInvalidateVerification,
  commsTestEmail,
  emailSettings,
} from '../services/comms.js';

const router = express.Router();

// Close to PHP's FILTER_VALIDATE_EMAIL: a dot-atom local part and a dotted
// host name made of valid labels.
const FILTER_EMAIL_RE =
  /^(?!\.)(?!.*\.\.)[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+(?<!\.)@(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

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

/** PHP `(int)` cast. */
function phpInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isNaN(n) ? 0 : n;
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
// GET /email
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('email', 'read'),
  ah(async (req, res) => {
    const orgId = req.commsOrgId;
    const s = await emailSettings(orgId);

    return jsonOk(res, {
      organizationId: orgId,
      mode: s.mode,
      provider: s.provider,
      isEnabled: gvBool(s.is_enabled),
      welcomeEnabled: gvBool(s.welcome_enabled),
      // Staff alerts: separate from the buyer-facing welcome message.
      notifyNewLead: gvBool(s.notify_new_lead ?? 0),
      notifyFollowup: gvBool(s.notify_followup ?? 0),
      followupLeadMinutes: phpInt(s.followup_lead_minutes ?? 60),
      notifyCcEmail: s.notify_cc_email ?? null,
      notifyDailySummary: gvBool(s.notify_daily_summary ?? 0),
      dailySummaryHour: phpInt(s.daily_summary_hour ?? 8),
      smtpHost: s.smtp_host,
      smtpPort: s.smtp_port !== null && s.smtp_port !== undefined ? phpInt(s.smtp_port) : null,
      smtpEncryption: s.smtp_encryption,
      smtpUsername: s.smtp_username,
      // Presence, never the value.
      hasSmtpPassword: !phpEmpty(s.smtp_password_enc),
      hasApiKey: !phpEmpty(s.api_key_enc),
      fromEmail: s.from_email,
      fromName: s.from_name,
      replyTo: s.reply_to,
      welcomeTemplateId: s.welcome_template_id,
      variableMap: safeJson(s.variable_map, []),
      verifiedAt: s.verified_at,
      lastTestAt: s.last_test_at,
      lastTestStatus: s.last_test_status,
      lastTestError: s.last_test_error,
      configuration: await checkEmailConfiguration(orgId),
      templates: camelize(
        await dbAll(
          `SELECT id, name, \`key\`, status, subject, body FROM message_templates
            WHERE organization_id = ? AND channel = 'EMAIL' AND is_active = 1 ORDER BY name ASC`,
          [orgId]
        )
      ),
    });
  })
);

// ---------------------------------------------------------------------------
// PATCH /email
// ---------------------------------------------------------------------------
router.patch(
  '/',
  requirePermission('email', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = req.commsOrgId;
    const body = req.body ?? {};
    const s = await emailSettings(orgId);

    const data = {};
    let credentialChanged = false;

    if (has(body, 'mode')) {
      const mode = str(body.mode).toUpperCase();
      if (!['SMTP', 'API'].includes(mode)) {
        throw badRequest('Mode must be SMTP or API.');
      }
      data.mode = mode;
      credentialChanged = mode !== s.mode;
    }
    for (const [camel, col] of Object.entries({ smtpHost: 'smtp_host', smtpUsername: 'smtp_username', provider: 'provider' })) {
      if (has(body, camel)) {
        data[col] = body[camel] === '' ? null : str(body[camel]).trim();
        if (data[col] !== s[col]) credentialChanged = true;
      }
    }
    if (has(body, 'smtpPort')) {
      data.smtp_port = body.smtpPort === '' || body.smtpPort === null ? null : phpInt(body.smtpPort);
      credentialChanged = true;
    }
    if (has(body, 'smtpEncryption')) {
      const enc = str(body.smtpEncryption).toUpperCase();
      if (!['NONE', 'TLS', 'SSL'].includes(enc)) {
        throw badRequest('Encryption must be NONE, TLS or SSL.');
      }
      data.smtp_encryption = enc;
      credentialChanged = true;
    }
    // An empty string clears a stored secret; a missing key leaves it alone.
    if (has(body, 'smtpPassword')) {
      const pass = str(body.smtpPassword);
      data.smtp_password_enc = pass === '' ? null : gvEncrypt(pass);
      credentialChanged = true;
    }
    if (has(body, 'apiKey')) {
      const key = str(body.apiKey);
      data.api_key_enc = key === '' ? null : gvEncrypt(key);
      credentialChanged = true;
    }
    for (const [camel, col] of Object.entries({ fromEmail: 'from_email', fromName: 'from_name', replyTo: 'reply_to' })) {
      if (has(body, camel)) {
        const value = body[camel] === '' ? null : str(body[camel]).trim();
        if (value !== null && ['from_email', 'reply_to'].includes(col) && !normalizeEmail(value)) {
          throw badRequest('Enter a valid email address.');
        }
        data[col] = value;
      }
    }
    if (has(body, 'welcomeTemplateId')) {
      const templateId = phpEmpty(body.welcomeTemplateId) ? null : body.welcomeTemplateId;
      if (
        templateId &&
        !(await dbScalar(
          "SELECT id FROM message_templates WHERE id = ? AND organization_id = ? AND channel = 'EMAIL'",
          [templateId, orgId]
        ))
      ) {
        throw badRequest('That email template does not exist.');
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
      data.welcome_enabled = gvBool(body.welcomeEnabled) ? 1 : 0;
    }
    if (has(body, 'notifyNewLead')) {
      data.notify_new_lead = gvBool(body.notifyNewLead) ? 1 : 0;
    }
    if (has(body, 'notifyFollowup')) {
      data.notify_followup = gvBool(body.notifyFollowup) ? 1 : 0;
    }
    if (has(body, 'followupLeadMinutes')) {
      // The sweep runs every 15 minutes, so a shorter lead time would simply
      // arrive late and look broken. Clamped rather than rejected.
      data.followup_lead_minutes = Math.max(15, Math.min(1440, phpInt(body.followupLeadMinutes)));
    }
    if (has(body, 'notifyDailySummary')) {
      data.notify_daily_summary = gvBool(body.notifyDailySummary) ? 1 : 0;
    }
    if (has(body, 'dailySummaryHour')) {
      data.daily_summary_hour = Math.max(0, Math.min(23, phpInt(body.dailySummaryHour)));
    }
    if (has(body, 'notifyCcEmail')) {
      const cc = str(body.notifyCcEmail).trim();
      if (cc !== '' && !FILTER_EMAIL_RE.test(cc)) {
        throw badRequest('The copy-to address is not a valid email address.');
      }
      data.notify_cc_email = cc !== '' ? cc : null;
    }

    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE email_settings SET ${sets}, updated_at = NOW() WHERE organization_id = ?`, [
        ...Object.values(data),
        orgId,
      ]);
    }
    if (credentialChanged) {
      await commsInvalidateVerification(orgId, 'EMAIL');
    }

    // Never log a secret itself, only that it moved.
    const { smtp_password_enc: passEnc, api_key_enc: keyEnc, ...loggable } = data;
    await auditRecord(
      orgId,
      a,
      'email.settings_updated',
      {
        entityType: 'INTEGRATION',
        entityLabel: 'Email',
        changes: {
          ...loggable,
          ...(has(data, 'smtp_password_enc') ? { smtpPassword: passEnc ? 'set' : 'cleared' } : {}),
          ...(has(data, 'api_key_enc') ? { apiKey: keyEnc ? 'set' : 'cleared' } : {}),
        },
      },
      req
    );
    return jsonOk(res, await checkEmailConfiguration(orgId));
  })
);

// ---------------------------------------------------------------------------
// POST /email/test
// ---------------------------------------------------------------------------
router.post(
  '/test',
  requirePermission('email', 'test'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = req.commsOrgId;
    const body = req.body ?? {};
    const to = normalizeEmail(str(body.email ?? ''));
    if (!to) {
      throw badRequest('Enter a valid email address to send the test to.');
    }
    const result = await commsTestEmail(orgId, to, a.id);
    await auditRecord(
      orgId,
      a,
      'email.test_sent',
      { entityType: 'INTEGRATION', entityLabel: 'Email', changes: { to, ok: result.ok } },
      req
    );
    return jsonOk(res, {
      ok: result.ok,
      error: result.ok ? null : result.error,
      configuration: await checkEmailConfiguration(orgId),
    });
  })
);

// ---------------------------------------------------------------------------
// GET /email/logs
// ---------------------------------------------------------------------------
router.get(
  '/logs',
  requirePermission('email', 'read'),
  ah(async (req, res) => {
    const orgId = req.commsOrgId;
    const { page, limit, offset } = parsePaging(req.query);
    const total = phpInt(
      await dbScalar("SELECT COUNT(*) FROM message_logs WHERE organization_id = ? AND channel = 'EMAIL'", [orgId])
    );
    // limit/offset are integers clamped by parsePaging, so interpolating them
    // is safe (and is what the PHP query did).
    const rows = await dbAll(
      `SELECT message_logs.*, leads.code AS lead_code
         FROM message_logs LEFT JOIN leads ON leads.id = message_logs.lead_id
        WHERE message_logs.organization_id = ? AND message_logs.channel = 'EMAIL'
        ORDER BY message_logs.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      [orgId]
    );
    return jsonOk(res, camelize(rows), pageMeta(page, limit, total));
  })
);

router.use((req, res, next) => next(notFound('Unknown email route.')));

export default router;
