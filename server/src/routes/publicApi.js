/**
 * Public ingestion API (`/api/v1`) — port of api/publicApi.php.
 *
 * Authenticated with an API key rather than a session, so ad platforms, landing
 * pages and integration middleware can post leads without a browser. Field
 * names accept both camelCase and the snake_case that most webhook senders use.
 */

import express from 'express';
import { dbAll, dbOne, dbScalar } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk, pageMeta, parsePaging } from '../lib/response.js';
import { ah } from '../middleware/index.js';
import { apiKeyAuth } from '../lib/apikey.js';
import { rateLimitCapture } from '../lib/rateLimit.js';
import { auditRecord } from '../lib/audit.js';
import { gvBool, parseDate } from '../lib/util.js';
import { createLead } from '../services/leadService.js';
import { findDuplicates } from '../services/duplicates.js';
import { PUBLIC_API_ALIASES, publicApiNormalize } from './publicApiShared.js';

const router = express.Router();

/** PHP's empty(). */
function isEmpty(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '' || value === '0') {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** PHP's (int) cast: null and non-numeric strings become 0. */
function toInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const m = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(value);
    return m ? Math.trunc(Number(m[0])) || 0 : 0;
  }
  return 0;
}

/** gmdate('c'): second precision with an explicit +00:00 offset. */
function isoUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/**
 * The PHP edition json-decoded the raw body whatever its Content-Type, so a
 * sender posting JSON as text/plain (or with no type at all) still worked.
 * express.json() only reads application/json; anything it left unread is read
 * here as text and decoded the same way. A body that is not a JSON object or
 * list becomes {}, exactly as request_body() returned [].
 */
router.use(express.text({ type: () => true, limit: '2mb' }), (req, res, next) => {
  if (typeof req.body === 'string') {
    let decoded = null;
    try {
      decoded = req.body === '' ? null : JSON.parse(req.body);
    } catch {
      decoded = null;
    }
    req.body = decoded !== null && typeof decoded === 'object' ? decoded : {};
  }
  next();
});

// ---------------------------------------------------------------------------
// GET /v1/ping — lets an integrator confirm the key works.
// ---------------------------------------------------------------------------
router.get(
  '/ping',
  ah(async (req, res) => {
    const auth = await apiKeyAuth(req, null);
    const org = await dbOne('SELECT name, slug FROM organizations WHERE id = ?', [auth.organizationId]);
    return jsonOk(res, {
      status: 'ok',
      organization: org?.name ?? null,
      key: auth.apiKey.name,
      scopes: auth.apiKey.scopes,
      serverTime: isoUtc(),
    });
  })
);

// ---------------------------------------------------------------------------
// GET /v1/metadata — the keys a sender may use for source/status/project.
// ---------------------------------------------------------------------------
router.get(
  '/metadata',
  ah(async (req, res) => {
    const auth = await apiKeyAuth(req, null);
    const orgId = auth.organizationId;
    return jsonOk(res, {
      sources: await dbAll('SELECT `key`, name FROM lead_sources WHERE organization_id = ? AND is_active = 1', [orgId]),
      statuses: await dbAll('SELECT `key`, name FROM lead_statuses WHERE organization_id = ? AND is_active = 1', [orgId]),
      projects: await dbAll(
        'SELECT id, name, location FROM projects WHERE organization_id = ? AND is_active = 1 AND is_archived = 0',
        [orgId]
      ),
      fieldAliases: PUBLIC_API_ALIASES,
    });
  })
);

// ---------------------------------------------------------------------------
// POST /v1/leads/batch — bulk ingest, capped so a single call cannot
// monopolise the process.
// ---------------------------------------------------------------------------
router.post(
  '/leads/batch',
  ah(async (req, res) => {
    const auth = await apiKeyAuth(req, 'leads:create');
    const orgId = auth.organizationId;
    const body = req.body ?? {};
    const items = body.leads ?? null;
    if (items === null || typeof items !== 'object') {
      throw badRequest('Send { "leads": [ ... ] }');
    }
    // A JSON object is an array to PHP too; its keys become the indexes.
    const entries = Array.isArray(items) ? items.map((item, i) => [i, item]) : Object.entries(items);
    if (entries.length > 200) {
      throw badRequest('A batch may contain at most 200 leads');
    }

    const results = [];
    for (const [index, item] of entries) {
      const input = publicApiNormalize(item !== null && typeof item === 'object' ? item : {});
      try {
        if (isEmpty(input.firstName)) {
          throw new Error('firstName is required');
        }
        if (isEmpty(input.email) && isEmpty(input.phone)) {
          throw new Error('email or phone is required');
        }
        if (isEmpty(input.sourceId)) {
          input.sourceId = 'api';
        }
        const createdLead = await createLead(input, { organizationId: orgId, origin: 'API', duplicatePolicy: 'FLAG' });
        results.push({
          index,
          ok: true,
          id: createdLead.lead.id,
          code: createdLead.lead.code,
          duplicates: createdLead.duplicates.length,
        });
      } catch (err) {
        results.push({ index, ok: false, error: err?.message ?? String(err) });
      }
    }
    return jsonOk(res, {
      accepted: results.filter((r) => r.ok).length,
      rejected: results.filter((r) => !r.ok).length,
      results,
    });
  })
);

// ---------------------------------------------------------------------------
// POST /v1/leads/check-duplicate — lets an integrator check before posting.
// ---------------------------------------------------------------------------
router.post(
  '/leads/check-duplicate',
  ah(async (req, res) => {
    const auth = await apiKeyAuth(req, 'leads:create');
    const duplicates = await findDuplicates(auth.organizationId, publicApiNormalize(req.body ?? {}));
    return jsonOk(res, {
      isDuplicate: duplicates.length > 0,
      matches: duplicates.map((d) => ({ id: d.id, code: d.code, matchedOn: d.matchedOn, confidence: d.confidence })),
    });
  })
);

// ---------------------------------------------------------------------------
// POST /v1/leads — ?duplicates=reject|flag|allow (default flag)
// ---------------------------------------------------------------------------
router.post(
  '/leads',
  ah(async (req, res) => {
    await rateLimitCapture(req);
    const auth = await apiKeyAuth(req, 'leads:create');
    const orgId = auth.organizationId;

    const input = publicApiNormalize(req.body ?? {});
    if (isEmpty(input.firstName)) {
      throw badRequest('firstName (or name) is required');
    }
    if (isEmpty(input.email) && isEmpty(input.phone)) {
      throw badRequest('Provide at least an email address or a phone number');
    }
    const policyParam = String(req.query.duplicates ?? 'flag').toUpperCase();
    const duplicatePolicy = ['REJECT', 'FLAG', 'ALLOW'].includes(policyParam) ? policyParam : 'FLAG';
    if (isEmpty(input.sourceId)) {
      input.sourceId = 'api';
    }

    const result = await createLead(input, { organizationId: orgId, origin: 'API', duplicatePolicy });
    const lead = result.lead;

    await auditRecord(
      orgId,
      null,
      'lead.created_via_api',
      {
        entityType: 'LEAD',
        entityId: lead.id,
        entityLabel: `${lead.code} ${lead.firstName}`,
        changes: { apiKey: auth.apiKey.prefix, duplicatePolicy },
      },
      req
    );

    const owner = lead.ownerId ? await dbOne('SELECT first_name, last_name FROM users WHERE id = ?', [lead.ownerId]) : null;
    return jsonCreated(res, {
      id: lead.id,
      code: lead.code,
      status: lead.status?.name ?? null,
      owner: owner ? `${owner.first_name} ${owner.last_name ?? ''}`.trim() : null,
      assignedBy: result.assignment?.ruleName ?? null,
      score: toInt(lead.score),
      duplicateWarnings: result.duplicates.map((d) => ({ id: d.id, code: d.code, matchedOn: d.matchedOn })),
    });
  })
);

// ---------------------------------------------------------------------------
// GET /v1/leads — read-back for integrations that reconcile their own records.
// ---------------------------------------------------------------------------
router.get(
  '/leads',
  ah(async (req, res) => {
    const auth = await apiKeyAuth(req, 'leads:read');
    const orgId = auth.organizationId;
    const { page, limit, offset } = parsePaging(req.query);

    const clauses = ['leads.organization_id = ?', 'leads.is_duplicate = 0'];
    const params = [orgId];
    if (!isEmpty(req.query.since)) {
      // strtotime('2024-01-01') is local midnight; JS reads a bare date as UTC
      // midnight, so a date-only value is pinned to local time first.
      const raw = String(req.query.since);
      const since = parseDate(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw);
      if (since) {
        clauses.push('leads.created_at >= ?');
        params.push(since);
      }
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const rows = await dbAll(
      `SELECT leads.id, leads.code, leads.first_name, leads.last_name, leads.email, leads.phone, leads.company,
              leads.city, leads.state, leads.score, leads.score_band, leads.created_at, leads.is_converted,
              s.\`key\` AS status_key, s.name AS status_name,
              src.\`key\` AS source_key, src.name AS source_name,
              c.code AS campaign_code, c.name AS campaign_name
       FROM leads
       LEFT JOIN lead_statuses s ON s.id = leads.status_id
       LEFT JOIN lead_sources src ON src.id = leads.source_id
       LEFT JOIN campaigns c ON c.id = leads.campaign_id
       ${where} ORDER BY leads.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const total = toInt(await dbScalar(`SELECT COUNT(*) FROM leads ${where}`, params));

    return jsonOk(
      res,
      rows.map((r) => ({
        id: r.id,
        code: r.code,
        firstName: r.first_name,
        lastName: r.last_name,
        email: r.email,
        phone: r.phone,
        company: r.company,
        city: r.city,
        state: r.state,
        score: toInt(r.score),
        scoreBand: r.score_band,
        createdAt: r.created_at,
        isConverted: gvBool(r.is_converted),
        status: r.status_key ? { key: r.status_key, name: r.status_name } : null,
        source: r.source_key ? { key: r.source_key, name: r.source_name } : null,
        campaign: r.campaign_code ? { code: r.campaign_code, name: r.campaign_name } : null,
      })),
      pageMeta(page, limit, total)
    );
  })
);

router.use((req, res, next) => next(notFound('Unknown /api/v1 route')));

export default router;
