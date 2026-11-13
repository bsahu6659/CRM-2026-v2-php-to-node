/** /api/forms/* — web form builder (port of api/forms.php). */

import crypto from 'node:crypto';
import express from 'express';
import { dbAll, dbExec, dbOne, dbScalar } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk, pageMeta, parsePaging } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { auditRecord } from '../lib/audit.js';
import { camelize, gvId, safeJson, slugify, toJson } from '../lib/util.js';
import { boolVal, validate } from '../lib/validate.js';
import { FORMS_FIELD_TYPES, FORMS_MAPPABLE, formsShape, formsValidateFields } from './formsShared.js';

const router = express.Router();

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** PHP truthiness, for the `$x ?: null` patterns the PATCH handler relies on. */
function truthy(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '' || value === '0') {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function shapeSubmission(s) {
  return { ...camelize(s), payload: safeJson(s.payload ?? '{}', []) };
}

// ---------------------------------------------------------------------------
// GET /forms
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('forms', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const rows = await dbAll(
      `SELECT f.*, p.id AS project_obj_id, p.name AS project_name, (SELECT COUNT(*) FROM form_submissions WHERE form_id = f.id) AS submission_count
         FROM web_forms f LEFT JOIN projects p ON p.id = f.project_id WHERE f.organization_id = ? ORDER BY f.created_at DESC`,
      [a.organizationId]
    );
    return jsonOk(
      res,
      rows.map((r) => {
        const shaped = formsShape(r);
        shaped.project = r.project_id ? { id: r.project_obj_id, name: r.project_name } : null;
        shaped.submissionCount = Math.trunc(Number(r.submission_count) || 0);
        delete shaped.projectObjId;
        delete shaped.projectName;
        return shaped;
      })
    );
  })
);

// ---------------------------------------------------------------------------
// GET /forms/field-catalogue — what the builder may offer.
// ---------------------------------------------------------------------------
router.get(
  '/field-catalogue',
  requirePermission('forms', 'read'),
  ah(async (req, res) => jsonOk(res, { types: FORMS_FIELD_TYPES, mappable: FORMS_MAPPABLE }))
);

// ---------------------------------------------------------------------------
// POST /forms
// ---------------------------------------------------------------------------
router.post(
  '/',
  requirePermission('forms', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    validate(body).required('name', 'Form name').maxLength('name', 120).validate();
    formsValidateFields(body.fields ?? []);

    const formId = gvId();
    // The slug half keeps the public URL readable; the random half is what
    // makes it unguessable.
    const publicKey = `${slugify(String(body.name)).slice(0, 20)}-${crypto.randomBytes(6).toString('hex')}`;
    await dbExec(
      `INSERT INTO web_forms (id, organization_id, name, public_key, description, fields, source_id, project_id, assign_to_user_id, assign_to_team_id,
          use_assignment_rules, redirect_url, success_message, submit_label, allowed_origins, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [
        formId, a.organizationId, body.name, publicKey, body.description ?? null, toJson(body.fields),
        body.sourceId ?? null, body.projectId ?? null, body.assignToUserId ?? null, body.assignToTeamId ?? null,
        has(body, 'useAssignmentRules') ? (boolVal(body.useAssignmentRules) ? 1 : 0) : 1,
        body.redirectUrl ?? null, body.successMessage ?? 'Thanks! Our team will contact you shortly.',
        body.submitLabel ?? 'Submit', body.allowedOrigins ?? '', has(body, 'isActive') ? (boolVal(body.isActive) ? 1 : 0) : 1,
      ]
    );
    const row = await dbOne('SELECT * FROM web_forms WHERE id = ?', [formId]);
    await auditRecord(
      a.organizationId,
      a,
      'form.created',
      { entityType: 'WEB_FORM', entityId: formId, entityLabel: row.name },
      req
    );
    return jsonCreated(res, formsShape(row));
  })
);

// ---------------------------------------------------------------------------
// GET /forms/:id/submissions
// ---------------------------------------------------------------------------
router.get(
  '/:id/submissions',
  requirePermission('forms', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const form = await dbOne('SELECT * FROM web_forms WHERE id = ? AND organization_id = ?', [req.params.id, a.organizationId]);
    if (!form) throw notFound('Form not found');
    const { page, limit, offset } = parsePaging(req.query);
    const rows = await dbAll('SELECT * FROM form_submissions WHERE form_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [
      form.id,
      limit,
      offset,
    ]);
    const total = Number(await dbScalar('SELECT COUNT(*) FROM form_submissions WHERE form_id = ?', [form.id]));
    return jsonOk(res, rows.map(shapeSubmission), pageMeta(page, limit, total));
  })
);

// ---------------------------------------------------------------------------
// GET /forms/:id — the form, its counters and the latest submissions.
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  requirePermission('forms', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const form = await dbOne('SELECT * FROM web_forms WHERE id = ? AND organization_id = ?', [req.params.id, a.organizationId]);
    if (!form) throw notFound('Form not found');
    const submissions = await dbAll('SELECT * FROM form_submissions WHERE form_id = ? ORDER BY created_at DESC LIMIT 25', [form.id]);
    const total = Number(await dbScalar('SELECT COUNT(*) FROM form_submissions WHERE form_id = ?', [form.id]));
    const accepted = Number(
      await dbScalar("SELECT COUNT(*) FROM form_submissions WHERE form_id = ? AND status = 'ACCEPTED'", [form.id])
    );
    const duplicates = Number(
      await dbScalar("SELECT COUNT(*) FROM form_submissions WHERE form_id = ? AND status = 'DUPLICATE'", [form.id])
    );
    return jsonOk(res, {
      form: formsShape(form),
      stats: { total, accepted, duplicates },
      submissions: submissions.map(shapeSubmission),
    });
  })
);

// ---------------------------------------------------------------------------
// PATCH /forms/:id
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requirePermission('forms', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const before = await dbOne('SELECT * FROM web_forms WHERE id = ? AND organization_id = ?', [req.params.id, a.organizationId]);
    if (!before) throw notFound('Form not found');

    const data = {};
    const map = {
      name: 'name',
      description: 'description',
      sourceId: 'source_id',
      projectId: 'project_id',
      assignToUserId: 'assign_to_user_id',
      assignToTeamId: 'assign_to_team_id',
      redirectUrl: 'redirect_url',
      allowedOrigins: 'allowed_origins',
    };
    for (const [camel, col] of Object.entries(map)) {
      if (has(body, camel)) {
        // allowed_origins is NOT NULL: clearing it means "any origin", stored as ''.
        data[col] = truthy(body[camel]) ? body[camel] : camel === 'allowedOrigins' ? '' : null;
      }
    }
    if (has(body, 'successMessage') && truthy(body.successMessage)) {
      data.success_message = body.successMessage;
    }
    if (has(body, 'submitLabel') && truthy(body.submitLabel)) {
      data.submit_label = body.submitLabel;
    }
    if (has(body, 'useAssignmentRules')) {
      data.use_assignment_rules = boolVal(body.useAssignmentRules) ? 1 : 0;
    }
    if (has(body, 'isActive')) {
      data.is_active = boolVal(body.isActive) ? 1 : 0;
    }
    if (has(body, 'fields')) {
      formsValidateFields(body.fields);
      data.fields = toJson(body.fields);
    }
    const keys = Object.keys(data);
    if (keys.length) {
      const sets = keys.map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE web_forms SET ${sets}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), before.id]);
    }
    return jsonOk(res, formsShape(await dbOne('SELECT * FROM web_forms WHERE id = ?', [before.id])));
  })
);

// ---------------------------------------------------------------------------
// DELETE /forms/:id
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requirePermission('forms', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const form = await dbOne('SELECT * FROM web_forms WHERE id = ? AND organization_id = ?', [req.params.id, a.organizationId]);
    if (!form) throw notFound('Form not found');
    await dbExec('DELETE FROM web_forms WHERE id = ?', [form.id]);
    await auditRecord(
      a.organizationId,
      a,
      'form.deleted',
      { entityType: 'WEB_FORM', entityId: form.id, entityLabel: form.name },
      req
    );
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown forms route')));

export default router;
