/**
 * My profile: personal details, password, two-factor, active sessions and
 * appearance. Port of the PHP edition's `views/profile.js`.
 *
 * The "Permissions" tab is not in the original view; it keeps what this
 * page showed before the port - the visibility scope and the effective
 * permission matrix, which is the server's own answer: /auth/me returns the
 * role grant with per-user GRANT/REVOKE overrides already applied, plus the
 * data scope resolved per action.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import { dateTime, relative, titleCase } from '../lib/format.js';
import { MODULE_LABELS, SCOPE_LABELS, enumLabel } from '../lib/modules.js';
import { refreshReference } from '../lib/reference.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import Icon from '../components/Icon.jsx';
import { PageHead, Panel } from '../components/shared.jsx';
import {
  Alert,
  Avatar,
  BusyButton,
  EmptyState,
  Field,
  Input,
  Modal,
  PageLoader,
  SwitchToggle,
  Tabs,
  copyToClipboard,
  reportError,
  toast,
  useConfirm,
} from '../components/ui/index.js';

const TABS = [
  { key: 'profile', label: 'Details' },
  { key: 'security', label: 'Security' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'preferences', label: 'Preferences' },
  { key: 'access', label: 'Permissions' },
];

export default function Profile() {
  const { user, organization } = useAuth();
  const [tab, setTab] = useState('profile');
  // Every tab click rebuilt the tab in the original (fresh fields, a fresh
  // session list); keying the content on a counter does the same.
  const [tick, setTick] = useState(0);

  const select = (key) => {
    setTab(key);
    setTick((t) => t + 1);
  };

  let content;
  if (tab === 'profile') content = <DetailsTab key={tick} />;
  else if (tab === 'security') content = <SecurityTab key={tick} />;
  else if (tab === 'sessions') content = <SessionsTab key={tick} />;
  else if (tab === 'preferences') content = <PreferencesTab key={tick} />;
  else content = <PermissionsTab key={tick} />;

  return (
    <div>
      <PageHead title="My profile" subtitle={`${user?.role?.name} · ${organization?.name}`} />
      <div className="mb-16">
        <Tabs items={TABS} active={tab} onSelect={select} />
      </div>
      <div>{content}</div>
    </div>
  );
}

const InfoRow = ({ label, value }) => (
  <div className="info-row">
    <div className="i-label">{label}</div>
    <div className="i-value">{value}</div>
  </div>
);

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------
function DetailsTab() {
  const { user, organization, teams, refresh } = useAuth();
  const [form, setForm] = useState(() => ({
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    phone: user.phone || '',
    jobTitle: user.jobTitle || '',
  }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const fullName = `${user.firstName} ${user.lastName || ''}`;

  const save = async () => {
    try {
      await api.patch('/api/users/me/profile', {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim() || null,
        jobTitle: form.jobTitle.trim() || null,
      });
      // The original reloaded the whole page so the sidebar and every cached
      // owner list showed the new name; re-reading the session re-renders the
      // shell, and the reference refresh updates the owner pickers.
      await refresh();
      refreshReference();
      toast.success('Profile updated');
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <div className="chart-grid two">
      <Panel title="Personal details">
        <div>
          <div className="row mb-16" style={{ gap: '14px' }}>
            <Avatar name={fullName} size="xl" url={user.avatarUrl} />
            <div>
              <h3>{fullName.trim()}</h3>
              <div className="muted small">{user.email}</div>
              <div className="row wrap mt-8" style={{ gap: '6px' }}>
                <span className="badge badge-brand">{user.role?.name || ''}</span>
                <span className="badge">{titleCase(user.role?.dataScope || '')}</span>
                {user.isPlatformAdmin ? <span className="badge badge-warning">Platform admin</span> : null}
              </div>
            </div>
          </div>
          <div className="form-grid">
            <Field label="First name">
              <Input value={form.firstName} onChange={set('firstName')} />
            </Field>
            <Field label="Last name">
              <Input value={form.lastName} onChange={set('lastName')} />
            </Field>
            <Field label="Phone">
              <Input type="tel" value={form.phone} onChange={set('phone')} />
            </Field>
            <Field label="Job title">
              <Input value={form.jobTitle} onChange={set('jobTitle')} />
            </Field>
          </div>
          <BusyButton className="btn btn-primary" onClick={save}>
            Save changes
          </BusyButton>
        </div>
      </Panel>

      <Panel title="Account">
        <div className="info-list">
          <InfoRow label="Email" value={user.email} />
          <InfoRow label="Role" value={user.role?.name || '—'} />
          <InfoRow label="Data scope" value={titleCase(user.role?.dataScope || '')} />
          <InfoRow label="Organisation" value={organization?.name || ''} />
          <InfoRow
            label="Teams"
            value={
              teams?.length ? (
                <div className="row wrap" style={{ gap: '4px' }}>
                  {teams.map((t) => (
                    <span key={t.id} className="badge" title={t.role ? enumLabel(t.role) : undefined}>
                      {t.name}
                    </span>
                  ))}
                </div>
              ) : (
                '—'
              )
            }
          />
          <InfoRow label="Region" value={user.region || '—'} />
          <InfoRow
            label="Email verified"
            value={user.emailVerifiedAt ? 'Yes' : <span className="badge badge-warning">Not verified</span>}
          />
          <InfoRow label="Last sign-in" value={user.lastLoginAt ? dateTime(user.lastLoginAt) : 'This is your first session'} />
          <InfoRow label="User ID" value={<span className="mono tiny">{user.id}</span>} />
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------
function SecurityTab() {
  const { user } = useAuth();
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState('');
  const [setup, setSetup] = useState(null); // { secret, otpauthUri } while the setup dialog is open
  const [disabling, setDisabling] = useState(false);

  const set = (name) => (e) => setPw((p) => ({ ...p, [name]: e.target.value }));

  const changePassword = async () => {
    setError('');
    if (pw.next !== pw.confirm) {
      setError('Those passwords do not match.');
      return;
    }
    try {
      await api.post('/api/auth/change-password', { currentPassword: pw.current, newPassword: pw.next });
      toast.success('Password changed', 'Your other sessions were signed out.');
      setPw({ current: '', next: '', confirm: '' });
    } catch (err) {
      setError(err.message);
    }
  };

  const startSetup = async () => {
    try {
      const res = await api.post('/api/auth/2fa/setup');
      setSetup(res.data);
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <div className="chart-grid two">
      <Panel title="Change password">
        <div>
          {error ? (
            <Alert tone="danger" className="mb-16">
              {error}
            </Alert>
          ) : null}
          <Field label="Current password" required>
            <Input type="password" autoComplete="current-password" value={pw.current} onChange={set('current')} />
          </Field>
          <Field label="New password" required hint="At least 8 characters with upper case, lower case and a number.">
            <Input type="password" autoComplete="new-password" value={pw.next} onChange={set('next')} />
          </Field>
          <Field label="Confirm new password" required>
            <Input type="password" autoComplete="new-password" value={pw.confirm} onChange={set('confirm')} />
          </Field>
          <BusyButton className="btn btn-primary" onClick={changePassword}>
            Change password
          </BusyButton>
        </div>
      </Panel>

      <Panel title="Two-factor authentication">
        {user.twoFactorEnabled ? (
          <div>
            <div className="alert success mb-16">
              <Icon name="shield" size={16} />
              <div>Two-factor authentication is on. You will be asked for a code at every sign-in.</div>
            </div>
            <button type="button" className="btn btn-danger" onClick={() => setDisabling(true)}>
              Turn off two-factor
            </button>
          </div>
        ) : (
          <div>
            <p className="muted mb-16">
              Add a second step at sign-in using any authenticator app (Google Authenticator, Authy, 1Password).
            </p>
            <BusyButton className="btn btn-primary" onClick={startSetup}>
              <Icon name="shield" size={15} />
              Set up two-factor
            </BusyButton>
          </div>
        )}
      </Panel>

      {setup ? <TwoFactorSetupModal setup={setup} onClose={() => setSetup(null)} /> : null}
      {disabling ? <TwoFactorDisableModal onClose={() => setDisabling(false)} /> : null}
    </div>
  );
}

function TwoFactorSetupModal({ setup, onClose }) {
  const { refresh } = useAuth();
  const [code, setCode] = useState('');

  const enable = async () => {
    try {
      await api.post('/api/auth/2fa/enable', { code: code.trim() });
      toast.success('Two-factor authentication enabled');
      onClose();
      // The tab re-renders from the refreshed session, as the original redrew it.
      await refresh();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <Modal
      title="Set up two-factor authentication"
      subtitle="Add this secret to your authenticator app, then confirm the code it shows."
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <BusyButton className="btn btn-primary" onClick={enable}>
            Enable
          </BusyButton>
        </div>
      }
    >
      <div>
        <div className="field">
          <label>Setup key</label>
          <div className="row" style={{ gap: '8px' }}>
            <code className="code-block grow" style={{ wordBreak: 'break-all' }}>
              {setup.secret}
            </code>
            <button
              type="button"
              className="btn btn-sm"
              aria-label="Copy setup key"
              onClick={() => copyToClipboard(setup.secret, 'Setup key copied')}
            >
              <Icon name="copy" size={14} />
            </button>
          </div>
        </div>
        <div className="field">
          <label>Or paste this URI into your app</label>
          <div className="code-block" style={{ wordBreak: 'break-all', fontSize: '11px' }}>
            {setup.otpauthUri}
          </div>
        </div>
        <Field label="Verification code" required hint="Enter the current 6-digit code.">
          <Input inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function TwoFactorDisableModal({ onClose }) {
  const { refresh } = useAuth();
  const [password, setPassword] = useState('');

  const disable = async () => {
    try {
      await api.post('/api/auth/2fa/disable', { password });
      toast.success('Two-factor authentication turned off');
      onClose();
      await refresh();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <Modal
      title="Turn off two-factor authentication"
      subtitle="Confirm your password to continue."
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <BusyButton className="btn btn-danger" onClick={disable}>
            Turn off
          </BusyButton>
        </div>
      }
    >
      <Field label="Password" required>
        <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
function SessionsTab() {
  const { signOut } = useAuth();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [state, setState] = useState({ status: 'loading', sessions: [], error: null });

  const load = useCallback(async (signal) => {
    setState((s) => ({ ...s, status: 'loading' }));
    try {
      const sessions = await api.data('/api/auth/sessions', undefined, { signal });
      setState({ status: 'ready', sessions, error: null });
    } catch (err) {
      if (err.name === 'AbortError') return;
      setState({ status: 'error', sessions: [], error: err });
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const endSession = async (s) => {
    try {
      await api.del(`/api/auth/sessions/${s.id}`);
      toast.success('Session ended');
      load();
    } catch (err) {
      reportError(err);
    }
  };

  const signOutEverywhere = async () => {
    const yes = await confirm({
      title: 'Sign out everywhere?',
      message: 'Every session, including this one, is ended. You will need to sign in again.',
      danger: true,
      confirmLabel: 'Sign out everywhere',
    });
    if (!yes) return;
    try {
      await api.post('/api/auth/logout-all');
      // This browser's session is gone too: drop the local copy and land on sign-in.
      await signOut();
      navigate('/login', { replace: true });
    } catch (err) {
      reportError(err);
    }
  };

  if (state.status === 'loading') return <PageLoader />;
  if (state.status === 'error') {
    return (
      <div className="card">
        <EmptyState iconName="alert" title="Could not load sessions" message={state.error.message} />
      </div>
    );
  }

  return (
    <Panel title="Active sessions" subtitle="Each browser you sign in from appears here.">
      <div>
        <div className="col" style={{ gap: '9px' }}>
          {state.sessions.map((s) => (
            <div key={s.id} className="row-between" style={{ padding: '12px', border: '1px solid var(--line)', borderRadius: '10px' }}>
              <div style={{ minWidth: 0 }}>
                <div className="strong truncate">
                  {s.current ? (
                    <span className="badge badge-success" style={{ marginRight: '6px' }}>
                      This device
                    </span>
                  ) : null}
                  {s.userAgent || 'Unknown device'}
                </div>
                <div className="tiny muted">
                  {`${s.ip || 'unknown IP'} · started ${relative(s.createdAt)} · last seen ${relative(s.lastSeenAt)}`}
                </div>
              </div>
              {!s.current ? (
                <button type="button" className="btn btn-sm" onClick={() => endSession(s)}>
                  Sign out
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-danger mt-16" onClick={signOutEverywhere}>
          <Icon name="logout" size={15} />
          Sign out everywhere
        </button>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
function PreferencesTab() {
  const { theme, setTheme } = useTheme();
  return (
    <Panel title="Appearance">
      <div>
        <p className="muted mb-16">Saved in this browser only, so a shared machine can look different for each person.</p>
        <SwitchToggle
          label="Dark theme"
          checked={theme === 'dark'}
          onChange={(value) => {
            setTheme(value ? 'dark' : 'light');
            toast.success(`Switched to the ${value ? 'dark' : 'light'} theme`);
          }}
        />
        <div className="alert info mt-16">
          <Icon name="info" size={16} />
          <div>
            <strong>Keyboard shortcuts</strong>
            Press <span className="code-inline">Ctrl/⌘ K</span> or <span className="code-inline">/</span> anywhere to open
            search and jump between records.
          </div>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Permissions (kept from the read-only profile this page replaced)
// ---------------------------------------------------------------------------
function PermissionsTab() {
  const { user, organization, scope } = useAuth();
  const permissions = user?.permissions ?? {};
  const scopes = user?.permissionScopes ?? {};
  const special = user?.specialPermissions ?? [];
  const modules = Object.keys(permissions).sort();

  return (
    <div>
      <section className="card mb-16">
        <div className="card-head">
          <h3>Visibility</h3>
        </div>
        <div className="card-body">
          <div className="info-list">
            <InfoRow label="Scope" value={SCOPE_LABELS[scope?.scope ?? user?.role?.dataScope] ?? enumLabel(scope?.scope)} />
            <InfoRow
              label="Reach"
              value={
                scope?.unrestricted
                  ? 'Every record in this company'
                  : `${scope?.userIds?.length ?? 0} user(s), ${scope?.teamIds?.length ?? 0} team(s)`
              }
            />
            <InfoRow label="Unassigned records" value={scope?.canSeeUnassigned ? 'Visible' : 'Hidden'} />
            <InfoRow label="Workspace" value={organization?.name} />
            <InfoRow
              label="Home workspace"
              value={user?.homeOrganizationId === organization?.id ? 'This one' : user?.homeOrganizationId}
            />
          </div>
        </div>
      </section>

      <section className="card mb-16">
        <div className="card-head">
          <h3>Effective permissions</h3>
          <span className="muted small">Role grant with personal overrides applied</span>
        </div>
        <div className="card-body">
          {modules.length === 0 ? (
            <p className="muted">This account holds no module permissions.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Module</th>
                    <th>Actions</th>
                    <th>Data scope</th>
                  </tr>
                </thead>
                <tbody>
                  {modules.map((mod) => {
                    const actions = [...permissions[mod]].sort();
                    const modScopes = [...new Set(Object.values(scopes[mod] ?? {}))];
                    return (
                      <tr key={mod}>
                        <td className="strong">{MODULE_LABELS[mod] ?? enumLabel(mod)}</td>
                        <td>
                          <div className="row wrap" style={{ gap: '5px' }}>
                            {actions.map((a) => (
                              <span key={a} className="chip">
                                {a}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="nowrap">{modScopes.length ? modScopes.map((s) => enumLabel(s)).join(', ') : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {special.length > 0 ? (
        <section className="card">
          <div className="card-head">
            <h3>Personal overrides</h3>
          </div>
          <div className="card-body">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Permission</th>
                    <th>Effect</th>
                    <th>Scope</th>
                    <th>Reason</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {special.map((s) => (
                    <tr key={`${s.module}:${s.action}`}>
                      <td className="mono tiny">{`${s.module}:${s.action}`}</td>
                      <td>
                        <span className={`badge ${s.effect === 'REVOKE' ? 'badge-danger' : 'badge-success'}`}>{enumLabel(s.effect)}</span>
                      </td>
                      <td>{s.dataScope ? enumLabel(s.dataScope) : '—'}</td>
                      <td>{s.reason || '—'}</td>
                      <td className="nowrap">{s.expiresAt ? dateTime(s.expiresAt) : 'Never'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
