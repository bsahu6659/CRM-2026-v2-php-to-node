/**
 * /api/notifications/* — port of api/notifications.php. Always personal: every
 * query is pinned to the actor's own rows, so there is no scope to resolve.
 */

import express from 'express';
import { dbAll, dbExec, dbOne, dbScalar } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { jsonOk, pageMeta, parsePaging } from '../lib/response.js';
import { ah } from '../middleware/index.js';
import { camelize } from '../lib/util.js';
import { runDueSweep } from '../services/notifications.js';

const router = express.Router();

/** PHP's empty(). */
function isEmpty(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '' || value === '0') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

async function unreadCount(userId) {
  return Number.parseInt(
    String(await dbScalar('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0', [userId])),
    10
  ) || 0;
}

// ---------------------------------------------------------------------------
// GET /notifications
// ---------------------------------------------------------------------------
router.get(
  '/',
  ah(async (req, res) => {
    const a = req.actor;
    const query = req.query;
    const { page, limit, offset } = parsePaging(query);
    const clauses = ['user_id = ?'];
    const params = [a.id];
    if ((query.unread ?? null) === 'true') {
      clauses.push('is_read = 0');
    }
    if (!isEmpty(query.type)) {
      clauses.push('type = ?');
      params.push(String(query.type));
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const rows = await dbAll(`SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    const total = Number.parseInt(String(await dbScalar(`SELECT COUNT(*) FROM notifications ${where}`, params)), 10) || 0;
    const unread = await unreadCount(a.id);
    return jsonOk(res, rows.map((r) => camelize(r)), { ...pageMeta(page, limit, total), unread });
  })
);

// ---------------------------------------------------------------------------
// GET /notifications/unread-count — the bell badge
// ---------------------------------------------------------------------------
router.get(
  '/unread-count',
  ah(async (req, res) => {
    return jsonOk(res, { unread: await unreadCount(req.actor.id) });
  })
);

// ---------------------------------------------------------------------------
// POST /notifications/read-all
// ---------------------------------------------------------------------------
router.post(
  '/read-all',
  ah(async (req, res) => {
    const count = await dbExec('UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_id = ? AND is_read = 0', [
      req.actor.id,
    ]);
    return jsonOk(res, { updated: count });
  })
);

// ---------------------------------------------------------------------------
// POST /notifications/sweep — runs the due-follow-up sweep on demand (the
// same work the cron job does), as the PHP edition allowed any signed-in user.
// ---------------------------------------------------------------------------
router.post(
  '/sweep',
  ah(async (req, res) => {
    return jsonOk(res, await runDueSweep());
  })
);

// ---------------------------------------------------------------------------
// POST /notifications/:id/read
// ---------------------------------------------------------------------------
router.post(
  '/:id/read',
  ah(async (req, res) => {
    const a = req.actor;
    const row = await dbOne('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [req.params.id, a.id]);
    if (!row) {
      throw notFound('Notification not found');
    }
    await dbExec('UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ?', [row.id]);
    return jsonOk(res, camelize(await dbOne('SELECT * FROM notifications WHERE id = ?', [row.id])));
  })
);

// ---------------------------------------------------------------------------
// DELETE /notifications/:id
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  ah(async (req, res) => {
    const a = req.actor;
    const row = await dbOne('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [req.params.id, a.id]);
    if (!row) {
      throw notFound('Notification not found');
    }
    await dbExec('DELETE FROM notifications WHERE id = ?', [row.id]);
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown notifications route')));

export default router;
