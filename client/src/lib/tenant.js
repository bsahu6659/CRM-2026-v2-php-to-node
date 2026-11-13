/**
 * Platform-admin tenant switching ("impersonation").
 *
 * Port of `switchToClient()` / `exitClientContext()` from the PHP edition's
 * clients view. The shell's tenant switcher, the client list, the client
 * detail page and the platform overview all call these.
 *
 * The original re-read the session and then reloaded the page; a full reload
 * is kept here on purpose. Every cached thing in the browser - reference
 * lists, branding, the unread count, half-loaded pages - belongs to the
 * tenant being left, and a fresh boot is the only way to be certain none of
 * it leaks into the next one. Every entry into a client is written to that
 * client's audit log by the server.
 */
import api from './api.js';
import { reportError, toast } from '../context/ToastContext.jsx';

export async function switchToClient(organizationId, name) {
  try {
    await api.post('/api/platform/switch', { organizationId });
    toast.success(`Now working inside ${name}`);
    // Land on their dashboard rather than leaving the admin on a
    // platform-only screen that no longer applies.
    window.location.assign('/');
  } catch (err) {
    reportError(err);
  }
}

export async function exitClientContext() {
  try {
    await api.post('/api/platform/switch', { organizationId: null });
    window.location.assign('/platform');
  } catch (err) {
    reportError(err);
  }
}
