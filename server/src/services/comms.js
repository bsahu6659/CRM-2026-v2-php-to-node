/**
 * WhatsApp + Email: configuration-aware automation. Port of services/Comms.php.
 *
 * The rule this file exists to enforce (spec sections 31, 35, 37) is that a
 * channel is GREEN only when it could actually deliver a message right now.
 * Flipping the switch on gets you ORANGE, not GREEN.
 *
 *   RED     the tenant turned the automation off
 *   ORANGE  turned on, but at least one required item is missing or unverified
 *   GREEN   turned on, every item present, credentials proven by a live test
 *
 * check*Configuration() is the single source of that verdict: the settings
 * screen renders it, the Super Admin overview aggregates it, and - crucially -
 * the send path re-runs it server-side before every message, so a stale or
 * doctored frontend cannot cause a send (section 37).
 *
 * The templating primitives at the top are pure and synchronous; provisioning
 * needs them before any channel is configured.
 */

import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import config from '../config/index.js';
import { dbExec, dbOne, dbScalar } from '../lib/db.js';
import { gvDecrypt } from '../lib/security.js';
import { digitsOnly, fullName, gvBool, gvId, safeJson } from '../lib/util.js';
import { onDomainEvent } from './events.js';

export const GV_COMMS_STATUS_OFF = 'RED';
export const GV_COMMS_STATUS_INCOMPLETE = 'ORANGE';
export const GV_COMMS_STATUS_ACTIVE = 'GREEN';

/** Variables every template may use; anything else must be explicitly mapped. */
export const GV_TEMPLATE_VARIABLES = [
  'customer_name', 'first_name', 'last_name', 'phone', 'email',
  'project_name', 'project_location', 'company_name', 'sales_person_name',
  'sales_person_phone', 'lead_code', 'lead_source', 'budget', 'configuration',
];

const VARIABLE_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

// ---------------------------------------------------------------------------
// PHP semantics the logic below depends on. Kept local and explicit because
// the verdicts hinge on them: PHP's empty() treats "0" as empty, and (string)
// of null/false is '' rather than 'null'/'false'.
// ---------------------------------------------------------------------------
function empty(value) {
  return (
    value === undefined || value === null || value === false || value === 0 || value === '' || value === '0' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function phpString(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return '1';
  return String(value);
}

function hasOwn(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * substr($s, 0, $n) for a column limit. Cut by characters, not bytes: PHP's
 * byte cut could split a multi-byte character and have MySQL reject the row,
 * and the VARCHAR limits are in characters anyway.
 */
function clip(value, length) {
  const s = phpString(value);
  if (s.length <= length) return s;
  return Array.from(s).slice(0, length).join('');
}

/** htmlspecialchars($s, ENT_QUOTES) */
function escapeHtml(value) {
  return phpString(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** rawurlencode(): like encodeURIComponent, but also escapes !'()* */
function rawUrlEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** number_format($n): no decimals, halves away from zero, comma thousands. */
function numberFormat(n) {
  const num = Number(n) || 0;
  const rounded = Math.round(Math.abs(num));
  const grouped = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return num < 0 && rounded !== 0 ? `-${grouped}` : grouped;
}

/** The variable map arrives as a parsed JSON column, a JSON string, or nothing. */
function variableMapOf(variableMap) {
  if (variableMap !== null && typeof variableMap === 'object') return variableMap;
  const decoded = safeJson(variableMap, {});
  return decoded !== null && typeof decoded === 'object' ? decoded : {};
}

// ---------------------------------------------------------------------------
// Settings rows
// ---------------------------------------------------------------------------
export async function whatsappSettings(orgId) {
  let row = await dbOne('SELECT * FROM whatsapp_settings WHERE organization_id = ?', [orgId]);
  if (!row) {
    await dbExec(
      'INSERT INTO whatsapp_settings (id, organization_id, created_at, updated_at) VALUES (?,?,NOW(),NOW())',
      [gvId(), orgId]
    );
    row = await dbOne('SELECT * FROM whatsapp_settings WHERE organization_id = ?', [orgId]);
  }
  return row ?? {};
}

export async function emailSettings(orgId) {
  let row = await dbOne('SELECT * FROM email_settings WHERE organization_id = ?', [orgId]);
  if (!row) {
    await dbExec(
      'INSERT INTO email_settings (id, organization_id, created_at, updated_at) VALUES (?,?,NOW(),NOW())',
      [gvId(), orgId]
    );
    row = await dbOne('SELECT * FROM email_settings WHERE organization_id = ?', [orgId]);
  }
  return row ?? {};
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
/** Every distinct {{variable}} referenced by a template body, in first-seen order. */
export function templateVariables(body) {
  const found = [];
  for (const match of String(body ?? '').matchAll(VARIABLE_RE)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/**
 * A template is only usable if every variable it references can actually be
 * filled - either it is a known context variable, or the channel config maps
 * it. Returns the unresolvable ones.
 */
export function templateUnmappedVariables(template, variableMap) {
  if (!template) {
    return [];
  }
  const map = variableMapOf(variableMap);
  const used = templateVariables(`${phpString(template.body)} ${phpString(template.subject ?? '')}`);
  const unmapped = [];
  for (const v of used) {
    if (GV_TEMPLATE_VARIABLES.includes(v)) {
      continue;
    }
    if (hasOwn(map, v) && map[v] !== '' && map[v] !== null) {
      continue;
    }
    unmapped.push(v);
  }
  return unmapped;
}

/** Builds the substitution context for one lead. */
export function templateContext(lead, org = null, owner = null, project = null) {
  return {
    customer_name: fullName(lead.first_name ?? null, lead.last_name ?? null).trim(),
    first_name: phpString(lead.first_name ?? ''),
    last_name: phpString(lead.last_name ?? ''),
    phone: phpString(lead.phone ?? ''),
    email: phpString(lead.email ?? ''),
    lead_code: phpString(lead.code ?? ''),
    // DECIMAL arrives as a string, so "0.00" is truthy here exactly as in PHP.
    budget: !empty(lead.budget_max) ? numberFormat(lead.budget_max) : '',
    configuration: phpString(lead.configuration ?? ''),
    lead_source: phpString(lead.source_name ?? ''),
    project_name: phpString(project?.name ?? ''),
    project_location: phpString(project?.location ?? ''),
    company_name: phpString(org?.name ?? ''),
    sales_person_name: owner ? fullName(owner.first_name ?? null, owner.last_name ?? null).trim() : '',
    sales_person_phone: phpString(owner?.phone ?? ''),
  };
}

/**
 * Substitutes {{variables}} from `context`, then from the channel's variable
 * map. A variable with no value becomes an empty string rather than literal
 * `{{customer_name}}` — a customer receiving the raw placeholder is worse than
 * a slightly clipped sentence, and templateUnmappedVariables() is what is
 * supposed to catch it before sending.
 */
export function templateRender(body, context = {}, variableMap = null) {
  const map = variableMapOf(variableMap);
  return String(body ?? '').replace(VARIABLE_RE, (_, key) => {
    if (hasOwn(context, key)) {
      return phpString(context[key]);
    }
    // A mapped variable points at another context key, or is a literal.
    if (hasOwn(map, key) && map[key] !== null && map[key] !== undefined) {
      const target = map[key];
      const viaContext = hasOwn(context, target) ? context[target] : undefined;
      return phpString(viaContext ?? target);
    }
    return '';
  });
}

/** Earlier name for templateRender(); kept so existing importers keep working. */
export const renderTemplate = templateRender;

// ---------------------------------------------------------------------------
// The three-state verdict
// ---------------------------------------------------------------------------
export function commsVerdict(welcomeEnabled, checklist) {
  const missing = [];
  for (const item of checklist) {
    if (!empty(item.required) && empty(item.ok)) {
      missing.push(item.label);
    }
  }
  const configured = missing.length === 0;

  let status;
  if (!welcomeEnabled) {
    status = GV_COMMS_STATUS_OFF;
  } else if (configured) {
    status = GV_COMMS_STATUS_ACTIVE;
  } else {
    status = GV_COMMS_STATUS_INCOMPLETE;
  }

  return {
    enabled: welcomeEnabled,
    configured,
    status,
    checklist,
    missing,
    // The single boolean the send path consults. Note it is NOT simply
    // `enabled` - that is the whole point of this module.
    readyToSend: welcomeEnabled && configured,
  };
}

export async function checkWhatsappConfiguration(orgId) {
  const s = await whatsappSettings(orgId);
  const template = !empty(s.welcome_template_id)
    ? await dbOne('SELECT * FROM message_templates WHERE id = ? AND organization_id = ?', [s.welcome_template_id, orgId])
    : null;
  const unmapped = templateUnmappedVariables(template, s.variable_map ?? null);

  // PHP's && always yields a boolean; JS's yields an operand, hence Boolean().
  const checklist = [
    { key: 'api', label: 'WhatsApp API connected', required: true,
      ok: !empty(s.access_token_enc) },
    { key: 'waba', label: 'Business account connected', required: true,
      ok: !empty(s.waba_id) },
    { key: 'sender', label: 'Sender number configured', required: true,
      ok: !empty(s.phone_number_id) && !empty(s.sender_number) },
    { key: 'credentials', label: 'API credentials valid', required: true,
      ok: gvBool(s.credentials_valid ?? 0) },
    { key: 'template', label: 'Welcome template selected', required: true,
      ok: Boolean(template) },
    { key: 'approved', label: 'Template approved by provider', required: true,
      ok: Boolean(template) && template.status === 'APPROVED',
      detail: template && template.status !== 'APPROVED' ? `Template status is ${phpString(template.status)}` : null },
    { key: 'variables', label: 'Template variables mapped', required: true,
      ok: Boolean(template) && unmapped.length === 0,
      detail: unmapped.length ? `Unmapped: ${unmapped.join(', ')}` : null },
    { key: 'test', label: 'Test message successful', required: true,
      ok: (s.last_test_status ?? null) === 'SUCCESS',
      detail: empty(s.last_test_error) ? null : s.last_test_error },
  ];

  const verdict = commsVerdict(gvBool(s.welcome_enabled ?? 0), checklist);
  verdict.channel = 'WHATSAPP';
  verdict.provider = s.provider ?? 'META_CLOUD';
  verdict.senderNumber = s.sender_number ?? null;
  verdict.templateId = s.welcome_template_id ?? null;
  verdict.templateName = template?.name ?? null;
  verdict.lastTestAt = s.last_test_at ?? null;
  return verdict;
}

export async function checkEmailConfiguration(orgId) {
  const s = await emailSettings(orgId);
  const template = !empty(s.welcome_template_id)
    ? await dbOne('SELECT * FROM message_templates WHERE id = ? AND organization_id = ?', [s.welcome_template_id, orgId])
    : null;
  const unmapped = templateUnmappedVariables(template, s.variable_map ?? null);

  const mode = s.mode ?? 'SMTP';
  const providerOk = mode === 'SMTP'
    ? (!empty(s.smtp_host) && !empty(s.smtp_port))
    : !empty(s.api_key_enc);

  const checklist = [
    { key: 'provider', label: mode === 'SMTP' ? 'SMTP server configured' : 'Email provider connected',
      required: true, ok: providerOk },
    { key: 'credentials', label: 'Credentials valid', required: true,
      ok: gvBool(s.credentials_valid ?? 0) },
    { key: 'from_email', label: 'Sender email configured', required: true,
      ok: !empty(s.from_email) },
    { key: 'from_name', label: 'Sender name configured', required: true,
      ok: !empty(s.from_name) },
    { key: 'template', label: 'Welcome email template selected', required: true,
      ok: Boolean(template) },
    { key: 'subject', label: 'Template has a subject line', required: true,
      ok: Boolean(template) && phpString(template.subject).trim() !== '' },
    { key: 'variables', label: 'Template variables mapped', required: true,
      ok: Boolean(template) && unmapped.length === 0,
      detail: unmapped.length ? `Unmapped: ${unmapped.join(', ')}` : null },
    { key: 'test', label: 'Test email successful', required: true,
      ok: (s.last_test_status ?? null) === 'SUCCESS',
      detail: empty(s.last_test_error) ? null : s.last_test_error },
  ];

  const verdict = commsVerdict(gvBool(s.welcome_enabled ?? 0), checklist);
  verdict.channel = 'EMAIL';
  verdict.mode = mode;
  verdict.fromEmail = s.from_email ?? null;
  verdict.fromName = s.from_name ?? null;
  verdict.templateId = s.welcome_template_id ?? null;
  verdict.templateName = template?.name ?? null;
  verdict.lastTestAt = s.last_test_at ?? null;
  return verdict;
}

// ---------------------------------------------------------------------------
// Delivery log
// ---------------------------------------------------------------------------
export async function commsLog(orgId, channel, fields) {
  const isSet = (v) => v !== null && v !== undefined;
  await dbExec(
    `INSERT INTO message_logs
       (id, organization_id, channel, lead_id, template_id, recipient, subject, body_preview,
        status, reason, provider_message_id, provider_response, is_test, triggered_by, user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
    [
      gvId(), orgId, channel,
      fields.leadId ?? null, fields.templateId ?? null, fields.recipient ?? null,
      isSet(fields.subject) ? clip(fields.subject, 300) : null,
      isSet(fields.body) ? clip(fields.body, 500) : null,
      fields.status, isSet(fields.reason) ? clip(fields.reason, 300) : null,
      fields.providerMessageId ?? null,
      isSet(fields.providerResponse) ? clip(fields.providerResponse, 4000) : null,
      !empty(fields.isTest) ? 1 : 0, fields.triggeredBy ?? null, fields.userId ?? null,
    ]
  );
}

// ---------------------------------------------------------------------------
// WhatsApp transport (Meta Cloud API)
// ---------------------------------------------------------------------------
export async function whatsappSendRaw(settings, to, payloadExtra) {
  const token = gvDecrypt(settings.access_token_enc ?? null);
  if (empty(token)) {
    return { ok: false, error: 'No access token stored.' };
  }
  const base = empty(settings.api_base_url) ? 'https://graph.facebook.com/v21.0' : String(settings.api_base_url);
  const url = `${base.replace(/\/+$/, '')}/${rawUrlEncode(phpString(settings.phone_number_id))}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to: digitsOnly(to),
    ...payloadExtra,
  };

  let status;
  let response;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // CURLOPT_TIMEOUT => 20. TLS peer verification is fetch's default.
      signal: AbortSignal.timeout(20000),
    });
    status = res.status;
    response = await res.text();
  } catch (err) {
    // fetch() hides the socket-level reason in `cause`; that is what curl_error()
    // would have reported.
    return { ok: false, error: `Network error: ${err?.cause?.message ?? err?.message ?? String(err)}` };
  }

  let decoded = null;
  try {
    decoded = JSON.parse(response);
  } catch {
    decoded = null;
  }
  if (status >= 200 && status < 300) {
    return { ok: true, messageId: decoded?.messages?.[0]?.id ?? null, raw: response };
  }
  const message = decoded?.error?.message ?? `HTTP ${status}`;
  return { ok: false, error: message, raw: response };
}

/**
 * WhatsApp business-initiated messages must use a pre-approved template, so
 * the body we store is only ever the preview; the provider renders the real
 * text from provider_name plus positional parameters.
 */
export async function whatsappSendTemplate(settings, template, to, context) {
  const vars = templateVariables(phpString(template.body));
  const params = vars.map((v) => ({ type: 'text', text: phpString(context[v] ?? '') }));
  const payload = {
    type: 'template',
    template: {
      name: empty(template.provider_name) ? template.key : template.provider_name,
      language: { code: empty(template.language) ? 'en' : template.language },
    },
  };
  if (params.length) {
    payload.template.components = [{ type: 'body', parameters: params }];
  }
  return whatsappSendRaw(settings, to, payload);
}

// ---------------------------------------------------------------------------
// Email transport (tenant SMTP)
//
// PHP spoke SMTP over a raw socket (smtp_expect/smtp_send) to avoid
// PHPMailer. Here nodemailer conducts the dialogue, configured to behave the
// same way: implicit TLS for SSL, mandatory STARTTLS for TLS and nothing for
// NONE; AUTH LOGIN whenever a username is set; peer certificates verified;
// 15-second timeouts. smtpStageError() turns nodemailer's failure back into
// the stage-labelled messages the PHP produced, which tenants see on the
// settings screen and in the delivery log.
// ---------------------------------------------------------------------------
function appHost() {
  try {
    return new URL(config.appUrl).hostname || 'localhost';
  } catch {
    return 'localhost';
  }
}

/** The display name PHP put in the header: quotes stripped when it is plain ASCII. */
function headerName(value) {
  const s = phpString(value);
  return /^[\x20-\x7E]*$/.test(s) ? s.replace(/"/g, '') : s;
}

function smtpStageError(err, host, port) {
  const response = err?.response ? String(err.response).trim() : '';
  const command = String(err?.command ?? '');
  const code = String(err?.code ?? '');
  const failed = (stage) => ({ ok: false, error: `${stage} failed: ${response}` });

  switch (code) {
    case 'ECONNECTION':
    case 'EDNS':
    case 'ESOCKET':
    case 'ETIMEDOUT':
      if (!response && (command === 'CONN' || command === '')) {
        return { ok: false, error: `Cannot reach ${host}:${port} - ${err?.message ?? ''}` };
      }
      break;
    case 'EPROTOCOL':
      if (command === 'CONN') return failed('Greeting');
      if (command === 'EHLO' || command === 'HELO') return failed('EHLO');
      break;
    case 'ETLS':
      // A refused STARTTLS carries the server's reply; a failed handshake does not.
      return response ? failed('STARTTLS') : { ok: false, error: 'TLS negotiation failed.' };
    case 'EAUTH':
      if (/334 VXNlcm5hbWU6/.test(String(err?.message ?? ''))) return failed('AUTH');
      if (/334 UGFzc3dvcmQ6/.test(String(err?.message ?? ''))) return failed('Username');
      return { ok: false, error: 'Authentication rejected by the mail server.' };
    case 'EENVELOPE':
      if (command === 'MAIL FROM') return failed('MAIL FROM');
      if (command === 'RCPT TO') return failed('RCPT TO');
      if (command === 'DATA') return failed('DATA');
      break;
    case 'EMESSAGE':
      return failed('Message body');
    default:
      break;
  }
  return { ok: false, error: String(err?.message ?? err) };
}

export async function smtpSend(settings, toEmail, toName, subject, htmlBody) {
  const host = phpString(settings.smtp_host);
  const port = Math.trunc(Number(settings.smtp_port) || 0);
  const encryption = phpString(settings.smtp_encryption ?? 'TLS').toUpperCase();
  const username = phpString(settings.smtp_username ?? '');
  // A tenant's credentials are sealed in the database and have to be opened;
  // the platform's own mailer is configured in .env, where the password is
  // already plain. Both arrive here rather than each growing its own sender.
  const password = settings.smtp_password_plain !== undefined && settings.smtp_password_plain !== null
    ? phpString(settings.smtp_password_plain)
    : phpString(gvDecrypt(settings.smtp_password_enc ?? null) ?? '');
  const fromEmail = phpString(settings.from_email);
  const fromName = phpString(settings.from_name);
  const ehloHost = appHost();

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: encryption === 'SSL',
    requireTLS: encryption === 'TLS',
    // NONE means plaintext; do not let nodemailer upgrade opportunistically.
    ignoreTLS: encryption !== 'TLS' && encryption !== 'SSL',
    tls: { rejectUnauthorized: true },
    name: ehloHost,
    auth: username !== '' ? { user: username, pass: password } : undefined,
    authMethod: 'LOGIN',
    // PHP sent AUTH whenever a username was set, advertised or not.
    forceAuth: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000,
  });

  const boundary = `gv${crypto.randomBytes(8).toString('hex')}`;
  const message = {
    from: { name: headerName(fromName), address: fromEmail },
    to: toName !== '' ? { name: headerName(toName), address: toEmail } : toEmail,
    subject,
    html: htmlBody,
    messageId: `<${boundary}@${ehloHost}>`,
  };
  if (!empty(settings.reply_to)) {
    message.replyTo = settings.reply_to;
  }

  try {
    const info = await transport.sendMail(message);
    return { ok: true, raw: String(info?.response ?? '').trim() };
  } catch (err) {
    return smtpStageError(err, host, port);
  } finally {
    // An unpooled transport has already sent QUIT; this only releases it.
    if (typeof transport.close === 'function') transport.close();
  }
}

/** RFC 2047 encoding so non-ASCII names survive the header. */
export function commsEncodeHeader(value) {
  const s = phpString(value);
  if (/^[\x20-\x7E]*$/.test(s)) {
    return `"${s.replace(/"/g, '')}"`;
  }
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// ---------------------------------------------------------------------------
// Welcome automation - the lead.created entry point
// ---------------------------------------------------------------------------
/**
 * Sends the welcome messages for a newly created lead, or records exactly why
 * it did not. Never throws: a lead must still be created if the tenant's
 * WhatsApp credentials have expired.
 */
export async function commsSendWelcome(orgId, leadId) {
  const results = {};
  try {
    const lead = await dbOne(
      `SELECT leads.*, lead_sources.name AS source_name
         FROM leads LEFT JOIN lead_sources ON lead_sources.id = leads.source_id
        WHERE leads.id = ? AND leads.organization_id = ?`,
      [leadId, orgId]
    );
    if (!lead) {
      return results;
    }
    const org = await dbOne('SELECT * FROM organizations WHERE id = ?', [orgId]);
    const owner = lead.owner_id ? await dbOne('SELECT * FROM users WHERE id = ?', [lead.owner_id]) : null;
    const project = lead.project_id ? await dbOne('SELECT * FROM projects WHERE id = ?', [lead.project_id]) : null;
    const context = templateContext(lead, org, owner, project);

    results.whatsapp = await commsDeliverWhatsapp(orgId, lead, context, 'lead.created');
    results.email = await commsDeliverEmail(orgId, lead, context, 'lead.created');
  } catch (err) {
    console.error(`[comms] welcome automation failed: ${err?.message ?? err}`);
  }
  return results;
}

export async function commsDeliverWhatsapp(orgId, lead, context, trigger) {
  const verdict = await checkWhatsappConfiguration(orgId);

  if (!verdict.enabled) {
    return 'DISABLED';
  }
  if (!verdict.readyToSend) {
    await commsLog(orgId, 'WHATSAPP', {
      leadId: lead.id, recipient: lead.phone, status: 'SKIPPED',
      reason: `Configuration incomplete: ${verdict.missing.join('; ')}`,
      triggeredBy: trigger,
    });
    return 'SKIPPED_INCOMPLETE';
  }
  if (empty(lead.phone)) {
    await commsLog(orgId, 'WHATSAPP', {
      leadId: lead.id, status: 'SKIPPED',
      reason: 'Lead has no phone number.', triggeredBy: trigger,
    });
    return 'SKIPPED_NO_PHONE';
  }

  const settings = await whatsappSettings(orgId);
  const template = await dbOne('SELECT * FROM message_templates WHERE id = ?', [settings.welcome_template_id]);
  const sent = await whatsappSendTemplate(settings, template, phpString(lead.phone), context);

  await commsLog(orgId, 'WHATSAPP', {
    leadId: lead.id, templateId: template.id, recipient: lead.phone,
    body: templateRender(phpString(template.body), context, settings.variable_map ?? null),
    status: sent.ok ? 'SENT' : 'FAILED',
    reason: sent.ok ? null : sent.error,
    providerMessageId: sent.messageId ?? null,
    providerResponse: sent.raw ?? null,
    triggeredBy: trigger,
  });
  return sent.ok ? 'SENT' : 'FAILED';
}

export async function commsDeliverEmail(orgId, lead, context, trigger) {
  const verdict = await checkEmailConfiguration(orgId);

  if (!verdict.enabled) {
    return 'DISABLED';
  }
  if (!verdict.readyToSend) {
    await commsLog(orgId, 'EMAIL', {
      leadId: lead.id, recipient: lead.email, status: 'SKIPPED',
      reason: `Configuration incomplete: ${verdict.missing.join('; ')}`,
      triggeredBy: trigger,
    });
    return 'SKIPPED_INCOMPLETE';
  }
  if (empty(lead.email)) {
    await commsLog(orgId, 'EMAIL', {
      leadId: lead.id, status: 'SKIPPED',
      reason: 'Lead has no email address.', triggeredBy: trigger,
    });
    return 'SKIPPED_NO_EMAIL';
  }

  const settings = await emailSettings(orgId);
  const template = await dbOne('SELECT * FROM message_templates WHERE id = ?', [settings.welcome_template_id]);
  const subject = templateRender(phpString(template.subject), context, settings.variable_map ?? null);
  const body = templateRender(phpString(template.body), context, settings.variable_map ?? null);

  const sent = await smtpSend(settings, phpString(lead.email), context.customer_name, subject, body);

  await commsLog(orgId, 'EMAIL', {
    leadId: lead.id, templateId: template.id, recipient: lead.email,
    subject, body,
    status: sent.ok ? 'SENT' : 'FAILED',
    reason: sent.ok ? null : sent.error,
    triggeredBy: trigger,
  });
  return sent.ok ? 'SENT' : 'FAILED';
}

// ---------------------------------------------------------------------------
// Test sends (spec section 38)
// ---------------------------------------------------------------------------
/**
 * Test sends deliberately bypass the welcome toggle - you test in order to
 * turn it on - but still require the transport itself to be configured. They
 * are logged with is_test = 1 so they never pollute delivery reporting, and
 * they never touch a lead record.
 */
export async function commsTestWhatsapp(orgId, toPhone, userId) {
  const settings = await whatsappSettings(orgId);
  if (empty(settings.access_token_enc) || empty(settings.phone_number_id)) {
    const error = 'Add an access token and sender number before sending a test.';
    await commsRecordTest(orgId, 'WHATSAPP', false, error);
    await commsLog(orgId, 'WHATSAPP', { recipient: toPhone, status: 'FAILED', reason: error, isTest: 1, userId, triggeredBy: 'manual.test' });
    return { ok: false, error };
  }

  const template = !empty(settings.welcome_template_id)
    ? await dbOne('SELECT * FROM message_templates WHERE id = ?', [settings.welcome_template_id])
    : null;

  const context = {
    ...Object.fromEntries(GV_TEMPLATE_VARIABLES.map((v) => [v, ''])),
    customer_name: 'Test Contact',
    company_name: phpString(await dbScalar('SELECT name FROM organizations WHERE id = ?', [orgId])),
    project_name: 'Sample Project',
  };

  const sent = template
    ? await whatsappSendTemplate(settings, template, toPhone, context)
    : await whatsappSendRaw(settings, toPhone, { type: 'text', text: { body: 'Growvanta CRM test message.' } });

  await commsRecordTest(orgId, 'WHATSAPP', sent.ok, sent.ok ? null : sent.error);
  await commsLog(orgId, 'WHATSAPP', {
    templateId: template?.id ?? null, recipient: toPhone,
    status: sent.ok ? 'SENT' : 'FAILED', reason: sent.ok ? null : sent.error,
    providerMessageId: sent.messageId ?? null, providerResponse: sent.raw ?? null,
    isTest: 1, userId, triggeredBy: 'manual.test',
  });
  return sent;
}

export async function commsTestEmail(orgId, toEmail, userId) {
  const settings = await emailSettings(orgId);
  if (empty(settings.from_email) || empty(settings.smtp_host)) {
    const error = 'Configure the SMTP server and sender address before sending a test.';
    await commsRecordTest(orgId, 'EMAIL', false, error);
    await commsLog(orgId, 'EMAIL', { recipient: toEmail, status: 'FAILED', reason: error, isTest: 1, userId, triggeredBy: 'manual.test' });
    return { ok: false, error };
  }

  const orgName = phpString(await dbScalar('SELECT name FROM organizations WHERE id = ?', [orgId]));
  const subject = 'Growvanta CRM - test email';
  const body = `<p>This is a test email from <strong>${escapeHtml(orgName)}</strong>.</p>`
    + '<p>If you are reading this, your outgoing email configuration works.</p>';

  const sent = await smtpSend(settings, toEmail, '', subject, body);

  await commsRecordTest(orgId, 'EMAIL', sent.ok, sent.ok ? null : sent.error);
  await commsLog(orgId, 'EMAIL', {
    recipient: toEmail, subject,
    status: sent.ok ? 'SENT' : 'FAILED', reason: sent.ok ? null : sent.error,
    isTest: 1, userId, triggeredBy: 'manual.test',
  });
  return sent;
}

/**
 * A passing test is the only thing that sets credentials_valid, and a failing
 * one clears it. That is what stops a channel from sitting on GREEN after its
 * token is revoked.
 */
export async function commsRecordTest(orgId, channel, ok, error) {
  // The table name comes from this two-way switch, never from input.
  const table = channel === 'WHATSAPP' ? 'whatsapp_settings' : 'email_settings';
  await dbExec(
    `UPDATE ${table}
        SET last_test_at = NOW(), last_test_status = ?, last_test_error = ?,
            credentials_valid = ?, verified_at = CASE WHEN ? = 1 THEN NOW() ELSE verified_at END
      WHERE organization_id = ?`,
    [ok ? 'SUCCESS' : 'FAILED', !empty(error) ? clip(error, 500) : null, ok ? 1 : 0, ok ? 1 : 0, orgId]
  );
}

/**
 * Any edit to the transport credentials invalidates the previous proof, which
 * drops the channel from GREEN back to ORANGE until it is retested.
 */
export async function commsInvalidateVerification(orgId, channel) {
  const table = channel === 'WHATSAPP' ? 'whatsapp_settings' : 'email_settings';
  await dbExec(
    `UPDATE ${table} SET credentials_valid = 0, last_test_status = NULL, last_test_error = NULL WHERE organization_id = ?`,
    [orgId]
  );
}

/**
 * Subscribes welcome automation to lead creation. Domain events dispatch after
 * the response has been sent (services/events.js), so a slow WhatsApp round
 * trip never delays the response that told the salesperson their lead was
 * saved.
 */
export function registerCommsListeners() {
  onDomainEvent('lead.created', async (payload) => {
    const orgId = payload?.organizationId ?? null;
    const leadId = payload?.data?.id ?? null;
    if (orgId && leadId) {
      await commsSendWelcome(orgId, leadId);
    }
  });
}
