/**
 * The `gv:data-changed` window event.
 *
 * The PHP edition fires it whenever something was created or changed from a
 * place that does not own the screen underneath - the Create menu in the
 * topbar, the lead form, the notification centre - and the shell answers by
 * re-reading the unread count. The same event name is kept so the behaviour
 * is identical.
 */
import { useEffect, useRef } from 'react';

export const DATA_CHANGED = 'gv:data-changed';

export function emitDataChanged() {
  window.dispatchEvent(new CustomEvent(DATA_CHANGED));
}

/**
 * Hook: runs `handler` every time `emitDataChanged()` is called anywhere.
 * The latest `handler` is always used, so it may close over fresh state.
 */
export function useDataChanged(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = () => ref.current?.();
    window.addEventListener(DATA_CHANGED, listener);
    return () => window.removeEventListener(DATA_CHANGED, listener);
  }, []);
}
