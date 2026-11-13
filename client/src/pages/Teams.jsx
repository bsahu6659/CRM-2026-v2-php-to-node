/**
 * Team management: hierarchy, membership, territory and performance snapshot.
 * Port of the PHP edition's `views/teams.js`.
 */
import { useCallback, useEffect, useState } from 'react';
import api from '../lib/api.js';
import { money, number } from '../lib/format.js';
import { refreshReference } from '../lib/reference.js';
import { useAuth } from '../context/AuthContext.jsx';
import Icon from '../components/Icon.jsx';
import { PALETTE } from '../components/charts.jsx';
import { NoAccess, PageHead, Panel } from '../components/shared.jsx';
import {
  Alert,
  Avatar,
  Drawer,
  Dropdown,
  EmptyState,
  Field,
  Input,
  KpiCard,
  MenuItem,
  PageLoader,
  Select,
  Textarea,
  openOverlay,
  reportError,
  toast,
  useConfirm,
} from '../components/ui/index.js';

export default function Teams() {
  const { can } = useAuth();
  if (!can('teams', 'read') && !can('users', 'read')) return <NoAccess what="teams" />;
  return <TeamsPage />;
}

function TeamsPage() {
  const { can } = useAuth();
  const confirm = useConfirm();
  // null until the first load lands; later reloads keep the tree on screen
  // until the new one arrives, as the original replaced it in place.
  const [tree, setTree] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.data('/api/teams/tree');
      setTree(data);
      setError(null);
    } catch (err) {
      reportError(err);
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openTeamForm = (props = {}) =>
    openOverlay((close) => <TeamForm {...props} onClose={close} onSaved={load} />);

  const removeTeam = async (team) => {
    const yes = await confirm({
      title: 'Delete this team?',
      message: `${team.name}. Members stay, but leads routed to this team lose the link.`,
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!yes) return;
    try {
      await api.del(`/api/teams/${team.id}`);
      toast.success('Team deleted');
      refreshReference();
      load();
    } catch (err) {
      reportError(err);
    }
  };

  const showTeamStats = (team) => openOverlay((close) => <TeamStatsDrawer team={team} onClose={close} />);

  let body;
  if (error) {
    body = (
      <div className="card">
        <EmptyState iconName="alert" title="Could not load teams" message={error.message} />
      </div>
    );
  } else if (!tree) {
    body = <PageLoader label="Loading teams" />;
  } else if (!tree.length) {
    body = (
      <div className="card">
        <EmptyState
          iconName="teams"
          title="No teams yet"
          message="Teams let you route leads by territory and give managers visibility over their people."
          action={
            can('teams', 'create') ? (
              <button type="button" className="btn btn-primary" onClick={() => openTeamForm()}>
                Create a team
              </button>
            ) : null
          }
        />
      </div>
    );
  } else {
    body = (
      <div className="col" style={{ gap: '14px' }}>
        {tree.map((team) => (
          <TeamNode
            key={team.id}
            team={team}
            depth={0}
            onEdit={(t) => openTeamForm({ team: t })}
            onStats={showTeamStats}
            onAddChild={(t) => openTeamForm({ parentTeamId: t.id })}
            onDelete={removeTeam}
          />
        ))}
      </div>
    );
  }

  return (
    <div>
      <PageHead
        title="Teams"
        subtitle="Team structure drives lead routing and how much data each manager can see."
        actions={
          can('teams', 'create')
            ? [
                <button key="new" type="button" className="btn btn-primary" onClick={() => openTeamForm()}>
                  <Icon name="plus" size={15} />
                  New team
                </button>,
              ]
            : []
        }
      />
      {body}
    </div>
  );
}

function TeamNode({ team, depth, onEdit, onStats, onAddChild, onDelete }) {
  const { can } = useAuth();
  const territory = team.territory || {};
  const territoryLabel = [...(territory.states || []), ...(territory.cities || []), ...(territory.countries || [])]
    .slice(0, 5)
    .join(', ');
  const members = team.members || [];

  return (
    <div style={{ marginLeft: depth ? '28px' : '0' }}>
      <section className="card mb-8">
        <div className="card-head">
          <div className="row" style={{ gap: '11px', minWidth: 0 }}>
            <span
              style={{
                width: '34px',
                height: '34px',
                borderRadius: '10px',
                background: 'var(--brand-50)',
                color: 'var(--brand-700)',
                display: 'grid',
                placeItems: 'center',
                flex: '0 0 34px',
              }}
            >
              <Icon name="teams" size={17} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h3 className="truncate">{team.name}</h3>
              <div className="sub truncate">
                {[
                  team.region ? `${team.region} region` : null,
                  team.manager ? `Managed by ${team.manager.firstName} ${team.manager.lastName || ''}`.trim() : 'No manager',
                  territoryLabel || null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
          </div>
          <div className="row" style={{ gap: '8px' }}>
            <span className="badge">{`${number(team.memberCount)} member${team.memberCount === 1 ? '' : 's'}`}</span>
            <span className="badge badge-brand">{`${number(team.leadCount)} leads`}</span>
            {can('teams', 'update') ? (
              <Dropdown
                trigger={
                  <button type="button" className="icon-btn" aria-label="Team actions">
                    <Icon name="more" size={16} />
                  </button>
                }
              >
                <div>
                  <MenuItem iconName="edit" onClick={() => onEdit(team)}>
                    Edit team
                  </MenuItem>
                  <MenuItem iconName="trending" onClick={() => onStats(team)}>
                    View performance
                  </MenuItem>
                  {can('teams', 'create') ? (
                    <MenuItem iconName="plus" onClick={() => onAddChild(team)}>
                      Add sub-team
                    </MenuItem>
                  ) : null}
                  {can('teams', 'delete') ? (
                    <MenuItem iconName="trash" danger onClick={() => onDelete(team)}>
                      Delete team
                    </MenuItem>
                  ) : null}
                </div>
              </Dropdown>
            ) : null}
          </div>
        </div>
        {members.length ? (
          <div className="card-body">
            <div className="row wrap" style={{ gap: '8px' }}>
              {members.map((m) => (
                <div
                  key={m.user.id}
                  className="row"
                  style={{
                    gap: '8px',
                    padding: '5px 10px 5px 5px',
                    border: '1px solid var(--line)',
                    borderRadius: '20px',
                    background: 'var(--surface-2)',
                  }}
                >
                  <Avatar name={`${m.user.firstName} ${m.user.lastName || ''}`} size="sm" url={m.user.avatarUrl} />
                  <span className="small">{`${m.user.firstName} ${m.user.lastName || ''}`.trim()}</span>
                  {m.teamRole === 'LEADER' ? <span className="badge badge-brand tiny">Lead</span> : null}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="card-body">
            <p className="muted small">No members yet.</p>
          </div>
        )}
      </section>
      {(team.children || []).map((child) => (
        <TeamNode
          key={child.id}
          team={child}
          depth={depth + 1}
          onEdit={onEdit}
          onStats={onStats}
          onAddChild={onAddChild}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function TeamStatsDrawer({ team, onClose }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .data(`/api/teams/${team.id}`, undefined, { signal: ctrl.signal })
      .then((data) => setState({ status: 'ready', data, error: null }))
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setState({ status: 'error', data: null, error: err });
      });
    return () => ctrl.abort();
  }, [team.id]);

  let body;
  if (state.status === 'loading') {
    body = <PageLoader />;
  } else if (state.status === 'error') {
    body = <EmptyState iconName="alert" title="Could not load" message={state.error.message} />;
  } else {
    const { data } = state;
    body = (
      <>
        <div className="kpi-grid mb-16">
          <KpiCard label="Leads" value={number(data.stats.leads)} accent={PALETTE[0]} />
          <KpiCard label="Converted" value={number(data.stats.converted)} accent={PALETTE[2]} />
          <KpiCard label="Revenue" value={money(data.stats.revenue, { compact: true })} accent={PALETTE[1]} />
          <KpiCard label="Open tasks" value={number(data.stats.openTasks)} accent={PALETTE[3]} />
        </div>
        <Panel title="Members">
          <div className="col" style={{ gap: '8px' }}>
            {data.members.map((m) => (
              <div key={m.user.id} className="row" style={{ gap: '10px' }}>
                <Avatar name={`${m.user.firstName} ${m.user.lastName || ''}`} size="sm" />
                <div className="grow">
                  <div className="strong small">{`${m.user.firstName} ${m.user.lastName || ''}`.trim()}</div>
                  <div className="tiny muted">{m.user.role?.name || ''}</div>
                </div>
                <span className="badge">{m.teamRole}</span>
              </div>
            ))}
          </div>
        </Panel>
      </>
    );
  }

  return (
    <Drawer title={`${team.name} performance`} onClose={onClose}>
      {body}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
const splitList = (value) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function TeamForm({ team = null, parentTeamId = null, onSaved, onClose }) {
  const isEdit = Boolean(team?.id);
  const [options, setOptions] = useState(null); // { teams, users } once loaded
  const [form, setForm] = useState(() => ({
    name: team?.name || '',
    description: team?.description || '',
    region: team?.region || '',
    parentTeamId: team?.parentTeamId || parentTeamId || '',
    managerId: team?.managerId || '',
    states: (team?.territory?.states || []).join(', '),
    cities: (team?.territory?.cities || []).join(', '),
  }));
  const [memberIds, setMemberIds] = useState(() => new Set((team?.members || []).map((m) => m.user.id)));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.data('/api/teams').catch(() => []), api.data('/api/users/assignable').catch(() => [])]).then(
      ([teams, users]) => {
        if (!cancelled) setOptions({ teams, users });
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));

  const toggleMember = (id, checked) =>
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = async () => {
    setError('');
    if (!form.name.trim()) {
      setError('The team needs a name.');
      return;
    }
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      parentTeamId: form.parentTeamId || null,
      region: form.region.trim() || null,
      managerId: form.managerId || null,
      territory: {
        states: splitList(form.states),
        cities: splitList(form.cities),
        countries: [],
      },
      // Only people in the pick-list can be ticked, as in the original.
      memberIds: (options?.users || []).filter((u) => memberIds.has(u.id)).map((u) => u.id),
    };
    setSaving(true);
    try {
      const res = isEdit ? await api.patch(`/api/teams/${team.id}`, payload) : await api.post('/api/teams', payload);
      toast.success(isEdit ? 'Team saved' : 'Team created');
      refreshReference();
      onClose();
      onSaved?.(res.data);
    } catch (err) {
      setSaving(false);
      setError(err.message);
    }
  };

  let body;
  if (!options) {
    body = <PageLoader />;
  } else {
    body = (
      <div>
        {error ? (
          <Alert tone="danger" className="mb-16">
            {error}
          </Alert>
        ) : null}
        <Field label="Team name" required>
          <Input placeholder="North India Sales" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Description">
          <Textarea rows={2} value={form.description} onChange={set('description')} />
        </Field>
        <div className="form-grid">
          <Field label="Parent team">
            <Select
              options={options.teams.filter((t) => t.id !== team?.id).map((t) => ({ value: t.id, label: t.name }))}
              placeholder="Top level"
              value={form.parentTeamId}
              onChange={set('parentTeamId')}
            />
          </Field>
          <Field label="Region">
            <Input placeholder="North" value={form.region} onChange={set('region')} />
          </Field>
          <Field label="Manager" hint="Managers see everything their team can see.">
            <Select
              options={options.users.map((u) => ({ value: u.id, label: u.fullName }))}
              placeholder="No manager"
              value={form.managerId}
              onChange={set('managerId')}
            />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Territory states" hint="Comma separated.">
            <Input placeholder="Haryana, Delhi, Punjab" value={form.states} onChange={set('states')} />
          </Field>
          <Field label="Territory cities" hint="Comma separated.">
            <Input placeholder="Gurugram, Noida" value={form.cities} onChange={set('cities')} />
          </Field>
        </div>
        <Field label="Members">
          <div style={{ maxHeight: '220px', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: '8px', padding: '8px' }}>
            {options.users.map((u) => (
              <label key={u.id} className="checkbox" style={{ display: 'flex', padding: '3px 0' }}>
                <input
                  type="checkbox"
                  value={u.id}
                  checked={memberIds.has(u.id)}
                  onChange={(e) => toggleMember(u.id, e.target.checked)}
                />
                {u.fullName}
              </label>
            ))}
          </div>
        </Field>
      </div>
    );
  }

  return (
    <Drawer
      title={isEdit ? `Edit ${team.name}` : 'New team'}
      subtitle="Territory feeds the assignment rules; membership feeds data visibility."
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!options || saving} onClick={save}>
            {isEdit ? 'Save team' : 'Create team'}
          </button>
        </div>
      }
    >
      {body}
    </Drawer>
  );
}
