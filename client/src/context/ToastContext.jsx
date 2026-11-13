import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError } from '../lib/api.js';

/**
 * Toasts.
 *
 * Port of `toast()` / `reportError()` from the PHP edition's ui.js, with the
 * same markup, timings and wording. Two ways in:
 *
 * - `useToast()` / `useReportError()` inside components;
 * - the module-level `toast` and `reportError` exports for plain helper
 *   functions (a shared confirm-then-delete, a clipboard helper) that are not
 *   components. They talk to the one mounted <ToastProvider>; anything sent
 *   before it has mounted is queued and shown as soon as it has.
 */
const ToastContext = createContext(null);

let nextId = 1;
let bridge = null;
const queued = [];

function show(title, { body = '', type = 'info', timeout = 4200 } = {}) {
  const item = { id: nextId++, title, body, type, timeout };
  if (bridge) bridge(item);
  else queued.push(item);
  return item.id;
}

/**
 * `toast(title, { body, type, timeout })` plus the shorthands. Returns the
 * toast id. `type` is 'info' | 'success' | 'error' | 'warning'; `timeout` in
 * ms, 0 keeps it until dismissed.
 */
export const toast = Object.assign(show, {
  success: (title, body) => show(title, { body, type: 'success' }),
  // Errors stay longer: they are usually something to act on.
  error: (title, body) => show(title, { body, type: 'error', timeout: 6500 }),
  warn: (title, body) => show(title, { body, type: 'warning' }),
  warning: (title, body) => show(title, { body, type: 'warning' }),
  info: (title, body) => show(title, { body, type: 'info' }),
});

/**
 * Turns any thrown error into a sensible toast. An aborted request is silent;
 * an API error shows the server's message with any validation `details`
 * joined underneath; anything else is also logged, because it is a bug.
 */
export function reportError(err, fallback = 'Something went wrong') {
  if (err?.name === 'AbortError') return;
  const message = err instanceof ApiError ? err.message : err?.message || fallback;
  const details = err instanceof ApiError && err.details ? err.details.map((d) => d.message).join(' · ') : '';
  toast.error(message, details);
  if (!(err instanceof ApiError)) console.error(err);
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const add = (item) => {
      setToasts((list) => [...list, item]);
      if (item.timeout) window.setTimeout(() => dismiss(item.id), item.timeout);
    };
    bridge = add;
    queued.splice(0).forEach(add);
    return () => {
      if (bridge === add) bridge = null;
    };
  }, [dismiss]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <div className="grow">
              <div className="t-title">{t.title}</div>
              {t.body ? <div className="t-body">{t.body}</div> : null}
            </div>
            <button type="button" className="t-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** The `toast` function object: `toast(title, opts)`, `toast.success(title, body)`, `.error`, `.warn`, `.warning`, `.info`. */
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

/** `reportError(err, fallback?)` for components. */
export function useReportError() {
  useToast();
  return reportError;
}
