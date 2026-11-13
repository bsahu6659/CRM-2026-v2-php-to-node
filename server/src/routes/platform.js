/**
 * /api/platform/* - the Super Admin surface (port of api/platform.php).
 *
 * Every route here is gated by requirePlatformAdmin(), which checks a column
 * on the user row, not a permission a tenant could grant itself. A tenant
 * admin who edits their own role to include `clients:read` still gets 403,
 * because the permission and the platform flag are independent gates.
 *
 * The one exception is GET /branding/:file, declared before that gate: a
 * company's logo has to load for its own staff, who are not platform
 * administrators. (app.js still requires a session for /api/platform, exactly
 * as PHP's front controller ran require_auth() before dispatching here.)
 *
 * Switching into a client writes sessions.active_organization_id; from that
 * point every ordinary route in the app reads and writes that tenant, because
 * lib/auth.js resolves actor.organizationId from the session.
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
import {
  BILLING_STATUSES,
  COMPANY_TYPES,
  deleteOrganization,
  isValidBillingStatus,
  isValidCompanyType,
  orgAccessDenial,
  orgBilling,
  orgBranding,
  orgUsesGlobalProjects,
  platformOrganizationId,
  requirePlatformAdmin,
  switchActiveTenant,
} from '../lib/tenancy.js';
import { camelize, gvBool, gvDiff, nowSql, round2, startOfDay, toSqlDate } from '../lib/util.js';
import { checkEmailConfiguration, checkWhatsappConfiguration } from '../services/comms.js';
import { provisionClient } from '../services/provisioning.js';

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

const count = async (sql, params = []) => toInt(await dbScalar(sql, params));

/** date('Y-m-01 00:00:00') */
const startOfMonth = () => `${toSqlDate(new Date()).slice(0, 7)}-01 00:00:00`;

// ---------------------------------------------------------------------------
// Image checks. PHP asked libmagic (finfo) for the real type and
// getimagesize() whether a raster decodes; Node has neither built in, so the
// formats a logo may be are recognised by their own headers here.
// ---------------------------------------------------------------------------
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const LEADING_BOM = new RegExp('^' + String.fromCharCode(0xfeff));

function looksLikeSvg(buf) {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4096)).replace(LEADING_BOM, '').trimStart();
  return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE\s+svg[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head);
}

function sniffImageMime(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (looksLikeSvg(buf)) return 'image/svg+xml';
  return 'application/octet-stream';
}

/** The getimagesize() test: the header carries real dimensions. */
function isReadableImage(buf, mime) {
  if (mime === 'image/png') {
    return buf.length >= 24 && buf.toString('latin1', 12, 16) === 'IHDR';
  }
  if (mime === 'image/webp') {
    return buf.length >= 30 && ['VP8 ', 'VP8L', 'VP8X'].includes(buf.toString('latin1', 12, 16));
  }
  if (mime === 'image/jpeg') {
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

/** $_FILES['file']: any failed upload got the same answer from PHP, except size. */
const receiveLogo = (req, res, next) => {
  uploadSingle('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(badRequest('That image is larger than the upload limit.'));
    return next(badRequest('Choose a logo image to upload.'));
  });
};

// ---------------------------------------------------------------------------
// GET /platform/branding/:file — branding images, served BEFORE the platform
// guard below.
//
// A company logo appears in that company's own sidebar and on its sign-in
// screen - so the people who need to load it are its ordinary users. Behind
// requirePlatformAdmin() every one of them received an error and a broken
// image; only the platform owner ever saw the logo they had uploaded.
//
// Safe to serve: the request is reduced to a basename inside the upload
// directory, must begin with `logo-`, and the stored name carries 12 random hex
// characters, so nothing else in that directory is reachable or guessable
// through this route.
// ---------------------------------------------------------------------------
router.get(
  '/branding/:file',
  ah(async (req, res) => {
    const name = path.basename(req.params.file);
    const filePath = path.join(config.uploads.dir, name);
    let bytes = null;
    if (name.startsWith('logo-')) {
      try {
        if ((await fs.promises.stat(filePath)).isFile()) bytes = await fs.promises.readFile(filePath);
      } catch {
        bytes = null;
      }
    }
    if (!bytes) {
      throw notFound('Image not found.');
    }
    const mime = sniffImageMime(bytes) || 'application/octet-stream';
    // Only ever hand back an image, whatever the bytes turn out to be.
    if (!mime.startsWith('image/')) {
      throw notFound('Image not found.');
    }
    res.set('Content-Type', mime);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.set('Cache-Control', 'public, max-age=3600');
    return res.end(bytes);
  })
);

// Everything below is platform-admin only, including the unknown-route 404.
router.use((req, res, next) => {
  try {
    requirePlatformAdmin(req);
    next();
  } catch (err) {
    next(err);
  }
});

/** Aggregate counters for one client, used by the list and the detail page. */
async function platformClientStats(orgId) {
  return {
    users: await count('SELECT COUNT(*) FROM users WHERE organization_id = ? AND is_active = 1', [orgId]),
    teams: await count('SELECT COUNT(*) FROM teams WHERE organization_id = ?', [orgId]),
    projects: await count('SELECT COUNT(*) FROM projects WHERE organization_id = ? AND is_archived = 0', [orgId]),
    leads: await count('SELECT COUNT(*) FROM leads WHERE organization_id = ? AND is_duplicate = 0', [orgId]),
    leadsToday: await count(
      'SELECT COUNT(*) FROM leads WHERE organization_id = ? AND is_duplicate = 0 AND created_at >= ?',
      [orgId, startOfDay()]
    ),
    leadsThisMonth: await count(
      'SELECT COUNT(*) FROM leads WHERE organization_id = ? AND is_duplicate = 0 AND created_at >= ?',
      [orgId, startOfMonth()]
    ),
  };
}

async function platformClientShape(org, withStats = true) {
  const out = camelize(org);
  delete out.settings;
  out.branding = orgBranding(org);
  out.billing = orgBilling(org);
  out.accessDenial = orgAccessDenial(org);
  out.usesGlobalProjects = orgUsesGlobalProjects(String(org.company_type));
  if (withStats) {
    out.stats = await platformClientStats(org.id);
    // The Super Admin overview in spec section 39 needs both channels at a
    // glance, so the verdict travels with the client row. It is nested
    // under `messaging` because `email` at the top level is the company's
    // own email address.
    out.messaging = {
      whatsapp: { status: (await checkWhatsappConfiguration(org.id)).status },
      email: { status: (await checkEmailConfiguration(org.id)).status },
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// GET /platform/overview
// ---------------------------------------------------------------------------
router.get(
  '/overview',
  requirePermission('clients', 'read'),
  ah(async (req, res) => {
    const byType = await dbAll(
      'SELECT company_type, COUNT(*) AS total FROM organizations WHERE is_platform = 0 GROUP BY company_type'
    );
    const typeCounts = {};
    for (const t of COMPANY_TYPES) {
      typeCounts[t.key] = 0;
    }
    for (const r of byType) {
      typeCounts[r.company_type] = toInt(r.total);
    }

    return jsonOk(res, {
      clients: {
        total: await count('SELECT COUNT(*) FROM organizations WHERE is_platform = 0'),
        active: await count("SELECT COUNT(*) FROM organizations WHERE is_platform = 0 AND status = 'ACTIVE'"),
        inactive: await count("SELECT COUNT(*) FROM organizations WHERE is_platform = 0 AND status = 'INACTIVE'"),
        suspended: await count("SELECT COUNT(*) FROM organizations WHERE is_platform = 0 AND status = 'SUSPENDED'"),
        byType: typeCounts,
        blocked: await count('SELECT COUNT(*) FROM organizations WHERE is_platform = 0 AND access_blocked = 1'),
        overdue: await count("SELECT COUNT(*) FROM organizations WHERE is_platform = 0 AND billing_status = 'PAST_DUE'"),
      },
      projects: {
        total: await count('SELECT COUNT(*) FROM projects WHERE is_archived = 0'),
        global: await count("SELECT COUNT(*) FROM projects WHERE visibility = 'GLOBAL' AND is_archived = 0"),
        shared: await count("SELECT COUNT(*) FROM projects WHERE visibility = 'SELECTED' AND is_archived = 0"),
      },
      leads: {
        total: await count('SELECT COUNT(*) FROM leads WHERE is_duplicate = 0'),
        today: await count('SELECT COUNT(*) FROM leads WHERE is_duplicate = 0 AND created_at >= ?', [startOfDay()]),
        thisMonth: await count('SELECT COUNT(*) FROM leads WHERE is_duplicate = 0 AND created_at >= ?', [startOfMonth()]),
      },
      users: await count('SELECT COUNT(*) FROM users WHERE is_active = 1'),
      leadsByClient: camelize(
        await dbAll(
          `SELECT organizations.id, organizations.name, organizations.company_type, COUNT(leads.id) AS total
             FROM organizations LEFT JOIN leads ON leads.organization_id = organizations.id AND leads.is_duplicate = 0
            WHERE organizations.is_platform = 0
            GROUP BY organizations.id, organizations.name, organizations.company_type
            ORDER BY total DESC LIMIT 12`
        )
      ),
      leadsBySource: camelize(
        await dbAll(
          `SELECT lead_sources.name, COUNT(leads.id) AS total
             FROM leads JOIN lead_sources ON lead_sources.id = leads.source_id
            WHERE leads.is_duplicate = 0
            GROUP BY lead_sources.name ORDER BY total DESC LIMIT 12`
        )
      ),
      leadsByProject: camelize(
        await dbAll(
          `SELECT projects.name, COUNT(leads.id) AS total
             FROM leads JOIN projects ON projects.id = leads.project_id
            WHERE leads.is_duplicate = 0
            GROUP BY projects.name ORDER BY total DESC LIMIT 12`
        )
      ),
    });
  })
);

// ---------------------------------------------------------------------------
// GET /platform/automation — spec section 39: which clients have not finished
// their messaging setup.
// ---------------------------------------------------------------------------
router.get(
  '/automation',
  requirePermission('clients', 'read'),
  ah(async (req, res) => {
    const orgs = await dbAll('SELECT id, name, company_type, status FROM organizations WHERE is_platform = 0 ORDER BY name ASC');
    const out = [];
    for (const o of orgs) {
      out.push({
        id: o.id,
        name: o.name,
        companyType: o.company_type,
        status: o.status,
        whatsapp: await checkWhatsappConfiguration(o.id),
        email: await checkEmailConfiguration(o.id),
      });
    }
    return jsonOk(res, out);
  })
);

// ---------------------------------------------------------------------------
// GET /platform/billing
// ---------------------------------------------------------------------------
router.get(
  '/billing',
  requirePermission('clients', 'read'),
  ah(async (req, res) => {
    const orgs = await dbAll('SELECT * FROM organizations WHERE is_platform = 0 ORDER BY name ASC');
    const rows = [];
    for (const o of orgs) {
      rows.push({
        id: o.id,
        name: o.name,
        companyType: o.company_type,
        status: o.status,
        billing: orgBilling(o),
        users: await count('SELECT COUNT(*) FROM users WHERE organization_id = ? AND is_active = 1', [o.id]),
      });
    }
    return jsonOk(res, {
      statuses: BILLING_STATUSES,
      clients: rows,
      summary: {
        blocked: rows.filter((r) => r.billing.accessBlocked).length,
        overdue: rows.filter((r) => r.billing.overdue).length,
        trial: rows.filter((r) => r.billing.status === 'TRIAL').length,
        mrr: round2(
          rows.reduce((sum, r) => sum + (r.billing.status === 'ACTIVE' ? Number(r.billing.monthlyFee ?? 0) || 0 : 0), 0)
        ),
      },
    });
  })
);

// ---------------------------------------------------------------------------
// GET /platform/company-types
// ---------------------------------------------------------------------------
router.get('/company-types', (req, res) => jsonOk(res, COMPANY_TYPES));

// ---------------------------------------------------------------------------
// GET /platform/clients
// ---------------------------------------------------------------------------
router.get(
  '/clients',
  requirePermission('clients', 'read'),
  ah(async (req, res) => {
    const query = req.query;
    const where = ['organizations.is_platform = 0'];
    const params = [];
    if (!isEmpty(query.q)) {
      where.push('(organizations.name LIKE ? OR organizations.email LIKE ? OR organizations.slug LIKE ?)');
      const like = `%${query.q}%`;
      params.push(like, like, like);
    }
    for (const [q, col] of [['companyType', 'company_type'], ['status', 'status']]) {
      if (!isEmpty(query[q])) {
        where.push(`organizations.${col} = ?`);
        params.push(query[q]);
      }
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const { page, limit, offset } = parsePaging(query);
    const total = await count(`SELECT COUNT(*) FROM organizations ${whereSql}`, params);
    const rows = await dbAll(`SELECT * FROM organizations ${whereSql} ORDER BY name ASC LIMIT ${limit} OFFSET ${offset}`, params);
    const data = [];
    for (const o of rows) data.push(await platformClientShape(o));
    return jsonOk(res, data, pageMeta(page, limit, total));
  })
);

// ---------------------------------------------------------------------------
// POST /platform/clients — one-click client onboarding.
// ---------------------------------------------------------------------------
router.post(
  '/clients',
  requirePermission('clients', 'create'),
  ah(async (req, res) => {
    const result = await provisionClient(req.body ?? {}, req.actor, req);
    const org = await dbOne('SELECT * FROM organizations WHERE id = ?', [result.organizationId]);
    return jsonCreated(res, { ...(await platformClientShape(org)), adminUserId: result.adminUserId });
  })
);

// ---------------------------------------------------------------------------
// GET /platform/clients/:clientId/(users|teams|projects|leads) — read-only
// windows into a client, for support without switching context.
// ---------------------------------------------------------------------------
router.get(
  '/clients/:clientId/:view(users|teams|projects|leads)',
  requirePermission('clients', 'read'),
  ah(async (req, res) => {
    const sub = req.params.clientId;
    const subId = req.params.view;
    if (!(await dbScalar('SELECT id FROM organizations WHERE id = ?', [sub]))) {
      throw notFound('Client not found.');
    }
    const { page, limit, offset } = parsePaging(req.query);

    let total;
    let rows;
    if (subId === 'users') {
      total = await count('SELECT COUNT(*) FROM users WHERE organization_id = ?', [sub]);
      rows = await dbAll(
        `SELECT users.id, users.first_name, users.last_name, users.email, users.phone, users.designation,
                users.is_active, users.last_login_at, roles.name AS role_name, teams.name AS team_name
           FROM users
           LEFT JOIN roles ON roles.id = users.role_id
           LEFT JOIN team_members ON team_members.user_id = users.id
           LEFT JOIN teams ON teams.id = team_members.team_id
          WHERE users.organization_id = ? ORDER BY users.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
        [sub]
      );
    } else if (subId === 'teams') {
      total = await count('SELECT COUNT(*) FROM teams WHERE organization_id = ?', [sub]);
      rows = await dbAll(
        `SELECT teams.*, COUNT(team_members.user_id) AS member_count
           FROM teams LEFT JOIN team_members ON team_members.team_id = teams.id
          WHERE teams.organization_id = ?
          GROUP BY teams.id ORDER BY teams.name ASC LIMIT ${limit} OFFSET ${offset}`,
        [sub]
      );
    } else if (subId === 'projects') {
      total = await count('SELECT COUNT(*) FROM projects WHERE organization_id = ?', [sub]);
      rows = await dbAll(
        `SELECT * FROM projects WHERE organization_id = ? ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
        [sub]
      );
    } else {
      total = await count('SELECT COUNT(*) FROM leads WHERE organization_id = ? AND is_duplicate = 0', [sub]);
      rows = await dbAll(
        `SELECT leads.id, leads.code, leads.first_name, leads.last_name, leads.phone, leads.email, leads.created_at,
                lead_statuses.name AS status_name, projects.name AS project_name, lead_sources.name AS source_name,
                owner.first_name AS owner_first_name, owner.last_name AS owner_last_name
           FROM leads
           LEFT JOIN lead_statuses ON lead_statuses.id = leads.status_id
           LEFT JOIN projects ON projects.id = leads.project_id
           LEFT JOIN lead_sources ON lead_sources.id = leads.source_id
           LEFT JOIN users owner ON owner.id = leads.owner_id
          WHERE leads.organization_id = ? AND leads.is_duplicate = 0
          ORDER BY leads.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
        [sub]
      );
    }
    return jsonOk(res, camelize(rows), pageMeta(page, limit, total));
  })
);

// ---------------------------------------------------------------------------
// GET /platform/clients/:clientId
// ---------------------------------------------------------------------------
router.get(
  '/clients/:clientId',
  requirePermission('clients', 'read'),
  ah(async (req, res) => {
    const sub = req.params.clientId;
    const org = await dbOne('SELECT * FROM organizations WHERE id = ? AND is_platform = 0', [sub]);
    if (!org) throw notFound('Client not found.');

    const payload = await platformClientShape(org);
    payload.admins = camelize(
      await dbAll(
        `SELECT users.id, users.first_name, users.last_name, users.email, users.phone, users.is_active, users.last_login_at, roles.name AS role_name
           FROM users JOIN roles ON roles.id = users.role_id
          WHERE users.organization_id = ? AND roles.\`key\` IN ('admin','super_admin')
          ORDER BY users.created_at ASC`,
        [sub]
      )
    );
    payload.messaging = {
      whatsapp: await checkWhatsappConfiguration(sub),
      email: await checkEmailConfiguration(sub),
    };
    return jsonOk(res, payload);
  })
);

// ---------------------------------------------------------------------------
// PATCH /platform/clients/:clientId
// ---------------------------------------------------------------------------
router.patch(
  '/clients/:clientId',
  requirePermission('clients', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const sub = req.params.clientId;
    const body = req.body ?? {};
    const org = await dbOne('SELECT * FROM organizations WHERE id = ? AND is_platform = 0', [sub]);
    if (!org) throw notFound('Client not found.');

    const map = {
      name: 'name', legalName: 'legal_name', companyType: 'company_type',
      website: 'website', email: 'email', phone: 'phone', address: 'address',
      city: 'city', state: 'state', country: 'country', pincode: 'pincode',
      logoUrl: 'logo_url', faviconUrl: 'favicon_url', brandPrimary: 'brand_primary',
      brandAccent: 'brand_accent', loginHeadline: 'login_headline',
      currency: 'currency', timezone: 'timezone',
      planName: 'plan_name', seats: 'seats', monthlyFee: 'monthly_fee',
      trialEndsAt: 'trial_ends_at', renewsAt: 'renews_at',
      lastPaymentAt: 'last_payment_at', billingNotes: 'billing_notes',
    };
    const data = {};
    for (const [camel, col] of Object.entries(map)) {
      if (has(body, camel)) {
        data[col] = body[camel] === '' ? null : body[camel];
      }
    }
    if (data.company_type !== undefined && data.company_type !== null && !isValidCompanyType(String(data.company_type))) {
      throw badRequest('Choose a valid company type.');
    }
    if (has(body, 'billingStatus')) {
      const billing = String(body.billingStatus ?? '').toUpperCase();
      if (!isValidBillingStatus(billing)) {
        throw badRequest('Choose a valid billing status.');
      }
      data.billing_status = billing;
    }

    // Lifecycle is expressed as one status plus the legacy is_active flag, kept
    // in step because loadActor() refuses a session in an inactive org.
    if (has(body, 'status')) {
      const status = String(body.status ?? '').toUpperCase();
      if (!['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(status)) {
        throw badRequest('Status must be ACTIVE, INACTIVE or SUSPENDED.');
      }
      data.status = status;
      data.is_active = status === 'ACTIVE' ? 1 : 0;
      data.suspended_at = status === 'SUSPENDED' ? nowSql() : null;
      data.suspend_reason = status === 'SUSPENDED' ? body.suspendReason ?? null : null;
    }

    const keys = Object.keys(data);
    if (keys.length) {
      const set = keys.map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE organizations SET ${set}, updated_at = NOW() WHERE id = ?`, [...Object.values(data), sub]);
    }

    const after = await dbOne('SELECT * FROM organizations WHERE id = ?', [sub]);
    await auditRecord(
      sub,
      a,
      'client.updated',
      {
        entityType: 'ORGANIZATION',
        entityId: sub,
        entityLabel: after.name,
        changes: gvDiff(org, after, keys),
      },
      req
    );
    return jsonOk(res, await platformClientShape(after));
  })
);

// ---------------------------------------------------------------------------
// POST /platform/clients/:clientId/access — turning off sign-in for a company
// that has not paid, and turning it back on. Separate from suspension: this is
// a billing lever, it is reversible in one click, and it says why on the
// sign-in screen so the customer knows who to call rather than filing a bug.
// ---------------------------------------------------------------------------
router.post(
  '/clients/:clientId/access',
  requirePermission('clients', 'update'),
  ah(async (req, res) => {
    const a = req.actor;
    const sub = req.params.clientId;
    const body = req.body ?? {};
    const org = await dbOne('SELECT * FROM organizations WHERE id = ? AND is_platform = 0', [sub]);
    if (!org) throw notFound('Client not found.');

    const blocked = gvBool(body.blocked ?? false);
    let reason = String(body.reason ?? '').trim();
    if (blocked && reason === '') {
      reason = 'Subscription payment outstanding.';
    }

    await dbExec(
      `UPDATE organizations
          SET access_blocked = ?, access_blocked_at = ?, access_blocked_reason = ?, updated_at = NOW()
        WHERE id = ?`,
      [blocked ? 1 : 0, blocked ? nowSql() : null, blocked ? reason.slice(0, 300) : null, sub]
    );

    // Blocking ends every open session immediately, so the lockout is real
    // rather than taking effect whenever people next happen to sign out.
    let endedSessions = 0;
    if (blocked) {
      endedSessions = await dbExec(
        `UPDATE sessions SET revoked_at = NOW()
          WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE organization_id = ?)`,
        [sub]
      );
    }

    await auditRecord(
      sub,
      a,
      blocked ? 'client.access_blocked' : 'client.access_restored',
      {
        entityType: 'ORGANIZATION',
        entityId: sub,
        entityLabel: org.name,
        changes: { reason: blocked ? reason : null, sessionsEnded: endedSessions },
      },
      req
    );

    const after = await dbOne('SELECT * FROM organizations WHERE id = ?', [sub]);
    return jsonOk(res, { ...(await platformClientShape(after)), sessionsEnded: endedSessions });
  })
);

// ---------------------------------------------------------------------------
// POST /platform/clients/:clientId/logo — multipart field `file`.
// ---------------------------------------------------------------------------
router.post(
  '/clients/:clientId/logo',
  requirePermission('clients', 'update'),
  receiveLogo,
  ah(async (req, res) => {
    const a = req.actor;
    const sub = req.params.clientId;
    const org = await dbOne('SELECT * FROM organizations WHERE id = ?', [sub]);
    if (!org) throw notFound('Client not found.');

    const file = req.file;
    if (!file) {
      throw badRequest('Choose a logo image to upload.');
    }
    if (file.size > config.uploads.maxBytes) {
      throw badRequest('That image is larger than the upload limit.');
    }
    const mime = sniffImageMime(file.buffer);
    const exts = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
    if (!has(exts, mime)) {
      throw badRequest('Logos must be PNG, JPG, WEBP or SVG.');
    }
    // SVG can carry script, so it is never re-served inline from our origin
    // without a sniff guard; raster types additionally have to decode.
    if (mime !== 'image/svg+xml' && !isReadableImage(file.buffer, mime)) {
      throw badRequest('That file is not a readable image.');
    }

    const uploadDir = config.uploads.dir;
    const storedName = `logo-${sub}-${crypto.randomBytes(6).toString('hex')}.${exts[mime]}`;
    try {
      await fs.promises.mkdir(uploadDir, { recursive: true, mode: 0o755 });
      await fs.promises.writeFile(path.join(uploadDir, storedName), file.buffer);
    } catch {
      throw badRequest('The logo could not be saved.');
    }
    // Served back through the API: the uploads directory is not public.
    const url = `/api/platform/branding/${encodeURIComponent(storedName)}`;
    await dbExec('UPDATE organizations SET logo_url = ?, updated_at = NOW() WHERE id = ?', [url, sub]);

    await auditRecord(
      sub,
      a,
      'client.branding_changed',
      { entityType: 'ORGANIZATION', entityId: sub, entityLabel: org.name, changes: { logoUrl: url } },
      req
    );
    return jsonOk(res, { logoUrl: url });
  })
);

// ---------------------------------------------------------------------------
// DELETE /platform/clients/:clientId
// ---------------------------------------------------------------------------
router.delete(
  '/clients/:clientId',
  requirePermission('clients', 'delete'),
  ah(async (req, res) => {
    const a = req.actor;
    const sub = req.params.clientId;
    const body = req.body ?? {};
    const org = await dbOne('SELECT * FROM organizations WHERE id = ? AND is_platform = 0', [sub]);
    if (!org) throw notFound('Client not found.');
    // Deleting a tenant cascades through every table that references it. That
    // is destructive and unrecoverable, so it needs the company name typed back.
    if ((body.confirmName ?? null) !== org.name) {
      throw badRequest('Type the company name exactly to confirm deletion.');
    }
    const stats = await platformClientStats(sub);
    await deleteOrganization(sub);
    await auditRecord(
      (await platformOrganizationId()) ?? sub,
      a,
      'client.deleted',
      { entityType: 'ORGANIZATION', entityId: sub, entityLabel: org.name, changes: stats },
      req
    );
    return jsonOk(res, { deleted: true, removed: stats });
  })
);

// ---------------------------------------------------------------------------
// POST /platform/switch — enter a client's CRM, or leave it.
// ---------------------------------------------------------------------------
router.post(
  '/switch',
  requirePermission('clients', 'impersonate'),
  ah(async (req, res) => {
    const a = req.actor;
    const body = req.body ?? {};
    const target = body.organizationId ?? null;

    if (target === null || target === '') {
      await switchActiveTenant(req.session.id, null);
      await auditRecord(
        (await platformOrganizationId()) ?? a.homeOrganizationId,
        a,
        'platform.context_exited',
        { entityType: 'ORGANIZATION', changes: [] },
        req
      );
      // The PHP edition returned here without writing a body, so leaving a
      // client answers 200 with an empty body; the client ignores it and
      // reloads the session either way.
      return res.status(200).end();
    }

    const org = await dbOne('SELECT * FROM organizations WHERE id = ?', [target]);
    if (!org) throw notFound('Client not found.');
    if (!gvBool(org.is_active)) {
      throw badRequest('That company is suspended. Reactivate it before opening its CRM.');
    }
    await switchActiveTenant(req.session.id, target);

    // Entering a client's data is exactly the kind of thing an audit trail
    // exists for, so it is logged in that client's own log.
    await auditRecord(
      target,
      a,
      'platform.context_entered',
      { entityType: 'ORGANIZATION', entityId: target, entityLabel: org.name, changes: [] },
      req
    );
    return jsonOk(res, { organizationId: target, name: org.name, branding: orgBranding(org) });
  })
);

router.use((req, res, next) => next(notFound('Unknown platform route.')));

export default router;
