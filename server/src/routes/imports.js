/**
 * /api/imports/* — CSV lead import, port of api/imports.php.
 *
 * Two-phase by design: `preview` stages the file and proposes a column mapping,
 * `execute` commits it. Staging on disk (rather than round-tripping the parsed
 * rows through the browser) keeps a 20k-row file out of the client's memory and
 * makes the mapping step cheap to iterate on.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import config from '../config/index.js';
import { dbAll, dbExec, dbOne, dbScalar } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { jsonCreated, jsonOk, pageMeta, parsePaging } from '../lib/response.js';
import { ah, requirePermission } from '../middleware/index.js';
import { uploadSingle } from '../middleware/upload.js';
import { auditRecord } from '../lib/audit.js';
import { camelize, gvId, normalizeEmail, normalizePhone, safeJson, toJson } from '../lib/util.js';
import { boolVal } from '../lib/validate.js';
import { parseCsvObjects, toCsv } from '../lib/csv.js';
import { findDuplicates } from '../services/duplicates.js';
import { createLead } from '../services/leadService.js';
import { notifyUser } from '../services/notifications.js';
import { projectVisibleWhere } from '../services/projects.js';

const router = express.Router();

const IMPORT_TARGET_FIELDS = [
  { key: 'firstName', label: 'First Name', required: true, aliases: ['first name', 'firstname', 'name', 'fname', 'lead name'] },
  { key: 'lastName', label: 'Last Name', aliases: ['last name', 'lastname', 'surname', 'lname'] },
  { key: 'email', label: 'Email', aliases: ['email', 'e-mail', 'email address', 'mail'] },
  { key: 'phone', label: 'Phone', aliases: ['phone', 'mobile', 'phone number', 'contact', 'contact number', 'mobile number'] },
  { key: 'altPhone', label: 'Alternate Phone', aliases: ['alternate phone', 'phone 2', 'secondary phone'] },
  { key: 'company', label: 'Company', aliases: ['company', 'organisation', 'organization', 'company name', 'business'] },
  { key: 'jobTitle', label: 'Job Title', aliases: ['job title', 'designation', 'title', 'role'] },
  { key: 'website', label: 'Website', aliases: ['website', 'url', 'web'] },
  { key: 'country', label: 'Country', aliases: ['country'] },
  { key: 'state', label: 'State', aliases: ['state', 'province', 'region'] },
  { key: 'city', label: 'City', aliases: ['city', 'town'] },
  { key: 'address', label: 'Address', aliases: ['address', 'street'] },
  { key: 'pincode', label: 'Pincode', aliases: ['pincode', 'pin code', 'zip', 'zipcode', 'postal code'] },
  { key: 'sourceId', label: 'Lead Source', aliases: ['source', 'lead source'] },
  { key: 'campaignId', label: 'Campaign', aliases: ['campaign', 'campaign code'] },
  { key: 'statusId', label: 'Lead Status', aliases: ['status', 'lead status'] },
  { key: 'priority', label: 'Priority', aliases: ['priority'] },
  { key: 'expectedValue', label: 'Expected Value', aliases: ['expected value', 'value', 'budget', 'deal value'] },
  { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'comments', 'message', 'remarks'] },
  { key: 'medium', label: 'Medium', aliases: ['medium'] },
  { key: 'utmSource', label: 'UTM Source', aliases: ['utm source', 'utm_source'] },
  { key: 'utmCampaign', label: 'UTM Campaign', aliases: ['utm campaign', 'utm_campaign'] },
  { key: 'tags', label: 'Tags (semicolon separated)', aliases: ['tags', 'tag'] },
];

/** PHP's empty(). */
function isEmpty(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '' || value === '0') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** PHP's (string) cast. */
function str(value) {
  if (value === undefined || value === null || value === false) return '';
  if (value === true) return '1';
  return String(value);
}

/** PHP's trim(): only " \t\n\r\0\x0B", the way the CSV cells were compared before. */
function phpTrim(value) {
  return str(value).replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

/** Header names come from the file: define them, so "__proto__" stays an ordinary key. */
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function importsSuggestMapping(headers) {
  const mapping = {};
  const used = new Set();
  for (const header of headers) {
    const norm = phpTrim(header).toLowerCase();
    for (const f of IMPORT_TARGET_FIELDS) {
      if (used.has(f.key)) {
        continue;
      }
      if (f.key.toLowerCase() === norm || (f.aliases ?? []).includes(norm)) {
        setOwn(mapping, header, f.key);
        used.add(f.key);
        break;
      }
    }
  }
  return mapping;
}

async function importsStagingDir() {
  const dir = path.join(config.uploads.dir, 'imports');
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 });
  return dir;
}

function importsShape(r) {
  const out = camelize(r);
  out.mapping = safeJson(r.mapping ?? '{}', []);
  out.errors = safeJson(r.errors ?? '[]', []);
  return out;
}

function withCreatedBy(r) {
  const out = importsShape(r);
  delete out.cbFirstName;
  delete out.cbLastName;
  out.createdBy = r.created_by_id ? { firstName: r.cb_first_name, lastName: r.cb_last_name } : null;
  return out;
}

function sendCsv(res, filename, csv) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(csv);
}

/**
 * Whatever went wrong with the multipart body, the PHP edition answered with
 * the same 400 — there was no $_FILES['file'] it could use.
 */
function acceptCsv(req, res, next) {
  uploadSingle('file')(req, res, (err) => (err ? next(badRequest('Attach a CSV file')) : next()));
}

// ---------------------------------------------------------------------------
// GET /imports/target-fields — what a column can be mapped onto
// ---------------------------------------------------------------------------
router.get(
  '/target-fields',
  requirePermission('imports', 'read'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const customFields = await dbAll(
      "SELECT `key`, label FROM custom_fields WHERE organization_id = ? AND entity = 'LEAD' AND is_active = 1",
      [orgId]
    );
    const out = IMPORT_TARGET_FIELDS.map((f) => ({ key: f.key, label: f.label, required: !isEmpty(f.required) }));
    for (const f of customFields) {
      out.push({ key: `customFields.${f.key}`, label: `${f.label} (custom)`, required: false });
    }
    return jsonOk(res, out);
  })
);

// ---------------------------------------------------------------------------
// GET /imports/template.csv
// ---------------------------------------------------------------------------
router.get(
  '/template.csv',
  requirePermission('imports', 'read'),
  ah(async (req, res) => {
    const sample = [
      {
        firstName: 'Aarav', lastName: 'Sharma', email: 'aarav.sharma@example.com', phone: '9876543210',
        company: 'Northwind Traders', jobTitle: 'Procurement Head', city: 'Gurugram', state: 'Haryana',
        country: 'India', pincode: '122001', sourceId: 'google_ads', priority: 'HIGH',
        expectedValue: '450000', notes: 'Asked for a callback on Monday', tags: 'enterprise;warm',
      },
    ];
    const csv = toCsv(sample, IMPORT_TARGET_FIELDS.map((f) => ({ key: f.key, label: f.label })));
    return sendCsv(res, 'growvanta-lead-import-template.csv', csv);
  })
);

// ---------------------------------------------------------------------------
// POST /imports/preview — stage the file, propose a mapping
// ---------------------------------------------------------------------------
router.post(
  '/preview',
  requirePermission('imports', 'create'),
  acceptCsv,
  ah(async (req, res) => {
    const file = req.file;
    if (!file) {
      throw badRequest('Attach a CSV file');
    }
    const name = str(file.originalname ?? 'import.csv');
    const mime = str(file.mimetype ?? '');
    if (!/\.csv$/i.test(name) && !['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv'].includes(mime)) {
      throw badRequest('Upload a .csv file. Export from Excel or Sheets as CSV first.');
    }
    if (!Buffer.isBuffer(file.buffer)) {
      throw badRequest('That file could not be read.');
    }
    const { headers, records } = parseCsvObjects(file.buffer, 20000);
    if (!headers.length) {
      throw badRequest('That file has no header row.');
    }
    if (!records.length) {
      throw badRequest('That file has a header but no data rows.');
    }

    const token = crypto.randomBytes(16).toString('hex');
    // The original bytes, not a re-encoding of them, so execute parses exactly
    // what was previewed.
    await fs.promises.writeFile(path.join(await importsStagingDir(), `${token}.csv`), file.buffer);

    return jsonOk(res, {
      token,
      fileName: name,
      headers,
      totalRows: records.length,
      sample: records.slice(0, 10),
      suggestedMapping: importsSuggestMapping(headers),
    });
  })
);

// ---------------------------------------------------------------------------
// POST /imports/execute — commit a staged file with the chosen mapping
// ---------------------------------------------------------------------------
router.post(
  '/execute',
  requirePermission('imports', 'create'),
  ah(async (req, res) => {
    const a = req.actor;
    const orgId = a.organizationId;
    const body = req.body ?? {};
    const token = body.token ?? '';
    const mapping = body.mapping ?? null;
    const duplicateHandling = body.duplicateHandling ?? 'SKIP';
    const defaultSourceId = body.defaultSourceId ?? null;
    const defaultOwnerId = body.defaultOwnerId ?? null;
    const runAssignment = Object.hasOwn(body, 'runAssignment') ? boolVal(body.runAssignment) : true;

    // A spreadsheet of enquiries is always a spreadsheet about something, and
    // the file rarely names it. Required for the run, applied to every row, and
    // recorded on the job so the import history says what was attributed.
    if (isEmpty(body.projectId)) {
      throw badRequest('Choose the project these leads belong to before importing.');
    }
    const vis = await projectVisibleWhere(orgId);
    const importProjectId = await dbScalar(
      `SELECT projects.id FROM projects WHERE projects.id = ? AND ${vis.sql}`,
      [body.projectId, ...vis.params]
    );
    if (!importProjectId) {
      throw badRequest('That project is not available to your company.');
    }

    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) {
      throw badRequest('Upload the file again - the staging token is missing or invalid.');
    }
    if (mapping === null || typeof mapping !== 'object' || isEmpty(mapping)) {
      throw badRequest('Provide a column mapping.');
    }
    const staged = path.join(await importsStagingDir(), `${token}.csv`);
    const stagedStat = await fs.promises.stat(staged).catch(() => null);
    if (!stagedStat || !stagedStat.isFile()) {
      throw badRequest('That upload has expired. Please upload the file again.');
    }
    const mapped = Object.values(mapping);
    if (!mapped.includes('firstName')) {
      throw badRequest('Map one column to First Name.');
    }
    if (!mapped.includes('email') && !mapped.includes('phone')) {
      throw badRequest('Map a column to Email or Phone so leads can be de-duplicated.');
    }
    if (!['SKIP', 'IMPORT', 'UPDATE'].includes(duplicateHandling)) {
      throw badRequest('duplicateHandling must be SKIP, IMPORT or UPDATE');
    }

    const { records } = parseCsvObjects(await fs.promises.readFile(staged), 20000);

    const jobId = gvId();
    await dbExec(
      `INSERT INTO import_jobs (id, organization_id, entity, project_id, file_name, total_rows, status, mapping, errors, created_by_id, created_at)
       VALUES (?,?,'LEAD',?,?,?,'RUNNING',?,'[]',?,NOW())`,
      [jobId, orgId, importProjectId, body.fileName ?? 'import.csv', records.length, toJson(mapping), a.id]
    );

    const errors = [];
    let createdRows = 0;
    let updatedRows = 0;
    let duplicateRows = 0;

    for (const [index, record] of records.entries()) {
      const rowNumber = index + 2; // +1 for header, +1 for 1-based rows
      const input = { customFields: {} };
      for (const [column, target] of Object.entries(mapping)) {
        if (isEmpty(target)) {
          continue;
        }
        const value = phpTrim(Object.hasOwn(record, column) ? record[column] ?? '' : '');
        if (value === '') {
          continue;
        }
        const targetKey = str(target);
        if (targetKey.startsWith('customFields.')) {
          setOwn(input.customFields, targetKey.slice(13), value);
        } else if (targetKey === 'tags') {
          input.tags = value
            .split(';')
            .map((t) => phpTrim(t))
            .filter((t) => !isEmpty(t));
        } else {
          setOwn(input, targetKey, value);
        }
      }

      try {
        if (isEmpty(input.firstName)) {
          throw new Error('First name is empty');
        }
        if (isEmpty(input.email) && isEmpty(input.phone)) {
          throw new Error('Neither email nor phone is present');
        }
        if (isEmpty(input.sourceId) && !isEmpty(defaultSourceId)) {
          input.sourceId = defaultSourceId;
        }
        if (isEmpty(input.sourceId)) {
          input.sourceId = 'import';
        }

        const duplicates = await findDuplicates(orgId, input, null, 1);
        if (duplicates.length) {
          duplicateRows++;
          if (duplicateHandling === 'SKIP') {
            errors.push({ row: rowNumber, message: `Duplicate of ${duplicates[0].code}`, level: 'INFO' });
            continue;
          }
          if (duplicateHandling === 'UPDATE') {
            const patch = {};
            for (const [camel, col] of Object.entries({
              lastName: 'last_name', email: 'email', phone: 'phone', company: 'company', jobTitle: 'job_title',
              city: 'city', state: 'state', country: 'country', pincode: 'pincode', notes: 'notes',
            })) {
              if (!isEmpty(input[camel])) {
                patch[col] = input[camel];
              }
            }
            if (patch.email !== undefined) {
              patch.email_norm = normalizeEmail(patch.email);
            }
            if (patch.phone !== undefined) {
              patch.phone_norm = normalizePhone(patch.phone);
            }
            if (Object.keys(patch).length) {
              const sets = Object.keys(patch).map((k) => `\`${k}\` = ?`).join(', ');
              await dbExec(`UPDATE leads SET ${sets}, updated_at = NOW() WHERE id = ?`, [
                ...Object.values(patch),
                duplicates[0].id,
              ]);
            }
            updatedRows++;
            continue;
          }
        }

        // The run's project wins unless the file itself mapped one, so a
        // spreadsheet that does name a project per row is still honoured.
        if (isEmpty(input.projectId) && isEmpty(input.project)) {
          input.projectId = importProjectId;
        }

        await createLead(input, {
          organizationId: orgId,
          actor: a,
          origin: 'IMPORT',
          duplicatePolicy: 'ALLOW',
          skipAssignment: !runAssignment,
          ownerId: isEmpty(defaultOwnerId) ? null : defaultOwnerId,
        });
        createdRows++;
      } catch (err) {
        errors.push({ row: rowNumber, message: str(err?.message).slice(0, 200) || 'Unknown error', level: 'ERROR' });
      }
    }

    const errorRows = errors.filter((e) => e.level === 'ERROR').length;
    await dbExec(
      `UPDATE import_jobs SET status = 'COMPLETED', created_rows = ?, updated_rows = ?, duplicate_rows = ?, error_rows = ?, errors = ?, finished_at = NOW() WHERE id = ?`,
      [createdRows, updatedRows, duplicateRows, errorRows, toJson(errors.slice(0, 500)), jobId]
    );
    await fs.promises.unlink(staged).catch(() => {});

    const finished = await dbOne('SELECT * FROM import_jobs WHERE id = ?', [jobId]);
    await auditRecord(
      orgId,
      a,
      'lead.imported',
      {
        entityType: 'IMPORT_JOB',
        entityId: jobId,
        entityLabel: finished.file_name,
        changes: { createdRows, updatedRows, duplicateRows, errorRows },
      },
      req
    );
    await notifyUser(
      orgId,
      a.id,
      'IMPORT_COMPLETE',
      `Import finished: ${createdRows} lead(s) created`,
      `${duplicateRows} duplicate(s), ${errorRows} error(s)`,
      'IMPORT_JOB',
      jobId,
      '#/imports'
    );

    return jsonCreated(res, { ...importsShape(finished), errors: errors.slice(0, 100) });
  })
);

// ---------------------------------------------------------------------------
// GET /imports — job history
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('imports', 'read'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const { page, limit, offset } = parsePaging(req.query);
    const rows = await dbAll(
      `SELECT j.*, u.first_name AS cb_first_name, u.last_name AS cb_last_name
         FROM import_jobs j LEFT JOIN users u ON u.id = j.created_by_id WHERE j.organization_id = ? ORDER BY j.created_at DESC LIMIT ? OFFSET ?`,
      [orgId, limit, offset]
    );
    const total = Number.parseInt(String(await dbScalar('SELECT COUNT(*) FROM import_jobs WHERE organization_id = ?', [orgId])), 10) || 0;
    return jsonOk(res, rows.map(withCreatedBy), pageMeta(page, limit, total));
  })
);

// ---------------------------------------------------------------------------
// GET /imports/:id/errors.csv
// ---------------------------------------------------------------------------
router.get(
  '/:id/errors.csv',
  requirePermission('imports', 'read'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const job = await dbOne('SELECT * FROM import_jobs WHERE id = ? AND organization_id = ?', [req.params.id, orgId]);
    if (!job) {
      throw notFound('Import job not found');
    }
    const errors = safeJson(job.errors ?? '[]', []);
    const csv = toCsv(errors, [
      { key: 'row', label: 'Row' },
      { key: 'level', label: 'Level' },
      { key: 'message', label: 'Message' },
    ]);
    return sendCsv(res, `import-errors-${job.id}.csv`, csv);
  })
);

// ---------------------------------------------------------------------------
// GET /imports/:id
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  requirePermission('imports', 'read'),
  ah(async (req, res) => {
    const orgId = req.actor.organizationId;
    const job = await dbOne(
      `SELECT j.*, u.first_name AS cb_first_name, u.last_name AS cb_last_name
         FROM import_jobs j LEFT JOIN users u ON u.id = j.created_by_id WHERE j.id = ? AND j.organization_id = ?`,
      [req.params.id, orgId]
    );
    if (!job) {
      throw notFound('Import job not found');
    }
    return jsonOk(res, withCreatedBy(job));
  })
);

router.use((req, res, next) => next(notFound('Unknown imports route')));

export default router;
