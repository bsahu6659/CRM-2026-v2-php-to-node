/**
 * /api/projects/* - the real-estate project master (port of api/projects.php).
 *
 * Read access follows projectVisibleWhere(): your own projects, anything
 * published GLOBAL, and anything explicitly shared with you. Write access is
 * narrower - only the owning tenant, enforced by projectAssertWritable().
 *
 * Lead counts returned here are always counted inside the caller's own tenant,
 * which is what keeps two brokers selling the same tower from seeing each
 * other's pipeline (spec section 24).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import config from '../config/index.js';
import { dbAll, dbExec, dbOne, dbScalar } from '../lib/db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk, pageMeta, parsePaging, parseSort } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { uploadSingle } from '../middleware/upload.js';
import { assertPermission } from '../lib/auth.js';
import { auditRecord, exportRecord } from '../lib/audit.js';
import { isPlatformAdmin, requirePlatformAdmin } from '../lib/tenancy.js';
import { camelize, gvBool, gvDiff, gvId, safeJson, toJson, toSqlDate } from '../lib/util.js';
import { xlsxDownload } from '../lib/xlsx.js';
import {
  GV_PROJECT_STATUSES,
  GV_PROJECT_TYPES,
  GV_PROJECT_VISIBILITY,
  projectAccessOrgIds,
  projectAssertWritable,
  projectImages,
  projectLeadCounts,
  projectLoadVisible,
  projectNextCode,
  projectPresent,
  projectSetAccess,
  projectSyncCover,
  projectUniqueSlug,
  projectVisibleWhere,
} from '../services/projects.js';

const router = express.Router();

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** PHP's empty(). */
function isEmpty(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '' || value === '0') {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** PHP's (int) cast. */
function toInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const m = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(value);
    return m ? Math.trunc(Number(m[0])) || 0 : 0;
  }
  return 0;
}

async function isFile(p) {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Image checks. The PHP edition asked libmagic (finfo) for the real type and
// getimagesize() whether it decodes; Node has neither built in, so the three
// formats a project image may be are recognised by their own headers here.
// ---------------------------------------------------------------------------
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffImageMime(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

/**
 * True when the header carries real dimensions — the getimagesize() test. It
 * rejects a script renamed to .jpg even if its leading bytes were crafted to
 * sniff as an image.
 */
function isReadableImage(buf, mime) {
  if (mime === 'image/png') {
    return buf.length >= 24 && buf.toString('latin1', 12, 16) === 'IHDR';
  }
  if (mime === 'image/webp') {
    const chunk = buf.toString('latin1', 12, 16);
    return buf.length >= 30 && ['VP8 ', 'VP8L', 'VP8X'].includes(chunk);
  }
  if (mime === 'image/jpeg') {
    // Walk the segments to a start-of-frame marker, which is where the size is.
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return false;
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return true;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return false;
  }
  return false;
}

/**
 * $_FILES['file'] with PHP's failure messages: multer reports an oversized or
 * broken upload as an error, which PHP saw as a non-OK upload status.
 */
const receiveImage = (req, res, next) => {
  uploadSingle('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(badRequest('That image is larger than the upload limit.'));
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return next(badRequest('Choose an image to upload.'));
    return next(badRequest('The upload did not complete. Please try again.'));
  });
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function projectsParseList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v ?? '').trim()).filter((v) => v !== '');
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).map((v) => String(v ?? '').trim()).filter((v) => v !== '');
  }
  if (typeof value === 'string' && value !== '') {
    return value.split(',').map((v) => v.trim()).filter((v) => v !== '');
  }
  return [];
}

/** Shared column mapping for create and update. */
function projectsWritableColumns(body, isCreate) {
  const map = {
    name: 'name', location: 'location', developerName: 'developer_name',
    projectType: 'project_type', city: 'city', state: 'state',
    country: 'country', pincode: 'pincode', address: 'address',
    description: 'description', reraNumber: 'rera_number', status: 'status',
    possessionDate: 'possession_date', priceMin: 'price_min', priceMax: 'price_max',
    areaMin: 'area_min', areaMax: 'area_max', areaUnit: 'area_unit',
    contactName: 'contact_name', contactPhone: 'contact_phone', contactEmail: 'contact_email',
    logoUrl: 'logo_url',
  };
  const out = {};
  for (const [camel, col] of Object.entries(map)) {
    if (has(body, camel)) {
      const value = body[camel];
      out[col] = value === '' ? null : value;
    }
  }
  if (has(body, 'configurations')) {
    out.configurations = toJson(projectsParseList(body.configurations));
  }
  if (has(body, 'amenities')) {
    out.amenities = toJson(projectsParseList(body.amenities));
  }
  if (has(body, 'isActive')) {
    out.is_active = gvBool(body.isActive) ? 1 : 0;
  }
  if (has(body, 'isArchived')) {
    out.is_archived = gvBool(body.isArchived) ? 1 : 0;
  }

  if (out.project_type !== undefined && out.project_type !== null && !GV_PROJECT_TYPES.includes(out.project_type)) {
    throw badRequest('Choose a valid project type.');
  }
  if (out.status !== undefined && out.status !== null && !GV_PROJECT_STATUSES.includes(out.status)) {
    throw badRequest('Choose a valid project status.');
  }
  if (isCreate) {
    for (const [col, label] of [['name', 'Project name'], ['location', 'Location'], ['developer_name', 'Developer / brand']]) {
      if (isEmpty(out[col])) {
        throw badRequest(`${label} is required.`);
      }
    }
  }
  return out;
}

/**
 * Visibility is a platform-level decision for GLOBAL (it publishes a project to
 * every client on the platform), but a tenant may still keep its own projects
 * PRIVATE or share them with named partners.
 */
async function projectsApplyVisibility(actor, projectId, visibility, accessOrgIds) {
  if (visibility === null || visibility === undefined) {
    return;
  }
  if (!GV_PROJECT_VISIBILITY.includes(visibility)) {
    throw badRequest('Choose a valid visibility option.');
  }
  if (visibility === 'GLOBAL' && !isPlatformAdmin(actor)) {
    throw forbidden('Only a platform administrator can publish a project to every company.');
  }
  await dbExec('UPDATE projects SET visibility = ? WHERE id = ?', [visibility, projectId]);

  if (visibility === 'SELECTED') {
    if (!isPlatformAdmin(actor)) {
      throw forbidden('Only a platform administrator can share a project with other companies.');
    }
    await projectSetAccess(projectId, projectsParseList(accessOrgIds), actor.id);
  } else if (visibility === 'PRIVATE') {
    // Dropping back to private must actually revoke, not just hide.
    await dbExec('DELETE FROM project_access WHERE project_id = ?', [projectId]);
  }
}

// ---------------------------------------------------------------------------
// GET /projects
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('projects', 'read'),
  ah(async (req, res) => {
    const query = req.query;
    const orgId = req.actor.organizationId;

    const vis = await projectVisibleWhere(orgId);
    const where = [vis.sql];
    const params = [...vis.params];

    if (!isEmpty(query.q)) {
      where.push('(projects.name LIKE ? OR projects.location LIKE ? OR projects.developer_name LIKE ? OR projects.code LIKE ?)');
      const like = `%${query.q}%`;
      params.push(like, like, like, like);
    }
    for (const [q, col] of [['projectType', 'project_type'], ['status', 'status'], ['city', 'city'], ['visibility', 'visibility']]) {
      if (!isEmpty(query[q])) {
        where.push(`projects.${col} = ?`);
        params.push(query[q]);
      }
    }
    // "ownership" splits the list the way a broker thinks about it: stock I
    // created versus stock somebody shared with me.
    if ((query.ownership ?? '') === 'own') {
      where.push('projects.organization_id = ?');
      params.push(orgId);
    } else if ((query.ownership ?? '') === 'shared') {
      where.push('projects.organization_id <> ?');
      params.push(orgId);
    }
    if ((query.includeArchived ?? '') !== 'true') {
      where.push('projects.is_archived = 0');
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const { page, limit, offset } = parsePaging(query);
    const total = toInt(await dbScalar(`SELECT COUNT(*) FROM projects ${whereSql}`, params));

    const [sortCol, sortDir] = parseSort(query, ['name', 'createdAt', 'location', 'priceMin', 'possessionDate'], 'created_at');
    const rows = await dbAll(
      `SELECT projects.*, organizations.name AS owner_org_name
         FROM projects JOIN organizations ON organizations.id = projects.organization_id
         ${whereSql} ORDER BY projects.${sortCol} ${sortDir} LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const counts = await projectLeadCounts(orgId, rows.map((r) => r.id));
    const data = [];
    for (const r of rows) {
      data.push(
        await projectPresent(r, orgId, {
          lead_count: counts[r.id] ?? 0,
          owner_org_name: r.owner_org_name,
        })
      );
    }
    return jsonOk(res, data, pageMeta(page, limit, total));
  })
);

// ---------------------------------------------------------------------------
// GET /projects/options — lightweight list for the lead form's project picker.
// ---------------------------------------------------------------------------
router.get(
  '/options',
  requirePermission('projects', 'read'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const vis = await projectVisibleWhere(orgId);
    const rows = await dbAll(
      `SELECT projects.id, projects.name, projects.location, projects.city, projects.developer_name,
              projects.project_type, projects.configurations
         FROM projects
        WHERE ${vis.sql} AND projects.is_active = 1 AND projects.is_archived = 0
        ORDER BY projects.name ASC`,
      vis.params
    );
    // The lead form uses `configurations` to suggest 2 BHK / 3 BHK for the
    // project the caller actually picked.
    for (const row of rows) {
      row.configurations = safeJson(row.configurations, []);
    }
    return jsonOk(res, camelize(rows));
  })
);

// ---------------------------------------------------------------------------
// GET /projects/meta
// ---------------------------------------------------------------------------
router.get(
  '/meta',
  ah(async (req, res) =>
    jsonOk(res, {
      types: GV_PROJECT_TYPES,
      statuses: GV_PROJECT_STATUSES,
      visibility: GV_PROJECT_VISIBILITY,
      canPublishGlobal: isPlatformAdmin(req.actor),
    })
  )
);

// ---------------------------------------------------------------------------
// GET /projects/export
// ---------------------------------------------------------------------------
router.get(
  '/export',
  requirePermission('projects', 'export'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const vis = await projectVisibleWhere(orgId);
    const rows = await dbAll(
      `SELECT projects.*, organizations.name AS owner_org_name
         FROM projects JOIN organizations ON organizations.id = projects.organization_id
        WHERE ${vis.sql} AND projects.is_archived = 0 ORDER BY projects.name ASC`,
      vis.params
    );
    const counts = await projectLeadCounts(orgId, rows.map((r) => r.id));
    for (const r of rows) {
      r.lead_count = counts[r.id] ?? 0;
      const list = safeJson(r.configurations, []);
      r.configurations = (Array.isArray(list) ? list : Object.values(list ?? {})).join(', ');
    }

    await exportRecord(orgId, a, 'PROJECTS', 'XLSX', rows.length, { ...req.query }, req);
    return xlsxDownload(
      res,
      `projects-${toSqlDate(new Date())}.xlsx`,
      [
        { key: 'code', label: 'Project Code', type: 'string' },
        { key: 'name', label: 'Project Name', type: 'string' },
        { key: 'developer_name', label: 'Developer / Brand', type: 'string' },
        { key: 'location', label: 'Location', type: 'string' },
        { key: 'city', label: 'City', type: 'string' },
        { key: 'project_type', label: 'Type', type: 'string' },
        { key: 'status', label: 'Status', type: 'string' },
        { key: 'configurations', label: 'Configurations', type: 'string' },
        { key: 'price_min', label: 'Price From', type: 'number' },
        { key: 'price_max', label: 'Price To', type: 'number' },
        { key: 'rera_number', label: 'RERA Number', type: 'string' },
        { key: 'possession_date', label: 'Possession', type: 'date' },
        { key: 'owner_org_name', label: 'Owned By', type: 'string' },
        { key: 'lead_count', label: 'Leads (your company)', type: 'number' },
      ],
      rows,
      'Projects'
    );
  })
);

// ---------------------------------------------------------------------------
// POST /projects
// ---------------------------------------------------------------------------
router.post(
  '/',
  requirePermission('projects', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    const data = projectsWritableColumns(body, true);

    const projectId = gvId();
    data.id = projectId;
    data.organization_id = orgId;
    data.code = await projectNextCode(orgId);
    data.slug = await projectUniqueSlug(orgId, String(data.name));
    data.created_by_id = a.id;
    data.visibility = 'PRIVATE';

    const cols = Object.keys(data).map((k) => `\`${k}\``).join(', ');
    const ph = Object.keys(data).map(() => '?').join(',');
    await dbExec(`INSERT INTO projects (${cols}, created_at, updated_at) VALUES (${ph}, NOW(), NOW())`, Object.values(data));

    await projectsApplyVisibility(a, projectId, body.visibility ?? null, body.sharedWith ?? []);

    await auditRecord(
      orgId,
      a,
      'project.created',
      {
        entityType: 'PROJECT',
        entityId: projectId,
        entityLabel: data.name,
        changes: { name: data.name, location: data.location },
      },
      req
    );

    return jsonCreated(res, await projectPresent(await dbOne('SELECT * FROM projects WHERE id = ?', [projectId]), orgId));
  })
);

// ---------------------------------------------------------------------------
// GET /projects/:id/cover — the cover photo, for list cards. projects keeps
// only the cover's stored file name, so this resolves it the same way the
// per-image route does, behind the same visibility check.
// ---------------------------------------------------------------------------
router.get(
  '/:id/cover',
  requirePermission('projects', 'read'),
  ah(async (req, res) => {
    const project = await projectLoadVisible(req.actor.organizationId, req.params.id);
    if (!project.cover_image_url) throw notFound('This project has no cover image.');
    const image = await dbOne('SELECT * FROM project_images WHERE project_id = ? AND url = ? LIMIT 1', [
      project.id,
      project.cover_image_url,
    ]);
    const filePath = path.join(config.uploads.dir, path.basename(String(project.cover_image_url)));
    if (!(await isFile(filePath))) throw notFound('The image file is missing from storage.');

    const bytes = await fs.promises.readFile(filePath);
    res.set('Content-Type', image?.mime_type || 'application/octet-stream');
    res.set('Content-Length', String(bytes.length));
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.end(bytes);
  })
);

// ---------------------------------------------------------------------------
// GET /projects/:id/images/:imageId/file — the binary itself. It goes through
// the same visibility check as the record, so a shared project's photos are
// readable but a private one's are not.
// ---------------------------------------------------------------------------
router.get(
  '/:id/images/:imageId/file',
  requirePermission('projects', 'read'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const { id, imageId } = req.params;
    await projectLoadVisible(orgId, id);
    const image = await dbOne('SELECT * FROM project_images WHERE id = ? AND project_id = ?', [imageId, id]);
    if (!image) throw notFound('Image not found.');

    const filePath = path.join(config.uploads.dir, path.basename(String(image.url)));
    if (!(await isFile(filePath))) throw notFound('The image file is missing from storage.');

    const bytes = await fs.promises.readFile(filePath);
    res.set('Content-Type', image.mime_type || 'application/octet-stream');
    res.set('Content-Length', String(bytes.length));
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.end(bytes);
  })
);

// ---------------------------------------------------------------------------
// GET /projects/:id/images
// ---------------------------------------------------------------------------
router.get(
  '/:id/images',
  requirePermission('projects', 'read'),
  ah(async (req, res) => {
    await projectLoadVisible(req.actor.organizationId, req.params.id);
    return jsonOk(res, await projectImages(req.params.id));
  })
);

// ---------------------------------------------------------------------------
// POST /projects/:id/images — multipart field `file`, optional `caption`.
// ---------------------------------------------------------------------------
router.post(
  '/:id/images',
  requirePermission('projects', 'manage'),
  receiveImage,
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const id = req.params.id;
    const project = await projectLoadVisible(orgId, id);
    await projectAssertWritable(a, project);

    const file = req.file;
    if (!file) throw badRequest('Choose an image to upload.');
    if (file.size > config.uploads.maxBytes) throw badRequest('That image is larger than the upload limit.');

    // Sniff the real type. The browser-supplied name and type are both
    // attacker-controlled, so neither decides whether this file is kept.
    const mime = sniffImageMime(file.buffer);
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(mime)) {
      throw badRequest('Project images must be JPG, PNG or WEBP.');
    }
    if (!isReadableImage(file.buffer, mime)) {
      throw badRequest('That file is not a readable image.');
    }

    const uploadDir = config.uploads.dir;
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
    const storedName = `project-${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
    try {
      await fs.promises.mkdir(uploadDir, { recursive: true, mode: 0o755 });
      await fs.promises.writeFile(path.join(uploadDir, storedName), file.buffer);
    } catch {
      throw badRequest('The image could not be saved.');
    }

    const imageId = gvId();
    const isFirst = toInt(await dbScalar('SELECT COUNT(*) FROM project_images WHERE project_id = ?', [id])) === 0;
    await dbExec(
      `INSERT INTO project_images (id, project_id, url, caption, is_cover, sort_order, file_size, mime_type, uploaded_by_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
      [
        imageId, id, storedName, req.body?.caption ?? null, isFirst ? 1 : 0,
        toInt(await dbScalar('SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_images WHERE project_id = ?', [id])),
        toInt(file.size), mime, a.id,
      ]
    );
    // The stored URL is an API path, not a filesystem path, so the visibility
    // check runs on every fetch.
    await dbExec('UPDATE project_images SET url = ? WHERE id = ?', [storedName, imageId]);
    await projectSyncCover(id);

    await auditRecord(
      orgId,
      a,
      'project.image_added',
      {
        entityType: 'PROJECT',
        entityId: id,
        entityLabel: project.name,
        changes: { imageId, mimeType: mime },
      },
      req
    );
    return jsonCreated(res, camelize(await dbOne('SELECT * FROM project_images WHERE id = ?', [imageId])));
  })
);

// ---------------------------------------------------------------------------
// PATCH /projects/:id/images/:imageId — cover, caption, order.
// ---------------------------------------------------------------------------
router.patch(
  '/:id/images/:imageId',
  requirePermission('projects', 'manage'),
  ah(async (req, res) => {
    const a = req.actor;
    const { id, imageId } = req.params;
    const body = req.body ?? {};
    const project = await projectLoadVisible(a.organizationId, id);
    await projectAssertWritable(a, project);
    if (!(await dbScalar('SELECT id FROM project_images WHERE id = ? AND project_id = ?', [imageId, id]))) {
      throw notFound('Image not found.');
    }
    if (has(body, 'isCover')) {
      await dbExec('UPDATE project_images SET is_cover = 0 WHERE project_id = ?', [id]);
      await dbExec('UPDATE project_images SET is_cover = ? WHERE id = ?', [gvBool(body.isCover) ? 1 : 0, imageId]);
    }
    if (has(body, 'caption')) {
      await dbExec('UPDATE project_images SET caption = ? WHERE id = ?', [isEmpty(body.caption) ? null : body.caption, imageId]);
    }
    if (has(body, 'sortOrder')) {
      await dbExec('UPDATE project_images SET sort_order = ? WHERE id = ?', [toInt(body.sortOrder), imageId]);
    }
    await projectSyncCover(id);
    return jsonOk(res, await projectImages(id));
  })
);

// ---------------------------------------------------------------------------
// DELETE /projects/:id/images/:imageId
// ---------------------------------------------------------------------------
router.delete(
  '/:id/images/:imageId',
  requirePermission('projects', 'manage'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const { id, imageId } = req.params;
    const project = await projectLoadVisible(orgId, id);
    await projectAssertWritable(a, project);
    const image = await dbOne('SELECT * FROM project_images WHERE id = ? AND project_id = ?', [imageId, id]);
    if (!image) throw notFound('Image not found.');

    const filePath = path.join(config.uploads.dir, path.basename(String(image.url)));
    if (await isFile(filePath)) {
      await fs.promises.unlink(filePath).catch(() => {});
    }
    await dbExec('DELETE FROM project_images WHERE id = ?', [imageId]);
    await projectSyncCover(id);

    await auditRecord(
      orgId,
      a,
      'project.image_removed',
      { entityType: 'PROJECT', entityId: id, entityLabel: project.name, changes: { imageId } },
      req
    );
    return jsonOk(res, await projectImages(id));
  })
);

// ---------------------------------------------------------------------------
// PUT /projects/:id/access — granting a project to named companies is a
// platform-owner action; it is the mechanism behind the broker model in spec
// section 23.
// ---------------------------------------------------------------------------
router.put(
  '/:id/access',
  ah(async (req, res) => {
    const a = requirePlatformAdmin(req);
    assertPermission(req, 'global_projects', 'manage');
    const id = req.params.id;
    const body = req.body ?? {};
    const project = await dbOne('SELECT * FROM projects WHERE id = ?', [id]);
    if (!project) throw notFound('Project not found.');

    const orgIds = projectsParseList(body.organizationIds ?? []);
    await dbExec('UPDATE projects SET visibility = ?, updated_at = NOW() WHERE id = ?', [orgIds.length ? 'SELECTED' : 'PRIVATE', id]);
    await projectSetAccess(id, orgIds, a.id);

    await auditRecord(
      project.organization_id,
      a,
      'project.access_changed',
      {
        entityType: 'PROJECT',
        entityId: id,
        entityLabel: project.name,
        changes: { organizationIds: orgIds },
      },
      req
    );
    return jsonOk(res, { sharedWith: await projectAccessOrgIds(id) });
  })
);

// ---------------------------------------------------------------------------
// GET /projects/:id
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  requirePermission('projects', 'read'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const id = req.params.id;
    const project = await projectLoadVisible(orgId, id);
    const counts = await projectLeadCounts(orgId, [id]);

    const ownerOrg = await dbOne('SELECT name, company_type FROM organizations WHERE id = ?', [project.organization_id]);
    const payload = await projectPresent(project, orgId, {
      lead_count: counts[id] ?? 0,
      owner_org_name: ownerOrg?.name ?? null,
    });
    payload.images = await projectImages(id);
    // Only the platform admin needs (or may see) the sharing list.
    payload.sharedWith = isPlatformAdmin(a) ? await projectAccessOrgIds(id) : [];
    return jsonOk(res, payload);
  })
);

// ---------------------------------------------------------------------------
// PATCH /projects/:id
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requirePermission('projects', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const id = req.params.id;
    const body = req.body ?? {};
    const project = await projectLoadVisible(orgId, id);
    await projectAssertWritable(a, project);

    const data = projectsWritableColumns(body, false);
    if (Object.keys(data).length) {
      if (data.name !== undefined && data.name !== null && data.name !== project.name) {
        data.slug = await projectUniqueSlug(orgId, String(data.name));
      }
      const set = Object.keys(data).map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE projects SET ${set}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), id]);
    }
    await projectsApplyVisibility(a, id, body.visibility ?? null, body.sharedWith ?? []);

    const after = await dbOne('SELECT * FROM projects WHERE id = ?', [id]);
    await auditRecord(
      orgId,
      a,
      'project.updated',
      {
        entityType: 'PROJECT',
        entityId: id,
        entityLabel: after.name,
        changes: gvDiff(project, after, Object.keys(data)),
      },
      req
    );
    return jsonOk(res, await projectPresent(after, orgId));
  })
);

// ---------------------------------------------------------------------------
// DELETE /projects/:id
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requirePermission('projects', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const id = req.params.id;
    const project = await projectLoadVisible(orgId, id);
    await projectAssertWritable(a, project);

    // A project with leads attached is archived rather than deleted - dropping
    // it would orphan the attribution on every lead that came through it.
    const leadCount = toInt(await dbScalar('SELECT COUNT(*) FROM leads WHERE project_id = ?', [id]));
    if (leadCount > 0) {
      await dbExec('UPDATE projects SET is_archived = 1, is_active = 0, updated_at = NOW() WHERE id = ?', [id]);
      await auditRecord(
        orgId,
        a,
        'project.archived',
        {
          entityType: 'PROJECT',
          entityId: id,
          entityLabel: project.name,
          changes: { reason: `${leadCount} leads reference this project` },
        },
        req
      );
      return jsonOk(res, {
        archived: true,
        leadCount,
        message: `Archived instead of deleted: ${leadCount} leads are attached to this project.`,
      });
    }

    await dbExec('DELETE FROM projects WHERE id = ?', [id]);
    await auditRecord(
      orgId,
      a,
      'project.deleted',
      { entityType: 'PROJECT', entityId: id, entityLabel: project.name, changes: [] },
      req
    );
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown projects route.')));

export default router;
