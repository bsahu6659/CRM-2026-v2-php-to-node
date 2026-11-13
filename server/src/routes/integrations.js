/**
 * /api/integrations/* — port of api/integrations.php.
 *
 * These are real configuration records, not decorative toggles: each provider
 * declares the fields it needs, the CRM stores them per organisation, and the
 * status reflects whether the credentials are actually present. Nothing claims
 * to be live until real credentials exist.
 *
 * Secret values are encrypted at rest with AES-256-GCM (lib/security.js
 * gvEncrypt) rather than stored as plain JSON, because the database is a
 * likelier exposure than the application. The ciphertext format is the PHP
 * edition's, so rows it wrote stay readable.
 *
 * The Facebook "Connect" flow is not here: it writes meta_lead_forms rows and
 * lives beside them in routes/metaForms.js, exactly as in the PHP edition.
 */

import express from 'express';
import config from '../config/index.js';
import { dbAll, dbExec, dbOne } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { jsonOk } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { gvDecrypt, gvEncrypt } from '../lib/security.js';
import { gvBool, gvId, safeJson, toJson } from '../lib/util.js';
import { boolVal } from '../lib/validate.js';

const router = express.Router();

export const INTEGRATION_PROVIDERS = {
  google_ads: {
    label: 'Google Ads',
    blurb: 'Import lead-form submissions and sync conversions back to Google Ads.',
    docs: 'docs/INTEGRATIONS.md#google-ads',
    fields: [
      { key: 'customerId', label: 'Customer ID', placeholder: '123-456-7890', required: true },
      { key: 'refreshToken', label: 'OAuth refresh token', secret: true, required: true },
      { key: 'conversionActionId', label: 'Conversion action ID' },
    ],
    envKeys: ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET'],
    capabilities: ['Lead form ingestion (webhook)', 'Offline conversion upload'],
  },
  meta_ads: {
    label: 'Meta Ads (Facebook & Instagram)',
    blurb: 'Receive Lead Ads in real time through the Meta webhook.',
    docs: 'docs/INTEGRATIONS.md#meta-ads',
    fields: [
      { key: 'pageId', label: 'Page ID', required: true },
      { key: 'pageAccessToken', label: 'Page access token', secret: true, required: true },
    ],
    envKeys: ['META_APP_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN'],
    capabilities: ['Lead Ads webhook', 'Conversions API'],
  },
  google_analytics: {
    label: 'Google Analytics 4',
    blurb: 'Send CRM-side conversion events back to GA4 for closed-loop reporting.',
    docs: 'docs/INTEGRATIONS.md#ga4',
    fields: [{ key: 'measurementId', label: 'Measurement ID', placeholder: 'G-XXXXXXX' }],
    envKeys: ['GA4_MEASUREMENT_ID', 'GA4_API_SECRET'],
    capabilities: ['Measurement Protocol events'],
  },
  whatsapp: {
    label: 'WhatsApp Business',
    blurb: 'Log WhatsApp conversations against leads and send template messages.',
    docs: 'docs/INTEGRATIONS.md#whatsapp',
    fields: [
      { key: 'phoneNumberId', label: 'Phone number ID', required: true },
      { key: 'accessToken', label: 'Access token', secret: true, required: true },
    ],
    envKeys: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'],
    capabilities: ['Inbound message webhook', 'Template send'],
  },
  smtp: {
    label: 'Email (SMTP)',
    blurb: 'Deliver notification and follow-up email. Without it, notifications stay in-app.',
    docs: 'docs/ENVIRONMENT.md#smtp',
    fields: [
      { key: 'host', label: 'SMTP host', required: true },
      { key: 'port', label: 'Port', placeholder: '587' },
      { key: 'username', label: 'Username' },
      { key: 'password', label: 'Password', secret: true },
      { key: 'fromAddress', label: 'From address' },
    ],
    envKeys: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'],
    capabilities: ['Notification email', 'Password reset and invitations'],
  },
  sms: {
    label: 'SMS gateway',
    blurb: 'Send SMS follow-ups and log them on the lead timeline.',
    docs: 'docs/INTEGRATIONS.md#sms',
    fields: [
      { key: 'provider', label: 'Provider', placeholder: 'twilio / msg91 / gupshup' },
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'senderId', label: 'Sender ID' },
    ],
    envKeys: ['SMS_PROVIDER_KEY'],
    capabilities: ['Outbound SMS', 'Delivery receipts'],
  },
  zapier: {
    label: 'Zapier / Make / n8n',
    blurb: 'Any no-code tool can post leads to the REST API and subscribe to webhooks.',
    docs: 'docs/API.md',
    fields: [],
    envKeys: [],
    capabilities: ['REST ingestion API', 'Outbound webhooks'],
  },
};

const INTEGRATION_SECRET_KEYS = ['refreshToken', 'pageAccessToken', 'accessToken', 'password', 'apiKey', 'apiSecret'];
const INTEGRATION_REDACTED = '••••••••';

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

/** A stored config as a fresh plain object (PHP arrays were copied by value). */
function configObject(value) {
  const decoded = safeJson(value, {});
  if (Array.isArray(decoded)) return Object.assign({}, decoded);
  return decoded !== null && typeof decoded === 'object' ? { ...decoded } : {};
}

/** Never send stored secrets back to the browser — only whether they are set. */
function integrationsRedact(cfg) {
  const out = {};
  for (const [key, value] of Object.entries(cfg)) {
    out[key] = INTEGRATION_SECRET_KEYS.includes(key) && !phpEmpty(value) ? INTEGRATION_REDACTED : value;
  }
  return out;
}

function integrationsEvaluateStatus(provider, stored) {
  const spec = has(INTEGRATION_PROVIDERS, provider) ? INTEGRATION_PROVIDERS[provider] : null;
  if (!spec) {
    return { status: 'NOT_CONFIGURED', missing: [], missingEnv: [] };
  }
  const missing = [];
  for (const f of spec.fields) {
    if (f.required && phpEmpty(stored[f.key])) missing.push(f.label);
  }
  // Server-wide credentials (developer tokens, app secrets) come from the
  // environment, never from a tenant; without them the provider cannot work.
  const missingEnv = spec.envKeys.filter((k) => phpEmpty(process.env[k]));
  return {
    status: missing.length || missingEnv.length ? 'NOT_CONFIGURED' : 'CONFIGURED',
    missing,
    missingEnv,
  };
}

/** Decrypts secret-keyed values so status checks see the real presence of a value. */
function integrationsDecryptConfig(stored) {
  const out = { ...stored };
  for (const key of INTEGRATION_SECRET_KEYS) {
    if (!phpEmpty(out[key])) out[key] = gvDecrypt(out[key]) ?? out[key];
  }
  return out;
}

function integrationsEncryptConfig(cfg) {
  const out = { ...cfg };
  for (const key of INTEGRATION_SECRET_KEYS) {
    if (!phpEmpty(out[key])) out[key] = gvEncrypt(String(out[key]));
  }
  return out;
}

router.get(
  '/',
  requirePermission('integrations', 'read'),
  ah(async (req, res) => {
    const rows = await dbAll('SELECT * FROM integrations WHERE organization_id = ?', [req.actor.organizationId]);
    const byProvider = {};
    for (const r of rows) byProvider[r.provider] = r;

    const list = [];
    for (const [key, spec] of Object.entries(INTEGRATION_PROVIDERS)) {
      const row = has(byProvider, key) ? byProvider[key] : null;
      const stored = integrationsDecryptConfig(configObject(row?.config ?? '{}'));
      const evaluation = integrationsEvaluateStatus(key, stored);
      list.push({
        provider: key,
        label: spec.label,
        blurb: spec.blurb,
        docs: spec.docs,
        fields: spec.fields,
        capabilities: spec.capabilities,
        envKeys: spec.envKeys,
        isEnabled: row ? gvBool(row.is_enabled) : false,
        config: integrationsRedact(stored),
        lastSyncedAt: row?.last_synced_at ?? null,
        lastError: row?.last_error ?? null,
        ...evaluation,
      });
    }
    return jsonOk(res, {
      integrations: list,
      appUrl: config.appUrl,
      note: 'Credentials are stored per organisation and encrypted at rest. Anything marked "not configured" is inert - the CRM will never claim to have sent something it could not.',
    });
  })
);

router.patch(
  '/:provider',
  requirePermission('integrations', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    const provider = req.params.provider;
    const spec = has(INTEGRATION_PROVIDERS, provider) ? INTEGRATION_PROVIDERS[provider] : null;
    if (!spec) throw notFound('Unknown integration');

    const existing = await dbOne('SELECT * FROM integrations WHERE organization_id = ? AND provider = ?', [orgId, provider]);
    const stored = integrationsDecryptConfig(configObject(existing?.config ?? '{}'));

    const incoming = body.config ?? [];
    const allowed = spec.fields.map((f) => f.key);
    const merged = { ...stored };
    const entries = incoming !== null && typeof incoming === 'object' ? Object.entries(incoming) : [];
    for (const [key, value] of entries) {
      if (!allowed.includes(key)) continue;
      // A redacted placeholder means "leave the stored secret alone".
      if (value === INTEGRATION_REDACTED) continue;
      if (value === '' || value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }

    const evaluation = integrationsEvaluateStatus(provider, merged);
    const isEnabled = has(body, 'isEnabled')
      ? boolVal(body.isEnabled)
      : existing
        ? gvBool(existing.is_enabled)
        : false;
    if (isEnabled && evaluation.status !== 'CONFIGURED') {
      throw badRequest(`Cannot enable ${spec.label} yet. Missing: ${[...evaluation.missing, ...evaluation.missingEnv].join(', ')}`);
    }

    const encrypted = toJson(integrationsEncryptConfig(merged));
    let rowId;
    if (existing) {
      await dbExec('UPDATE integrations SET config = ?, is_enabled = ?, status = ?, updated_at = NOW() WHERE id = ?', [
        encrypted, isEnabled ? 1 : 0, evaluation.status, existing.id,
      ]);
      rowId = existing.id;
    } else {
      rowId = gvId();
      await dbExec(
        'INSERT INTO integrations (id, organization_id, provider, name, config, is_enabled, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,NOW(),NOW())',
        [rowId, orgId, provider, spec.label, encrypted, isEnabled ? 1 : 0, evaluation.status]
      );
    }

    await auditRecord(
      orgId,
      a,
      'integration.updated',
      {
        entityType: 'INTEGRATION',
        entityId: rowId,
        entityLabel: spec.label,
        changes: { isEnabled, fieldsSet: Object.keys(merged) },
      },
      req
    );
    return jsonOk(res, { provider, isEnabled, config: integrationsRedact(merged), ...evaluation });
  })
);

router.use((req, res, next) => next(notFound('Unknown integrations route')));

export default router;
