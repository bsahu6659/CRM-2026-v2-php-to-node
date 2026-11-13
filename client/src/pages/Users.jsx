/**
 * User administration: list, invite, edit, deactivate, plus the org chart.
 * Port of the PHP edition's `views/users.js`.
 *
 * `UserForm` is also opened by the topbar Create menu (docs/CLIENT-UI.md §17),
 * so it is a named export that loads its own pick-lists and closes itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../lib/api.js';
import { number, relative, titleCase } from '../lib/format.js';
import { useQueryParams } from '../lib/query.js';
import { refreshReference } from '../lib/reference.js';
import { useAuth } from '../context/AuthContext.jsx';
import Icon from '../components/Icon.jsx';
import { NoAccess, PageHead, Panel } from '../components/shared.jsx';
import {
  Alert,
  Avatar,
  BusyButton,
  DataTable,
  Drawer,
  Dropdown,
  EmptyState,
  Field,
  Input,
  MenuItem,
  Modal,
  PageLoader,
  SearchBox,
  Select,
  Tabs,
  copyToClipboard,
  openOverlay,
  reportError,
  toast,
  useConfirm,
} from '../components/ui/index.js';
import { PermissionsDrawer } from './UserPermissionsDrawer.jsx';

const TABS = [
  { key: 'list', label: 'All users' },
  { key: 'chart', label: 'Org chart' },
];

export default function Users() {
  const { can } = useAuth();
  if (!can('users', 'read')) return <NoAccess what="users" />;
  return <UsersPage />;
}

function UsersPage() {
  const { can } = useAuth();
  const [query, setQuery] = useQueryParams();
  const tab = query.tab === 'chart' ? 'chart' : 'list';
  // Bumped by every save: the list refreshes in place, the chart re-fetches.
  const [version, setVersion] = useState(0);

  // Stable, because forms opened through openOverlay keep the copy they were given.
  const refresh = useCallback(() => {
    refreshReference();
    setVersion((v) => v + 1);
  }, []);

  const openForm = (user = null) =>
    openOverlay((close) => <UserForm user={user} onClose={close} onSaved={refresh} />);

  return (
    <div>
      <PageHead
        title="Users"
        subtitle="People, their roles and who they report to."
        actions={
          can('users', 'create')
            ? [
                <button key="invite" type="button" className="btn btn-primary" onClick={() => openForm()}>
                  <Icon name="plus" size={15} />
                  Invite user
                </button>,
              ]
            : []
        }
      />
      <div className="mb-16">
        <Tabs items={TABS} active={tab} onSelect={(key) => setQuery({ tab: key === 'chart' ? 'chart' : '' })} />
      </div>
      <div>
        {tab === 'chart' ? (
          <OrgChart version={version} />
        ) : (
          <UserTable version={version} refresh={refresh} onEdit={openForm} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// All users
// ---------------------------------------------------------------------------
function UserTable({ version, refresh, onEdit }) {
  const { can, user: me } = useAuth();
  const confirm = useConfirm();
  const tableRef = useRef(null);
  // The filters live with the table, so leaving for the org chart and coming
  // back starts from a clean list, as the original rebuilt it.
  const [filters, setFilters] = useState({ q: '', isActive: '' });

  const firstVersion = useRef(version);
  useEffect(() => {
    if (version !== firstVersion.current) tableRef.current?.refresh();
  }, [version]);

  const toggleActive = async (row) => {
    if (row.isActive) {
      const yes = await confirm({
        title: `Deactivate ${row.fullName}?`,
        message: 'They are signed out immediately and can no longer sign in. Their leads and history are kept.',
        confirmLabel: 'Deactivate',
        danger: true,
      });
      if (!yes) return;
    }
    try {
      await api.patch(`/api/users/${row.id}`, { isActive: !row.isActive });
      toast.success(row.isActive ? 'User deactivated' : 'User reactivated');
      refresh();
    } catch (err) {
      reportError(err);
    }
  };

  const sendReset = async (row) => {
    try {
      const res = await api.post(`/api/users/${row.id}/reset-password`);
      showLink('Password reset link', res.data.resetUrl, 'Send this to the user. It expires in 24 hours and can be used once.');
    } catch (err) {
      reportError(err);
    }
  };

  const columns = [
    {
      label: 'User',
      sortKey: 'firstName',
      render: (row) => (
        <div className="row" style={{ gap: '10px' }}>
          <Avatar name={row.fullName} url={row.avatarUrl} />
          <div style={{ minWidth: 0 }}>
            <div className="cell-main truncate">
              {row.fullName}
              {row.id === me?.id ? (
                <span className="badge badge-brand" style={{ marginLeft: '6px' }}>
                  You
                </span>
              ) : null}
            </div>
            <div className="cell-sub truncate">{row.email}</div>
          </div>
        </div>
      ),
    },
    {
      label: 'Role',
      render: (row) => (
        <div>
          <span className="badge badge-brand">{row.role?.name || '—'}</span>
          <div className="cell-sub">{titleCase(row.role?.dataScope || '')}</div>
        </div>
      ),
    },
    { label: 'Job title', cellClass: 'hide-sm', render: (row) => row.jobTitle || '—' },
    {
      label: 'Reports to',
      cellClass: 'hide-sm',
      render: (row) => {
        // The list endpoint sends the manager as a ready-made `managerName`;
        // a `manager` object, which the original read, is honoured if present.
        const manager = row.manager ? `${row.manager.firstName} ${row.manager.lastName || ''}`.trim() : row.managerName;
        return manager || <span className="muted">—</span>;
      },
    },
    {
      label: 'Teams',
      cellClass: 'hide-sm',
      render: (row) =>
        row.teamMemberships?.length ? (
          <div className="row wrap" style={{ gap: '4px' }}>
            {row.teamMemberships.slice(0, 2).map((m) => (
              <span key={m.team.id} className="badge">
                {m.team.name}
              </span>
            ))}
            {row.teamMemberships.length > 2 ? <span className="badge">{`+${row.teamMemberships.length - 2}`}</span> : null}
          </div>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      label: 'Status',
      render: (row) => (
        <div>
          <span className={`badge ${row.isActive ? 'badge-success' : 'badge-danger'}`}>
            {row.isActive ? 'Active' : 'Deactivated'}
          </span>
          {row.lastLoginAt ? (
            <div className="cell-sub">{`Seen ${relative(row.lastLoginAt)}`}</div>
          ) : (
            <div className="cell-sub">Never signed in</div>
          )}
        </div>
      ),
    },
    {
      label: '',
      width: '48px',
      render: (row) => (
        <Dropdown
          trigger={
            <button type="button" className="icon-btn" aria-label="User actions">
              <Icon name="more" size={16} />
            </button>
          }
        >
          <div>
            {can('users', 'update') ? (
              <MenuItem iconName="edit" onClick={() => onEdit(row)}>
                Edit
              </MenuItem>
            ) : null}
            {can('users', 'manage') ? (
              <MenuItem
                iconName="shield"
                onClick={() =>
                  openOverlay((close) => <PermissionsDrawer user={row} onClose={close} onSaved={refresh} />)
                }
              >
                Special access
              </MenuItem>
            ) : null}
            {can('users', 'manage') ? (
              <MenuItem iconName="key" onClick={() => sendReset(row)}>
                Send password reset
              </MenuItem>
            ) : null}
            {/* For the person standing at your desk who cannot open the reset
                email. Your own password is deliberately absent - that goes
                through Profile, which asks for the current one first. */}
            {can('users', 'manage') && row.id !== me?.id ? (
              <MenuItem iconName="shield" onClick={() => openOverlay((close) => <SetPasswordModal row={row} onClose={close} />)}>
                Set a new password
              </MenuItem>
            ) : null}
            {can('users', 'update') && row.id !== me?.id ? (
              <MenuItem iconName={row.isActive ? 'close' : 'check'} onClick={() => toggleActive(row)}>
                {row.isActive ? 'Deactivate' : 'Reactivate'}
              </MenuItem>
            ) : null}
          </div>
        </Dropdown>
      ),
    },
  ];

  return (
    <DataTable
      ref={tableRef}
      columns={columns}
      load={(params) => api.get('/api/users', params)}
      params={filters}
      emptyTitle="No users found"
      toolbar={
        <div className="row wrap grow" style={{ gap: '10px' }}>
          <SearchBox placeholder="Search users…" value={filters.q} onSearch={(q) => setFilters((f) => ({ ...f, q }))} />
          <Select
            options={[
              { value: '', label: 'Active and inactive' },
              { value: 'true', label: 'Active only' },
              { value: 'false', label: 'Deactivated only' },
            ]}
            value={filters.isActive}
            onChange={(e) => {
              const isActive = e.target.value;
              setFilters((f) => ({ ...f, isActive }));
            }}
          />
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Org chart
// ---------------------------------------------------------------------------
function OrgChart({ version }) {
  const [state, setState] = useState({ status: 'loading', roots: [], error: null });

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: 'loading', roots: [], error: null });
    api
      .data('/api/users/hierarchy', undefined, { signal: ctrl.signal })
      .then((roots) => setState({ status: 'ready', roots, error: null }))
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setState({ status: 'error', roots: [], error: err });
      });
    return () => ctrl.abort();
  }, [version]);

  if (state.status === 'loading') return <PageLoader />;
  if (state.status === 'error') {
    return (
      <div className="card">
        <EmptyState iconName="alert" title="Could not load the org chart" message={state.error.message} />
      </div>
    );
  }
  if (!state.roots.length) {
    return (
      <div className="card">
        <EmptyState iconName="users" title="No reporting structure yet" />
      </div>
    );
  }
  return (
    <Panel title="Reporting structure" subtitle="Who reports to whom. Data visibility follows this tree plus team membership.">
      <div>
        {state.roots.map((root) => (
          <OrgNode key={root.id} user={root} depth={0} />
        ))}
      </div>
    </Panel>
  );
}

function OrgNode({ user, depth }) {
  const children = user.children || [];
  return (
    <div
      style={{
        marginLeft: depth ? '24px' : '0',
        borderLeft: depth ? '1px solid var(--line)' : 'none',
        paddingLeft: depth ? '14px' : '0',
      }}
    >
      <div
        className="row"
        style={{
          gap: '10px',
          padding: '9px 11px',
          border: '1px solid var(--line)',
          borderRadius: '10px',
          marginBottom: '8px',
          background: 'var(--surface)',
        }}
      >
        <Avatar name={user.fullName} size="sm" url={user.avatarUrl} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="strong truncate">{user.fullName}</div>
          <div className="tiny muted truncate">{user.jobTitle || user.role?.name}</div>
        </div>
        <span className="badge">{user.role?.name || ''}</span>
        {children.length ? (
          <span className="badge">{`${number(children.length)} report${children.length === 1 ? '' : 's'}`}</span>
        ) : null}
      </div>
      {children.map((child) => (
        <OrgNode key={child.id} user={child} depth={depth + 1} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/**
 * Set someone's password outright.
 *
 * Every session that person has open is signed out by the server, because a
 * forced password change that leaves the old session working has not actually
 * taken the account back. The dialog says so before the button is pressed.
 */
function SetPasswordModal({ row, onClose }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const pwRef = useRef(null);
  const repeatRef = useRef(null);

  const submit = async () => {
    if (password !== repeat) {
      setError('Those two passwords do not match.');
      repeatRef.current?.focus();
      return;
    }
    if (!password) {
      setError('Enter a password.');
      pwRef.current?.focus();
      return;
    }
    try {
      const res = await api.post(`/api/users/${row.id}/set-password`, { password });
      onClose();
      toast.success(res.data.message || 'Password updated');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Modal
      title={`Set a new password for ${row.fullName || row.email}`}
      subtitle="They can sign in with it immediately. Tell it to them yourself — it is not emailed."
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <BusyButton className="btn btn-primary" onClick={submit}>
            Set password
          </BusyButton>
        </div>
      }
    >
      <div>
        {error ? (
          <Alert tone="danger" className="mb-16">
            {error}
          </Alert>
        ) : null}
        <Field label="New password" required hint="At least 8 characters, with an uppercase letter and a number." htmlFor="gv-setpw">
          <Input
            ref={pwRef}
            type="password"
            id="gv-setpw"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Repeat it" required htmlFor="gv-setpw2">
          <Input
            ref={repeatRef}
            type="password"
            id="gv-setpw2"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </Field>
        <div className="alert warning mt-8">Everywhere this person is currently signed in will be signed out.</div>
      </div>
    </Modal>
  );
}

/** A one-off link to hand over (reset or invitation), with a copy button. */
function LinkModal({ title, subtitle, url, copyLabel = 'Link copied', withIcon = true, onClose }) {
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={() => copyToClipboard(url, copyLabel)}>
            {withIcon ? <Icon name="copy" size={15} /> : null}
            Copy link
          </button>
        </div>
      }
    >
      <div className="code-block" style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
        {url}
      </div>
    </Modal>
  );
}

function showLink(title, url, message) {
  openOverlay((close) => <LinkModal title={title} subtitle={message} url={url} onClose={close} />);
}

// ---------------------------------------------------------------------------
// Invite / edit form
// ---------------------------------------------------------------------------

const PROFILE_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'jobTitle', 'region'];

/**
 * Invite a user, or edit one. Contract (docs/CLIENT-UI.md §17):
 * `{ user = null, onSaved(savedUser), onClose() }`.
 */
export function UserForm({ user = null, onSaved, onClose }) {
  const { user: me, organization } = useAuth();
  const isEdit = Boolean(user?.id);

  const [options, setOptions] = useState(null); // { roles, teams, users } once loaded
  const [form, setForm] = useState(() =>
    Object.fromEntries(PROFILE_FIELDS.map((name) => [name, user?.[name] ?? '']))
  );
  const [roleId, setRoleId] = useState(user?.role?.id || '');
  const [managerId, setManagerId] = useState(user?.managerId || '');
  const [teamIds, setTeamIds] = useState(() => new Set());
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.data('/api/roles').catch(() => []),
      api.data('/api/teams').catch(() => []),
      api.data('/api/users/assignable').catch(() => []),
    ]).then(([roles, teams, users]) => {
      if (cancelled) return;
      setOptions({ roles, teams, users });
      if (!user?.role?.id) setRoleId(roles.find((r) => r.key === 'sales_executive')?.id || '');
      if (user) {
        // The original read `user.teamMemberships`, which the users list does
        // not send; without a fallback every edit would save an empty team
        // list and silently take the person out of all their teams. Each team
        // from /api/teams carries its members, so read membership from there.
        const ids = teams
          .filter((t) =>
            user.teamMemberships
              ? user.teamMemberships.some((m) => m.team.id === t.id)
              : (t.members || []).some((m) => m.user.id === user.id)
          )
          .map((t) => t.id);
        setTeamIds(new Set(ids));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));

  const toggleTeam = (id, checked) =>
    setTeamIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  /**
   * Name the company the new user will belong to.
   *
   * A platform admin standing at platform level creates a PLATFORM user, not
   * one inside a client - the account then never appears in that client's list
   * and the whole thing looks like it silently failed. Saying which company is
   * about to gain a user is the cheapest way to stop that.
   */
  function inviteSubtitle() {
    const org = organization?.name;
    if (!org) {
      return 'They join your organisation with the role you pick.';
    }
    if (me?.isPlatformAdmin && !me?.isImpersonating) {
      return `They join ${org} — the platform company itself. To add someone to a client, open that client first.`;
    }
    return `They join ${org} with the role you pick.`;
  }

  const save = async () => {
    setError('');
    const payload = {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim() || null,
      email: form.email.trim(),
      phone: form.phone.trim() || null,
      jobTitle: form.jobTitle.trim() || null,
      region: form.region.trim() || null,
      roleId,
      managerId: managerId || null,
      // Kept in the pick-list's order, as the original read the ticked boxes top to bottom.
      teamIds: (options?.teams || []).filter((t) => teamIds.has(t.id)).map((t) => t.id),
    };
    if (!isEdit && password) payload.password = password;

    if (!payload.firstName || !payload.email) {
      setError('First name and email are required.');
      return;
    }

    setSaving(true);
    try {
      const res = isEdit ? await api.patch(`/api/users/${user.id}`, payload) : await api.post('/api/users', payload);
      onClose();
      onSaved?.(res.data);
      if (!isEdit && res.data.inviteUrl) {
        // The form is closing, so the follow-up dialog goes through the overlay
        // host. The server now emails the invitation as well, but it still
        // returns the link because delivery can fail without the API knowing.
        const inviteUrl = res.data.inviteUrl;
        openOverlay((close) => (
          <LinkModal
            title="User created"
            subtitle="An invitation email is on its way. If email is not configured or it does not arrive, share this link directly. It expires in 7 days."
            url={inviteUrl}
            copyLabel="Invitation link copied"
            withIcon={false}
            onClose={close}
          />
        ));
      } else {
        toast.success(isEdit ? 'User updated' : 'User created');
      }
    } catch (err) {
      setSaving(false);
      setError(err.message);
    }
  };

  let body;
  if (!options) {
    body = <PageLoader />;
  } else {
    const { roles, teams, users } = options;
    const roleOptions = roles.map((r) => ({ value: r.id, label: `${r.name} · ${titleCase(r.dataScope)}` }));
    body = (
      <div>
        {error ? (
          <Alert tone="danger" className="mb-16">
            {error}
          </Alert>
        ) : null}
        <div className="form-grid">
          <Field label="First name" required>
            <Input value={form.firstName} onChange={set('firstName')} />
          </Field>
          <Field label="Last name">
            <Input value={form.lastName} onChange={set('lastName')} />
          </Field>
          <Field label="Email" required>
            <Input type="email" value={form.email} onChange={set('email')} />
          </Field>
          <Field label="Phone">
            <Input type="tel" value={form.phone} onChange={set('phone')} />
          </Field>
          <Field label="Job title">
            <Input value={form.jobTitle} onChange={set('jobTitle')} />
          </Field>
          <Field label="Region">
            <Input placeholder="North / South / West" value={form.region} onChange={set('region')} />
          </Field>
        </div>
        <Field label="Role" required hint="The role decides both permissions and how much data they can see.">
          <Select
            options={roleOptions}
            // A role the list does not contain would otherwise *look* like the
            // first option while a different id is saved; the blank entry keeps
            // what is shown and what is sent the same.
            placeholder={roleOptions.some((o) => o.value === roleId) ? undefined : 'Choose a role'}
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
          />
        </Field>
        <Field label="Reports to" hint="Managers see everything their reports can see.">
          <Select
            options={users.map((u) => ({ value: u.id, label: u.fullName }))}
            placeholder="No manager"
            value={managerId}
            onChange={(e) => setManagerId(e.target.value)}
          />
        </Field>
        <Field label="Teams">
          <div style={{ maxHeight: '170px', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: '8px', padding: '8px' }}>
            {teams.map((t) => (
              <label key={t.id} className="checkbox" style={{ display: 'flex', padding: '3px 0' }}>
                <input
                  type="checkbox"
                  value={t.id}
                  checked={teamIds.has(t.id)}
                  onChange={(e) => toggleTeam(t.id, e.target.checked)}
                />
                {t.name}
              </label>
            ))}
          </div>
        </Field>
        {isEdit ? null : (
          <div>
            <Field label="Initial password" hint="Optional. If blank, an invitation link is generated for you to share.">
              <Input
                type="password"
                placeholder="Leave blank to send an invitation instead"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          </div>
        )}
        {isEdit ? null : (
          <div className="alert info">
            <Icon name="info" size={16} />
            <div>You can only grant a role at or below your own authority, and never a wider data scope than your own.</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <Drawer
      title={isEdit ? `Edit ${user.fullName}` : 'Invite a user'}
      subtitle={isEdit ? user.email : inviteSubtitle()}
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!options || saving} onClick={save}>
            {isEdit ? 'Save changes' : 'Create user'}
          </button>
        </div>
      }
    >
      {body}
    </Drawer>
  );
}
