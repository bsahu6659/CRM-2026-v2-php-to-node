/**
 * /api/webhooks/* — port of api/webhooks.php.
 *
 * Outbound webhook configuration: where the CRM posts lead events, which
 * events, and the signing secret the receiver verifies them with. Delivery
 * itself lives in services/webhooks.js. (The inbound Meta receiver is a
 * different thing entirely — routes/metaInbound.js, mounted at /webhooks.)
 */

import crypto from 'node:crypto';
import express from 'express';
import config from '../config/index.js';
import { dbAll, dbExec, dbOne } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { camelize, gvId, safeJson, toJson } from '../lib/util.js';
import { boolVal, validate } from '../lib/validate.js';
import { GV_WEBHOOK_EVENTS, sendTestWebhook } from '../services/webhooks.js';

const router = express.Router();

function has(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * PDO returns every column as a scalar, so the PHP edition saw JSON columns
 * (`events`, a delivery's `payload`) as text except where it decoded them on
 * purpose. mysql2 parses native JSON into objects; re-serialising keeps
 * camelize() from renaming keys inside a stored payload.
 */
function scalarRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v !== null && typeof v === 'object' && !Buffer.isBuffer(v) ? JSON.stringify(v) : v;
  }
  return out;
}

function webhooksValidateEvents(events) {
  const bad = events.filter((e) => e !== '*' && !GV_WEBHOOK_EVENTS.includes(e));
  if (bad.length) {
    throw badRequest(`Unknown event(s): ${bad.join(', ')}`);
  }
  return events;
}

/**
 * Outbound URLs are restricted to https and non-loopback hosts in production:
 * a webhook pointing at localhost or a private range would turn this endpoint
 * into an SSRF primitive against the CRM's own network.
 */
function webhooksAssertSafeUrl(raw) {
  let parts = null;
  try {
    parts = new URL(raw);
  } catch {
    parts = null;
  }
  const scheme = parts ? parts.protocol.replace(/:$/, '') : '';
  const hostname = parts ? parts.hostname : '';
  if (!parts || scheme === '' || hostname === '') {
    throw badRequest('Enter a full https:// URL');
  }
  if (config.env === 'production') {
    if (scheme.toLowerCase() !== 'https') {
      throw badRequest('Webhook URLs must use https in production.');
    }
    const host = hostname.toLowerCase();
    // WHATWG URL keeps IPv6 hosts in brackets.
    const isPrivate =
      host === 'localhost' || host === '::1' || host === '[::1]' ||
      /^127\./.test(host) || /^10\./.test(host) ||
      /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.endsWith('.internal');
    if (isPrivate) {
      throw badRequest('Webhook URLs cannot point at private or loopback addresses.');
    }
  }
  return raw;
}

function webhooksNewSecret() {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}

async function loadOrgHook(req, id) {
  const hook = await dbOne('SELECT * FROM webhooks WHERE id = ? AND organization_id = ?', [id, req.actor.organizationId]);
  if (!hook) throw notFound('Webhook not found');
  return hook;
}

router.get(
  '/events',
  requirePermission('webhooks', 'read'),
  ah(async (req, res) => jsonOk(res, GV_WEBHOOK_EVENTS))
);

router.get(
  '/',
  requirePermission('webhooks', 'read'),
  ah(async (req, res) => {
    const rows = await dbAll(
      `SELECT w.*, (SELECT COUNT(*) FROM webhook_deliveries WHERE webhook_id = w.id) AS delivery_count
         FROM webhooks w WHERE w.organization_id = ? ORDER BY w.created_at DESC`,
      [req.actor.organizationId]
    );
    // The secret is needed by the integrator to verify signatures, so it is
    // shown to admins who already hold webhooks:read.
    return jsonOk(
      res,
      rows.map((r) => ({
        ...camelize(scalarRow(r)),
        events: safeJson(r.events ?? '[]', []),
        deliveryCount: Number.parseInt(r.delivery_count, 10) || 0,
      }))
    );
  })
);

router.get(
  '/:id/deliveries',
  requirePermission('webhooks', 'read'),
  ah(async (req, res) => {
    const hook = await loadOrgHook(req, req.params.id);
    const rows = await dbAll('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 50', [hook.id]);
    return jsonOk(res, rows.map((r) => camelize(scalarRow(r))));
  })
);

router.post(
  '/',
  requirePermission('webhooks', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    validate(body)
      .required('name', 'Webhook name').maxLength('name', 80)
      .required('url', 'URL')
      .validate();
    const events = body.events ?? [];
    if (!Array.isArray(events) || events.length === 0) {
      throw badRequest('Choose at least one event');
    }
    webhooksValidateEvents(events);
    const url = webhooksAssertSafeUrl(String(body.url));

    const hookId = gvId();
    await dbExec(
      'INSERT INTO webhooks (id, organization_id, name, url, secret, events, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,NOW(),NOW())',
      [
        hookId, orgId, body.name, url, webhooksNewSecret(), toJson(events),
        has(body, 'isActive') ? (boolVal(body.isActive) ? 1 : 0) : 1,
      ]
    );
    const row = await dbOne('SELECT * FROM webhooks WHERE id = ?', [hookId]);
    await auditRecord(
      orgId,
      a,
      'webhook.created',
      { entityType: 'WEBHOOK', entityId: hookId, entityLabel: row.name, changes: { url, events } },
      req
    );
    return jsonCreated(res, { ...camelize(scalarRow(row)), events });
  })
);

router.post(
  '/:id/test',
  requirePermission('webhooks', 'update'),
  ah(async (req, res) => {
    const hook = await loadOrgHook(req, req.params.id);
    return jsonOk(res, await sendTestWebhook(hook));
  })
);

router.post(
  '/:id/rotate-secret',
  requirePermission('webhooks', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const hook = await loadOrgHook(req, req.params.id);
    const secret = webhooksNewSecret();
    await dbExec('UPDATE webhooks SET secret = ? WHERE id = ?', [secret, hook.id]);
    await auditRecord(
      a.organizationId,
      a,
      'webhook.secret_rotated',
      { entityType: 'WEBHOOK', entityId: hook.id, entityLabel: hook.name },
      req
    );
    return jsonOk(res, { secret });
  })
);

router.patch(
  '/:id',
  requirePermission('webhooks', 'update'),
  ah(async (req, res) => {
    const body = req.body ?? {};
    const before = await loadOrgHook(req, req.params.id);
    const data = {};
    if (has(body, 'name')) {
      data.name = body.name;
    }
    if (has(body, 'url')) {
      data.url = webhooksAssertSafeUrl(body.url === null ? '' : String(body.url));
    }
    if (has(body, 'isActive')) {
      data.is_active = boolVal(body.isActive) ? 1 : 0;
    }
    if (has(body, 'events')) {
      webhooksValidateEvents(body.events);
      data.events = toJson(body.events);
    }
    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE webhooks SET ${sets}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), before.id]);
    }
    const row = await dbOne('SELECT * FROM webhooks WHERE id = ?', [before.id]);
    return jsonOk(res, { ...camelize(scalarRow(row)), events: safeJson(row.events ?? '[]', []) });
  })
);

router.delete(
  '/:id',
  requirePermission('webhooks', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const hook = await loadOrgHook(req, req.params.id);
    await dbExec('DELETE FROM webhooks WHERE id = ?', [hook.id]);
    await auditRecord(a.organizationId, a, 'webhook.deleted', { entityType: 'WEBHOOK', entityId: hook.id, entityLabel: hook.name }, req);
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown webhooks route')));

export default router;
