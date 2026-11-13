/**
 * Roles & permissions. Port of the PHP edition's `views/roles.js`.
 *
 * The permission matrix is generated from the server's catalogue, so the UI can
 * never offer a grant the API would reject. Data scope is chosen separately
 * because "what you can do" and "whose records you can do it to" are different
 * questions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../lib/api.js';
import { number, titleCase } from '../lib/format.js';
import { useAuth } from '../context/AuthContext.jsx';
import Icon from '../components/Icon.jsx';
import { NoAccess, PageHead } from '../components/shared.jsx';
import {
  Alert,
  Avatar,
  DataTable,
  Drawer,
  Dropdown,
  EmptyState,
  Field,
  Input,
  MenuItem,
  PageLoader,
  SearchBox,
  Select,
  Tabs,
  Textarea,
  openOverlay,
  reportError,
  toast,
  useConfirm,
} from '../components/ui/index.js';
import { PermissionsDrawer } from './UserPermissionsDrawer.jsx';

const ACTIONS = ['read', 'create', 'update', 'delete', 'export', 'assign', 'manage'];

export default function Roles() {
  const { can } = useAuth();
  if (!can('roles', 'read')) return <NoAccess what="roles and permissions" />;
  return <RolesPage />;
}

function RolesPage() {
  const { can } = useAuth();
  // { catalogue, roles } once loaded; later reloads keep the page on screen
  // until the new data arrives, as the original replaced it in place.
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('roles');
  // Bumped after an inline role change so the people list re-reads as well.
  const [peopleVersion, setPeopleVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const catalogue = await api.data('/api/roles/catalogue');
      const roles = await api.data('/api/roles');
      setData({ catalogue, roles });
      setError(null);
    } catch (err) {
      reportError(err);
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reloadAll = useCallback(() => {
    load();
    setPeopleVersion((v) => v + 1);
  }, [load]);

  const selectTab = (key) => {
    setTab(key);
    load();
  };

  const openRoleForm = (role = null) => {
    if (!data) return;
    const { catalogue } = data;
    openOverlay((close) => <RoleForm role={role} catalogue={catalogue} onClose={close} onSaved={load} />);
  };

  let body;
  if (error) {
    body = (
      <div className="card">
        <EmptyState iconName="alert" title="Could not load roles" message={error.message} />
      </div>
    );
  } else if (!data) {
    body = <PageLoader label="Loading roles" />;
  } else {
    const { catalogue, roles } = data;
    body = (
      <>
        <Tabs
          items={[
            { key: 'roles', label: 'Roles', count: roles.length },
            { key: 'people', label: 'People & roles' },
          ]}
          active={tab}
          onSelect={selectTab}
        />
        {tab === 'people' ? (
          <PeopleTab roles={roles} catalogue={catalogue} reload={reloadAll} version={peopleVersion} />
        ) : (
          <div>
            <div className="alert info mb-16 mt-16">
              <Icon name="shield" size={16} />
              <div>
                <strong>Permissions are enforced on the server</strong>
                Hiding a button in the UI is a convenience. Every request is independently checked against the role, and
                data scope is applied to every query.
              </div>
            </div>
            <div className="chart-grid half">
              {roles.map((r) => (
                <RoleCard
                  key={r.id}
                  role={r}
                  catalogue={catalogue}
                  onEdit={() => openRoleForm(r)}
                  onDuplicate={() => openRoleForm({ ...r, id: null, name: `${r.name} (copy)`, isSystem: false })}
                  onDeleted={load}
                  onShowPeople={() => selectTab('people')}
                />
              ))}
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div>
      <PageHead
        title="Roles & Permissions"
        subtitle="What each role can do, and whose records they can see."
        actions={
          can('roles', 'create')
            ? [
                <button key="new" type="button" className="btn btn-primary" onClick={() => openRoleForm()}>
                  <Icon name="plus" size={15} />
                  New role
                </button>,
              ]
            : []
        }
      />
      {body}
    </div>
  );
}

function RoleCard({ role, catalogue, onEdit, onDuplicate, onDeleted, onShowPeople }) {
  const { can, user } = useAuth();
  const confirm = useConfirm();
  const perms = role.permissions && !Array.isArray(role.permissions) ? role.permissions : {};
  const grantedModules = Object.keys(perms);
  const totalActions = Object.values(perms).reduce((sum, a) => sum + a.length, 0);
  const scopeLabel = catalogue.dataScopes.find((s) => s.key === role.dataScope)?.label || role.dataScope;

  const remove = async () => {
    const yes = await confirm({
      title: 'Delete this role?',
      message: role.userCount > 0 ? `${role.userCount} user(s) still hold it - move them first.` : `${role.name} will be removed.`,
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!yes) return;
    try {
      await api.del(`/api/roles/${role.id}`);
      toast.success('Role deleted');
      onDeleted();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="row" style={{ gap: '8px' }}>
            {role.name}
            {role.isSystem ? <span className="badge">Built-in</span> : null}
            {role.id === user?.role?.id ? <span className="badge badge-brand">Your role</span> : null}
          </h3>
          <div className="sub">{role.description || `Level ${role.level}`}</div>
        </div>
        {can('roles', 'update') ? (
          <Dropdown
            trigger={
              <button type="button" className="icon-btn" aria-label="Role actions">
                <Icon name="more" size={16} />
              </button>
            }
          >
            <div>
              <MenuItem iconName="edit" onClick={onEdit}>
                Edit
              </MenuItem>
              <MenuItem iconName="copy" onClick={onDuplicate}>
                Duplicate
              </MenuItem>
              {!role.isSystem && can('roles', 'delete') ? (
                <MenuItem iconName="trash" danger onClick={remove}>
                  Delete
                </MenuItem>
              ) : null}
            </div>
          </Dropdown>
        ) : null}
      </div>
      <div className="card-body">
        <div className="row wrap mb-16" style={{ gap: '18px' }}>
          <div>
            <div className="tiny muted">Users</div>
            {role.userCount > 0 && onShowPeople ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ padding: '0', height: 'auto', fontWeight: '700' }}
                onClick={onShowPeople}
                title="See who holds this role"
              >
                {number(role.userCount)}
              </button>
            ) : (
              <div className="strong">{number(role.userCount)}</div>
            )}
          </div>
          <div>
            <div className="tiny muted">Data scope</div>
            <div className="strong">{scopeLabel}</div>
          </div>
          <div>
            <div className="tiny muted">Modules</div>
            <div className="strong">{`${number(grantedModules.length)} · ${number(totalActions)} permissions`}</div>
          </div>
        </div>
        <div className="row wrap" style={{ gap: '5px' }}>
          {grantedModules.slice(0, 10).map((key) => {
            const mod = catalogue.modules.find((m) => m.key === key);
            return (
              <span key={key} className="badge" title={(perms[key] || []).join(', ')}>
                {mod?.label || key}
              </span>
            );
          })}
          {grantedModules.length > 10 ? <span className="badge">{`+${grantedModules.length - 10}`}</span> : null}
        </div>
      </div>
    </section>
  );
}

/**
 * Who holds which role.
 *
 * The role cards answer "what can this role do"; this answers "and who is it?",
 * which is the question you actually have when someone changes job. The role
 * can be changed inline, because making people hop to the Users screen to do
 * one dropdown is how permissions end up stale.
 */
function PeopleTab({ roles, catalogue, reload, version }) {
  const { can } = useAuth();
  const tableRef = useRef(null);
  const [filters, setFilters] = useState({ q: '', roleId: '' });
  const rolesById = Object.fromEntries(roles.map((r) => [r.id, r]));
  const scopeLabelFor = (role) => catalogue.dataScopes.find((s) => s.key === role?.dataScope)?.label || role?.dataScope || '—';

  const firstVersion = useRef(version);
  useEffect(() => {
    if (version !== firstVersion.current) tableRef.current?.refresh();
  }, [version]);

  const columns = [
    {
      label: 'Person',
      render: (row) => (
        <div className="row" style={{ gap: '10px' }}>
          <Avatar name={row.fullName} size="sm" url={row.avatarUrl} />
          <div style={{ minWidth: 0 }}>
            <div className="cell-main truncate">{row.fullName}</div>
            <div className="cell-sub truncate">{row.email}</div>
          </div>
        </div>
      ),
    },
    {
      label: 'Role',
      width: '210px',
      render: (row) =>
        can('users', 'update') ? (
          <RoleSelectCell row={row} roles={roles} rolesById={rolesById} onChanged={reload} />
        ) : (
          <span className="badge">{rolesById[row.roleId]?.name || '—'}</span>
        ),
    },
    {
      label: 'Sees',
      cellClass: 'hide-sm',
      render: (row) => <span className="small muted">{scopeLabelFor(rolesById[row.roleId])}</span>,
    },
    {
      label: 'Reports to',
      cellClass: 'hide-sm',
      render: (row) => <span className="small">{row.managerName || 'Nobody'}</span>,
    },
    {
      label: 'Status',
      render: (row) => (
        <span className={`badge ${row.isActive ? 'badge-success' : ''}`}>{row.isActive ? 'Active' : 'Inactive'}</span>
      ),
    },
    {
      label: '',
      width: '150px',
      render: (row) =>
        can('users', 'manage') ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => openOverlay((close) => <PermissionsDrawer user={row} onClose={close} onSaved={reload} />)}
          >
            <Icon name="shield" size={13} />
            Special access
          </button>
        ) : null,
    },
  ];

  return (
    <div>
      <div className="alert info mb-16">
        <Icon name="users" size={16} />
        <div>
          <strong>Change a role here and it applies everywhere. </strong>
          The role decides what someone can do; &quot;Sees&quot; is how much of the company their role lets them read. Use
          Special access for one-off exceptions rather than inventing a new role.
        </div>
      </div>
      <DataTable
        ref={tableRef}
        columns={columns}
        load={(params) => api.get('/api/users', { ...params, scoped: 'false' })}
        params={filters}
        emptyTitle="Nobody here yet"
        emptyMessage="Invite users and they will appear with their role."
        toolbar={
          <div className="row wrap grow" style={{ gap: '10px' }}>
            <SearchBox placeholder="Search people…" value={filters.q} onSearch={(q) => setFilters((f) => ({ ...f, q }))} />
            <Select
              options={[{ value: '', label: 'All roles' }, ...roles.map((r) => ({ value: r.id, label: `${r.name} (${r.userCount})` }))]}
              value={filters.roleId}
              onChange={(e) => {
                const roleId = e.target.value;
                setFilters((f) => ({ ...f, roleId }));
              }}
            />
          </div>
        }
      />
    </div>
  );
}

/** The inline role picker: disabled while saving, reverted when the server refuses. */
function RoleSelectCell({ row, roles, rolesById, onChanged }) {
  const [value, setValue] = useState(row.roleId);
  const [busy, setBusy] = useState(false);

  // A refreshed row (after the save, or a change made elsewhere) wins.
  useEffect(() => {
    setValue(row.roleId);
  }, [row.roleId]);

  const change = async (roleId) => {
    const previous = row.roleId;
    setValue(roleId);
    setBusy(true);
    try {
      await api.patch(`/api/users/${row.id}`, { roleId });
      toast.success(`${row.fullName} is now ${rolesById[roleId]?.name}`, 'Their permissions change the next time they load the app.');
      setBusy(false);
      onChanged();
    } catch (err) {
      setValue(previous);
      setBusy(false);
      reportError(err);
    }
  };

  return (
    <Select
      options={roles.map((r) => ({ value: r.id, label: r.name }))}
      // A role the list does not show (one hidden from this admin) would
      // otherwise look like the first option; the blank keeps the two honest.
      placeholder={rolesById[value] ? undefined : '—'}
      value={value}
      disabled={busy}
      onChange={(e) => change(e.target.value)}
    />
  );
}

// ---------------------------------------------------------------------------
function RoleForm({ role = null, catalogue, onSaved, onClose }) {
  const isEdit = Boolean(role?.id);
  // An empty grant can arrive as a JSON list ([]) rather than an object; keys
  // set on an array would be dropped when the payload is serialised.
  const [permissions, setPermissions] = useState(() =>
    role?.permissions && !Array.isArray(role.permissions) ? structuredClone(role.permissions) : {}
  );
  const [name, setName] = useState(role?.name || '');
  const [description, setDescription] = useState(role?.description || '');
  const [level, setLevel] = useState(String(role?.level ?? 50));
  const [dataScope, setDataScope] = useState(role?.dataScope || 'OWN');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Group the matrix by module group so it reads like the sidebar.
  const groups = new Map();
  for (const mod of catalogue.modules) {
    if (!groups.has(mod.group)) groups.set(mod.group, []);
    groups.get(mod.group).push(mod);
  }

  const has = (perms, mod, action) => (perms[mod.key] || []).includes(action);

  const toggle = (mod, action, checked) => {
    setPermissions((prev) => {
      const next = { ...prev };
      const current = new Set(next[mod.key] || []);
      if (checked) {
        current.add(action);
        // Any write implies read; otherwise the row is unusable.
        if (action !== 'read' && mod.actions.includes('read')) current.add('read');
      } else {
        current.delete(action);
        if (action === 'read') current.clear();
      }
      if (current.size) next[mod.key] = [...current];
      else delete next[mod.key];
      return next;
    });
  };

  /**
   * "Toggle all" for one group. The original flipped every box in the group
   * and replayed each change, which nets out to: everything on → clear the
   * group's modules; otherwise → tick every action the matrix shows.
   */
  const toggleGroup = (modules) => {
    setPermissions((prev) => {
      const visible = (mod) => ACTIONS.filter((a) => mod.actions.includes(a));
      const allOn = modules.every((mod) => visible(mod).every((a) => has(prev, mod, a)));
      const next = { ...prev };
      for (const mod of modules) {
        if (allOn) {
          delete next[mod.key];
        } else {
          const current = new Set(next[mod.key] || []);
          for (const a of visible(mod)) current.add(a);
          if (current.size) next[mod.key] = [...current];
        }
      }
      return next;
    });
  };

  const save = async () => {
    setError('');
    if (!name.trim()) {
      setError('The role needs a name.');
      return;
    }
    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      level: Number(level) || 50,
      dataScope,
      permissions,
    };
    setSaving(true);
    try {
      if (isEdit) await api.patch(`/api/roles/${role.id}`, payload);
      else await api.post('/api/roles', payload);
      toast.success(isEdit ? 'Role updated' : 'Role created');
      onClose();
      onSaved?.();
    } catch (err) {
      setSaving(false);
      setError(err.message);
    }
  };

  return (
    <Drawer
      title={isEdit ? `Edit ${role.name}` : 'New role'}
      subtitle="Permissions decide the actions; data scope decides whose records."
      wide
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
            {isEdit ? 'Save role' : 'Create role'}
          </button>
        </div>
      }
    >
      <div>
        {error ? (
          <Alert tone="danger" className="mb-16">
            {error}
          </Alert>
        ) : null}
        {role?.isSystem ? (
          <div className="alert warning mb-16">
            <Icon name="alert" size={16} />
            <div>
              This is a built-in role. Its permissions and scope are locked so the organisation always has a working
              administrator. Duplicate it to make a custom variant.
            </div>
          </div>
        ) : null}
        <div className="form-grid">
          <Field label="Role name" required>
            <Input placeholder="Inside Sales Rep" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Authority level" hint="0 is highest. You cannot create a role above your own.">
            <Input type="number" min="0" max="100" value={level} onChange={(e) => setLevel(e.target.value)} />
          </Field>
        </div>
        <Field label="Description">
          <Textarea
            rows={2}
            placeholder="What is this role for?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label="Data scope" hint="How much of the organisation this role can see.">
          <Select
            options={catalogue.dataScopes.map((s) => ({ value: s.key, label: `${s.key.replace(/_/g, ' ')} — ${s.label}` }))}
            value={dataScope}
            onChange={(e) => setDataScope(e.target.value)}
          />
        </Field>
        <h4 className="mt-16 mb-8">Permissions</h4>
        <div className="col" style={{ gap: '16px' }}>
          {[...groups.entries()].map(([groupName, modules]) => (
            <div key={groupName}>
              <div className="row-between mb-8">
                <h4>{groupName}</h4>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => toggleGroup(modules)}>
                  Toggle all
                </button>
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Module</th>
                      {ACTIONS.map((a) => (
                        <th key={a} className="center">
                          {titleCase(a)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {modules.map((mod) => (
                      <tr key={mod.key}>
                        <td className="cell-main">{mod.label}</td>
                        {ACTIONS.map((action) => (
                          <td key={action} className="center">
                            {mod.actions.includes(action) ? (
                              <input
                                type="checkbox"
                                checked={has(permissions, mod, action)}
                                aria-label={`${mod.label} ${action}`}
                                onChange={(e) => toggle(mod, action, e.target.checked)}
                              />
                            ) : (
                              <span className="muted tiny">—</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Drawer>
  );
}
