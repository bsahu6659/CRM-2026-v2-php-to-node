/**
 * /webhooks/* — the two URLs Facebook calls. Port of webhooks/meta_leads.php
 * and webhooks/meta_oauth.php.
 *
 * Mounted in app.js behind express.raw(), with no session, CSRF or JSON
 * middleware: Meta signs the exact bytes it sends, so req.body arrives here as
 * a Buffer and is verified before anything parses it. Both the original PHP
 * file names (already registered in existing Meta app dashboards) and clean
 * aliases are served:
 *
 *   /webhooks/meta_leads.php  | /webhooks/meta-leads   Lead Ads deliveries
 *   /webhooks/meta_oauth.php  | /webhooks/meta-oauth   "Connect Facebook" return
 */

import express from 'express';
import config from '../config/index.js';
import { dbExec } from '../lib/db.js';
import { safeEqual } from '../lib/security.js';
import { gvId } from '../lib/util.js';
import { ah } from '../middleware/index.js';
import { flushDomainEvents } from '../services/events.js';
import { metaConnectComplete } from '../services/metaConnect.js';
import { metaJsonDecode, metaProcessWebhook, metaVerifySignature } from '../services/metaLeads.js';

const router = express.Router();

/** PHP rawurlencode(): RFC 3986, so !'()* are escaped too. */
function rawurlencode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** The request body exactly as it arrived; express.raw() leaves {} when there was none. */
function rawBody(req) {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

// ---------------------------------------------------------------------------
// Meta (Facebook / Instagram) Lead Ads webhook endpoint.
//
// Configure this URL in the Meta app dashboard under
// Webhooks > Page > leadgen:
//
//     https://your-api-domain.com/webhooks/meta_leads.php
//
// GET  — Meta's subscription handshake. Answers hub.challenge when
//        hub.verify_token matches META_VERIFY_TOKEN from .env.
// POST — a delivery. The signature is verified against META_APP_SECRET before
//        the body is parsed, and we always answer 200 once the payload is
//        logged: Meta retries (and eventually disables) a subscription that
//        returns errors, and a per-lead failure is recorded in
//        meta_webhook_events rather than being pushed back at the platform.
// ---------------------------------------------------------------------------
router.all(['/meta_leads.php', '/meta-leads'], ah(async (req, res) => {
  const method = req.method ?? 'GET';

  try {
    if (method === 'GET') {
      // PHP turned "hub.mode" into hub_mode on the way into $_GET; Express
      // keeps the dot. Both spellings are accepted, as they were there.
      const q = req.query ?? {};
      const mode = q.hub_mode ?? q['hub.mode'] ?? null;
      const token = q.hub_verify_token ?? q['hub.verify_token'] ?? null;
      const challenge = q.hub_challenge ?? q['hub.challenge'] ?? '';
      const expected = String(config.meta.verifyToken ?? '');

      if (mode === 'subscribe' && expected !== '' && typeof token === 'string' && safeEqual(expected, token)) {
        res.status(200).set('Content-Type', 'text/plain; charset=utf-8');
        return res.send(String(challenge));
      }
      return res.status(403).json({
        error: { code: 'VERIFY_FAILED', message: 'hub.verify_token did not match META_VERIFY_TOKEN.' },
      });
    }

    if (method !== 'POST') {
      return res.status(405).json({
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET to verify or POST to deliver.' },
      });
    }

    const raw = rawBody(req);
    const signature = req.get('x-hub-signature-256') ?? null;

    if (!metaVerifySignature(raw, signature)) {
      // Record the attempt before refusing it.
      //
      // This used to write to the error log and nothing else, which made
      // a rejected delivery indistinguishable from no delivery: the events
      // list stayed empty either way, and "Facebook never called" and
      // "Facebook called and we turned it away" look identical from the
      // screen. They need completely different fixes, so the difference has
      // to be visible.
      //
      // No organisation is attached, because an unverified caller's claim
      // about which company it is cannot be trusted.
      try {
        await dbExec(
          `INSERT INTO meta_webhook_events (id, organization_id, meta_page_id, meta_form_id, meta_lead_id, raw_payload, status, error, created_at, processed_at)
           VALUES (?,NULL,NULL,NULL,NULL,?,?,?,NOW(),NOW())`,
          [
            gvId(),
            raw.toString('utf8').slice(0, 2000),
            signature ? 'BAD_SIGNATURE' : 'NO_SIGNATURE',
            signature
              ? 'A delivery arrived but X-Hub-Signature-256 did not match META_APP_SECRET. The app secret in .env is probably from a different app.'
              : 'A delivery arrived with no X-Hub-Signature-256 header at all.',
          ]
        );
      } catch (logError) {
        console.error('[meta] could not record the rejected delivery: ' + (logError?.message ?? logError));
      }

      console.error('[meta] rejected a delivery with an invalid or missing X-Hub-Signature-256');
      return res.status(401).json({ error: { code: 'BAD_SIGNATURE', message: 'Invalid signature.' } });
    }

    // Only now, with the signature proven over the raw bytes, is it parsed.
    const payload = metaJsonDecode(raw.toString('utf8'));
    if (payload === null || typeof payload !== 'object') {
      return res.status(400).json({ error: { code: 'BAD_PAYLOAD', message: 'Body was not valid JSON.' } });
    }

    // Acknowledge immediately, then do the Graph API round-trips after the
    // response has gone — Meta times a delivery out at ~20 seconds. This is
    // the fastcgi_finish_request() of the PHP edition: the handler simply
    // keeps running after res.json() has ended the response.
    res.status(200).json({ received: true });

    await metaProcessWebhook(payload);
    // Lead events raised while processing were queued on this request's
    // context; the response is already finished, so they are run here.
    await flushDomainEvents();
  } catch (err) {
    console.error('[meta] webhook handler error: ' + (err?.message ?? err));
    if (!res.headersSent) {
      // Never hand Meta an error it will retry forever.
      res.status(200).json({ received: true });
    }
  }
  return undefined;
}));

// ---------------------------------------------------------------------------
// Where Facebook returns the admin after they authorise the app.
//
// Register this exact URL (metaRedirectUri()) in the Meta app dashboard under
// Facebook Login > Settings > Valid OAuth Redirect URIs:
//
//     https://your-api-domain.com/webhooks/meta_oauth.php
//
// It is deliberately a redirector, not an API endpoint: a person's browser
// lands here, so it must end with them back inside the CRM looking at a screen
// that tells them what happened - never at a page of JSON.
//
// Nothing here trusts the caller, and no session is read: the `state` is the
// only thing that ties this request to the one that left the CRM, and it is
// checked against a hash held server-side, for one user, with a fifteen-minute
// life.
// ---------------------------------------------------------------------------

/**
 * Always end up on the integrations screen, with the outcome in the URL.
 *
 * The PHP edition sent people to APP_URL/index.html#/integrations, because the
 * same host served the SPA. Here the React app lives at CLIENT_URL with
 * BrowserRouter paths, and the API origin has no page to show a human, so the
 * browser goes to CLIENT_URL/integrations.
 */
function metaOauthBack(res, app, status, message = '') {
  const url = app + '/integrations?meta=' + rawurlencode(status)
    + (message !== '' ? '&reason=' + rawurlencode(String(message).slice(0, 300)) : '');
  res.status(302).set('Location', url).end();
}

router.all(['/meta_oauth.php', '/meta-oauth'], ah(async (req, res) => {
  const app = String(config.clientUrl ?? '').replace(/\/+$/, '');
  const q = req.query ?? {};

  // The admin pressed Cancel on Facebook's screen, or declined a permission.
  if (q.error !== undefined) {
    const reason = String(q.error_description ?? q.error ?? 'Authorisation was cancelled.');
    return metaOauthBack(res, app, 'cancelled', reason);
  }

  const code = String(q.code ?? '');
  const state = String(q.state ?? '');

  if (code === '' || state === '') {
    return metaOauthBack(res, app, 'failed', 'Facebook did not return an authorisation code.');
  }

  try {
    await metaConnectComplete(state, code);
  } catch (err) {
    console.error('[meta-oauth] ' + (err?.message ?? err));
    return metaOauthBack(res, app, 'failed', err?.message ?? String(err));
  }
  // Success only means "we hold a token"; the admin still has to choose which
  // of their pages belongs in this CRM, which the screen prompts for next.
  return metaOauthBack(res, app, 'choose');
}));

export default router;
