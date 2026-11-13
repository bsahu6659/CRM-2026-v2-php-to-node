import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Busy state for submit handlers, so double-clicks cannot double-post.
 * Port of ui.js `busy(button, fn)`.
 */

/**
 * Hook: `const [busy, run] = useBusy();` - `run(fn, ...args)` calls `fn`
 * unless a previous call is still pending (then it returns undefined), and
 * resolves to `fn`'s result. Errors propagate to the caller.
 */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (fn, ...args) => {
    if (pending.current) return undefined;
    pending.current = true;
    setBusy(true);
    try {
      return await fn(...args);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);

  return [busy, run];
}

/**
 * A <button> that disables itself, adds `.loading` and shows a spinner before
 * its label while its async `onClick(event)` runs. `onClick` should catch its
 * own errors (reportError); a rejection is not swallowed here.
 */
export function BusyButton({ onClick, className = 'btn', type = 'button', disabled = false, children, ...rest }) {
  const [busy, run] = useBusy();
  return (
    <button
      type={type}
      className={busy ? `${className} loading` : className}
      disabled={disabled || busy}
      onClick={(e) => run(onClick, e)}
      {...rest}
    >
      {busy ? (
        <>
          <span className="spinner" /> {children}
        </>
      ) : (
        children
      )}
    </button>
  );
}
