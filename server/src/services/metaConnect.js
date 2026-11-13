/**
 * "Connect Facebook" - one app, many client companies. Port of
 * services/MetaConnect.php.
 *
 * A CRM that serves several property firms cannot hold one Facebook page's
 * token. Each company has its own page and its own lead forms, so each company
 * authorises this app on its own account and the CRM keeps that company's token
 * against that company's row.
 *
 * The round trip:
 *
 *   1. metaConnectStart()      - mints a state, returns the Facebook URL
 *   2. the admin authorises on facebook.com and picks their page
 *   3. /webhooks/meta_oauth.php - Facebook returns a code to a fixed callback
 *   4. metaConnectComplete()   - code -> user token -> LONG-LIVED user token
 *   5. metaConnectPages()      - lists the pages that person administers
 *   6. metaConnectAttach()     - stores the page token and SUBSCRIBES the page
 *
 * Step 6's subscription is the one that is easy to leave out and impossible to
 * notice: a page can be connected, its token valid, its forms listed, and not
 * one lead will ever arrive until the page is subscribed to the app's leadgen
 * field. So it is done here, and recorded, rather than assumed.
 */

import config from '../config/index.js';
import { dbAll, dbExec, dbOne, dbScalar } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';
import { auditRecord } from '../lib/audit.js';
import { currentRequest } from '../lib/context.js';
import { gvDecrypt, gvEncrypt, randomToken, sha256 } from '../lib/security.js';
import { gvId, nowSql, toSqlDateTime } from '../lib/util.js';
import { metaGraphGet, metaJsonDecode } from './metaLeads.js';

// business_management is what lets /me/businesses return pages a person reaches through a
// business portfolio. Without it, a page owned by a portfolio never appears in the picker.
// pages_manage_ads is what /{page}/leadgen_forms requires; without it the form list comes
// back empty and the page is stored as a single "all forms" entry, so forms cannot be told
// apart for project routing.
export const META_CONNECT_SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_metadata,leads_retrieval,business_management,pages_manage_ads';

// ---------------------------------------------------------------------------
// Local stand-ins for PHP built-ins.
// ---------------------------------------------------------------------------

/** PHP empty(); a decoded JSON object is a PHP array, so {} counts as empty. */
function isEmpty(value) {
  if (value === null || value === undefined || value === false) return true;
  if (value === '' || value === '0' || value === 0) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** PHP isset() on one value: present and not null. */
function isSet(value) {
  return value !== undefined && value !== null;
}

/** foreach over a PHP array: lists and keyed arrays both yield their values. */
function phpValues(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return Object.values(value);
  return [];
}

/** PHP count() on a decoded JSON value. */
function phpCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === 'object') return Object.keys(value).length;
  return value === null || value === undefined ? 0 : 1;
}

/** PHP urlencode(), the encoding http_build_query() uses. */
function urlencode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

/** PHP http_build_query() for a flat array; null entries are skipped as PHP does. */
function httpBuildQuery(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${urlencode(k)}=${urlencode(typeof v === 'boolean' ? (v ? '1' : '0') : v)}`)
    .join('&');
}

/** gmdate('c'): ISO 8601 in UTC with an explicit +00:00 offset. */
function gmdateC() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// ---------------------------------------------------------------------------

/** Where Facebook sends the browser back. Must match the app's whitelist exactly. */
export function metaRedirectUri() {
  return String(config.appUrl ?? '').replace(/\/+$/, '') + '/webhooks/meta_oauth.php';
}

export function metaGraphVersion() {
  return String(config.meta.graphVersion || 'v19.0');
}

/** One POST to the Graph API. */
export async function metaGraphPost(url, fields) {
  let status;
  let response;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: httpBuildQuery(fields),
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    response = await res.text();
  } catch (err) {
    console.error(`[meta-connect] POST failed: ${err?.cause?.message ?? err?.message ?? err}`);
    return null;
  }
  const decoded = metaJsonDecode(response);
  if (status >= 400) {
    console.error(`[meta-connect] POST HTTP ${status}: ${String(response).slice(0, 300)}`);
  }
  return decoded !== null && typeof decoded === 'object' ? decoded : null;
}

/**
 * Step 1. Returns the URL to send the admin to.
 *
 * The state is random, hashed at rest, tied to one organisation and one user,
 * and dies in fifteen minutes - long enough to sign in to Facebook, short
 * enough that an abandoned attempt cannot be picked up later.
 */
export async function metaConnectStart(orgId, userId) {
  const appId = String(config.meta.appId ?? '');
  if (appId === '' || String(config.meta.appSecret ?? '') === '') {
    throw badRequest('Facebook is not set up on this server yet - META_APP_ID and META_APP_SECRET are missing from .env.');
  }

  // One live attempt per user; a second press replaces the first.
  await dbExec("DELETE FROM meta_oauth_states WHERE user_id = ? AND status <> 'USED'", [userId]);

  const state = randomToken(32);
  await dbExec(
    `INSERT INTO meta_oauth_states (id, organization_id, user_id, state_hash, status, expires_at, created_at)
     VALUES (?,?,?,?,?,?,NOW())`,
    [gvId(), orgId, userId, sha256(state), 'PENDING', toSqlDateTime(new Date(Date.now() + 900 * 1000))]
  );

  const url = 'https://www.facebook.com/' + metaGraphVersion() + '/dialog/oauth?' + httpBuildQuery({
    client_id: appId,
    redirect_uri: metaRedirectUri(),
    scope: META_CONNECT_SCOPES,
    response_type: 'code',
    state,
  });

  return { url, expiresIn: 900 };
}

/**
 * Step 4. Turns the returned code into a long-lived user token.
 *
 * Both exchanges matter. The first gives a token that dies within the hour; the
 * second is what makes the page tokens derived from it permanent. Skipping it
 * produces an integration that works all afternoon and is dead by morning.
 */
export async function metaConnectComplete(state, code) {
  const row = await dbOne(
    "SELECT * FROM meta_oauth_states WHERE state_hash = ? AND status = 'PENDING' AND expires_at > NOW()",
    [sha256(state)]
  );
  if (!row) {
    throw badRequest('That Facebook link has expired. Start the connection again from the CRM.');
  }

  const v = metaGraphVersion();
  const appId = String(config.meta.appId ?? '');
  const appSecret = String(config.meta.appSecret ?? '');

  const short = await metaGraphGet(`https://graph.facebook.com/${v}/oauth/access_token?` + httpBuildQuery({
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: metaRedirectUri(),
    code,
  }));
  if (isEmpty(short?.access_token)) {
    const why = String(short?.error?.message ?? 'Facebook did not return an access token.');
    await dbExec('UPDATE meta_oauth_states SET status = ?, error = ? WHERE id = ?', ['FAILED', why.slice(0, 400), row.id]);
    throw badRequest(why);
  }

  const long = await metaGraphGet(`https://graph.facebook.com/${v}/oauth/access_token?` + httpBuildQuery({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: short.access_token,
  }));
  // If the exchange fails we keep going with the short-lived token rather
  // than losing the whole attempt - but the page tokens it yields will expire,
  // so the failure is recorded where support can find it.
  const userToken = long?.access_token ?? short.access_token;
  if (isEmpty(long?.access_token)) {
    console.error('[meta-connect] long-lived exchange failed; page tokens will expire');
  }

  await dbExec(
    'UPDATE meta_oauth_states SET status = ?, user_token_enc = ?, expires_at = ? WHERE id = ?',
    ['AUTHORISED', gvEncrypt(userToken), toSqlDateTime(new Date(Date.now() + 900 * 1000)), row.id]
  );

  return { organizationId: row.organization_id, userId: row.user_id, stateId: row.id };
}

/** The pending authorisation for this user, if one is waiting for page choice. */
export async function metaConnectPending(userId) {
  return dbOne(
    `SELECT * FROM meta_oauth_states WHERE user_id = ? AND status = 'AUTHORISED' AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
}

/**
 * Every page this person can manage, keyed by page id, each with its page token.
 *
 * /me/accounts only lists pages where the person holds a role on the page itself.
 * Pages owned by a business portfolio, which the person manages through that
 * portfolio, are missing from it - so the portfolio's owned and client pages are
 * merged in. A page found both ways keeps the /me/accounts entry.
 */
export async function metaUserPages(userToken) {
  const v = metaGraphVersion();
  const byId = {};

  const res = await metaGraphGet(`https://graph.facebook.com/${v}/me/accounts?` + httpBuildQuery({
    fields: 'id,name,access_token', limit: 100, access_token: userToken,
  }));
  if (!isSet(res?.data)) {
    const why = String(res?.error?.message ?? 'Facebook did not return any pages.');
    throw badRequest(why);
  }
  for (const p of phpValues(res.data)) {
    byId[p?.id ?? ''] = p;
  }

  // Best effort: an authorisation made before business_management was requested
  // simply returns an error here, and the /me/accounts pages still work.
  const biz = await metaGraphGet(`https://graph.facebook.com/${v}/me/businesses?` + httpBuildQuery({
    fields: 'id,name,owned_pages.limit(100){id,name,access_token},client_pages.limit(100){id,name,access_token}',
    limit: 50,
    access_token: userToken,
  }));
  if (!isSet(biz?.data)) {
    console.error('[meta-connect] business pages unavailable: ' + (biz?.error?.message ?? 'no data'));
  }
  for (const b of phpValues(biz?.data)) {
    for (const edge of ['owned_pages', 'client_pages']) {
      for (const p of phpValues(b?.[edge]?.data)) {
        if (!Object.prototype.hasOwnProperty.call(byId, p?.id ?? '') && !isEmpty(p?.access_token)) {
          byId[p.id] = p;
        }
      }
    }
  }

  return byId;
}

/**
 * Step 5. Every page this person administers, with what is already connected
 * marked, so the picker can show the truth rather than a blank list.
 */
export async function metaConnectPages(orgId, userId) {
  const pending = await metaConnectPending(userId);
  if (!pending) {
    throw badRequest('Connect Facebook first - there is no authorisation waiting.');
  }
  const token = String(gvDecrypt(pending.user_token_enc) ?? '');
  const v = metaGraphVersion();

  const userPages = await metaUserPages(token);

  const connected = (
    await dbAll('SELECT DISTINCT meta_page_id FROM meta_lead_forms WHERE organization_id = ?', [orgId])
  ).map((r) => r.meta_page_id);

  const pages = [];
  for (const p of Object.values(userPages)) {
    // The form count is what tells an admin they picked the right page.
    const forms = await metaGraphGet(`https://graph.facebook.com/${v}/${p.id}/leadgen_forms?` + httpBuildQuery({
      fields: 'id,name,status',
      limit: 100,
      access_token: p.access_token ?? token,
    }));
    pages.push({
      id: p.id,
      name: p.name ?? p.id,
      formCount: isSet(forms?.data) ? phpCount(forms.data) : 0,
      alreadyConnected: connected.includes(p.id),
    });
  }
  return pages;
}

/**
 * Step 6. Stores the chosen pages and subscribes each one.
 *
 * Every lead form on the page is recorded, so a form the customer adds next
 * month arrives without anybody touching the CRM - the webhook carries the form
 * id and the page is what was subscribed.
 */
export async function metaConnectAttach(orgId, userId, pageIds, actor = null) {
  const pending = await metaConnectPending(userId);
  if (!pending) {
    throw badRequest('Connect Facebook first - there is no authorisation waiting.');
  }
  const userToken = String(gvDecrypt(pending.user_token_enc) ?? '');
  const v = metaGraphVersion();

  const byId = await metaUserPages(userToken);

  const sourceId = await dbScalar(
    "SELECT id FROM lead_sources WHERE organization_id = ? AND `key` = 'meta_ads'",
    [orgId]
  );

  const result = { pages: 0, forms: 0, problems: [] };

  for (const pageId of pageIds) {
    // Own keys only: a page id of "constructor" must not resolve to a
    // function on Object.prototype.
    const page = Object.prototype.hasOwnProperty.call(byId, pageId) ? byId[pageId] : null;
    if (!page || isEmpty(page.access_token)) {
      result.problems.push(`No access to page ${pageId}.`);
      continue;
    }
    const pageToken = String(page.access_token);

    // THE step that makes leads arrive. Without it everything below looks
    // correct and the webhook is never called.
    const sub = await metaGraphPost(
      `https://graph.facebook.com/${v}/${pageId}/subscribed_apps`,
      { subscribed_fields: 'leadgen', access_token: pageToken }
    );
    const subscribed = !isEmpty(sub?.success);
    // Why it failed has to survive the request. A toast that fades after a
    // few seconds is no use to someone asking a week later why a page that
    // looks connected has never delivered a lead, so the reason is stored
    // against the page and shown on the card until it is fixed.
    const subError = subscribed
      ? null
      : String(sub?.error?.message ?? 'Could not subscribe this page to lead notifications.').slice(0, 400);
    if (!subscribed) {
      result.problems.push((page.name ?? pageId) + ': ' + subError);
    }

    const forms = await metaGraphGet(`https://graph.facebook.com/${v}/${pageId}/leadgen_forms?` + httpBuildQuery({
      fields: 'id,name,status', limit: 100, access_token: pageToken,
    }));
    let formList = forms?.data ?? [];

    // A page with no form yet is still worth connecting: it is subscribed,
    // so the first form the customer publishes starts delivering at once.
    if (isEmpty(formList)) {
      formList = [{ id: 'page-' + pageId, name: (page.name ?? pageId) + ' (all forms)' }];
    }

    for (const f of phpValues(formList)) {
      const existing = await dbOne(
        'SELECT id FROM meta_lead_forms WHERE meta_page_id = ? AND meta_form_id = ?',
        [pageId, f.id]
      );
      if (existing) {
        await dbExec(
          `UPDATE meta_lead_forms SET organization_id = ?, page_name = ?, form_name = ?,
                  page_access_token = ?, source_id = COALESCE(source_id, ?), is_active = 1,
                  subscribed_at = ?, last_error = ?, updated_at = NOW()
            WHERE id = ?`,
          [orgId, page.name ?? null, f.name ?? null, gvEncrypt(pageToken),
            sourceId, subscribed ? nowSql() : null, subError, existing.id]
        );
      } else {
        await dbExec(
          `INSERT INTO meta_lead_forms
             (id, organization_id, meta_page_id, page_name, meta_form_id, form_name,
              page_access_token, source_id, is_active, subscribed_at, last_error, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,1,?,?,NOW(),NOW())`,
          [gvId(), orgId, pageId, page.name ?? null, f.id, f.name ?? null,
            gvEncrypt(pageToken), sourceId, subscribed ? nowSql() : null, subError]
        );
      }
      result.forms++;
    }
    result.pages++;
  }

  // The user token could list every page this person administers, including
  // ones they did not connect. It has done its job.
  await dbExec("UPDATE meta_oauth_states SET status = 'USED', user_token_enc = NULL WHERE id = ?", [pending.id]);

  if (actor) {
    // The PHP audit_record() read the caller's IP and user agent from the
    // request globals; the request in context is the same thing here.
    await auditRecord(orgId, actor, 'meta.pages_connected', {
      entityType: 'INTEGRATION', entityLabel: 'Meta Lead Ads',
      changes: { pages: result.pages, forms: result.forms },
    }, currentRequest());
  }
  return result;
}

/**
 * Ask Facebook what is actually wrong.
 *
 * Every failure in this integration looks identical from the CRM: a page that
 * is connected, a card that looks healthy, and no leads. The cause is always on
 * Facebook's side - a permission that was never granted, an app whose webhook
 * was never subscribed, a page token that has expired - and none of it is
 * visible from here unless something asks.
 *
 * So this asks, using the app credentials already in .env. Nobody has to paste
 * a secret anywhere, and the answer comes back in words rather than as a
 * missing lead three weeks later.
 *
 * Read-only. It changes nothing on Facebook and nothing in the database.
 */
export async function metaConnectDiagnose(orgId) {
  const v = metaGraphVersion();
  const appId = String(config.meta.appId ?? '');
  const secret = String(config.meta.appSecret ?? '');
  const verify = String(config.meta.verifyToken ?? '');
  const appUrl = String(config.appUrl ?? '').replace(/\/+$/, '');
  const checks = [];

  const add = (name, state, detail, fix = '') => {
    checks.push({ name, state, detail, fix });
  };

  // ---- 1. is the server configured at all ----------------------------
  if (appId === '' || secret === '') {
    add('Server configuration', 'FAIL',
      'META_APP_ID or META_APP_SECRET is missing from .env.',
      'Add both from developers.facebook.com > your app > Settings > Basic.');
    return { checks, pages: [], ranAt: gmdateC() };
  }
  add('Server configuration', 'PASS', `App ID ${appId} is configured, and the app secret is present.`);

  add('Webhook verify token',
    verify === '' ? 'FAIL' : 'PASS',
    verify === ''
      ? 'META_VERIFY_TOKEN is empty, so Facebook cannot verify the webhook.'
      : 'META_VERIFY_TOKEN is set.',
    verify === '' ? 'Set any string in .env and paste the same value into Meta > Webhooks.' : '');

  // ---- 2. does the app itself listen for leadgen ----------------------
  // The step everyone forgets. A page can be subscribed to the app perfectly
  // while the APP is not subscribed to the leadgen field - and then Facebook
  // has nowhere to deliver to. It looks like nothing is wrong.
  const appToken = appId + '|' + secret;
  const subs = await metaGraphGet(`https://graph.facebook.com/${v}/${appId}/subscriptions?`
    + httpBuildQuery({ access_token: appToken }));

  if (!isSet(subs?.data)) {
    add('App webhook subscription', 'FAIL',
      'Facebook refused the request: ' + (subs?.error?.message ?? 'no answer from the Graph API.'),
      'Usually the app secret in .env does not match the app. Check Settings > Basic.');
  } else {
    let page = null;
    for (const row of phpValues(subs.data)) {
      if ((row?.object ?? '') === 'page') {
        page = row;
      }
    }
    if (!page) {
      add('App webhook subscription', 'FAIL',
        'This app has no Page webhook at all, so Facebook has nowhere to send leads.',
        'Meta app dashboard > Webhooks > Page > Subscribe, callback '
        + `${appUrl}/webhooks/meta_leads.php, and tick the leadgen field.`);
    } else {
      // array_column(): rows without a name are skipped.
      const fields = phpValues(page.fields ?? [])
        .filter((f) => f !== null && typeof f === 'object' && Object.prototype.hasOwnProperty.call(f, 'name'))
        .map((f) => f.name);
      const hasLeadgen = fields.includes('leadgen');
      const callback = String(page.callback_url ?? '');
      const expected = `${appUrl}/webhooks/meta_leads.php`;

      add('App webhook subscription',
        hasLeadgen ? 'PASS' : 'FAIL',
        hasLeadgen
          ? 'The app is subscribed to the Page leadgen field.'
          : 'The Page webhook exists but leadgen is NOT among its fields ('
            + (fields.join(', ') || 'none') + ').',
        hasLeadgen ? '' : 'Meta app dashboard > Webhooks > Page > Subscribe to the leadgen field.');

      add('Webhook callback URL',
        callback === expected ? 'PASS' : 'FAIL',
        callback === expected
          ? `Facebook will deliver to ${callback}`
          : `Facebook is delivering to "${callback}", but this server answers at "${expected}".`,
        callback === expected ? '' : `Change the callback URL in the Meta app dashboard to ${expected}`);

      if (Object.prototype.hasOwnProperty.call(page, 'active') && isEmpty(page.active)) {
        add('Webhook status', 'FAIL',
          'Facebook has marked this webhook inactive, which it does after repeated delivery failures.',
          'Fix the callback URL, then re-subscribe in the Meta app dashboard.');
      }
    }
  }

  // ---- 2b. has Facebook ever actually called this server --------------
  // The subscription can be perfect and the deliveries still not arrive.
  // Only the receiving end knows, so ask it.
  // Scoped to this company, and to the pages it has connected.
  //
  // An unmapped delivery carries no organisation_id, so counting every row
  // would have shown one customer how much traffic another customer's pages
  // receive. Matching on their own page ids as well keeps their own dropped
  // deliveries visible without exposing anyone else's.
  const ownPages = (
    await dbAll('SELECT DISTINCT meta_page_id FROM meta_lead_forms WHERE organization_id = ?', [orgId])
  ).map((r) => r.meta_page_id);
  let params = [orgId];
  let pageClause = '';
  if (ownPages.length) {
    pageClause = ' OR meta_page_id IN (' + ownPages.map(() => '?').join(',') + ')';
    params = [...params, ...ownPages];
  }
  const recent = await dbAll(
    `SELECT status, COUNT(*) AS n, MAX(created_at) AS last_at
       FROM meta_webhook_events
      WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
        AND (organization_id = ?${pageClause})
   GROUP BY status`,
    params
  );
  const total = recent.reduce((sum, r) => sum + Number(r.n), 0);
  const byStatus = recent.map((r) => r.status + ': ' + r.n);
  let bad = 0;
  for (const r of recent) {
    if (['BAD_SIGNATURE', 'NO_SIGNATURE'].includes(r.status)) {
      bad += Number.parseInt(String(r.n), 10) || 0;
    }
  }

  if (total === 0) {
    add('Deliveries received', 'FAIL',
      'Facebook has not called this server once in the last 7 days.',
      'If a lead was submitted in that time, the delivery is not reaching the '
      + 'server at all. Check that ' + appUrl + '/webhooks/meta_leads.php is '
      + 'reachable from outside, and that no firewall or security rule is '
      + 'blocking POST requests to it.');
  } else if (bad > 0) {
    add('Deliveries received', 'FAIL',
      `${total} delivery attempt(s) in the last 7 days, but ${bad} were refused for a bad signature (`
      + byStatus.join(', ') + ').',
      'META_APP_SECRET in .env does not match the app that is sending. Copy it '
      + 'again from Settings > Basic and paste it into .env.');
  } else {
    add('Deliveries received', 'PASS',
      `${total} delivery(ies) reached this server in the last 7 days (` + byStatus.join(', ') + ').');
  }

  // ---- 3. is the OAuth redirect URI going to match --------------------
  add('OAuth redirect URI', 'INFO',
    'This exact value must be listed under Facebook Login > Settings > Valid OAuth Redirect URIs: '
    + metaRedirectUri());

  // ---- 4. each connected page, as Facebook sees it --------------------
  const rows = await dbAll(
    `SELECT meta_page_id, page_name, page_access_token, subscribed_at, last_error,
            COUNT(*) AS form_count
       FROM meta_lead_forms
      WHERE organization_id = ?
   GROUP BY meta_page_id, page_name, page_access_token, subscribed_at, last_error`,
    [orgId]
  );

  const pages = [];
  for (const r of rows) {
    const pageId = String(r.meta_page_id ?? '');
    const token = gvDecrypt(r.page_access_token);
    const entry = {
      pageId,
      name: r.page_name || pageId,
      formCount: Number.parseInt(String(r.form_count), 10) || 0,
      storedError: r.last_error || null,
      problems: [],
    };

    if (!token) {
      entry.problems.push('No usable access token is stored for this page. Connect it again.');
      pages.push(entry);
      continue;
    }

    // Is the token still alive? An expired page token is silent: every call
    // just fails, and the CRM has no reason to notice.
    const me = await metaGraphGet(`https://graph.facebook.com/${v}/${pageId}?`
      + httpBuildQuery({ fields: 'id,name', access_token: token }));
    if (!isSet(me?.id)) {
      entry.problems.push('The stored access token no longer works: '
        + (me?.error?.message ?? 'Facebook rejected it.')
        + ' Press Connect Facebook again.');
      pages.push(entry);
      continue;
    }
    entry.name = me.name ?? entry.name;

    // THE check. Is this page actually subscribed to THIS app for leadgen?
    const sub = await metaGraphGet(`https://graph.facebook.com/${v}/${pageId}/subscribed_apps?`
      + httpBuildQuery({ access_token: token }));
    if (!isSet(sub?.data)) {
      entry.problems.push('Could not read this page\'s app subscriptions: '
        + (sub?.error?.message ?? 'no answer from Facebook.')
        + ' This normally means the pages_manage_metadata permission was not granted.');
    } else {
      let mine = null;
      for (const app of phpValues(sub.data)) {
        if (String(app?.id ?? '') === appId) {
          mine = app;
        }
      }
      if (!mine) {
        entry.problems.push('This page is NOT subscribed to the app. '
          + 'Leads will never arrive, however healthy the page looks here.');
      } else {
        const f = mine.subscribed_fields ?? [];
        entry.subscribedFields = f;
        const fieldList = phpValues(f);
        if (!fieldList.includes('leadgen')) {
          entry.problems.push('The page is subscribed to the app, but not for the '
            + 'leadgen field (' + (fieldList.join(', ') || 'no fields') + ').');
        }
      }
    }

    entry.healthy = entry.problems.length === 0;
    pages.push(entry);
  }

  if (pages.length === 0) {
    add('Connected pages', 'INFO', 'No Facebook page is connected to this company yet.',
      'Press Connect Facebook above.');
  }

  return { checks, pages, ranAt: gmdateC() };
}

/**
 * Abandoned and spent attempts are rubbish; the sweep clears them.
 *
 * Runs inside the nightly cron, which must not die because migration 007 has
 * not been applied on a given install: tidying up Facebook state is the least
 * important thing that sweep does, and follow-up alerts are the most.
 */
export async function metaConnectSweep() {
  const where = "WHERE expires_at < NOW() OR status = 'USED'";
  let n;
  try {
    n = Number.parseInt(String(await dbScalar(`SELECT COUNT(*) FROM meta_oauth_states ${where}`)), 10) || 0;
    await dbExec(`DELETE FROM meta_oauth_states ${where}`);
  } catch (err) {
    console.error('[meta-connect] sweep skipped: ' + (err?.message ?? err));
    return { metaOauthStatesCleared: 0 };
  }
  return { metaOauthStatesCleared: n };
}
