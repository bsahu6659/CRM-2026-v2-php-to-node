import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api, { setUnauthorizedHandler } from '../lib/api.js';
import { configureFormatting } from '../lib/format.js';
import { applyBranding } from '../lib/branding.js';
import { clearReference } from '../lib/reference.js';
import { setUnreadCount } from '../lib/unread.js';
import {
  clearSession,
  setSession,
  userCan,
  userCanAny,
  userIsPlatformAdmin,
  userIsSuperAdmin,
  userOnPlatform,
  userScopeRank,
} from '../lib/session.js';

/**
 * The signed-in session.
 *
 * `/auth/me` is the single source of truth: it returns the user with their
 * *effective* permissions (role grant plus per-user overrides), the active
 * organisation, the visibility scope and, for a platform admin, the tenant
 * list. Nothing here is cached in localStorage — a permission revoked by an
 * admin has to take effect on the next request, not on the next browser
 * restart, and the session cookie is httpOnly so the browser could not
 * reconstruct it anyway.
 *
 * Loading the session also does what the PHP edition's `loadSession()` did:
 * configures number/date formatting for the organisation, repaints the tenant
 * branding, and mirrors the payload into `lib/session.js` for helpers that
 * are not components.
 */
const AuthContext = createContext(null);

/** Everything tied to the session that must not survive it. */
function dropSession() {
  clearSession();
  clearReference();
  setUnreadCount(0);
  applyBranding(null);
}

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', me: null });

  const refresh = useCallback(async () => {
    try {
      const res = await api.get('/api/auth/me');
      setSession(res.data);
      configureFormatting(res.data.organization);
      applyBranding(res.data.organization?.branding);
      setState({ status: 'signed-in', me: res.data });
      return res.data;
    } catch (err) {
      if (err.status === 401) {
        dropSession();
        setState({ status: 'signed-out', me: null });
        return null;
      }
      setState({ status: 'error', me: null, error: err });
      throw err;
    }
  }, []);

  useEffect(() => {
    // A 401 on any later request means the session went away underneath us
    // (expired, revoked from another device, or the account was deactivated).
    // Dropping to signed-out re-renders the router onto /login.
    setUnauthorizedHandler(() => {
      dropSession();
      setState({ status: 'signed-out', me: null });
    });
    refresh().catch(() => {});
  }, [refresh]);

  const signIn = useCallback(
    async (credentials) => {
      const res = await api.post('/api/auth/login', credentials);
      // A 2FA-enabled account gets `{ twoFactorRequired: true }` and no
      // session; the caller shows the code step and posts again.
      if (res.data?.twoFactorRequired) return { twoFactorRequired: true };
      await refresh();
      return { twoFactorRequired: false };
    },
    [refresh]
  );

  const signOut = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      dropSession();
      setState({ status: 'signed-out', me: null });
    }
  }, []);

  const value = useMemo(() => {
    const me = state.me;
    const user = me?.user ?? null;
    return {
      status: state.status,
      error: state.error ?? null,
      user,
      organization: me?.organization ?? null,
      teams: me?.teams ?? [],
      scope: me?.scope ?? null,
      platform: me?.platform ?? null,
      /** Re-reads /auth/me (the PHP edition's `loadSession()`); resolves to the payload or null. */
      refresh,
      signIn,
      signOut,
      /** Mirrors the server's two-gate check: module + action. */
      can: (moduleKey, action) => userCan(user, moduleKey, action),
      canAny: (pairs) => userCanAny(user, pairs),
      canRead: (moduleKey) => userCan(user, moduleKey, 'read'),
      isSuperAdmin: () => userIsSuperAdmin(user),
      scopeRank: () => userScopeRank(user),
      isPlatformAdmin: () => userIsPlatformAdmin(user),
      onPlatform: () => userOnPlatform(user),
    };
  }, [state, refresh, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
