/**
 * /api/api-keys/* — port of api/apikeys.php.
 *
 * Keys for the /api/v1 ingestion API. Only the SHA-256 hash and a short
 * prefix are stored; the raw key exists exactly once, in the creation
 * response.
 */

import express from 'express';
import { dbAll, dbExec, dbOne } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { generateApiKey } from '../lib/security.js';
import { gvId, parseDate, safeJson, toJson } from '../lib/util.js';
import { validate } from '../lib/validate.js';

const router = express.Router();

export const API_KEY_SCOPES = [
  { key: 'leads:create', label: 'Create leads' },
  { key: 'leads:read', label: 'Read leads' },
  { key: '*', label: 'Full ingestion access' },
];

/** 'YYYY-MM-DD HH:MM:SS' (local, as mysql2 returns it) is in the past. */
function isPast(sqlDateTime) {
  const ts = new Date(String(sqlDateTime).replace(' ', 'T')).getTime();
  return !Number.isNaN(ts) && ts < Date.now();
}

async function loadOrgKey(req, id) {
  const key = await dbOne('SELECT * FROM api_keys WHERE id = ? AND organization_id = ?', [id, req.actor.organizationId]);
  if (!key) throw notFound('API key not found');
  return key;
}

router.get(
  '/scopes',
  requirePermission('apikeys', 'read'),
  ah(async (req, res) => jsonOk(res, API_KEY_SCOPES))
);

router.get(
  '/',
  requirePermission('apikeys', 'read'),
  ah(async (req, res) => {
    const rows = await dbAll(
      `SELECT k.*, u.first_name AS cb_first_name, u.last_name AS cb_last_name
         FROM api_keys k LEFT JOIN users u ON u.id = k.created_by_id WHERE k.organization_id = ? ORDER BY k.created_at DESC`,
      [req.actor.organizationId]
    );
    // The raw key is shown exactly once, at creation. Only the prefix survives.
    return jsonOk(
      res,
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        scopes: safeJson(r.scopes ?? '[]', []),
        lastUsedAt: r.last_used_at,
        useCount: Number.parseInt(r.use_count, 10) || 0,
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at,
        createdAt: r.created_at,
        createdBy: r.created_by_id ? `${r.cb_first_name ?? ''} ${r.cb_last_name ?? ''}`.trim() : null,
        status: r.revoked_at ? 'REVOKED' : r.expires_at && isPast(r.expires_at) ? 'EXPIRED' : 'ACTIVE',
      }))
    );
  })
);

router.post(
  '/',
  requirePermission('apikeys', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    validate(body).required('name', 'Key name').maxLength('name', 80).validate();

    const scopes = body.scopes ?? [];
    const allowed = API_KEY_SCOPES.map((s) => s.key);
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((s) => !allowed.includes(s))) {
      throw badRequest(`Choose at least one valid scope: ${allowed.join(', ')}`);
    }

    const { raw, prefix, hash } = generateApiKey();
    const keyId = gvId();
    await dbExec(
      'INSERT INTO api_keys (id, organization_id, name, prefix, key_hash, scopes, created_by_id, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,NOW())',
      [keyId, orgId, body.name, prefix, hash, toJson(scopes), a.id, parseDate(body.expiresAt ?? null)]
    );
    await auditRecord(
      orgId,
      a,
      'api_key.created',
      { entityType: 'API_KEY', entityId: keyId, entityLabel: body.name, changes: { scopes, prefix } },
      req
    );
    return jsonCreated(res, {
      id: keyId,
      name: body.name,
      prefix,
      scopes,
      key: raw,
      warning: 'Copy this key now. It is hashed on save and cannot be shown again.',
    });
  })
);

router.post(
  '/:id/revoke',
  requirePermission('apikeys', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const key = await loadOrgKey(req, req.params.id);
    if (key.revoked_at) {
      throw badRequest('That key is already revoked.');
    }
    await dbExec('UPDATE api_keys SET revoked_at = NOW() WHERE id = ?', [key.id]);
    await auditRecord(a.organizationId, a, 'api_key.revoked', { entityType: 'API_KEY', entityId: key.id, entityLabel: key.name }, req);
    return jsonOk(res, { revoked: true });
  })
);

router.delete(
  '/:id',
  requirePermission('apikeys', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const key = await loadOrgKey(req, req.params.id);
    await dbExec('DELETE FROM api_keys WHERE id = ?', [key.id]);
    await auditRecord(a.organizationId, a, 'api_key.deleted', { entityType: 'API_KEY', entityId: key.id, entityLabel: key.name }, req);
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown api-keys route')));

export default router;
