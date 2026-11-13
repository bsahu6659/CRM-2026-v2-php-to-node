import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { loadReference } from '../lib/reference.js';
import { refreshUnread, useUnreadCount } from '../lib/unread.js';
import { useDataChanged } from '../lib/events.js';
import Icon from './Icon.jsx';
import { Avatar } from './ui/Blocks.jsx';
import { Dropdown, MenuItem, MenuSeparator, MenuTitle } from './ui/Dropdown.jsx';
import CommandPalette from './shell/CommandPalette.jsx';
import NotificationPanel from './shell/NotificationPanel.jsx';
import QuickCreateMenu from './shell/QuickCreateMenu.jsx';
import TenantSwitcher from './shell/TenantSwitcher.jsx';
import { NAV, activeNavPath, visibleNavItems } from './shell/nav.js';

/**
 * Application shell: navy sidebar, sticky topbar, routed content. Port of
 * everything the PHP edition's app.js does outside the views - navigation
 * built from permissions, the command palette, the notification centre, the
 * Create menu, the tenant switcher, the user menu, theme toggle, persisted
 * sidebar collapse, mobile navigation, tenant branding in the sidebar,
 * reference-data warm-up, unread polling and the landing redirect.
 */
const SIDEBAR_KEY = 'gv.sidebar';

function getSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

function setSidebarCollapsed(collapsed) {
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  } catch {
    // Private mode: the toggle still works for this visit.
  }
}

/**
 * The sidebar lockup. A client company that has uploaded a logo sees their own
 * brand here; everyone else sees Growvanta. This is the white-label surface,
 * driven entirely by the tenant record.
 */
function BrandLockup({ branding }) {
  if (branding?.logoUrl) {
    return (
      <div className="brand">
        <img
          className="brand-mark"
          // The tenant record can outlive the file it points at - a logo removed
          // from the uploads directory leaves the row behind. Without this the
          // sidebar shows a browser's broken-image icon, which reads as "this
          // application is broken" rather than "one picture is missing".
          onError={(e) => {
            const img = e.currentTarget;
            if (img.dataset.fellBack) return;
            img.dataset.fellBack = '1';
            img.src = '/assets/mark-64.png';
          }}
          src={branding.logoUrl}
          alt=""
          width={32}
          height={32}
          style={{ objectFit: 'contain', borderRadius: '7px' }}
        />
        <div className="brand-text truncate" title={branding.name}>
          {branding.name}
        </div>
      </div>
    );
  }
  return (
    <div className="brand">
      <img
        className="brand-mark"
        src="/assets/mark-64.png"
        srcSet="/assets/mark-64.png 1x, /assets/mark-128.png 2x"
        alt=""
        width={32}
        height={32}
      />
      <div className="brand-text">
        GROW<span>VANTA</span>
      </div>
    </div>
  );
}

export default function AppShell() {
  const auth = useAuth();
  const { user, organization, signOut, can, onPlatform } = auth;
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const { pathname } = location;
  const unread = useUnreadCount();

  const [collapsed, setCollapsed] = useState(getSidebarCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const navItems = useMemo(() => visibleNavItems(auth), [auth]);
  const activePath = activeNavPath(pathname, navItems);
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');

  // Landing redirect, once per boot. A platform admin with no client selected
  // owns no leads of their own, so the tenant dashboard would greet them with
  // a screen of zeros that reads as a broken install - send them to the
  // platform overview instead. Roles without dashboard access land on leads.
  const landed = useRef(false);
  useLayoutEffect(() => {
    if (landed.current) return;
    landed.current = true;
    if (pathname !== '/') return;
    if (onPlatform()) navigate('/platform', { replace: true });
    else if (!can('dashboard', 'read') && can('leads', 'read')) navigate('/leads', { replace: true });
  }, [pathname, onPlatform, can, navigate]);

  // What the router's beforeRender did: close the mobile drawer and start the
  // new page at the top. Query-only changes are not navigations to a new page.
  useEffect(() => {
    setMobileOpen(false);
    window.scrollTo({ top: 0 });
  }, [pathname]);

  useEffect(() => {
    // Reference data is used by nearly every screen; warm it once.
    loadReference().catch(() => {});
    refreshUnread();
    // Light polling keeps the badge honest without a socket connection.
    const poll = window.setInterval(refreshUnread, 60_000);
    return () => window.clearInterval(poll);
  }, []);

  useDataChanged(() => {
    refreshUnread();
  });

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // Plain "/" opens search, unless the user is typing into a field.
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  async function handleSignOut() {
    try {
      await signOut();
    } catch {
      // Sign out anyway: the local session is already dropped.
    }
    navigate('/login', { replace: true });
  }

  const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac');
  const classes = ['app', collapsed && 'collapsed', mobileOpen && 'mobile-open'].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      onClick={(e) => {
        // The dimmed backdrop behind the mobile drawer is `.app::after`, so a
        // tap on it lands on this element itself.
        if (mobileOpen && e.target === e.currentTarget) setMobileOpen(false);
      }}
    >
      <aside className="sidebar">
        <BrandLockup branding={organization?.branding} />

        <nav className="nav" aria-label="Main navigation">
          {NAV.map((group, gi) => {
            const visible = group.items.filter((item) => item.show(auth));
            if (!visible.length) return null;
            return [
              group.section ? (
                <div key={`s${gi}`} className="nav-section-title">
                  {group.section}
                </div>
              ) : null,
              ...visible.map((item) => (
                <Link
                  key={item.path}
                  className={item.path === activePath ? 'nav-item active' : 'nav-item'}
                  to={item.path}
                  title={item.label}
                  onClick={() => setMobileOpen(false)}
                >
                  <Icon name={item.iconName} size={18} />
                  <span className="nav-label">{item.label}</span>
                </Link>
              )),
            ];
          })}
        </nav>

        <div className="sidebar-footer">
          <Dropdown
            align="left"
            trigger={
              <div className="u-card">
                <Avatar name={fullName} url={user.avatarUrl} />
                <div className="u-meta grow" style={{ minWidth: 0 }}>
                  <div className="u-name truncate">{fullName}</div>
                  <div className="u-role truncate">{user.role?.name || ''}</div>
                </div>
              </div>
            }
          >
            <div>
              <MenuTitle>{organization?.name || ''}</MenuTitle>
              <MenuItem iconName="user" onClick={() => navigate('/profile')}>
                My profile
              </MenuItem>
              <MenuItem iconName={theme === 'dark' ? 'sun' : 'moon'} onClick={toggle}>
                {theme === 'dark' ? 'Light theme' : 'Dark theme'}
              </MenuItem>
              <MenuSeparator />
              <MenuItem iconName="logout" danger onClick={handleSignOut}>
                Sign out
              </MenuItem>
            </div>
          </Dropdown>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn mobile-only"
            aria-label="Toggle navigation"
            onClick={() => setMobileOpen((v) => !v)}
          >
            <Icon name="menu" size={19} />
          </button>
          <button
            type="button"
            className="icon-btn desk-only"
            aria-label="Collapse sidebar"
            onClick={() => {
              const next = !collapsed;
              setCollapsed(next);
              setSidebarCollapsed(next);
            }}
          >
            <Icon name="list" size={18} />
          </button>

          <button type="button" className="search-trigger" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={15} />
            <span>Search leads and projects…</span>
            <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>

          <TenantSwitcher />

          <div className="row" style={{ marginLeft: 'auto', gap: '6px' }}>
            <Dropdown
              trigger={
                <button type="button" className="btn btn-primary btn-sm">
                  <Icon name="plus" size={15} />
                  <span className="hide-sm">Create</span>
                </button>
              }
            >
              <QuickCreateMenu onClientCreated={() => navigate('/clients')} />
            </Dropdown>

            <Dropdown
              trigger={
                <button type="button" className="icon-btn" aria-label="Notifications">
                  <Icon name="bell" size={18} />
                  {unread > 0 ? <span className="count">{unread > 99 ? '99+' : String(unread)}</span> : null}
                </button>
              }
            >
              {(close) => <NotificationPanel close={close} />}
            </Dropdown>

            <button type="button" className="icon-btn desk-only" aria-label="Toggle theme" onClick={toggle}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
            </button>
          </div>
        </header>

        <main className="content" id="outlet">
          <Outlet />
        </main>
      </div>

      {paletteOpen ? (
        <CommandPalette navTargets={navItems} onClose={() => setPaletteOpen(false)} />
      ) : null}
    </div>
  );
}
