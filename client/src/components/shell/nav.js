/**
 * Navigation model. Each entry declares the permission that reveals it, so the
 * sidebar is a projection of the signed-in role rather than a fixed list.
 * `show(auth)` receives the `useAuth()` value.
 *
 * Identical to the NAV table in the PHP edition's app.js.
 */
export const NAV = [
  {
    section: 'Platform',
    items: [
      { path: '/platform', label: 'Platform overview', iconName: 'grid', show: (a) => a.onPlatform() },
      { path: '/clients', label: 'Client companies', iconName: 'building', show: (a) => a.onPlatform() },
    ],
  },
  {
    section: null,
    items: [
      { path: '/', label: 'Dashboard', iconName: 'dashboard', show: (a) => a.can('dashboard', 'read') },
      { path: '/leads', label: 'Leads', iconName: 'leads', show: (a) => a.can('leads', 'read') },
      { path: '/projects', label: 'Projects', iconName: 'building', show: (a) => a.can('projects', 'read') },
    ],
  },
  {
    section: 'Marketing',
    items: [{ path: '/forms', label: 'Web Forms', iconName: 'forms', show: (a) => a.can('forms', 'read') }],
  },
  {
    section: 'Insights',
    items: [
      { path: '/reports', label: 'Reports', iconName: 'reports', show: (a) => a.can('reports', 'read') },
      {
        path: '/performance',
        label: 'Performance',
        iconName: 'trending',
        show: (a) => a.can('reports', 'read') || a.can('targets', 'read'),
      },
      { path: '/activities', label: 'Activity Feed', iconName: 'activity', show: (a) => a.can('activities', 'read') },
    ],
  },
  {
    section: 'Administration',
    items: [
      { path: '/users', label: 'Users', iconName: 'users', show: (a) => a.can('users', 'read') },
      { path: '/teams', label: 'Teams', iconName: 'teams', show: (a) => a.can('teams', 'read') || a.can('users', 'read') },
      { path: '/roles', label: 'Roles & Permissions', iconName: 'shield', show: (a) => a.can('roles', 'read') },
      { path: '/automation', label: 'Automation', iconName: 'automation', show: (a) => a.can('automation', 'read') },
      {
        path: '/communication',
        label: 'WhatsApp & Email',
        iconName: 'message',
        show: (a) => a.canAny([['whatsapp', 'read'], ['email', 'read']]),
      },
      { path: '/imports', label: 'Import & Export', iconName: 'import', show: (a) => a.can('imports', 'read') },
      { path: '/settings', label: 'Settings', iconName: 'settings', show: (a) => a.can('settings', 'read') },
      {
        path: '/developers',
        label: 'Developers',
        iconName: 'key',
        show: (a) => a.canAny([['apikeys', 'read'], ['webhooks', 'read']]),
      },
      { path: '/integrations', label: 'Integrations', iconName: 'integrations', show: (a) => a.can('integrations', 'read') },
      { path: '/audit', label: 'Audit Log', iconName: 'audit', show: (a) => a.can('audit', 'read') },
    ],
  },
];

/** Every nav item the user may see, flattened - the command palette's "Go to" list. */
export const visibleNavItems = (auth) => NAV.flatMap((g) => g.items).filter((item) => item.show(auth));

/**
 * The nav path that should be highlighted for `pathname`: the longest item
 * path that prefixes it, with '/' matching only itself.
 */
export function activeNavPath(pathname, items) {
  const best = items
    .map((item) => item.path)
    .filter((p) => (p === '/' ? pathname === '/' : pathname.startsWith(p)))
    .sort((a, b) => b.length - a.length)[0];
  return best ?? null;
}
