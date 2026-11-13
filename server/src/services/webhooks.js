/**
 * Outbound webhooks — port of services/Webhooks.php.
 *
 * Every delivery is recorded (status, body, duration) so an integrator can
 * debug their endpoint from the CRM. Payloads are HMAC-SHA256 signed with the
 * webhook's own secret and sent as `X-Growvanta-Signature`, so the receiver
 * can verify the call really came from us.
 *
 * Delivery runs from a domain-event listener, which the event bus only
 * dispatches after the response has been sent, so the retry/backoff loop
 * below never makes the user wait.
 */

import { dbAll, dbExec } from '../lib/db.js';
import { signWebhookPayload } from '../lib/security.js';
import { gvId, safeJson, toJson } from '../lib/util.js';
import { GV_EVENTS, onDomainEvent } from './events.js';

export const GV_WEBHOOK_EVENTS = [
  'lead.created', 'lead.updated', 'lead.assigned', 'lead.status_changed', 'lead.converted',
  'task.created', 'task.completed',
];

export const GV_WEBHOOK_TIMEOUT_MS = 8000;
export const GV_WEBHOOK_MAX_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs the payload, retrying up to GV_WEBHOOK_MAX_ATTEMPTS times with a
 * linear backoff. Returns { ok, statusCode? , error? }.
 *
 * The AbortController timeout covers connect AND the whole response, as
 * curl's CURLOPT_TIMEOUT_MS did; redirects are not followed (a 3xx is a
 * failed delivery), matching CURLOPT_FOLLOWLOCATION => false.
 */
export async function deliverWebhook(webhook, event, payload) {
  const body = toJson({
    event,
    firedAt: new Date().toISOString(),
    organizationId: webhook.organization_id,
    data: payload,
  });
  const signature = signWebhookPayload(webhook.secret, body);

  let attempt = 0;
  let lastError = null;
  let statusCode = null;

  while (attempt < GV_WEBHOOK_MAX_ATTEMPTS) {
    attempt++;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GV_WEBHOOK_TIMEOUT_MS);

    let failure = null;
    let responseStatus = null;
    let responseText = '';
    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Growvanta-CRM-Webhook/1.0',
          'X-Growvanta-Event': event,
          'X-Growvanta-Signature': `sha256=${signature}`,
          'X-Growvanta-Delivery-Attempt': String(attempt),
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      responseStatus = res.status;
      // Read inside the timeout too: curl counted the body against the limit,
      // and an endpoint that trickles its reply must not hold the worker.
      responseText = await res.text();
    } catch (err) {
      failure = err;
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Math.round(Date.now() - startedAt);

    if (failure) {
      lastError = controller.signal.aborted || failure?.name === 'AbortError'
        ? 'Timed out'
        : (failure?.cause?.message ?? failure?.message ?? String(failure));
      try {
        await dbExec(
          'INSERT INTO webhook_deliveries (id, webhook_id, event, payload, error, attempt, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,NOW())',
          [gvId(), webhook.id, event, body, lastError, attempt, durationMs]
        );
      } catch (err) {
        console.error(`[webhooks] failed to log delivery: ${err?.message ?? err}`);
      }
    } else {
      statusCode = responseStatus;
      const responseSnippet = String(responseText ?? '').slice(0, 500);
      await dbExec(
        'INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status_code, response, attempt, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,NOW())',
        [gvId(), webhook.id, event, body, statusCode, responseSnippet, attempt, durationMs]
      );
      if (statusCode >= 200 && statusCode < 300) {
        await dbExec('UPDATE webhooks SET failure_count = 0, last_status = ?, last_fired_at = NOW() WHERE id = ?', [statusCode, webhook.id]);
        return { ok: true, statusCode };
      }
      lastError = `HTTP ${statusCode}`;
    }

    if (attempt < GV_WEBHOOK_MAX_ATTEMPTS) {
      await sleep(500 * attempt);
    }
  }

  try {
    await dbExec(
      'UPDATE webhooks SET failure_count = failure_count + 1, last_status = ?, last_fired_at = NOW() WHERE id = ?',
      [statusCode, webhook.id]
    );
  } catch (err) {
    console.error(`[webhooks] failed to update failure count: ${err?.message ?? err}`);
  }
  return { ok: false, error: lastError };
}

export async function dispatchWebhooks(event, orgId, data) {
  const hooks = await dbAll('SELECT * FROM webhooks WHERE organization_id = ? AND is_active = 1', [orgId]);
  for (const hook of hooks) {
    const decoded = safeJson(hook.events, []);
    const events = Array.isArray(decoded)
      ? decoded
      : (decoded !== null && typeof decoded === 'object' ? Object.values(decoded) : []);
    if (!events.includes(event) && !events.includes('*')) {
      continue;
    }
    try {
      await deliverWebhook(hook, event, data);
    } catch (err) {
      console.error(`[webhooks] delivery failed ${hook.url}: ${err?.message ?? err}`);
    }
  }
}

/** Test fire used by the admin UI's "Send test event" button. */
export async function sendTestWebhook(webhook) {
  return deliverWebhook(webhook, 'lead.created', {
    id: 'test_lead_id', code: 'LD-TEST', firstName: 'Test', lastName: 'Lead',
    email: 'test.lead@example.com', note: 'This is a test delivery from Growvanta CRM.',
  });
}

export function registerWebhookListeners() {
  for (const event of GV_EVENTS) {
    if (!GV_WEBHOOK_EVENTS.includes(event)) {
      continue;
    }
    onDomainEvent(event, async (payload) => {
      const orgId = payload?.organizationId ?? null;
      if (!orgId) {
        return;
      }
      await dispatchWebhooks(event, orgId, payload.data ?? null);
    });
  }
}
