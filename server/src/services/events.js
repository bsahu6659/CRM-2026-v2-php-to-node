/**
 * Domain event bus — port of services/Events.php.
 *
 * Inside a request, emitted events are queued and only dispatched once the
 * response has gone out, exactly as the PHP edition did with
 * fastcgi_finish_request(): the user never waits on automation, webhooks or
 * notifications. Outside a request (cron sweep, inbound webhooks, scripts)
 * there is no response to wait for, so they dispatch on the next tick.
 */

import { afterResponse, currentContext } from '../lib/context.js';
import { outsideTransaction } from '../lib/db.js';

// A real-estate CRM has one lifecycle: the lead. "Converted" means booked,
// which is a lead status - there is no separate deal object to raise events
// for, and no task, contact or account to create.
export const GV_EVENTS = [
  'lead.created', 'lead.updated', 'lead.status_changed', 'lead.assigned',
  'lead.converted', 'lead.merged', 'lead.deleted',
  'project.created', 'project.updated',
];

const listeners = new Map();
const pending = new Set();

export function onDomainEvent(name, handler) {
  if (!listeners.has(name)) listeners.set(name, []);
  listeners.get(name).push(handler);
}

function dispatch(name, payload) {
  return outsideTransaction(async () => {
    for (const handler of listeners.get(name) ?? []) {
      try {
        await handler(payload);
      } catch (err) {
        console.error(`[events] handler threw for ${name}:`, err?.message ?? err);
      }
    }
  });
}

function track(promise) {
  pending.add(promise);
  promise.finally(() => pending.delete(promise));
  return promise;
}

async function runQueue(queue) {
  const items = queue.splice(0);
  for (const [name, payload] of items) {
    await track(dispatch(name, payload));
  }
}

/** Queues a payload; it runs once the current response has been sent. */
export function emitDomainEvent(name, payload) {
  if (!GV_EVENTS.includes(name)) {
    console.error(`[events] unknown event emitted: ${name}`);
  }
  const ctx = currentContext();
  if (ctx) {
    if (ctx.events.length === 0) afterResponse(() => runQueue(ctx.events));
    ctx.events.push([name, payload]);
    return;
  }
  track(dispatch(name, payload));
}

/** Drains whatever the current request has queued, right now. */
export async function flushDomainEvents() {
  const ctx = currentContext();
  if (ctx) await runQueue(ctx.events);
}

/**
 * Waits for every in-flight handler. One-shot scripts (the sweep) call this
 * before exiting so a queued notification is not cut off mid-send.
 */
export async function drainDomainEvents() {
  while (pending.size) {
    await Promise.allSettled([...pending]);
  }
}
