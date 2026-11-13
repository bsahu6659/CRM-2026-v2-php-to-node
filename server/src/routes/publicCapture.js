/**
 * Public lead capture — port of api/publicCapture.php: the hosted form page,
 * the embeddable script, and the submit endpoint they both post to.
 *
 * These routes are deliberately unauthenticated — they are the front door for
 * website traffic. Protection comes from: a per-form origin allow-list, a
 * per-IP rate limit, a honeypot field, and the fact that a submission can only
 * ever write the lead columns a form has explicitly mapped (FORMS_MAPPABLE).
 *
 * app.js mounts this router at /api/public ahead of the global cors(), cookie
 * parser and securityHeaders, because the CORS answer here depends on which
 * form is being posted to. Everything those middlewares would have done is
 * therefore done in this file: the security headers PHP's index.php sent on
 * every API response, and the per-form allow-list in place of the global one.
 * app.js also rewrites the short URLs onto this router:
 *
 *   /f/:key        -> /hosted/:key   (req.gvEmbeddable = true)
 *   /embed/:key.js -> /embed/:key    (req.gvEmbeddable = true)
 */

import express from 'express';
import multer from 'multer';
import config from '../config/index.js';
import { dbAll, dbExec, dbOne } from '../lib/db.js';
import { AppError, notFound } from '../lib/errors.js';
import { jsonError, jsonOk } from '../lib/response.js';
import { ah } from '../middleware/index.js';
import { clientIp, userAgent } from '../lib/auth.js';
import { rateLimitCapture } from '../lib/rateLimit.js';
import { gvBool, gvId, safeJson, toJson } from '../lib/util.js';
import { createLead } from '../services/leadService.js';
import { FORMS_MAPPABLE } from './formsShared.js';

const router = express.Router();

// U+2028 / U+2029, built from char codes so neither raw character sits in this file.
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g');

// ---------------------------------------------------------------------------
// PHP semantics the capture logic depends on
// ---------------------------------------------------------------------------

/** PHP's empty(): "0", an empty list and an empty object are all empty. */
function isEmpty(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '' || value === '0') {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

const truthy = (value) => !isEmpty(value);

/** PHP's trim() strips exactly these characters, not every Unicode space. */
function phpTrim(value) {
  return String(value).replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

/** Own-property read: a field keyed `constructor` must not hit Object.prototype. */
function own(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** A decoded JSON list or map, as the list PHP's foreach would walk. */
function asList(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return Object.values(value);
  return [];
}

/** The scheme and host PHP's parse_url() would report (no port). */
function parseUrlParts(url) {
  const s = String(url);
  let m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)/.exec(s);
  if (m) return { scheme: m[1], host: m[2] === '' ? null : m[2] };
  m = /^\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)/.exec(s);
  if (m) return { scheme: null, host: m[1] === '' ? null : m[1] };
  // parse_url() reads a bare "host:port" as a host, not as a scheme.
  m = /^([^/?#:@]+):(\d+)(?:[/?#]|$)/.exec(s);
  if (m) return { scheme: null, host: m[1] };
  m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(s);
  if (m) return { scheme: m[1], host: null };
  return { scheme: null, host: null };
}

/** htmlspecialchars($v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'). */
function captureEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---------------------------------------------------------------------------
// Headers and body parsing for the whole public surface
// ---------------------------------------------------------------------------

/**
 * The baseline PHP's front controller sent on every API response. The short
 * public URLs skip X-Frame-Options, as .htaccess did for GV_EMBEDDABLE: the
 * hosted page is meant to be iframed, and its own CSP governs that.
 */
router.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  if (!req.gvEmbeddable) res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Content-Security-Policy', "default-src 'none'");
  next();
});

/**
 * PHP read a submission from the JSON body, falling back to $_POST — which
 * also covers multipart posts such as `fetch(url, { body: new FormData(form) })`.
 * Any file parts are drained and dropped, as PHP ignored $_FILES here; a
 * multipart error simply leaves the fields read so far, the way $_POST did.
 */
const discardFiles = {
  _handleFile(req, file, cb) {
    file.stream.on('error', cb);
    file.stream.on('end', () => cb(null, {}));
    file.stream.resume();
  },
  _removeFile(req, file, cb) {
    cb(null);
  },
};
const multipartFields = multer({ storage: discardFiles, limits: { fileSize: config.uploads.maxBytes } }).any();

router.use((req, res, next) => {
  if (!req.is('multipart/form-data')) return next();
  multipartFields(req, res, () => {
    req.files = undefined;
    next();
  });
});

/**
 * request_body() json-decoded the raw body whatever its Content-Type, so a
 * page posting JSON as text/plain (the no-preflight trick) was accepted.
 * app.js has already parsed JSON and urlencoded bodies; whatever is left
 * unread is decoded here the same way, and anything that is not a JSON object
 * or list becomes an empty body, as PHP's [] did.
 */
router.use(express.text({ type: (req) => !req.is('multipart/form-data'), limit: '2mb' }), (req, res, next) => {
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
// Helpers
// ---------------------------------------------------------------------------

async function captureLoadActiveForm(publicKey) {
  const form = await dbOne(
    `SELECT f.*, o.name AS org_name, o.is_active AS org_is_active, o.logo_url AS org_logo_url
     FROM web_forms f JOIN organizations o ON o.id = f.organization_id WHERE f.public_key = ?`,
    [publicKey]
  );
  if (!form || !gvBool(form.is_active) || !gvBool(form.org_is_active)) {
    throw notFound('This form is no longer available.');
  }
  return form;
}

/** Applies the form's origin allow-list. An empty list means "any origin". */
function captureOriginAllowed(form, origin) {
  const list = String(form.allowed_origins ?? '')
    .split(',')
    .map(phpTrim)
    .filter((s) => s !== '' && s !== '0');
  if (!list.length) {
    return true;
  }
  if (isEmpty(origin)) {
    return false;
  }
  const o = parseUrlParts(origin);
  const originHost = `${o.scheme ?? ''}://${o.host ?? ''}`;
  for (const allowed of list) {
    if (allowed === '*') {
      return true;
    }
    const allowedParts = parseUrlParts(allowed);
    if (!isEmpty(allowedParts.host)) {
      if (`${allowedParts.scheme ?? 'https'}://${allowedParts.host}` === originHost) {
        return true;
      }
    } else if (allowed === origin) {
      return true;
    }
  }
  return false;
}

function captureApplyCors(req, res, form) {
  const origin = req.headers.origin ?? null;
  if (captureOriginAllowed(form, origin)) {
    res.set('Access-Control-Allow-Origin', truthy(origin) ? origin : '*');
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'content-type');
}

async function captureRecordSubmission(req, form, payload, status, message, leadId = null) {
  await dbExec(
    `INSERT INTO form_submissions (id, form_id, organization_id, payload, lead_id, status, message, ip, user_agent, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
    [
      gvId(),
      form.id,
      form.organization_id,
      toJson(payload),
      leadId,
      status,
      truthy(message) ? String(message).slice(0, 300) : null,
      clientIp(req),
      userAgent(req),
    ]
  );
}

// ---------------------------------------------------------------------------
// GET /public/demo-accounts — demo accounts for the sign-in page.
//
// Read live rather than hard-coded, because a hard-coded list drifts the moment
// the seed changes and then offers accounts that do not exist. Refuses outright
// outside a local/dev environment: this lists real email addresses, and it must
// never be reachable on a production install.
// ---------------------------------------------------------------------------
router.get(
  '/demo-accounts',
  ah(async (req, res) => {
    // Fail closed: only an explicitly local/development install exposes this.
    // An unset or unrecognised APP_ENV is treated as production.
    if (!['local', 'development'].includes(String(config.env))) {
      throw notFound('Not available.');
    }
    const rows = await dbAll(
      `SELECT users.email, roles.name AS role_name, roles.level,
              organizations.name AS org_name, organizations.company_type, organizations.is_platform,
              users.is_platform_admin
         FROM users
         JOIN roles ON roles.id = users.role_id
         JOIN organizations ON organizations.id = users.organization_id
        WHERE users.is_active = 1
        ORDER BY users.is_platform_admin DESC, organizations.is_platform DESC,
                 organizations.name ASC, roles.level ASC
        LIMIT 30`
    );
    return jsonOk(
      res,
      rows.map((r) => ({
        email: r.email,
        role: gvBool(r.is_platform_admin) ? 'Platform Super Admin' : r.role_name,
        company: r.org_name,
        companyType: gvBool(r.is_platform) ? 'PLATFORM' : r.company_type,
      }))
    );
  })
);

// ---------------------------------------------------------------------------
// GET /public/forms/:publicKey — form definition (used by the embed script)
// ---------------------------------------------------------------------------
router.get(
  '/forms/:publicKey',
  ah(async (req, res) => {
    const form = await captureLoadActiveForm(req.params.publicKey);
    captureApplyCors(req, res, form);
    const fields = asList(safeJson(form.fields ?? '[]', [])).filter(
      (f) => isEmpty(own(f, 'hidden')) || !isEmpty(own(f, 'defaultValue'))
    );
    return jsonOk(res, {
      name: form.name,
      description: form.description,
      fields,
      submitLabel: form.submit_label,
      successMessage: form.success_message,
      redirectUrl: form.redirect_url,
      organization: form.org_name,
    });
  })
);

// ---------------------------------------------------------------------------
// OPTIONS /public/forms/:publicKey/submit — the preflight carries the form's
// own origin allow-list, not a blanket 204.
// ---------------------------------------------------------------------------
router.options(
  '/forms/:publicKey/submit',
  ah(async (req, res) => {
    const form = await captureLoadActiveForm(req.params.publicKey);
    captureApplyCors(req, res, form);
    return res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /public/forms/:publicKey/submit — submission
// ---------------------------------------------------------------------------
router.post(
  '/forms/:publicKey/submit',
  ah(async (req, res) => {
    await rateLimitCapture(req);
    const form = await captureLoadActiveForm(req.params.publicKey);
    captureApplyCors(req, res, form);

    const origin = req.headers.origin ?? req.headers.referer ?? null;
    if (!captureOriginAllowed(form, origin)) {
      return jsonError(res, 403, 'ORIGIN_NOT_ALLOWED', 'This form is not enabled for that website.');
    }

    // Accept JSON (embed script / fetch) and classic form posts alike; both
    // have been parsed onto req.body by the time the handler runs.
    const body = req.body !== null && typeof req.body === 'object' ? req.body : {};

    // Honeypot: real users never fill a hidden field. Answer 200 so bots learn nothing.
    if (!isEmpty(own(body, '_gv_hp'))) {
      await captureRecordSubmission(req, form, body, 'REJECTED', 'Honeypot triggered');
      return jsonOk(res, { received: true, message: form.success_message });
    }

    const definitions = asList(safeJson(form.fields ?? '[]', []));
    const leadInput = { customFields: {} };
    const errors = [];

    for (const field of definitions) {
      const fieldKey = own(field, 'key');
      const raw = own(body, fieldKey) ?? own(field, 'defaultValue') ?? '';
      const value = typeof raw === 'string' ? phpTrim(raw) : raw;
      if (!isEmpty(own(field, 'required')) && (value === '' || value === null)) {
        errors.push({ field: fieldKey ?? null, message: `${own(field, 'label') ?? ''} is required` });
        continue;
      }
      if (value === '' || value === null) {
        continue;
      }
      const mapTo = own(field, 'mapTo');
      if (!isEmpty(mapTo) && FORMS_MAPPABLE.includes(mapTo)) {
        leadInput[mapTo] = value;
      } else {
        leadInput.customFields[fieldKey] = value;
      }
    }
    if (errors.length) {
      return jsonError(res, 422, 'VALIDATION_ERROR', 'Please check the form', errors);
    }

    // Tracking parameters the page passes through, plus what we can observe.
    for (const key of ['utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent', 'gclid', 'fbclid', 'landingPage']) {
      if (isEmpty(leadInput[key]) && !isEmpty(own(body, key))) {
        leadInput[key] = String(own(body, key)).slice(0, 400);
      }
    }
    if (isEmpty(leadInput.landingPage) && truthy(origin)) {
      leadInput.landingPage = String(origin).slice(0, 400);
    }
    leadInput.referrerUrl = req.headers.referer !== undefined ? String(req.headers.referer).slice(0, 400) : null;

    // The form, not the visitor, decides source and campaign. Setting them on the
    // input (rather than patching after creation) means scoring and automation
    // see the real source on the very first evaluation.
    if (truthy(form.source_id)) {
      leadInput.sourceId = form.source_id;
    }
    // A form tied to a project produces leads already attributed to it, which
    // is the whole point of a per-project landing page.
    if (truthy(form.project_id)) {
      leadInput.projectId = form.project_id;
    }

    let result;
    try {
      result = await createLead(leadInput, {
        organizationId: form.organization_id,
        origin: 'FORM',
        duplicatePolicy: 'FLAG',
        ownerId: truthy(form.assign_to_user_id) ? form.assign_to_user_id : null,
        teamId: truthy(form.assign_to_team_id) ? form.assign_to_team_id : null,
        skipAssignment: !gvBool(form.use_assignment_rules) && !truthy(form.assign_to_user_id),
      });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      await captureRecordSubmission(req, form, body, 'REJECTED', err.message);
      if (err.status === 400 || err.status === 409) {
        return jsonError(res, err.status, err.errorCode, err.message);
      }
      throw err;
    }

    const duplicateCount = result.duplicates.length;
    await captureRecordSubmission(
      req,
      form,
      body,
      duplicateCount ? 'DUPLICATE' : 'ACCEPTED',
      duplicateCount ? `Matched ${duplicateCount} existing lead(s)` : null,
      result.lead.id
    );
    await dbExec('UPDATE web_forms SET submission_count = submission_count + 1 WHERE id = ?', [form.id]);

    return jsonOk(res, {
      received: true,
      message: form.success_message,
      redirectUrl: truthy(form.redirect_url) ? form.redirect_url : null,
    });
  })
);

// ---------------------------------------------------------------------------
// GET /public/hosted/:publicKey — hosted form page (/f/:publicKey)
// ---------------------------------------------------------------------------
function renderHostedPage(form) {
  const fields = asList(safeJson(form.fields ?? '[]', []));

  const inputs = [];
  for (const field of fields) {
    if (!isEmpty(own(field, 'hidden'))) {
      continue;
    }
    const isRequired = !isEmpty(own(field, 'required'));
    const id = `gv_${captureEscape(own(field, 'key'))}`;
    const required = isRequired ? 'required' : '';
    const label = `<label for="${id}">${captureEscape(own(field, 'label'))}${isRequired ? ' <span class="req">*</span>' : ''}</label>`;
    const key = captureEscape(own(field, 'key'));
    const placeholder = captureEscape(own(field, 'placeholder') ?? '');
    const type = own(field, 'type') ?? '';

    if (type === 'textarea') {
      inputs.push(`<div class="field">${label}<textarea id="${id}" name="${key}" rows="4" ${required} placeholder="${placeholder}"></textarea></div>`);
    } else if (type === 'select') {
      let options = '';
      for (const o of asList(own(field, 'options') ?? [])) {
        const escaped = captureEscape(String(o));
        options += `<option value="${escaped}">${escaped}</option>`;
      }
      inputs.push(`<div class="field">${label}<select id="${id}" name="${key}" ${required}><option value="">Select...</option>${options}</select></div>`);
    } else if (type === 'checkbox') {
      inputs.push(`<div class="field field--check"><input type="checkbox" id="${id}" name="${key}" value="yes" ${required}>${label}</div>`);
    } else {
      const inputType = captureEscape(own(field, 'type') ?? 'text');
      const defaultValue = captureEscape(own(field, 'defaultValue') ?? '');
      inputs.push(`<div class="field">${label}<input type="${inputType}" id="${id}" name="${key}" ${required} placeholder="${placeholder}" value="${defaultValue}"></div>`);
    }
  }

  const name = captureEscape(form.name);
  const sub = captureEscape(truthy(form.description) ? form.description : `Submitted to ${form.org_name}`);
  const submitLabel = captureEscape(form.submit_label);
  const successMessage = captureEscape(form.success_message);
  const redirectUrl = captureEscape(form.redirect_url ?? '');
  const keyEscaped = captureEscape(form.public_key);
  const inputsHtml = inputs.join('\n      ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7fb; --card:#fff; --ink:#101828; --muted:#667085; --line:#e4e7ec; --brand:#1d4ed8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b1020; --card:#141a2e; --ink:#e8ecf6; --muted:#98a2b3; --line:#242c45; --brand:#6d8bff; } }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--ink); font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .card { max-width:560px; margin:0 auto; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px; }
  h1 { margin:0 0 4px; font-size:20px; }
  p.sub { margin:0 0 20px; color:var(--muted); font-size:14px; }
  .field { margin-bottom:14px; display:flex; flex-direction:column; gap:6px; }
  .field--check { flex-direction:row; align-items:center; gap:8px; }
  label { font-size:13px; font-weight:600; }
  .req { color:#dc2626; }
  input, select, textarea { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
  input:focus, select:focus, textarea:focus { outline:2px solid var(--brand); outline-offset:1px; }
  button { width:100%; margin-top:8px; padding:12px; border:0; border-radius:8px; background:var(--brand); color:#fff; font-weight:600; font-size:15px; cursor:pointer; }
  button[disabled] { opacity:.6; cursor:progress; }
  .msg { margin-top:14px; padding:12px; border-radius:8px; font-size:14px; display:none; }
  .msg.ok { background:#dcfce7; color:#14532d; display:block; }
  .msg.err { background:#fee2e2; color:#7f1d1d; display:block; }
  .hp { position:absolute; left:-9999px; }
  footer { margin-top:18px; text-align:center; font-size:12px; color:var(--muted); }
</style>
</head>
<body>
  <div class="card">
    <h1>${name}</h1>
    <p class="sub">${sub}</p>
    <form id="gvForm" novalidate>
      ${inputsHtml}
      <input class="hp" type="text" name="_gv_hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button type="submit">${submitLabel}</button>
    </form>
    <div class="msg" id="gvMsg" role="status"></div>
    <footer>Powered by Growvanta CRM</footer>
  </div>
<script src="/public-form.js" data-endpoint="/api/public/forms/${keyEscaped}/submit" data-success="${successMessage}" data-redirect="${redirectUrl}"></script>
</body>
</html>`;
}

router.get(
  '/hosted/:publicKey',
  ah(async (req, res) => {
    const form = await captureLoadActiveForm(req.params.publicKey);
    const html = renderHostedPage(form);

    res.set('Content-Type', 'text/html; charset=utf-8');
    // The hosted page is meant to be embedded in an iframe on customer sites;
    // frame-ancestors is what governs that, so no X-Frame-Options is sent
    // whichever URL the page was reached by.
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors *"
    );
    res.removeHeader('X-Frame-Options');
    return res.send(html);
  })
);

// ---------------------------------------------------------------------------
// GET /public/embed/:publicKey — embeddable script (/embed/:publicKey.js):
// injects a styled form into the host page.
// ---------------------------------------------------------------------------
function renderEmbedScript(form) {
  const fields = asList(safeJson(form.fields ?? '[]', []));

  const payload = {
    key: form.public_key,
    name: form.name,
    description: truthy(form.description) ? form.description : '',
    submitLabel: form.submit_label,
    successMessage: form.success_message,
    redirectUrl: truthy(form.redirect_url) ? form.redirect_url : '',
    endpoint: `${config.appUrl}/api/public/forms/${form.public_key}/submit`,
    fields: fields
      .filter((f) => isEmpty(own(f, 'hidden')))
      .map((f) => ({
        key: own(f, 'key') ?? null,
        label: own(f, 'label') ?? null,
        type: own(f, 'type') ?? null,
        required: !isEmpty(own(f, 'required')),
        placeholder: own(f, 'placeholder') ?? '',
        options: own(f, 'options') ?? [],
        defaultValue: own(f, 'defaultValue') ?? '',
      })),
  };
  // json_encode() escapes U+2028/U+2029, which older engines reject inside a
  // string literal; JSON.stringify() does not, so it is done by hand.
  const configJson = toJson(payload).replace(LINE_SEPARATOR, '\\' + 'u2028').replace(PARAGRAPH_SEPARATOR, '\\' + 'u2029');
  const formName = form.name;

  return `/* Growvanta CRM embeddable form - ${formName} */
(function () {
  var CONFIG = ${configJson};
  var mount = document.getElementById('growvanta-form-' + CONFIG.key)
    || document.querySelector('[data-growvanta-form="' + CONFIG.key + '"]');
  if (!mount) {
    console.warn('[Growvanta] No mount element found. Add <div id="growvanta-form-' + CONFIG.key + '"></div>');
    return;
  }

  var style = document.createElement('style');
  style.textContent = '.gv-form{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:560px}'
    + '.gv-form h3{margin:0 0 4px;font-size:18px}.gv-form .gv-sub{margin:0 0 16px;opacity:.7;font-size:14px}'
    + '.gv-f{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}'
    + '.gv-f label{font-size:13px;font-weight:600}'
    + '.gv-f input,.gv-f select,.gv-f textarea{padding:10px 12px;border:1px solid rgba(128,128,128,.35);border-radius:8px;font:inherit;background:transparent;color:inherit;width:100%;box-sizing:border-box}'
    + '.gv-form button{width:100%;padding:12px;border:0;border-radius:8px;background:#1d4ed8;color:#fff;font-weight:600;font-size:15px;cursor:pointer}'
    + '.gv-form button[disabled]{opacity:.6;cursor:progress}'
    + '.gv-msg{margin-top:12px;padding:10px 12px;border-radius:8px;font-size:14px}'
    + '.gv-msg.ok{background:#dcfce7;color:#14532d}.gv-msg.err{background:#fee2e2;color:#7f1d1d}'
    + '.gv-hp{position:absolute!important;left:-9999px!important}';
  document.head.appendChild(style);

  var wrap = document.createElement('div');
  wrap.className = 'gv-form';
  var heading = document.createElement('h3');
  heading.textContent = CONFIG.name;
  wrap.appendChild(heading);
  if (CONFIG.description) {
    var sub = document.createElement('p');
    sub.className = 'gv-sub';
    sub.textContent = CONFIG.description;
    wrap.appendChild(sub);
  }

  var form = document.createElement('form');
  form.noValidate = true;

  CONFIG.fields.forEach(function (field) {
    var row = document.createElement('div');
    row.className = 'gv-f';
    var label = document.createElement('label');
    label.textContent = field.label + (field.required ? ' *' : '');
    var input;
    if (field.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 4;
    } else if (field.type === 'select') {
      input = document.createElement('select');
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = 'Select...';
      input.appendChild(blank);
      field.options.forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        input.appendChild(o);
      });
    } else {
      input = document.createElement('input');
      input.type = field.type;
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.defaultValue) input.value = field.defaultValue;
    }
    input.name = field.key;
    input.id = 'gv-' + CONFIG.key + '-' + field.key;
    label.setAttribute('for', input.id);
    if (field.required) input.required = true;
    row.appendChild(label);
    row.appendChild(input);
    form.appendChild(row);
  });

  var honey = document.createElement('input');
  honey.type = 'text';
  honey.name = '_gv_hp';
  honey.className = 'gv-hp';
  honey.tabIndex = -1;
  honey.setAttribute('autocomplete', 'off');
  honey.setAttribute('aria-hidden', 'true');
  form.appendChild(honey);

  var button = document.createElement('button');
  button.type = 'submit';
  button.textContent = CONFIG.submitLabel;
  form.appendChild(button);

  var msg = document.createElement('div');
  wrap.appendChild(form);
  wrap.appendChild(msg);
  mount.appendChild(wrap);

  function utm() {
    var params = new URLSearchParams(window.location.search);
    var map = { utm_source: 'utmSource', utm_medium: 'utmMedium', utm_campaign: 'utmCampaign', utm_term: 'utmTerm', utm_content: 'utmContent', gclid: 'gclid', fbclid: 'fbclid' };
    var out = { landingPage: window.location.href.slice(0, 400) };
    Object.keys(map).forEach(function (k) { if (params.get(k)) out[map[k]] = params.get(k); });
    return out;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    msg.className = '';
    msg.textContent = '';
    var missing = CONFIG.fields.filter(function (f) {
      return f.required && !String(new FormData(form).get(f.key) || '').trim();
    });
    if (missing.length) {
      msg.className = 'gv-msg err';
      msg.textContent = 'Please fill in: ' + missing.map(function (f) { return f.label; }).join(', ');
      return;
    }

    var data = utm();
    new FormData(form).forEach(function (value, key) { data[key] = value; });
    button.disabled = true;
    button.textContent = 'Sending...';

    fetch(CONFIG.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function (r) {
      return r.json().then(function (body) { return { okay: r.ok, body: body }; });
    }).then(function (result) {
      button.disabled = false;
      button.textContent = CONFIG.submitLabel;
      if (!result.okay) {
        msg.className = 'gv-msg err';
        msg.textContent = (result.body && result.body.error && result.body.error.message) || 'Something went wrong. Please try again.';
        return;
      }
      form.reset();
      msg.className = 'gv-msg ok';
      msg.textContent = (result.body.data && result.body.data.message) || CONFIG.successMessage;
      var redirect = (result.body.data && result.body.data.redirectUrl) || CONFIG.redirectUrl;
      if (redirect) setTimeout(function () { window.location.href = redirect; }, 900);
    }).catch(function () {
      button.disabled = false;
      button.textContent = CONFIG.submitLabel;
      msg.className = 'gv-msg err';
      msg.textContent = 'Network error. Please try again.';
    });
  });
})();`;
}

router.get(
  '/embed/:publicKey',
  ah(async (req, res) => {
    const key = req.params.publicKey.replace(/\.js$/, '');
    const form = await captureLoadActiveForm(key);
    const js = renderEmbedScript(form);

    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Access-Control-Allow-Origin', '*');
    return res.send(js);
  })
);

router.use((req, res, next) => next(notFound('Unknown public capture route')));

export default router;
