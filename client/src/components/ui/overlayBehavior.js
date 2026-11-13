/**
 * Behaviour shared by every modal surface (Modal, Drawer, command palette):
 * Escape to close, a Tab focus trap, first-field focus, and a body scroll
 * lock. Internal to the UI kit - pages use Modal / Drawer.
 *
 * Differences from the PHP edition, both deliberate:
 * - Escape closes only the top-most surface. The original registered one
 *   document listener per surface, so a confirm opened over a drawer closed
 *   both at once and threw away the form underneath.
 * - The scroll lock is counted, so closing a confirm does not unlock the page
 *   while the drawer beneath it is still open.
 */
import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const stack = [];
let lockCount = 0;

function onDocumentKey(e) {
  if (e.key !== 'Escape' || !stack.length) return;
  stack[stack.length - 1].current?.();
}

export function lockBodyScroll() {
  lockCount += 1;
  document.body.style.overflow = 'hidden';
  return () => {
    lockCount = Math.max(0, lockCount - 1);
    if (!lockCount) document.body.style.overflow = '';
  };
}

/**
 * @param containerRef ref to the dialog element (focus is trapped inside it)
 * @param onEscape     called when Escape is pressed while this is the top surface
 */
export function useOverlayBehavior(containerRef, onEscape) {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    const container = containerRef.current;

    stack.push(escapeRef);
    if (stack.length === 1) document.addEventListener('keydown', onDocumentKey);
    const unlock = lockBodyScroll();

    const trap = (e) => {
      if (e.key !== 'Tab' || !container) return;
      const items = [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    container?.addEventListener('keydown', trap);

    // Same selector and delay as the original, so focus lands where it did.
    const timer = window.setTimeout(() => {
      container?.querySelector('input, select, textarea, button')?.focus();
    }, 40);

    return () => {
      window.clearTimeout(timer);
      container?.removeEventListener('keydown', trap);
      unlock();
      const index = stack.lastIndexOf(escapeRef);
      if (index !== -1) stack.splice(index, 1);
      if (!stack.length) document.removeEventListener('keydown', onDocumentKey);
    };
  }, [containerRef]);
}
