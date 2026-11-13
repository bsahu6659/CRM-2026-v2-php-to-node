/**
 * /api/settings/* — port of api/settings.php.
 *
 * Organisation configuration plus the per-tenant vocabularies every lead
 * screen is built from: lead statuses, lead sources, custom fields and tags.
 */

import express from 'express';
import { dbAll, dbExec, dbOne, dbScalar } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { camelize, gvBool, gvDiff, gvId, safeJson, slugify, toJson } from '../lib/util.js';
import { boolVal, validate } from '../lib/validate.js';
import { GV_CUSTOM_FIELD_TYPES } from '../services/customFields.js';

const router = express.Router();

function has(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

/** PHP isset(): present and not null. */
function isSet(obj, key) {
  return has(obj, key) && obj[key] !== null && obj[key] !== undefined;
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

/** PHP `(int)` cast. */
function phpInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** PHP `(float)` cast. */
function phpFloat(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  const n = Number.parseFloat(String(v ?? '').trim());
  return Number.isNaN(n) ? 0 : n;
}

/**
 * PDO returns every column as a scalar, so the PHP edition saw JSON columns
 * (`settings`, `options`) as text except where it decoded them on purpose.
 * mysql2 parses native JSON into objects; re-serialising keeps camelize() out
 * of the stored JSON and gvDiff() comparing like with like.
 */
function scalarRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v !== null && typeof v === 'object' && !Buffer.isBuffer(v) ? JSON.stringify(v) : v;
  }
  return out;
}

/** Last four base-36 digits of the Unix time — the PHP suffix for a clashing key. */
function keySuffix() {
  return Math.floor(Date.now() / 1000).toString(36).slice(-4);
}

function sqlSets(data) {
  return Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
}

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------
router.get(
  '/organization',
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const org = await dbOne('SELECT * FROM organizations WHERE id = ?', [orgId]);
    const userCount = phpInt(await dbScalar('SELECT COUNT(*) FROM users WHERE organization_id = ? AND is_active = 1', [orgId]));
    const leadCount = phpInt(await dbScalar('SELECT COUNT(*) FROM leads WHERE organization_id = ?', [orgId]));
    return jsonOk(res, {
      ...camelize(scalarRow(org)),
      settings: safeJson(org.settings, []),
      stats: { users: userCount, leads: leadCount },
    });
  })
);

router.patch(
  '/organization',
  requirePermission('settings', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    const before = await dbOne('SELECT * FROM organizations WHERE id = ?', [orgId]);

    const data = {};
    const fields = { name: 'name', domain: 'domain', logoUrl: 'logo_url', timezone: 'timezone', currency: 'currency', locale: 'locale' };
    for (const [camel, col] of Object.entries(fields)) {
      if (has(body, camel)) data[col] = orNull(body[camel]);
    }
    if (has(body, 'settings')) {
      const current = safeJson(before.settings, []);
      const incoming =
        body.settings !== null && typeof body.settings === 'object' ? body.settings : safeJson(body.settings, []);
      // Only the known keys are merged, so a client cannot park arbitrary
      // data in the organisation's settings blob.
      const merged = Array.isArray(current) ? Object.assign({}, current) : { ...(current ?? {}) };
      for (const key of ['autoAssignFallback', 'duplicatePolicy', 'defaultPipelineId', 'workingHours', 'fiscalYearStart']) {
        if (has(incoming, key)) merged[key] = incoming[key];
      }
      if (!phpEmpty(merged.duplicatePolicy) && !['FLAG', 'REJECT', 'ALLOW'].includes(merged.duplicatePolicy)) {
        throw badRequest('duplicatePolicy must be FLAG, REJECT or ALLOW');
      }
      data.settings = toJson(merged);
    }
    if (Object.keys(data).length) {
      await dbExec(`UPDATE organizations SET ${sqlSets(data)}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), orgId]);
    }
    const org = await dbOne('SELECT * FROM organizations WHERE id = ?', [orgId]);
    await auditRecord(
      orgId,
      a,
      'organization.updated',
      {
        entityType: 'ORGANIZATION',
        entityId: orgId,
        entityLabel: org.name,
        changes: gvDiff(scalarRow(before), scalarRow(org), Object.keys(data)),
      },
      req
    );
    return jsonOk(res, { ...camelize(scalarRow(org)), settings: safeJson(org.settings, []) });
  })
);

// ---------------------------------------------------------------------------
// Lead statuses
// ---------------------------------------------------------------------------
router.get(
  '/lead-statuses',
  ah(async (req, res) => {
    const rows = await dbAll(
      'SELECT s.*, (SELECT COUNT(*) FROM leads WHERE leads.status_id = s.id) AS lead_count FROM lead_statuses s WHERE s.organization_id = ? ORDER BY s.sort_order ASC',
      [req.actor.organizationId]
    );
    return jsonOk(res, rows.map((r) => ({ ...camelize(r), leadCount: phpInt(r.lead_count) })));
  })
);

router.post(
  '/lead-statuses/reorder',
  requirePermission('settings', 'update'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const order = (req.body ?? {}).order ?? null;
    if (!Array.isArray(order)) {
      throw badRequest('order must be an array of status ids');
    }
    for (const [index, statusId] of order.entries()) {
      await dbExec('UPDATE lead_statuses SET sort_order = ? WHERE id = ? AND organization_id = ?', [index, statusId, orgId]);
    }
    return jsonOk(res, { reordered: order.length });
  })
);

router.post(
  '/lead-statuses',
  requirePermission('settings', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    validate(body).required('name', 'Status name').maxLength('name', 60).validate();

    let key = slugify(String(body.name)).replace(/-/g, '_');
    if (await dbOne('SELECT id FROM lead_statuses WHERE organization_id = ? AND `key` = ?', [orgId, key])) {
      key += `_${keySuffix()}`;
    }
    const maxOrder = phpInt((await dbScalar('SELECT MAX(sort_order) FROM lead_statuses WHERE organization_id = ?', [orgId])) ?? 0);

    // Exactly one default / converted status per organisation.
    if (!phpEmpty(body.isDefault)) {
      await dbExec('UPDATE lead_statuses SET is_default = 0 WHERE organization_id = ?', [orgId]);
    }
    if (!phpEmpty(body.isConverted)) {
      await dbExec('UPDATE lead_statuses SET is_converted = 0 WHERE organization_id = ?', [orgId]);
    }
    const statusId = gvId();
    await dbExec(
      `INSERT INTO lead_statuses (id, organization_id, name, \`key\`, color, sort_order, probability, is_active, is_default, is_qualified, is_converted, is_lost, is_junk, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        statusId, orgId, body.name, key, body.color ?? '#6366f1', body.sortOrder ?? maxOrder + 1, phpInt(body.probability ?? 0),
        has(body, 'isActive') ? (boolVal(body.isActive) ? 1 : 0) : 1,
        !phpEmpty(body.isDefault) ? 1 : 0, !phpEmpty(body.isQualified) ? 1 : 0,
        !phpEmpty(body.isConverted) ? 1 : 0, !phpEmpty(body.isLost) ? 1 : 0, !phpEmpty(body.isJunk) ? 1 : 0,
      ]
    );
    const row = await dbOne('SELECT * FROM lead_statuses WHERE id = ?', [statusId]);
    await auditRecord(orgId, a, 'lead_status.created', { entityType: 'LEAD_STATUS', entityId: statusId, entityLabel: row.name }, req);
    return jsonCreated(res, camelize(row));
  })
);

router.patch(
  '/lead-statuses/:id',
  requirePermission('settings', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    const before = await dbOne('SELECT * FROM lead_statuses WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!before) throw notFound('Status not found');
    if (!phpEmpty(body.isDefault)) {
      await dbExec('UPDATE lead_statuses SET is_default = 0 WHERE organization_id = ?', [orgId]);
    }
    if (!phpEmpty(body.isConverted)) {
      await dbExec('UPDATE lead_statuses SET is_converted = 0 WHERE organization_id = ?', [orgId]);
    }
    const data = {};
    for (const [camel, col] of Object.entries({ name: 'name', color: 'color' })) {
      if (has(body, camel)) data[col] = body[camel];
    }
    for (const [camel, col] of Object.entries({ sortOrder: 'sort_order', probability: 'probability' })) {
      if (has(body, camel)) data[col] = phpInt(body[camel]);
    }
    const flags = {
      isActive: 'is_active', isDefault: 'is_default', isQualified: 'is_qualified',
      isConverted: 'is_converted', isLost: 'is_lost', isJunk: 'is_junk',
    };
    for (const [camel, col] of Object.entries(flags)) {
      if (has(body, camel)) data[col] = boolVal(body[camel]) ? 1 : 0;
    }
    if (Object.keys(data).length) {
      await dbExec(`UPDATE lead_statuses SET ${sqlSets(data)} WHERE id = ?`, [...Object.values(data), before.id]);
    }
    const row = await dbOne('SELECT * FROM lead_statuses WHERE id = ?', [before.id]);
    await auditRecord(
      orgId,
      a,
      'lead_status.updated',
      { entityType: 'LEAD_STATUS', entityId: row.id, entityLabel: row.name, changes: gvDiff(before, row, Object.keys(data)) },
      req
    );
    return jsonOk(res, camelize(row));
  })
);

router.delete(
  '/lead-statuses/:id',
  requirePermission('settings', 'update'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const status = await dbOne('SELECT * FROM lead_statuses WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!status) throw notFound('Status not found');
    const leadCount = phpInt(await dbScalar('SELECT COUNT(*) FROM leads WHERE status_id = ?', [status.id]));
    if (leadCount > 0) {
      throw badRequest(`${leadCount} lead(s) still use this status. Move them first, or deactivate the status instead.`);
    }
    if (gvBool(status.is_default)) {
      throw badRequest('Set another status as the default before deleting this one.');
    }
    await dbExec('DELETE FROM lead_statuses WHERE id = ?', [status.id]);
    return jsonOk(res, { deleted: true });
  })
);

// ---------------------------------------------------------------------------
// Lead sources
// ---------------------------------------------------------------------------
router.get(
  '/lead-sources',
  ah(async (req, res) => {
    const rows = await dbAll(
      'SELECT s.*, (SELECT COUNT(*) FROM leads WHERE leads.source_id = s.id) AS lead_count FROM lead_sources s WHERE s.organization_id = ? ORDER BY s.sort_order ASC',
      [req.actor.organizationId]
    );
    return jsonOk(res, rows.map((r) => ({ ...camelize(r), leadCount: phpInt(r.lead_count) })));
  })
);

router.post(
  '/lead-sources',
  requirePermission('settings', 'update'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const body = req.body ?? {};
    validate(body).required('name', 'Source name').maxLength('name', 60).validate();

    let key = slugify(String(body.name)).replace(/-/g, '_');
    if (await dbOne('SELECT id FROM lead_sources WHERE organization_id = ? AND `key` = ?', [orgId, key])) {
      key += `_${keySuffix()}`;
    }
    const sourceId = gvId();
    await dbExec(
      'INSERT INTO lead_sources (id, organization_id, name, `key`, category, cost_per_lead, is_active, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,NOW())',
      [
        sourceId, orgId, body.name, key, body.category ?? 'OTHER',
        isSet(body, 'costPerLead') && body.costPerLead !== '' ? phpFloat(body.costPerLead) : null,
        has(body, 'isActive') ? (boolVal(body.isActive) ? 1 : 0) : 1, phpInt(body.sortOrder ?? 99),
      ]
    );
    return jsonCreated(res, camelize(await dbOne('SELECT * FROM lead_sources WHERE id = ?', [sourceId])));
  })
);

router.patch(
  '/lead-sources/:id',
  requirePermission('settings', 'update'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const body = req.body ?? {};
    const before = await dbOne('SELECT * FROM lead_sources WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!before) throw notFound('Source not found');
    const data = {};
    if (has(body, 'name')) {
      data.name = body.name;
    }
    if (has(body, 'category')) {
      data.category = body.category;
    }
    if (has(body, 'sortOrder')) {
      data.sort_order = phpInt(body.sortOrder);
    }
    if (has(body, 'isActive')) {
      data.is_active = boolVal(body.isActive) ? 1 : 0;
    }
    if (has(body, 'costPerLead')) {
      data.cost_per_lead = body.costPerLead === null || body.costPerLead === '' ? null : phpFloat(body.costPerLead);
    }
    if (Object.keys(data).length) {
      await dbExec(`UPDATE lead_sources SET ${sqlSets(data)} WHERE id = ?`, [...Object.values(data), before.id]);
    }
    return jsonOk(res, camelize(await dbOne('SELECT * FROM lead_sources WHERE id = ?', [before.id])));
  })
);

router.delete(
  '/lead-sources/:id',
  requirePermission('settings', 'update'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const source = await dbOne('SELECT * FROM lead_sources WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!source) throw notFound('Source not found');
    if (phpInt(await dbScalar('SELECT COUNT(*) FROM leads WHERE source_id = ?', [source.id])) > 0) {
      throw badRequest('Leads still reference this source. Deactivate it instead.');
    }
    await dbExec('DELETE FROM lead_sources WHERE id = ?', [source.id]);
    return jsonOk(res, { deleted: true });
  })
);

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------
function customFieldShape(r) {
  return { ...camelize(scalarRow(r)), options: safeJson(r.options ?? '[]', []) };
}

router.get(
  '/custom-fields',
  ah(async (req, res) => {
    const query = req.query;
    const params = [req.actor.organizationId];
    let sql = 'SELECT * FROM custom_fields WHERE organization_id = ?';
    if (!phpEmpty(query.entity)) {
      sql += ' AND entity = ?';
      params.push(String(query.entity));
    }
    sql += ' ORDER BY entity ASC, sort_order ASC';
    return jsonOk(res, (await dbAll(sql, params)).map(customFieldShape));
  })
);

router.post(
  '/custom-fields',
  requirePermission('settings', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    validate(body)
      .required('entity', 'Entity').in('entity', ['LEAD', 'CONTACT', 'ACCOUNT', 'OPPORTUNITY'])
      .required('label', 'Label').maxLength('label', 80)
      .required('type', 'Type').in('type', GV_CUSTOM_FIELD_TYPES)
      .validate();

    if (['SELECT', 'MULTISELECT'].includes(body.type) && phpEmpty(body.options)) {
      throw badRequest('Choice fields need at least one option.');
    }
    let key = slugify(String(body.label)).replace(/-/g, '_');
    if (await dbOne('SELECT id FROM custom_fields WHERE organization_id = ? AND entity = ? AND `key` = ?', [orgId, body.entity, key])) {
      key += `_${keySuffix()}`;
    }
    const fieldId = gvId();
    await dbExec(
      `INSERT INTO custom_fields (id, organization_id, entity, \`key\`, label, type, options, is_required, is_active, show_in_list, default_value, help_text, sort_order, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        fieldId, orgId, body.entity, key, body.label, body.type, toJson(body.options ?? []),
        !phpEmpty(body.isRequired) ? 1 : 0, has(body, 'isActive') ? (boolVal(body.isActive) ? 1 : 0) : 1,
        !phpEmpty(body.showInList) ? 1 : 0, body.defaultValue ?? null, body.helpText ?? null, phpInt(body.sortOrder ?? 0),
      ]
    );
    const row = await dbOne('SELECT * FROM custom_fields WHERE id = ?', [fieldId]);
    await auditRecord(
      orgId,
      a,
      'custom_field.created',
      { entityType: 'CUSTOM_FIELD', entityId: fieldId, entityLabel: `${row.entity}.${row.key}` },
      req
    );
    return jsonCreated(res, { ...camelize(scalarRow(row)), options: safeJson(row.options, []) });
  })
);

router.patch(
  '/custom-fields/:id',
  requirePermission('settings', 'update'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const body = req.body ?? {};
    const before = await dbOne('SELECT * FROM custom_fields WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!before) throw notFound('Custom field not found');
    // `entity` is deliberately not updatable: moving a field would orphan its values.
    const data = {};
    const fields = { label: 'label', type: 'type', defaultValue: 'default_value', helpText: 'help_text' };
    for (const [camel, col] of Object.entries(fields)) {
      if (has(body, camel)) data[col] = orNull(body[camel]);
    }
    if (has(body, 'sortOrder')) {
      data.sort_order = phpInt(body.sortOrder);
    }
    for (const [camel, col] of Object.entries({ isRequired: 'is_required', isActive: 'is_active', showInList: 'show_in_list' })) {
      if (has(body, camel)) data[col] = boolVal(body[camel]) ? 1 : 0;
    }
    if (has(body, 'options')) {
      data.options = toJson(body.options);
    }
    if (Object.keys(data).length) {
      await dbExec(`UPDATE custom_fields SET ${sqlSets(data)} WHERE id = ?`, [...Object.values(data), before.id]);
    }
    const row = await dbOne('SELECT * FROM custom_fields WHERE id = ?', [before.id]);
    return jsonOk(res, { ...camelize(scalarRow(row)), options: safeJson(row.options, []) });
  })
);

router.delete(
  '/custom-fields/:id',
  requirePermission('settings', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const row = await dbOne('SELECT * FROM custom_fields WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!row) throw notFound('Custom field not found');
    await dbExec('DELETE FROM custom_fields WHERE id = ?', [row.id]);
    await auditRecord(
      orgId,
      a,
      'custom_field.deleted',
      { entityType: 'CUSTOM_FIELD', entityId: row.id, entityLabel: `${row.entity}.${row.key}` },
      req
    );
    return jsonOk(res, { deleted: true, note: 'Stored values are dropped the next time each record is saved.' });
  })
);

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------
router.get(
  '/tags',
  ah(async (req, res) => {
    const rows = await dbAll(
      `SELECT t.id, t.name, t.color, (SELECT COUNT(*) FROM lead_tags WHERE lead_tags.tag_id = t.id) AS usage_count
         FROM tags t WHERE t.organization_id = ? ORDER BY t.name ASC`,
      [req.actor.organizationId]
    );
    return jsonOk(
      res,
      rows.map((r) => ({ id: r.id, name: r.name, color: r.color, usageCount: phpInt(r.usage_count) }))
    );
  })
);

// Creating a tag is part of tagging a lead, so it is gated on leads:update
// rather than on settings.
router.post(
  '/tags',
  requirePermission('leads', 'update'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const body = req.body ?? {};
    const name = body.name === undefined || body.name === null ? '' : String(body.name).trim();
    if (name === '') {
      throw badRequest('Tag name is required');
    }
    const existing = await dbOne('SELECT * FROM tags WHERE organization_id = ? AND name = ?', [orgId, name]);
    if (existing) {
      if (!phpEmpty(body.color)) {
        await dbExec('UPDATE tags SET color = ? WHERE id = ?', [body.color, existing.id]);
      }
      return jsonCreated(res, camelize(await dbOne('SELECT * FROM tags WHERE id = ?', [existing.id])));
    }
    const tagId = gvId();
    await dbExec('INSERT INTO tags (id, organization_id, name, color, created_at) VALUES (?,?,?,?,NOW())', [
      tagId, orgId, name, body.color ?? '#64748b',
    ]);
    return jsonCreated(res, camelize(await dbOne('SELECT * FROM tags WHERE id = ?', [tagId])));
  })
);

router.delete(
  '/tags/:id',
  requirePermission('settings', 'update'),
  ah(async (req, res) => {
    const tag = await dbOne('SELECT * FROM tags WHERE id = ? AND organization_id = ?', [req.params.id, req.actor.organizationId]);
    if (!tag) throw notFound('Tag not found');
    await dbExec('DELETE FROM tags WHERE id = ?', [tag.id]);
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown settings route')));

export default router;
