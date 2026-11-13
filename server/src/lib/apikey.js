/**
 * API-key auth for the public ingestion API (/api/v1) — Meta and website
 * integrations authenticate this way, never with a session cookie.
 */

import { dbExec, dbOne } from './db.js';
import { forbidden, unauthenticated } from './errors.js';
import { sha256 } from './security.js';
import { gvBool, safeJson } from './util.js';

export async function apiKeyAuth(req, requiredScope = null) {
  let raw = req.get('x-api-key') ?? null;
  if (!raw) {
    const header = req.get('authorization') ?? '';
    if (header.toLowerCase().startsWith('bearer ')) raw = header.slice(7).trim();
  }
  if (!raw) throw unauthenticated('API key required. Send it in the X-API-Key header.');

  const key = await dbOne('SELECT * FROM api_keys WHERE key_hash = ?', [sha256(raw)]);
  if (!key || key.revoked_at || (key.expires_at && new Date(key.expires_at).getTime() < Date.now())) {
    throw unauthenticated('Invalid or revoked API key');
  }

  const org = await dbOne('SELECT * FROM organizations WHERE id = ?', [key.organization_id]);
  if (!org || !gvBool(org.is_active)) throw forbidden('Organisation is inactive');

  const scopes = safeJson(key.scopes, []);
  if (requiredScope && !scopes.includes(requiredScope) && !scopes.includes('*')) {
    throw forbidden(`API key is missing the "${requiredScope}" scope`);
  }

  req.apiKey = { id: key.id, prefix: key.prefix, name: key.name, scopes };
  req.apiKeyOrgId = key.organization_id;

  await dbExec('UPDATE api_keys SET last_used_at = NOW(), use_count = use_count + 1 WHERE id = ?', [key.id]);

  return { organizationId: key.organization_id, apiKey: req.apiKey };
}
