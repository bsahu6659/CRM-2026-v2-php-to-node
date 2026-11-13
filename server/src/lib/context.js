/**
 * Request-scoped context.
 *
 * The PHP edition reached the signed-in user and the pending domain events
 * through globals ($GLOBALS['GV_ACTOR'], $GLOBALS['GV_EVENT_QUEUE']) from
 * anywhere in the call stack. One Node process serves many requests at once,
 * so the equivalent lives in AsyncLocalStorage: each request runs inside its
 * own store, and a service several calls deep can still ask "who is acting"
 * without a `req` argument threaded through every signature.
 *
 * Mounted after the body and cookie parsers on purpose: those finish on
 * stream callbacks, which do not reliably carry async context.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { outsideTransaction } from './db.js';

const storage = new AsyncLocalStorage();

export function requestContext(req, res, next) {
  const store = { req, events: [], onFinish: [] };
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    const hooks = store.onFinish.splice(0);
    // Run outside the request's store: anything a hook emits is dispatched on
    // its own rather than queued onto a request that has already ended.
    storage.exit(() =>
      outsideTransaction(() => {
        for (const hook of hooks) {
          setImmediate(() => {
            Promise.resolve()
              .then(hook)
              .catch((err) => console.error('[context] after-response hook failed:', err));
          });
        }
      })
    );
  };
  res.on('finish', done);
  res.on('close', done);
  storage.run(store, () => next());
}

export function currentContext() {
  return storage.getStore() ?? null;
}

export function currentRequest() {
  return storage.getStore()?.req ?? null;
}

/** The PHP edition's actor(): the signed-in user for this request, or null. */
export function currentActor() {
  return currentRequest()?.actor ?? null;
}

/**
 * Runs `fn` once the response has been sent — the Node counterpart of
 * fastcgi_finish_request() followed by more work. Outside a request (cron,
 * scripts) it simply runs on the next tick.
 */
export function afterResponse(fn) {
  const store = storage.getStore();
  if (store) {
    store.onFinish.push(fn);
    return;
  }
  outsideTransaction(() =>
    setImmediate(() => {
      Promise.resolve()
        .then(fn)
        .catch((err) => console.error('[context] deferred task failed:', err));
    })
  );
}
