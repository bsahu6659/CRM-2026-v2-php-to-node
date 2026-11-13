/**
 * Unread notification count, shared between the shell's bell and any page.
 *
 * Port of `store.unreadCount` / `setUnreadCount()`. The shell polls
 * `refreshUnread()` once a minute and whenever a `gv:data-changed` event fires;
 * a page that changes read state (the notification centre) either emits that
 * event or calls `refreshUnread()` itself.
 */
import { useSyncExternalStore } from 'react';
import api from './api.js';

let unread = 0;
const listeners = new Set();

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getUnreadCount = () => unread;

export function setUnreadCount(count) {
  unread = Number(count) || 0;
  listeners.forEach((fn) => fn());
}

/** Re-reads the count from the server. Never throws: a failed poll must not disturb the user. */
export async function refreshUnread() {
  try {
    const res = await api.get('/api/notifications/unread-count');
    setUnreadCount(res?.data?.unread || 0);
  } catch {
    // Keep the last known value.
  }
  return unread;
}

/** Hook: the current unread count; re-renders when it changes. */
export function useUnreadCount() {
  return useSyncExternalStore(subscribe, getUnreadCount);
}
