import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useQueryParams } from '../lib/query.js';
import { loadReference } from '../lib/reference.js';
import { emitDataChanged } from '../lib/events.js';
import { date, money, number, relative, titleCase } from '../lib/format.js';
import Icon from '../components/Icon.jsx';
import {
  FilterBar, LeadNameCell, NoAccess, OwnerCell, PageHead, ScoreCell, StatusBadge, TagList,
} from '../components/shared.jsx';
import {
  Avatar, BusyButton, DataTable, Dropdown, EmptyState, Field, Input, MenuItem, Modal, PageLoader, SearchBox,
  Select, reportError, toast, useConfirm,
} from '../components/ui/index.js';
import LeadForm from './LeadForm.jsx';

/**
 * Leads: a server-paginated table and a drag-and-drop Kanban board over the
 * same filter set, plus saved views and bulk actions. Port of the PHP
 * edition's `views/leads.js`.
 *
 * Filters live in the URL, so any view a user builds is a shareable link and
 * survives a refresh. The page is not remounted when only the query changes:
 * the table and the board read the filters from the URL on every render,
 * which is what the original's `onQuery` did.
 */
const LEAD_FILTERS = ['range', 'project', 'status', 'source', 'owner', 'team', 'priority', 'scoreBand'];

const QUICK_VIEWS = [
  { label: 'All', filters: {} },
  { label: 'My leads', filters: { ownerId: 'me' } },
  { label: 'Unassigned', filters: { unassigned: 'true' } },
  // Enquiries with no project attached - from an older form, an import or
  // Meta. Typing one in by hand now requires a project, so this list only
  // ever shrinks.
  { label: 'No project', filters: { noProject: 'true' } },
  { label: 'Follow-up today', filters: { followUp: 'today' } },
  { label: 'Overdue', filters: { followUp: 'overdue' } },
  { label: 'Hot & very hot', filters: { scoreBand: 'HOT,VERY_HOT' } },
  { label: 'Converted', filters: { converted: 'true' } },
];

const TASK_TYPES = ['CALL', 'EMAIL', 'MEETING', 'FOLLOW_UP', 'TASK'].map((t) => ({ value: t, label: titleCase(t) }));
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => ({ value: p, label: titleCase(p) }));

const plural = (n) => `${n} lead${n === 1 ? '' : 's'}`;

/** The query minus the keys that steer the page rather than filter the data. */
function stripControlKeys(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'view' || key === 'page' || value === '') continue;
    out[key] = value;
  }
  return out;
}

export default function Leads() {
  const { can } = useAuth();
  if (!can('leads', 'read')) return <NoAccess what="leads" />;
  return <LeadsPage />;
}

function LeadsPage() {
  const { can, user } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [query, setQuery] = useQueryParams();
  const view = query.view === 'board' ? 'board' : 'list';
  const filters = useMemo(() => stripControlKeys(query), [query]);

  const tableRef = useRef(null);
  const [boardKey, setBoardKey] = useState(0);
  const [savedViews, setSavedViews] = useState([]);
  // { lead } while the lead drawer is open (lead null = new).
  const [form, setForm] = useState(null);
  // The open bulk / save-view dialog: { kind, ... }.
  const [dialog, setDialog] = useState(null);

  const loadSavedViews = useCallback(async () => {
    let saved = [];
    try {
      saved = await api.data('/api/saved-views', { entity: 'LEAD' });
    } catch {
      saved = [];
    }
    setSavedViews(Array.isArray(saved) ? saved : []);
  }, []);

  useEffect(() => {
    loadSavedViews();
  }, [loadSavedViews]);

  const boardParam = view === 'board' ? 'board' : '';

  function switchView(next) {
    if (view === next) return;
    setQuery({ view: next === 'board' ? 'board' : '' });
  }

  // Merges into the current filters; an empty value removes that filter.
  const applyFilters = (patch) => setQuery(patch);

  // Replaces every filter (a quick or saved view), keeping the list/board choice.
  const replaceFilters = (next) => setQuery({ ...next, view: boardParam }, { merge: false });

  function matchesFilters(candidate) {
    const keys = Object.keys(candidate);
    if (!keys.length) return !Object.keys(filters).length;
    return keys.every((k) => String(filters[k] || '') === String(candidate[k]));
  }

  function refreshCurrent() {
    if (view === 'list') tableRef.current?.refresh();
    else setBoardKey((k) => k + 1);
  }

  function exportLeads() {
    api
      .download('/api/leads/export', filters)
      .then(() => toast.success('Export downloaded'))
      .catch(reportError);
  }

  async function deleteLead(row) {
    const yes = await confirm({
      title: 'Delete this lead?',
      message: `${row.fullName} and its entire timeline will be removed. This cannot be undone.`,
      confirmLabel: 'Delete lead',
      danger: true,
    });
    if (!yes) return;
    try {
      await api.del(`/api/leads/${row.id}`);
      toast.success('Lead deleted');
      tableRef.current?.refresh();
    } catch (err) {
      reportError(err);
    }
  }

  async function bulkDelete(ids, ctx) {
    const yes = await confirm({
      title: `Delete ${plural(ids.length)}?`,
      message: 'Their activities, tasks and documents go with them. This cannot be undone.',
      confirmLabel: 'Delete permanently',
      danger: true,
      requireText: 'DELETE',
    });
    if (!yes) return;
    try {
      const res = await api.post('/api/leads/bulk/delete', { leadIds: ids });
      toast.success(`${res.data.deleted} lead(s) deleted`);
      ctx.clear();
      tableRef.current?.refresh();
    } catch (err) {
      reportError(err);
    }
  }

  async function openWithReference(kind, ids, ctx) {
    const reference = await loadReference();
    setDialog({ kind, ids, ctx, reference });
  }

  const actions = [
    <div key="view" className="btn-group">
      <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => switchView('list')}>
        List
      </button>
      <button type="button" className={view === 'board' ? 'active' : ''} onClick={() => switchView('board')}>
        Board
      </button>
    </div>,
    can('leads', 'export') ? (
      <button key="export" type="button" className="btn" onClick={exportLeads}>
        <Icon name="download" size={15} />
        Export
      </button>
    ) : null,
    can('imports', 'create') ? (
      <button key="import" type="button" className="btn" onClick={() => navigate('/imports')}>
        <Icon name="import" size={15} />
        Import
      </button>
    ) : null,
    can('leads', 'create') ? (
      <button key="new" type="button" className="btn btn-primary" onClick={() => setForm({ lead: null })}>
        <Icon name="plus" size={15} />
        New lead
      </button>
    ) : null,
  ].filter(Boolean);

  const toolbar = (
    <div className="toolbar">
      <SearchBox
        placeholder="Search name, email, phone, company…"
        value={filters.q || ''}
        onSearch={(value) => applyFilters({ q: value })}
      />
      <FilterBar filters={LEAD_FILTERS} current={filters} onChange={applyFilters} />
    </div>
  );

  const columns = [
    { label: 'Lead', sortKey: 'firstName', render: (row) => <LeadNameCell lead={row} /> },
    {
      label: 'Contact',
      render: (row) => (
        <div>
          <div className="truncate">{row.email || '—'}</div>
          <div className="cell-sub">{row.phone || ''}</div>
        </div>
      ),
    },
    {
      label: 'Project',
      cellClass: 'hide-sm',
      render: (row) =>
        row.projectName ? (
          <div>
            <div className="truncate">{row.projectName}</div>
            {row.configuration ? <div className="cell-sub">{row.configuration}</div> : null}
          </div>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { label: 'Status', render: (row) => <StatusBadge name={row.status?.name} color={row.status?.color} /> },
    { label: 'Score', sortKey: 'score', render: (row) => <ScoreCell score={row.score} band={row.scoreBand} /> },
    { label: 'Source', cellClass: 'hide-sm', render: (row) => <span className="small">{row.source?.name || '—'}</span> },
    { label: 'Owner', render: (row) => <OwnerCell owner={row.owner} /> },
    {
      label: 'Value',
      sortKey: 'expectedValue',
      cellClass: 'right hide-sm',
      render: (row) => (row.expectedValue ? money(row.expectedValue, { compact: true }) : '—'),
    },
    {
      label: 'Follow-up',
      sortKey: 'nextFollowUpAt',
      cellClass: 'hide-sm',
      render: (row) => {
        if (!row.nextFollowUpAt) return <span className="muted">—</span>;
        const overdue = new Date(row.nextFollowUpAt) < new Date();
        return <span className={overdue ? 'badge badge-danger' : 'badge'}>{relative(row.nextFollowUpAt)}</span>;
      },
    },
    {
      label: 'Created',
      sortKey: 'createdAt',
      cellClass: 'hide-sm',
      render: (row) => <span className="small muted">{date(row.createdAt)}</span>,
    },
    {
      label: '',
      width: '48px',
      render: (row) => (
        <Dropdown
          trigger={
            <button type="button" className="icon-btn" aria-label="Row actions">
              <Icon name="more" size={16} />
            </button>
          }
        >
          <div>
            <MenuItem iconName="eye" onClick={() => navigate(`/leads/${row.id}`)}>
              Open
            </MenuItem>
            {can('leads', 'update') ? (
              <MenuItem iconName="edit" onClick={() => setForm({ lead: row })}>
                Edit
              </MenuItem>
            ) : null}
            {can('leads', 'delete') ? (
              <MenuItem iconName="trash" danger onClick={() => deleteLead(row)}>
                Delete
              </MenuItem>
            ) : null}
          </div>
        </Dropdown>
      ),
    },
  ];

  const bulkActions = (ids, ctx) => (
    <div className="row wrap" style={{ gap: '6px' }}>
      {can('leads', 'assign') ? (
        <button type="button" className="btn btn-sm" onClick={() => openWithReference('assign', ids, ctx)}>
          <Icon name="user" size={14} />
          Assign
        </button>
      ) : null}
      {can('leads', 'change_status') ? (
        <button type="button" className="btn btn-sm" onClick={() => openWithReference('status', ids, ctx)}>
          <Icon name="refresh" size={14} />
          Change status
        </button>
      ) : null}
      {can('leads', 'update') ? (
        <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: 'tag', ids, ctx })}>
          <Icon name="star" size={14} />
          Tag
        </button>
      ) : null}
      {can('tasks', 'create') ? (
        <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: 'task', ids, ctx })}>
          <Icon name="tasks" size={14} />
          Create tasks
        </button>
      ) : null}
      {can('leads', 'delete') ? (
        <button type="button" className="btn btn-sm btn-danger" onClick={() => bulkDelete(ids, ctx)}>
          <Icon name="trash" size={14} />
          Delete
        </button>
      ) : null}
    </div>
  );

  // After a bulk change: drop the selection and reload the rows.
  const afterBulk = (ctx) => {
    ctx.clear();
    tableRef.current?.refresh();
  };

  const closeDialog = () => setDialog(null);

  return (
    <div>
      <PageHead
        title="Leads"
        subtitle="Every prospect in your scope, from first touch to conversion."
        actions={actions}
      />

      <div className="row wrap chip-strip" style={{ gap: '6px' }}>
        {QUICK_VIEWS.map((qv) => {
          // 'me' is a placeholder for the signed-in user; resolve it once so
          // the highlight compares against the id the filter actually holds.
          const resolved = { ...qv.filters };
          if (resolved.ownerId === 'me') resolved.ownerId = user.id;
          return (
            <button
              key={qv.label}
              type="button"
              className={`btn btn-sm ${matchesFilters(resolved) ? 'btn-primary' : ''}`}
              onClick={() => replaceFilters(resolved)}
            >
              {qv.label}
            </button>
          );
        })}
        {savedViews.map((sv) => (
          <button
            key={sv.id}
            type="button"
            className="btn btn-sm"
            title={sv.owned ? 'Your saved view' : 'Shared view'}
            onClick={() => replaceFilters({ ...(sv.filters || {}) })}
          >
            <Icon name="star" size={12} />
            {sv.name}
          </button>
        ))}
        {Object.keys(filters).length ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: 'saveView' })}>
            <Icon name="save" size={13} />
            Save view
          </button>
        ) : null}
      </div>

      <div className="mt-16">
        {view === 'board' ? (
          <LeadBoard filters={filters} toolbar={toolbar} reloadKey={boardKey} />
        ) : (
          <DataTable
            ref={tableRef}
            toolbar={toolbar}
            params={filters}
            defaultSort="createdAt"
            selectable={can('leads', 'update') || can('leads', 'assign') || can('leads', 'delete')}
            onRowClick={(row) => navigate(`/leads/${row.id}`)}
            load={(params) => api.get('/api/leads', params)}
            emptyTitle="No leads match these filters"
            emptyMessage="Try widening the date range or clearing a filter."
            emptyAction={
              can('leads', 'create') ? (
                <button type="button" className="btn btn-primary" onClick={() => setForm({ lead: null })}>
                  Add a lead
                </button>
              ) : null
            }
            columns={columns}
            bulkActions={bulkActions}
          />
        )}
      </div>

      {form ? <LeadForm lead={form.lead} onClose={() => setForm(null)} onSaved={refreshCurrent} /> : null}

      {dialog?.kind === 'saveView' ? (
        <SaveViewDialog filters={filters} onClose={closeDialog} onSaved={loadSavedViews} />
      ) : null}
      {dialog?.kind === 'assign' ? (
        <BulkAssignDialog
          ids={dialog.ids}
          reference={dialog.reference}
          onClose={closeDialog}
          onDone={() => afterBulk(dialog.ctx)}
        />
      ) : null}
      {dialog?.kind === 'status' ? (
        <BulkStatusDialog
          ids={dialog.ids}
          reference={dialog.reference}
          onClose={closeDialog}
          onDone={() => afterBulk(dialog.ctx)}
        />
      ) : null}
      {dialog?.kind === 'tag' ? (
        <BulkTagDialog ids={dialog.ids} onClose={closeDialog} onDone={() => afterBulk(dialog.ctx)} />
      ) : null}
      {dialog?.kind === 'task' ? (
        <BulkTaskDialog
          ids={dialog.ids}
          onClose={closeDialog}
          onDone={() => {
            dialog.ctx.clear();
            emitDataChanged();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function DialogFooter({ onClose, onConfirm, label }) {
  return (
    <div className="row">
      <button type="button" className="btn" onClick={onClose}>
        Cancel
      </button>
      <BusyButton className="btn btn-primary" onClick={onConfirm}>
        {label}
      </BusyButton>
    </div>
  );
}

function SaveViewDialog({ filters, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const nameRef = useRef(null);

  async function save() {
    if (!name.trim()) {
      nameRef.current?.focus();
      return;
    }
    try {
      await api.post('/api/saved-views', {
        entity: 'LEAD',
        name: name.trim(),
        filters,
        isShared: shared,
      });
      toast.success('View saved');
      onClose();
      onSaved();
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <Modal
      title="Save this view"
      subtitle="Filters, not results - the view stays live."
      onClose={onClose}
      footer={<DialogFooter onClose={onClose} onConfirm={save} label="Save" />}
    >
      <div>
        <Field label="View name" required>
          <Input ref={nameRef} placeholder="My hot leads" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <label className="checkbox">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          Share with everyone in the organisation
        </label>
      </div>
    </Modal>
  );
}

function BulkAssignDialog({ ids, reference, onClose, onDone }) {
  const [ownerId, setOwnerId] = useState('');
  const [teamId, setTeamId] = useState('');

  async function assign() {
    if (!ownerId && !teamId) {
      toast.warn('Choose a user or a team');
      return;
    }
    try {
      const res = await api.post('/api/leads/bulk/assign', {
        leadIds: ids,
        ownerId: ownerId || undefined,
        teamId: teamId || undefined,
      });
      toast.success(`${res.data.updated} lead(s) assigned`);
      onClose();
      onDone();
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <Modal
      title={`Assign ${plural(ids.length)}`}
      onClose={onClose}
      footer={<DialogFooter onClose={onClose} onConfirm={assign} label="Assign" />}
    >
      <div>
        <Field label="Assign to user">
          <Select
            options={reference.users.map((u) => ({ value: u.id, label: u.fullName || u.name }))}
            placeholder="Choose a user"
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
          />
        </Field>
        <Field label="Or route to team" hint="Choose one. Team routing leaves the owner open for the team to pick up.">
          <Select
            options={reference.teams.map((t) => ({ value: t.id, label: t.name }))}
            placeholder="Or a team"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

function BulkStatusDialog({ ids, reference, onClose, onDone }) {
  const [statusId, setStatusId] = useState('');
  const [reason, setReason] = useState('');

  async function update() {
    if (!statusId) {
      toast.warn('Pick a status');
      return;
    }
    try {
      const res = await api.post('/api/leads/bulk/status', {
        leadIds: ids,
        statusId,
        lostReason: reason || undefined,
      });
      toast.success(`${res.data.updated} lead(s) updated`);
      onClose();
      onDone();
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <Modal
      title={`Change status for ${plural(ids.length)}`}
      onClose={onClose}
      footer={<DialogFooter onClose={onClose} onConfirm={update} label="Update" />}
    >
      <div>
        <Field label="New status" required>
          <Select
            options={reference.statuses.map((s) => ({ value: s.id, label: s.name }))}
            placeholder="Choose a status"
            value={statusId}
            onChange={(e) => setStatusId(e.target.value)}
          />
        </Field>
        <Field label="Reason">
          <Input
            placeholder="Optional reason (used when marking lost)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

function BulkTagDialog({ ids, onClose, onDone }) {
  const [text, setText] = useState('');

  async function apply() {
    const tags = text.split(',').map((t) => t.trim()).filter(Boolean);
    if (!tags.length) {
      toast.warn('Enter at least one tag');
      return;
    }
    try {
      await api.post('/api/leads/bulk/tag', { leadIds: ids, tags });
      toast.success('Tags applied');
      onClose();
      onDone();
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <Modal
      title={`Tag ${plural(ids.length)}`}
      onClose={onClose}
      footer={<DialogFooter onClose={onClose} onConfirm={apply} label="Apply" />}
    >
      <Field label="Tags" hint="Comma separated. Existing tags are kept.">
        <Input placeholder="enterprise, high-intent" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
    </Modal>
  );
}

function BulkTaskDialog({ ids, onClose, onDone }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState('CALL');
  const [priority, setPriority] = useState('MEDIUM');
  const [days, setDays] = useState('1');
  const titleRef = useRef(null);

  async function create() {
    if (!title.trim()) {
      titleRef.current?.focus();
      return;
    }
    try {
      const res = await api.post('/api/leads/bulk/tasks', {
        leadIds: ids,
        title: title.trim(),
        type,
        priority,
        dueInDays: Number(days) || 1,
      });
      toast.success(`${res.data.created} task(s) created`);
      onClose();
      onDone();
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <Modal
      title={`Create a task on ${plural(ids.length)}`}
      onClose={onClose}
      footer={<DialogFooter onClose={onClose} onConfirm={create} label="Create tasks" />}
    >
      <div>
        <Field label="Task title" required>
          <Input ref={titleRef} placeholder="Call and qualify" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="Type">
            <Select options={TASK_TYPES} value={type} onChange={(e) => setType(e.target.value)} />
          </Field>
          <Field label="Priority">
            <Select options={PRIORITIES} value={priority} onChange={(e) => setPriority(e.target.value)} />
          </Field>
          <Field label="Due in (days)">
            <Input type="number" min="0" max="90" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Board view
// ---------------------------------------------------------------------------

function LeadBoard({ filters, toolbar, reloadKey }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState({ status: 'loading', columns: [], error: null });
  const [dragOver, setDragOver] = useState(null);
  const [dragging, setDragging] = useState(null);
  const filtersKey = JSON.stringify(filters);
  const token = useRef(0);

  const loadBoard = useCallback(
    async (showLoader) => {
      const mine = ++token.current;
      if (showLoader) setState((s) => ({ ...s, status: 'loading' }));
      try {
        const columns = await api.data('/api/leads/board', JSON.parse(filtersKey));
        if (mine !== token.current) return;
        setState({ status: 'ready', columns: columns || [], error: null });
      } catch (err) {
        if (mine !== token.current) return;
        reportError(err);
        setState({ status: 'error', columns: [], error: err });
      }
    },
    [filtersKey]
  );

  // New filters or an explicit refresh rebuild the board behind a loader.
  useEffect(() => {
    loadBoard(true);
    return () => {
      token.current += 1;
    };
  }, [loadBoard, reloadKey]);

  async function onDrop(e, column) {
    e.preventDefault();
    setDragOver(null);
    const leadId = e.dataTransfer.getData('text/plain');
    if (!leadId) return;
    if (!can('leads', 'change_status')) {
      toast.warn('You do not have permission to change lead status.');
      return;
    }
    try {
      await api.patch(`/api/leads/${leadId}`, { statusId: column.status.id });
      toast.success(`Moved to ${column.status.name}`);
      loadBoard(false);
    } catch (err) {
      reportError(err);
    }
  }

  let body;
  if (state.status === 'loading') {
    body = <PageLoader label="Loading board" />;
  } else if (state.status === 'error') {
    body = (
      <div className="card">
        <EmptyState iconName="alert" title="Could not load the board" message={state.error.message} />
      </div>
    );
  } else if (!state.columns.length) {
    body = (
      <div className="card">
        <EmptyState title="No statuses configured" />
      </div>
    );
  } else {
    const draggable = can('leads', 'update');
    body = (
      <div className="kanban">
        {state.columns.map((column) => (
          <div
            key={column.status.id}
            className={dragOver === column.status.id ? 'kanban-col drag-over' : 'kanban-col'}
            data-status-id={column.status.id}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(column.status.id);
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => onDrop(e, column)}
          >
            <div className="kanban-col-head">
              <span className="k-dot" style={{ background: column.status.color }} />
              <span className="k-name">{column.status.name}</span>
              <span className="k-count">{number(column.total)}</span>
            </div>
            <div className="kanban-col-body">
              {column.items.map((lead) => (
                <div
                  key={lead.id}
                  className={dragging === lead.id ? 'kanban-card dragging' : 'kanban-card'}
                  draggable={draggable ? 'true' : 'false'}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', lead.id);
                    e.dataTransfer.effectAllowed = 'move';
                    setDragging(lead.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => navigate(`/leads/${lead.id}`)}
                >
                  <div className="kc-title truncate">{lead.fullName}</div>
                  <div className="kc-sub truncate">
                    {[lead.company, lead.city].filter(Boolean).join(' · ') || lead.email || lead.phone || ''}
                  </div>
                  {lead.tags?.length ? (
                    <div className="mb-8">
                      <TagList tags={lead.tags} />
                    </div>
                  ) : null}
                  <div className="kc-foot">
                    <div className="row" style={{ gap: '6px' }}>
                      <ScoreCell score={lead.score} band={lead.scoreBand} />
                    </div>
                    {lead.owner ? (
                      <Avatar
                        name={`${lead.owner.firstName} ${lead.owner.lastName || ''}`}
                        size="sm"
                        url={lead.owner.avatarUrl}
                      />
                    ) : (
                      <span className="badge">Open</span>
                    )}
                  </div>
                  {lead.expectedValue ? (
                    <div className="tiny muted mt-8">{money(lead.expectedValue, { compact: true })}</div>
                  ) : null}
                </div>
              ))}
              {column.total > column.items.length ? (
                <div className="muted tiny center" style={{ padding: '6px' }}>
                  {`+${column.total - column.items.length} more`}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="card mb-16">{toolbar}</div>
      {body}
    </div>
  );
}
