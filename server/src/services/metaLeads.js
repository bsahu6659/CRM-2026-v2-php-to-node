/**
 * Meta (Facebook / Instagram) Lead Ads ingestion — port of services/MetaLeads.php.
 *
 * Meta's webhook tells you only that a lead exists, never what is in it — the
 * payload carries a leadgen_id, a page_id and a form_id. The actual field
 * values must be fetched from the Graph API with the page's access token, which
 * is why meta_lead_forms stores one (encrypted) per connected page/form.
 *
 * Flow:
 *   1. routes/metaInbound.js verifies X-Hub-Signature-256 and hands the
 *      change entries here.
 *   2. Every entry is logged to meta_webhook_events before anything else, so a
 *      failure is debuggable and replayable rather than silently lost.
 *   3. The page/form mapping decides organisation, source, project and owner.
 *   4. Field values are fetched, normalised, and pushed through createLead()
 *      — the same single write path manual entry and web forms use, so scoring,
 *      assignment and automation all behave identically.
 */

import crypto from 'node:crypto';
import config from '../config/index.js';
import { dbExec, dbOne, dbScalar } from '../lib/db.js';
import { gvDecrypt, safeEqual } from '../lib/security.js';
import { gvBool, gvId, toJson } from '../lib/util.js';
import { createLead } from './leadService.js';

/** Field names Meta's standard questions use, mapped onto lead columns. */
export const META_FIELD_ALIASES = {
  full_name: 'firstName', first_name: 'firstName', last_name: 'lastName',
  email: 'email', phone_number: 'phone', phone: 'phone',
  company_name: 'company', job_title: 'jobTitle', city: 'city',
  state: 'state', province: 'state', country: 'country',
  street_address: 'address', post_code: 'pincode', zip_code: 'pincode',
};

// ---------------------------------------------------------------------------
// Local stand-ins for PHP built-ins.
// ---------------------------------------------------------------------------

/**
 * PHP empty() for the values seen here. A decoded JSON object is a PHP array,
 * so an object with no keys is "empty" just as [] is.
 */
function isEmpty(value) {
  if (value === null || value === undefined || value === false) return true;
  if (value === '' || value === '0' || value === 0) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** PHP trim(): only the six characters PHP strips, not every Unicode space. */
function phpTrim(value) {
  return String(value ?? '').replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

/** PHP (string) for the scalars a decoded payload can hold. */
function str(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return '1';
  return String(value);
}

/** PHP rawurlencode(): RFC 3986, so !'()* are escaped too. */
function rawurlencode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** foreach over a PHP array: lists and keyed arrays both yield their values. */
function phpValues(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return Object.values(value);
  return [];
}

/**
 * json_decode($text, true), without JavaScript's 53-bit integer ceiling.
 *
 * PHP decodes an integer of up to 64 bits exactly. JSON.parse() silently
 * rounds anything past 2^53, and Facebook object ids (leadgen_id, page_id,
 * form_id) are long enough to hit that whenever they arrive unquoted - a
 * rounded leadgen id fetches the wrong lead, or none, and defeats the
 * duplicate check. Such integers are therefore read as their exact digit
 * string, which is what PHP's (string) cast of them produced anyway.
 *
 * Returns null for anything that is not valid JSON, as json_decode does.
 */
export function metaJsonDecode(text) {
  const src = String(text ?? '');
  const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let out = '';
  let inString = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inString) {
      if (ch === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      if (m) {
        const token = m[0];
        const isInteger = /^-?\d+$/.test(token);
        out += isInteger && !Number.isSafeInteger(Number(token)) ? `"${token}"` : token;
        i += token.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** is_array() on a json_decode(…, true) result: objects and lists both count. */
function isDecodedArray(value) {
  return value !== null && typeof value === 'object';
}

// ---------------------------------------------------------------------------
// Graph API
// ---------------------------------------------------------------------------

export function metaGraphBase() {
  return 'https://graph.facebook.com/' + (config.meta.graphVersion ?? 'v19.0');
}

/** Verifies Meta's X-Hub-Signature-256 against the raw body using the app secret. */
export function metaVerifySignature(rawBody, signatureHeader) {
  const appSecret = String(config.meta.appSecret ?? '');
  if (appSecret === '' || !signatureHeader) {
    return false;
  }
  const header = String(signatureHeader);
  if (!header.startsWith('sha256=')) {
    return false;
  }
  // Over the bytes exactly as they arrived. Hashing a re-serialised or
  // re-decoded body would change whitespace and escapes and never match.
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const expected = crypto.createHmac('sha256', appSecret).update(body).digest('hex');
  return safeEqual(expected, header.slice(7));
}

/** One GET to the Graph API; returns the decoded body or null on failure. */
export async function metaGraphGet(url) {
  let status;
  let response;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    response = await res.text();
  } catch (err) {
    console.error(`[meta] Graph request failed: ${err?.cause?.message ?? err?.message ?? err}`);
    return null;
  }
  const decoded = metaJsonDecode(response);
  if (status >= 400) {
    console.error(`[meta] Graph returned HTTP ${status}: ${String(response).slice(0, 300)}`);
    return isDecodedArray(decoded) ? decoded : null;
  }
  return isDecodedArray(decoded) ? decoded : null;
}

/** Fetches one lead's full field data from the Graph API. */
export async function metaFetchLead(leadgenId, pageAccessToken) {
  const url = metaGraphBase() + '/' + rawurlencode(leadgenId)
    + '?fields=' + rawurlencode('id,created_time,ad_id,adset_id,campaign_id,form_id,field_data')
    + '&access_token=' + rawurlencode(pageAccessToken);
  const data = await metaGraphGet(url);
  // isset($data['error']): present and not null.
  if (isEmpty(data) || (data.error !== undefined && data.error !== null)) {
    return null;
  }
  return data;
}

/**
 * Turns Meta's `field_data` ([{name, values:[...]}, ...]) into lead input.
 * Unrecognised questions are preserved as custom-field values rather than
 * dropped, so nothing the advertiser asked for is lost.
 */
export function metaMapFieldData(fieldData) {
  const input = { customFields: {} };
  for (const field of phpValues(fieldData)) {
    const name = phpTrim(str(field?.name ?? '')).toLowerCase();
    const value = phpTrim(str(phpValues(field?.values)[0] ?? ''));
    if (name === '' || value === '') {
      continue;
    }
    const target = Object.prototype.hasOwnProperty.call(META_FIELD_ALIASES, name) ? META_FIELD_ALIASES[name] : null;
    if (target === 'firstName' && name === 'full_name' && value.includes(' ')) {
      // Meta returns answers in form order, so full_name can arrive after
      // first_name. The more specific answer wins either way.
      if (isEmpty(input.firstName)) {
        const parts = value.split(/\s+/);
        input.firstName = parts.shift();
        if (isEmpty(input.lastName)) {
          input.lastName = parts.join(' ');
        }
      }
      continue;
    }
    if (target) {
      if (isEmpty(input[target])) {
        input[target] = value;
      }
    } else {
      input.customFields[name] = value;
    }
  }
  return input;
}

/**
 * Processes a single `leadgen` change entry.
 *
 * @returns {Promise<{status: string, leadId?: string, message?: string}>}
 */
export async function metaProcessLeadgen(change, rawEntry) {
  const value = change?.value ?? {};
  const leadgenId = str(value?.leadgen_id ?? '');
  const pageId = str(value?.page_id ?? '');
  const formId = str(value?.form_id ?? '');

  const eventId = gvId();
  let mapping = (!isEmpty(pageId) && !isEmpty(formId))
    ? await dbOne('SELECT * FROM meta_lead_forms WHERE meta_page_id = ? AND meta_form_id = ?', [pageId, formId])
    : null;

  // Fall back to the page.
  //
  // Connecting a page that has no form yet stores a placeholder row keyed
  // "page-<id>", and the promise made at that moment is that the first form
  // published afterwards starts delivering by itself. It did not: the lookup
  // above needs an exact form id, so a real lead against a form created later
  // matched nothing and was dropped as UNMAPPED - silently, because a dropped
  // webhook looks like no webhook. The page is what Facebook subscribed and
  // the page token is what reads the lead, so the page is the right thing to
  // fall back to.
  let viaPage = false;
  if (!mapping && !isEmpty(pageId)) {
    mapping = await dbOne(
      'SELECT * FROM meta_lead_forms WHERE meta_page_id = ? AND meta_form_id = ? LIMIT 1',
      [pageId, 'page-' + pageId]
    );
    if (!mapping) {
      // Any active row for this page will do; they all carry the same
      // page access token, which is what actually fetches the lead.
      mapping = await dbOne(
        'SELECT * FROM meta_lead_forms WHERE meta_page_id = ? AND is_active = 1 ORDER BY created_at LIMIT 1',
        [pageId]
      );
    }
    viaPage = Boolean(mapping);
    if (viaPage) {
      // Worth a line in the log: it means a form exists on Facebook that
      // the CRM has never been told about by name.
      console.error(`[meta] lead for unknown form ${formId} matched via page ${pageId}`);
    }
  }

  await dbExec(
    `INSERT INTO meta_webhook_events (id, organization_id, meta_page_id, meta_form_id, meta_lead_id, raw_payload, status, created_at)
     VALUES (?,?,?,?,?,?,?,NOW())`,
    [
      eventId,
      mapping?.organization_id ?? null,
      !isEmpty(pageId) ? pageId : null,
      !isEmpty(formId) ? formId : null,
      !isEmpty(leadgenId) ? leadgenId : null,
      toJson(rawEntry),
      'RECEIVED',
    ]
  );

  const fail = async (status, message) => {
    await dbExec(
      'UPDATE meta_webhook_events SET status = ?, error = ?, processed_at = NOW() WHERE id = ?',
      [status, String(message).slice(0, 500), eventId]
    );
    console.error(`[meta] ${status}: ${message}`);
    return { status, message };
  };

  if (isEmpty(leadgenId)) {
    return fail('INVALID', 'Change payload had no leadgen_id');
  }
  if (!mapping) {
    return fail('UNMAPPED', `Facebook delivered a lead for page ${pageId} (form ${formId}), but no page in this CRM is connected to it. Press Connect Facebook on the Integrations screen and tick that page.`);
  }
  if (!gvBool(mapping.is_active)) {
    return fail('INACTIVE', 'That Meta form is connected but paused.');
  }

  // Meta retries a delivery until it gets a 200; the platform lead id is the
  // natural idempotency key.
  const existing = await dbOne('SELECT id FROM leads WHERE meta_lead_id = ?', [leadgenId]);
  if (existing) {
    await dbExec(
      'UPDATE meta_webhook_events SET status = ?, lead_id = ?, processed_at = NOW() WHERE id = ?',
      ['DUPLICATE', existing.id, eventId]
    );
    return { status: 'DUPLICATE', leadId: existing.id };
  }

  const token = gvDecrypt(mapping.page_access_token);
  if (!token) {
    return fail('NO_TOKEN', 'No page access token stored for that form. Reconnect the page under Integrations > Meta Ads.');
  }

  const fetched = await metaFetchLead(leadgenId, token);
  if (isEmpty(fetched) || !isEmpty(fetched.error)) {
    const message = fetched?.error?.message ?? 'Graph API did not return the lead.';
    await dbExec('UPDATE meta_lead_forms SET last_error = ? WHERE id = ?', [String(message).slice(0, 500), mapping.id]);
    return fail('FETCH_FAILED', message);
  }

  const input = metaMapFieldData(fetched.field_data ?? []);
  if (isEmpty(input.firstName)) {
    // Meta forms do not always ask for a name; fall back to something usable
    // rather than rejecting a real, paid-for lead.
    input.firstName = input.email ?? input.phone ?? 'Meta lead';
  }
  if (isEmpty(input.email) && isEmpty(input.phone)) {
    return fail('INCOMPLETE', 'That Meta form collected neither an email address nor a phone number.');
  }

  // Ad-level attribution, so marketing reports can tie revenue to the exact ad.
  input.metaLeadId = leadgenId;
  input.metaFormId = !isEmpty(formId) ? formId : (fetched.form_id ?? null);
  input.metaPageId = !isEmpty(pageId) ? pageId : null;
  input.metaAdId = fetched.ad_id ?? null;
  input.metaAdsetId = fetched.adset_id ?? null;
  input.metaCampaignId = fetched.campaign_id ?? null;
  input.utmSource = input.utmSource ?? 'meta';
  input.utmMedium = input.utmMedium ?? 'paid_social';
  input.medium = input.medium ?? 'paid_social';

  // The connected form decides routing; fall back to the meta_ads source so a
  // lead is never orphaned just because the mapping omitted one.
  let sourceId = mapping.source_id;
  if (!sourceId) {
    sourceId = await dbScalar(
      "SELECT id FROM lead_sources WHERE organization_id = ? AND `key` = 'meta_ads'",
      [mapping.organization_id]
    );
  }
  if (sourceId) {
    input.sourceId = sourceId;
  }

  // A Meta lead form cannot ask the buyer which tower they mean, so the
  // project is chosen once when the form is connected rather than guessed per
  // lead. Optional by design: an unattributed lead is still a lead, and it
  // surfaces under the "No project" filter for someone to put right.
  if (!isEmpty(mapping.project_id)) {
    input.projectId = mapping.project_id;
  }

  // Campaign attribution rides on the lead itself (meta_campaign_id above,
  // plus utm_campaign) rather than a CRM campaign object, which no longer
  // exists. Nothing is lost: the marketing report groups on exactly these.

  let result;
  try {
    result = await createLead(input, {
      organizationId: mapping.organization_id,
      origin: 'META',
      duplicatePolicy: 'FLAG',
      ownerId: mapping.assign_to_user_id || null,
      teamId: mapping.assign_to_team_id || null,
      skipAssignment: Boolean(mapping.assign_to_user_id),
    });
  } catch (err) {
    return fail('FAILED', err?.message ?? String(err));
  }

  await dbExec(
    'UPDATE meta_webhook_events SET status = ?, lead_id = ?, processed_at = NOW() WHERE id = ?',
    ['PROCESSED', result.lead.id, eventId]
  );
  await dbExec('UPDATE meta_lead_forms SET last_synced_at = NOW(), last_error = NULL WHERE id = ?', [mapping.id]);

  return { status: 'PROCESSED', leadId: result.lead.id };
}

/**
 * Walks a full webhook body ({object: 'page', entry: [...]}) and processes
 * every leadgen change it carries.
 */
export async function metaProcessWebhook(payload) {
  const results = [];
  for (const entry of phpValues(payload?.entry)) {
    for (const change of phpValues(entry?.changes)) {
      if ((change?.field ?? '') !== 'leadgen') {
        continue;
      }
      try {
        results.push(await metaProcessLeadgen(change, entry));
      } catch (err) {
        console.error('[meta] unhandled processing error: ' + (err?.message ?? err));
        results.push({ status: 'FAILED', message: err?.message ?? String(err) });
      }
    }
  }
  return results;
}
