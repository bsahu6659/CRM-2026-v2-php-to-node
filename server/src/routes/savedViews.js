/**
 * /api/saved-views/* — port of api/savedViews.php. A view belongs to the user
 * who saved it; others see it only when it is shared, and never edit it.
 */

import express from 'express';
import { dbAll, dbExec, dbOne } from '../lib/db.js';
import { forbidden, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk } from '../lib/response.js';
import { ah } from '../middleware/index.js';
import { camelize, gvId, safeJson, toJson } from '../lib/util.js';
import { validate } from '../lib/validate.js';

const router = express.Router();

/** PHP's empty(). */
function isEmpty(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '' || value === '0') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function savedViewsShape(v) {
  const out = camelize(v);
  out.filters = safeJson(v.filters ?? '{}', []);
  out.columns = safeJson(v.columns ?? '[]', []);
  out.sort = safeJson(v.sort ?? '{}', []);
  return out;
}

// ---------------------------------------------------------------------------
// GET /saved-views — own views plus anything a colleague has shared
// organisation-wide.
// ---------------------------------------------------------------------------
router.get(
  '/',
  ah(async (req, res) => {
    const a = req.actor;
    const query = req.query;
    const params = [a.organizationId];
    let sql = `SELECT sv.*, u.first_name AS user_first_name, u.last_name AS user_last_name
            FROM saved_views sv LEFT JOIN users u ON u.id = sv.user_id
            WHERE sv.organization_id = ?`;
    if (!isEmpty(query.entity)) {
      sql += ' AND sv.entity = ?';
      params.push(String(query.entity));
    }
    sql += ' AND (sv.user_id = ? OR sv.is_shared = 1) ORDER BY sv.is_default DESC, sv.name ASC';
    params.push(a.id);
    const rows = await dbAll(sql, params);
    return jsonOk(
      res,
      rows.map((r) => {
        const out = savedViewsShape(r);
        delete out.userFirstName;
        delete out.userLastName;
        out.user = { firstName: r.user_first_name, lastName: r.user_last_name };
        out.owned = r.user_id === a.id;
        return out;
      })
    );
  })
);

// ---------------------------------------------------------------------------
// POST /saved-views
// ---------------------------------------------------------------------------
router.post(
  '/',
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const v = validate(body);
    v.required('entity', 'Entity').in('entity', ['LEAD', 'OPPORTUNITY', 'TASK', 'CONTACT', 'ACCOUNT']);
    v.required('name', 'View name').maxLength('name', 80);
    v.validate();

    // One default per user per entity: setting a new one clears the old.
    if (!isEmpty(body.isDefault)) {
      await dbExec('UPDATE saved_views SET is_default = 0 WHERE user_id = ? AND entity = ?', [a.id, body.entity]);
    }
    const viewId = gvId();
    await dbExec(
      `INSERT INTO saved_views (id, organization_id, user_id, entity, name, filters, columns, sort, is_shared, is_default, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [
        viewId, a.organizationId, a.id, body.entity, body.name,
        toJson(body.filters ?? []), toJson(body.columns ?? []), toJson(body.sort ?? []),
        !isEmpty(body.isShared) ? 1 : 0, !isEmpty(body.isDefault) ? 1 : 0,
      ]
    );
    return jsonCreated(res, savedViewsShape(await dbOne('SELECT * FROM saved_views WHERE id = ?', [viewId])));
  })
);

// ---------------------------------------------------------------------------
// PATCH /saved-views/:id
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const view = await dbOne('SELECT * FROM saved_views WHERE id = ? AND organization_id = ?', [req.params.id, a.organizationId]);
    if (!view) {
      throw notFound('View not found');
    }
    if (view.user_id !== a.id) {
      throw forbidden('You can only edit views you created.');
    }
    if (!isEmpty(body.isDefault)) {
      await dbExec('UPDATE saved_views SET is_default = 0 WHERE user_id = ? AND entity = ?', [a.id, view.entity]);
    }
    const data = {};
    if (Object.hasOwn(body, 'name')) {
      data.name = body.name;
    }
    for (const [camel, col] of Object.entries({ filters: 'filters', columns: 'columns', sort: 'sort' })) {
      if (Object.hasOwn(body, camel)) {
        data[col] = toJson(body[camel]);
      }
    }
    for (const [camel, col] of Object.entries({ isShared: 'is_shared', isDefault: 'is_default' })) {
      if (Object.hasOwn(body, camel)) {
        data[col] = isEmpty(body[camel]) ? 0 : 1;
      }
    }
    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE saved_views SET ${sets}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), view.id]);
    }
    return jsonOk(res, savedViewsShape(await dbOne('SELECT * FROM saved_views WHERE id = ?', [view.id])));
  })
);

// ---------------------------------------------------------------------------
// DELETE /saved-views/:id
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  ah(async (req, res) => {
    const a = req.actor;
    const view = await dbOne('SELECT * FROM saved_views WHERE id = ? AND organization_id = ?', [req.params.id, a.organizationId]);
    if (!view) {
      throw notFound('View not found');
    }
    if (view.user_id !== a.id) {
      throw forbidden('You can only delete views you created.');
    }
    await dbExec('DELETE FROM saved_views WHERE id = ?', [view.id]);
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown saved-views route')));

export default router;
