/**
 * /api/documents/* — port of api/documents.php.
 *
 * Uploads are written with a generated name and never with the client's
 * filename, so a crafted name cannot traverse out of the upload directory or
 * land as an executable. The original name is kept in the database for display
 * and used only in the Content-Disposition header on download.
 *
 * The upload directory is not served statically: every download is streamed
 * through GET /:id/download, after the organisation and permission checks.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import config from '../config/index.js';
import { dbExec, dbOne } from '../lib/db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk } from '../lib/response.js';
import { ah, requirePermission, scopeInfo } from '../middleware/index.js';
import { uploadSingle } from '../middleware/upload.js';
import { auditRecord } from '../lib/audit.js';
import { camelize, gvId } from '../lib/util.js';

const router = express.Router();

const DOCUMENT_RELATIONS = { leadId: 'lead_id', contactId: 'contact_id', accountId: 'account_id', opportunityId: 'opportunity_id' };
const DOCUMENT_PARENT_TABLES = { lead_id: 'leads', contact_id: 'contacts', account_id: 'accounts', opportunity_id: 'opportunities' };

/** PHP's empty(). */
function isEmpty(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '' || value === '0') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** PHP's rawurlencode(): RFC 3986, so !'()* are escaped too. */
function rawUrlEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Multer's failures arrive before the handler runs. They are turned into the
 * same 400s the PHP edition raised from $_FILES['file']['error'], rather than
 * the generic 413 the global error handler would give.
 */
function acceptFile(req, res, next) {
  uploadSingle('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(badRequest('That file is larger than the upload limit.'));
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return next(badRequest('Attach a file'));
    return next(badRequest('The upload did not complete. Please try again.'));
  });
}

function bufferHas(buffer, text, encoding = 'latin1') {
  return buffer.indexOf(Buffer.from(text, encoding)) !== -1;
}

/**
 * Trust the sniffed type, not the browser-supplied one. The PHP edition asked
 * libmagic (finfo); Node has no built-in equivalent, so the formats on the
 * upload allow-list are recognised here by their signatures. Anything that is
 * not one of them comes back as something the allow-list rejects.
 */
function sniffMime(buffer) {
  if (!buffer || buffer.length === 0) return 'application/x-empty';
  const head = buffer.subarray(0, 16);
  const starts = (bytes) => bytes.every((b, i) => head[i] === b);

  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';

  // OLE2 compound file: legacy .xls / .doc, told apart by their main stream.
  if (starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // Word stores body text as UTF-16 too, so its stream name is checked
    // first: a document that merely mentions a "Book" is still a document.
    if (bufferHas(buffer, 'WordDocument', 'utf16le')) return 'application/msword';
    if (bufferHas(buffer, 'Workbook', 'utf16le') || bufferHas(buffer, 'Book', 'utf16le')) return 'application/vnd.ms-excel';
    return 'application/CDFV2';
  }

  // ZIP container: Office Open XML is recognised by its part names.
  if (starts([0x50, 0x4b, 0x03, 0x04])) {
    if (bufferHas(buffer, '[Content_Types].xml')) {
      if (bufferHas(buffer, 'word/')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if (bufferHas(buffer, 'xl/')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      if (bufferHas(buffer, 'ppt/')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    }
    return 'application/zip';
  }

  // Text: no NUL and no control bytes other than the whitespace and escape
  // characters ordinary text files carry.
  const sample = buffer.subarray(0, Math.min(buffer.length, 65536));
  for (const b of sample) {
    if (b === 0x7f || (b < 0x20 && ![0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x1b].includes(b))) {
      return 'application/octet-stream';
    }
  }
  // Markup and scripts are text too, but not text this endpoint stores.
  const lead = sample.toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^<\?php/i.test(lead)) return 'text/x-php';
  if (/^<\?xml/i.test(lead)) return 'text/xml';
  if (/^<(!doctype\s+html|html|head|body|script|svg|iframe)\b/i.test(lead)) return 'text/html';
  if (lead.startsWith('#!')) return 'text/x-shellscript';
  return 'text/plain';
}

// ---------------------------------------------------------------------------
// POST /documents — multipart upload, attached to a lead (or legacy parent)
// ---------------------------------------------------------------------------
router.post(
  '/',
  requirePermission('documents', 'create'),
  acceptFile,
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const uploadDir = config.uploads.dir;
    const file = req.file;
    if (!file) {
      throw badRequest('Attach a file');
    }
    if (file.size > config.uploads.maxBytes) {
      throw badRequest('That file is larger than the upload limit.');
    }

    // Trust the sniffed type, not the browser-supplied one.
    const mime = sniffMime(file.buffer);
    if (!config.uploads.allowedMime.includes(mime)) {
      throw badRequest(`That file type (${mime}) is not allowed.`);
    }

    const fields = req.body ?? {};
    const links = {};
    for (const [camel, col] of Object.entries(DOCUMENT_RELATIONS)) {
      if (!isEmpty(fields[camel])) {
        links[col] = fields[camel];
      }
    }
    if (!Object.keys(links).length) {
      throw badRequest('Attach the document to a lead, contact, account or opportunity.');
    }
    // Verify the parent exists in this organisation before keeping the file.
    for (const [col, value] of Object.entries(links)) {
      if (!(await dbOne(`SELECT id FROM ${DOCUMENT_PARENT_TABLES[col]} WHERE id = ? AND organization_id = ?`, [value, orgId]))) {
        throw notFound('The record this document belongs to was not found.');
      }
    }

    await fs.promises.mkdir(uploadDir, { recursive: true, mode: 0o755 });
    const original = String(file.originalname ?? '').slice(0, 200);
    const baseName = original.split('/').pop();
    const dot = baseName.lastIndexOf('.');
    const ext = (dot === -1 ? '' : baseName.slice(dot + 1)).slice(0, 10).toLowerCase().replace(/[^a-z0-9]/g, '');
    const storedName = `${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(8).toString('hex')}${ext ? `.${ext}` : ''}`;
    try {
      await fs.promises.writeFile(path.join(uploadDir, storedName), file.buffer);
    } catch (err) {
      console.error('[documents] could not write upload:', err.message);
      throw badRequest('The upload could not be saved.');
    }

    const docId = gvId();
    const columns = {
      id: docId,
      organization_id: orgId,
      file_name: original,
      stored_name: storedName,
      mime_type: mime,
      size_bytes: Math.trunc(file.size),
      uploaded_by_id: a.id,
      ...links,
    };
    const cols = Object.keys(columns).map((k) => `\`${k}\``).join(', ');
    const ph = Object.keys(columns).map(() => '?').join(',');
    await dbExec(`INSERT INTO documents (${cols}, created_at) VALUES (${ph}, NOW())`, Object.values(columns));

    await dbExec(
      `INSERT INTO activities (id, organization_id, type, subject, lead_id, contact_id, account_id, opportunity_id, user_id, occurred_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [
        gvId(), orgId, 'DOCUMENT', `Uploaded ${original}`,
        links.lead_id ?? null, links.contact_id ?? null, links.account_id ?? null, links.opportunity_id ?? null,
        a.id,
      ]
    );
    await auditRecord(orgId, a, 'document.uploaded', { entityType: 'DOCUMENT', entityId: docId, entityLabel: original }, req);

    const doc = await dbOne('SELECT * FROM documents WHERE id = ?', [docId]);
    return jsonCreated(res, {
      ...camelize(doc),
      uploadedBy: { id: a.id, firstName: a.firstName, lastName: a.lastName },
    });
  })
);

// ---------------------------------------------------------------------------
// GET /documents/:id/download — streamed through the API
// ---------------------------------------------------------------------------
router.get(
  '/:id/download',
  requirePermission('documents', 'read'),
  ah(async (req, res, next) => {
    const a = req.actor;
    const doc = await dbOne('SELECT * FROM documents WHERE id = ? AND organization_id = ?', [req.params.id, a.organizationId]);
    if (!doc) {
      throw notFound('Document not found');
    }
    // Re-join against the stored name, never against anything from the request.
    const filePath = path.join(config.uploads.dir, path.basename(String(doc.stored_name)));
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw notFound('That file is no longer on disk.');
    }

    // setHeader, not res.set: Express would append a charset to text types,
    // and the stored type is sent exactly as it was recorded.
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${rawUrlEncode(doc.file_name)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(stat.size));

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        for (const h of ['Content-Type', 'Content-Disposition', 'Content-Length']) res.removeHeader(h);
        next(notFound('That file is no longer on disk.'));
        return;
      }
      console.error('[documents] download stream failed:', err.message);
      res.destroy(err);
    });
    stream.pipe(res);
  })
);

// ---------------------------------------------------------------------------
// DELETE /documents/:id
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requirePermission('documents', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const scope = await scopeInfo(req);
    const doc = await dbOne('SELECT * FROM documents WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!doc) {
      throw notFound('Document not found');
    }
    if (doc.uploaded_by_id !== a.id && !scope.unrestricted && !scope.userIds.includes(doc.uploaded_by_id)) {
      throw forbidden('You can only remove documents you or your team uploaded.');
    }
    await dbExec('DELETE FROM documents WHERE id = ?', [doc.id]);
    const filePath = path.join(config.uploads.dir, path.basename(String(doc.stored_name)));
    // Best effort, like PHP's @unlink: the row is gone either way, and a file
    // that is already missing is not a reason to fail the request.
    await fs.promises.unlink(filePath).catch(() => {});
    await auditRecord(orgId, a, 'document.deleted', { entityType: 'DOCUMENT', entityId: doc.id, entityLabel: doc.file_name }, req);
    return jsonOk(res, { deleted: true });
  })
);

router.use((req, res, next) => next(notFound('Unknown documents route')));

export default router;
