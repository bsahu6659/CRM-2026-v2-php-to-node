import { createContext, Fragment, useCallback, useContext, useEffect, useState } from 'react';
import ErrorBoundary from '../ErrorBoundary.jsx';
import { reportError } from '../../context/ToastContext.jsx';

/**
 * Imperative overlays.
 *
 * The PHP edition opened forms and dialogs from anywhere with a function call
 * - `openLeadForm({ onSaved })`, `confirmDialog({...})` - and the DOM node
 * lived on <body> until it closed itself. `openOverlay(render)` is the same
 * thing in React: `render(close)` is mounted by the one <UIProvider> at the
 * root and stays until `close()` is called, independent of whichever page or
 * component asked for it. That matters when the opener goes away first - a
 * form that closes itself and then shows a follow-up dialog, a menu item
 * that unmounts with its menu, a page the user navigates off.
 *
 * Components that own their dialog's lifetime can simply render <Modal> or
 * <Drawer> conditionally instead; both styles work side by side.
 */
const OverlayContext = createContext(null);

let nextId = 1;
let bridge = null;
const queued = [];

/**
 * Mounts `render(close)` at the application root. Returns `close`.
 * The element returned by `render` normally is a <Modal> or <Drawer> whose
 * `onClose` calls `close`.
 */
export function openOverlay(render) {
  const id = nextId++;
  const close = () => {
    if (bridge) bridge.remove(id);
    else {
      const index = queued.findIndex((item) => item.id === id);
      if (index !== -1) queued.splice(index, 1);
    }
  };
  const item = { id, render, close };
  if (bridge) bridge.add(item);
  else queued.push(item);
  return close;
}

/** Mount once, inside the router and auth providers (see main.jsx). */
export function UIProvider({ children }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    const api = {
      add: (item) => setItems((list) => [...list, item]),
      remove: (id) => setItems((list) => list.filter((item) => item.id !== id)),
    };
    bridge = api;
    const pending = queued.splice(0);
    if (pending.length) setItems((list) => [...list, ...pending]);
    return () => {
      if (bridge === api) bridge = null;
    };
  }, []);

  return (
    <OverlayContext.Provider value={openOverlay}>
      {children}
      {items.map((item) => (
        <Fragment key={item.id}>
          <ErrorBoundary
            fallback={null}
            onError={(err) => {
              reportError(err);
              item.close();
            }}
          >
            {item.render(item.close)}
          </ErrorBoundary>
        </Fragment>
      ))}
    </OverlayContext.Provider>
  );
}

/** Hook form of `openOverlay` (same function). */
export function useOverlay() {
  const open = useContext(OverlayContext);
  if (!open) throw new Error('useOverlay must be used inside <UIProvider>');
  return useCallback((render) => open(render), [open]);
}
