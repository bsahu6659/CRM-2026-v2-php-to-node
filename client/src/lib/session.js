/**
 * Session snapshot and permission helpers for code that lives outside React.
 *
 * Port of the PHP edition's `js/lib/store.js` permission half. `AuthProvider`
 * writes the `/api/auth/me` payload here every time it loads it, so a plain
 * helper function (a reference-data loader, a confirm-then-delete helper shared
 * by two pages) can ask `can('leads', 'create')` without being a component.
 *
 * Inside components use `useAuth()` instead: it exposes the same functions but
 * re-renders the component when the session changes, which this module cannot.
 *
 * These checks decide what the UI *shows*; the server independently decides
 * what it *allows*. Both checks exist on purpose.
 */

const state = {
  user: null,
  organization: null,
  teams: [],
  scope: null,
  // Present only for a platform administrator: the client list behind the
  // tenant switcher, and which client (if any) is currently open.
  platform: null,
};

/** Called by AuthProvider with the `/api/auth/me` data member. */
export function setSession(me) {
  state.user = me?.user ?? null;
  state.organization = me?.organization ?? null;
  state.teams = me?.teams ?? [];
  state.scope = me?.scope ?? null;
  state.platform = me?.platform ?? null;
}

export function clearSession() {
  state.user = null;
  state.organization = null;
  state.teams = [];
  state.scope = null;
  state.platform = null;
}

/** Read-only view of the current session: `{ user, organization, teams, scope, platform }`. */
export const getSession = () => state;

// ---------------------------------------------------------------------------
// Permission checks. Each takes the user explicitly so AuthContext can reuse
// them against the user it is rendering, and the exported zero-config
// versions below read the snapshot.
// ---------------------------------------------------------------------------
const SCOPE_RANK = { OWN: 1, TEAM: 2, TEAM_AND_BELOW: 3, REGION: 4, ORGANIZATION: 5, ALL: 6 };

export function userCan(user, moduleKey, action) {
  const granted = user?.permissions?.[moduleKey];
  return Array.isArray(granted) && granted.includes(action);
}
export const userCanAny = (user, pairs) => pairs.some(([m, a]) => userCan(user, m, a));
export const userIsSuperAdmin = (user) => user?.role?.key === 'super_admin';
export const userScopeRank = (user) => SCOPE_RANK[user?.role?.dataScope] || 1;
export const userIsPlatformAdmin = (user) => Boolean(user?.isPlatformAdmin);
// A platform admin who has switched into a client is working inside that
// client; the platform-only screens are hidden until they step back out.
export const userOnPlatform = (user) => userIsPlatformAdmin(user) && !user?.isImpersonating;

/** `can('leads', 'create')` - the single check every screen uses. */
export const can = (moduleKey, action) => userCan(state.user, moduleKey, action);
export const canAny = (pairs) => userCanAny(state.user, pairs);
export const canRead = (moduleKey) => can(moduleKey, 'read');
export const isSuperAdmin = () => userIsSuperAdmin(state.user);
export const scopeRank = () => userScopeRank(state.user);
export const isPlatformAdmin = () => userIsPlatformAdmin(state.user);
export const onPlatform = () => userOnPlatform(state.user);
