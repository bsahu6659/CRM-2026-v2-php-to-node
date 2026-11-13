/**
 * Automation: assignment rules, lead scoring, workflows and follow-up sequences.
 *
 * The condition builder is shared by assignment rules and workflows - both send
 * the same `{ match, conditions[] }` shape to the server, which is also what the
 * evaluator reads, so what you build is literally what runs. The builders and
 * editors live in ./automation/.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useQueryParams } from '../lib/query.js';
import { dateTime, number, relative, titleCase } from '../lib/format.js';
import Icon from '../components/Icon.jsx';
import { NoAccess, PageHead, Panel } from '../components/shared.jsx';
import {
  BusyButton,
  Drawer,
  Dropdown,
  EmptyState,
  Field,
  Input,
  MenuItem,
  Modal,
  PageLoader,
  Select,
  Tabs,
  confirmDialog,
  openOverlay,
  reportError,
  toast,
} from '../components/ui/index.js';
import { userName } from './automation/builders.jsx';
import { AssignmentRuleForm, ScoringRuleForm, SequenceForm, WorkflowForm } from './automation/forms.jsx';

const TABS = [
  { key: 'assignment', label: 'Lead assignment' },
  { key: 'scoring', label: 'Lead scoring' },
  { key: 'workflows', label: 'Workflows' },
  { key: 'sequences', label: 'Follow-up sequences' },
];

const LIST_PATHS = {
  assignment: '/api/automation/assignment-rules',
  scoring: '/api/automation/scoring-rules',
  workflows: '/api/automation/workflows',
  sequences: '/api/automation/sequences',
};

const RUN_TONE = { SUCCESS: 'badge-success', FAILED: 'badge-danger', SKIPPED: '' };

// ---------------------------------------------------------------------------
// Turning stored rules back into words
// ---------------------------------------------------------------------------
const labelForField = (meta, key) => meta.leadFields.find((f) => f.key === key)?.label || key;
const labelForOperator = (meta, key) => meta.operators.find((o) => o.key === key)?.label || key;

/** A condition's value as a person reads it: a user's name, not their id. */
function formatValue(meta, fieldKey, value) {
  if (value === undefined || value === null || value === '') return '';
  const def = meta.leadFields.find((f) => f.key === fieldKey);
  if (def?.type === 'user') {
    const u = meta.options.users.find((x) => x.id === value);
    return u ? userName(u) : value;
  }
  if (def?.type === 'team') return meta.options.teams.find((t) => t.id === value)?.name || value;
  if (def?.type === 'project') return (meta.options.projects || []).find((p) => p.id === value)?.name || value;
  return String(value);
}

const conditionText = (meta, c) =>
  `${labelForField(meta, c.field)} ${labelForOperator(meta, c.operator)} ${formatValue(meta, c.field, c.value)}`;

function describeStrategy(meta, rule) {
  const strategy = meta.strategies.find((s) => s.key === rule.strategy)?.label || rule.strategy;
  const team = meta.options.teams.find((t) => t.id === rule.targetTeamId);
  const users = (rule.targetUserIds || [])
    .map((id) => meta.options.users.find((u) => u.id === id))
    .filter(Boolean)
    .map(userName);
  const parts = [strategy];
  if (team) parts.push(`team ${team.name}`);
  if (users.length) parts.push(users.slice(0, 3).join(', ') + (users.length > 3 ? ` +${users.length - 3}` : ''));
  return parts.join(' · ');
}

function describeScoringRule(meta, rule) {
  const kind = meta.scoringKinds.find((k) => k.key === rule.kind)?.label || rule.kind;
  return [kind, rule.field, rule.value].filter(Boolean).join(' · ');
}

/** `div.alert.info` with the info icon (the shared <Alert> draws the warning glyph). */
function InfoNote({ className, children }) {
  return (
    <div className={['alert info', className].filter(Boolean).join(' ')}>
      <Icon name="info" size={16} />
      <div>{children}</div>
    </div>
  );
}

/** The "⋯" trigger every rule card and row uses. */
const moreButton = (label) => (
  <button type="button" className="icon-btn" aria-label={label}>
    <Icon name="more" size={16} />
  </button>
);

/** Delete after a confirmation naming the thing; shared by every list. */
async function confirmAndDelete({ title, name, path, done, reload }) {
  const yes = await confirmDialog({ title, message: name, danger: true, confirmLabel: 'Delete' });
  if (!yes) return;
  try {
    await api.del(path);
    toast.success(done);
    reload();
  } catch (err) {
    reportError(err);
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function Automation() {
  const { can } = useAuth();
  if (!can('automation', 'read')) return <NoAccess what="automation" />;
  return <AutomationPage />;
}

function AutomationPage() {
  const { can } = useAuth();
  const [query, setQuery] = useQueryParams();
  const tab = TABS.some((t) => t.key === query.tab) ? query.tab : 'assignment';

  // The metadata (fields, operators, strategies, pickers) is fetched once per
  // visit, as the original did, and shared by every tab and editor.
  const metaRef = useRef(null);
  const [view, setView] = useState({ status: 'loading', tab, items: [], error: null });
  const [recalculating, setRecalculating] = useState(false);

  const load = useCallback(
    async (signal) => {
      setView({ status: 'loading', tab, items: [], error: null });
      try {
        if (!metaRef.current) metaRef.current = await api.data('/api/automation/metadata', undefined, { signal });
        const items = await api.data(LIST_PATHS[tab], undefined, { signal });
        setView({ status: 'ready', tab, items, error: null });
      } catch (err) {
        if (err.name === 'AbortError') return;
        reportError(err);
        setView({ status: 'error', tab, items: [], error: err });
      }
    },
    [tab]
  );

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const reload = useCallback(() => load(), [load]);
  const meta = metaRef.current;

  // Clicking the open tab reloads it, as the original's tab bar did.
  const selectTab = (key) => {
    if (key === tab) reload();
    else setQuery({ tab: key }, { merge: false });
  };

  const openAssignment = (rule = null) =>
    openOverlay((close) => <AssignmentRuleForm meta={meta} rule={rule} onClose={close} onSaved={reload} />);
  const openScoring = (rule = null) =>
    openOverlay((close) => <ScoringRuleForm meta={meta} rule={rule} onClose={close} onSaved={reload} />);
  const openWorkflow = (workflow = null) =>
    openOverlay((close) => <WorkflowForm meta={meta} workflow={workflow} onClose={close} onSaved={reload} />);
  const openSequence = (sequence = null) =>
    openOverlay((close) => <SequenceForm meta={meta} sequence={sequence} onClose={close} onSaved={reload} />);
  const openTest = () => openOverlay((close) => <TestRulesModal meta={meta} onClose={close} />);
  const openRuns = (workflow) => openOverlay((close) => <WorkflowRunsDrawer workflow={workflow} onClose={close} />);

  async function recalculate() {
    const yes = await confirmDialog({
      title: 'Recalculate every lead score?',
      message: 'Runs the current rules over every lead in the organisation. On a large database this takes a moment.',
      confirmLabel: 'Recalculate',
    });
    if (!yes) return;
    setRecalculating(true);
    try {
      const res = await api.post('/api/automation/scoring-rules/recalculate');
      toast.success(`${res.data.changed} of ${res.data.processed} lead scores updated`);
    } catch (err) {
      reportError(err);
    } finally {
      setRecalculating(false);
    }
  }

  const current = view.tab === tab;
  const ready = current && view.status === 'ready';

  // Header actions belong to the tab on screen, and appear once it has loaded.
  let actions = null;
  if (ready && can('automation', 'create')) {
    if (tab === 'assignment') {
      actions = [
        <button key="test" type="button" className="btn" onClick={openTest}>
          <Icon name="play" size={15} />
          Test a lead
        </button>,
        <button key="new" type="button" className="btn btn-primary" onClick={() => openAssignment()}>
          <Icon name="plus" size={15} />
          New rule
        </button>,
      ];
    } else if (tab === 'scoring') {
      actions = [
        // The server guards recalculation with automation:update, so a role
        // that can only create rules would see a button that always 403s.
        can('automation', 'update') ? (
          <button key="recalc" type="button" className="btn" disabled={recalculating} onClick={recalculate}>
            <Icon name="refresh" size={15} />
            Recalculate all
          </button>
        ) : null,
        <button key="new" type="button" className="btn btn-primary" onClick={() => openScoring()}>
          <Icon name="plus" size={15} />
          New rule
        </button>,
      ];
    } else if (tab === 'workflows') {
      actions = [
        <button key="new" type="button" className="btn btn-primary" onClick={() => openWorkflow()}>
          <Icon name="plus" size={15} />
          New workflow
        </button>,
      ];
    } else {
      actions = [
        <button key="new" type="button" className="btn btn-primary" onClick={() => openSequence()}>
          <Icon name="plus" size={15} />
          New sequence
        </button>,
      ];
    }
  }

  let body;
  if (current && view.status === 'error') {
    body = (
      <div className="card">
        <EmptyState iconName="alert" title="Could not load" message={view.error.message} />
      </div>
    );
  } else if (!ready) {
    body = <PageLoader />;
  } else if (tab === 'assignment') {
    body = (
      <AssignmentRules meta={meta} rules={view.items} reload={reload} onNew={() => openAssignment()} onEdit={openAssignment} />
    );
  } else if (tab === 'scoring') {
    body = <ScoringRules meta={meta} rules={view.items} reload={reload} onNew={() => openScoring()} onEdit={openScoring} />;
  } else if (tab === 'workflows') {
    body = (
      <Workflows
        meta={meta}
        workflows={view.items}
        reload={reload}
        onNew={() => openWorkflow()}
        onEdit={openWorkflow}
        onRuns={openRuns}
      />
    );
  } else {
    body = <Sequences sequences={view.items} reload={reload} onNew={() => openSequence()} onEdit={openSequence} />;
  }

  return (
    <div>
      <PageHead
        title="Automation"
        subtitle="Route leads, score them, and run workflows without anyone touching a keyboard."
        actions={actions}
      />
      <div className="mb-16">
        <Tabs items={TABS} active={tab} onSelect={selectTab} />
      </div>
      <div>{body}</div>
    </div>
  );
}

// ===========================================================================
// Assignment rules
// ===========================================================================
function AssignmentRules({ meta, rules, reload, onNew, onEdit }) {
  const { can } = useAuth();

  if (!rules.length) {
    return (
      <div className="card">
        <EmptyState
          iconName="automation"
          title="No assignment rules"
          message="Without rules, new leads fall back to load-balanced round robin across everyone who can take leads."
          action={
            can('automation', 'create') ? (
              <button type="button" className="btn btn-primary" onClick={onNew}>
                Create a rule
              </button>
            ) : null
          }
        />
      </div>
    );
  }

  return (
    <>
      <InfoNote className="mb-16">
        Rules run in priority order (lowest first). The first rule that matches wins, unless it is set to keep going.
      </InfoNote>
      <div className="col" style={{ gap: '10px' }}>
        {rules.map((rule) => (
          <RuleCard key={rule.id} meta={meta} rule={rule} reload={reload} onEdit={onEdit} />
        ))}
      </div>
    </>
  );
}

function RuleCard({ meta, rule, reload, onEdit }) {
  const { can } = useAuth();
  const conditions = rule.conditions?.conditions || [];

  async function toggleActive() {
    try {
      await api.patch(`/api/automation/assignment-rules/${rule.id}`, { isActive: !rule.isActive });
      toast.success(rule.isActive ? 'Rule paused' : 'Rule activated');
      reload();
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="row" style={{ gap: '8px' }}>
            <span className="badge">{`#${rule.priority}`}</span>
            {rule.name}
            {rule.isActive ? null : <span className="badge badge-warning">Paused</span>}
          </h3>
          <div className="sub">{rule.description || describeStrategy(meta, rule)}</div>
        </div>
        <div className="row" style={{ gap: '8px' }}>
          <span className="badge badge-brand">{`${number(rule.assignedCount)} assigned`}</span>
          {can('automation', 'update') ? (
            <Dropdown trigger={moreButton('Rule actions')}>
              <MenuItem iconName="edit" onClick={() => onEdit(rule)}>
                Edit
              </MenuItem>
              <MenuItem iconName={rule.isActive ? 'close' : 'check'} onClick={toggleActive}>
                {rule.isActive ? 'Pause' : 'Activate'}
              </MenuItem>
              {can('automation', 'delete') ? (
                <MenuItem
                  iconName="trash"
                  danger
                  onClick={() =>
                    confirmAndDelete({
                      title: 'Delete this rule?',
                      name: rule.name,
                      path: `/api/automation/assignment-rules/${rule.id}`,
                      done: 'Rule deleted',
                      reload,
                    })
                  }
                >
                  Delete
                </MenuItem>
              ) : null}
            </Dropdown>
          ) : null}
        </div>
      </div>
      <div className="card-body">
        <div className="row wrap" style={{ gap: '8px', alignItems: 'flex-start' }}>
          <span className="badge badge-info" style={{ flex: '0 0 auto' }}>
            IF
          </span>
          {conditions.length ? (
            <div className="row wrap" style={{ gap: '6px' }}>
              {conditions.map((c, i) => [
                i > 0 ? (
                  <span key={`op${i}`} className="tiny muted strong">
                    {rule.conditions.match === 'ANY' ? 'OR' : 'AND'}
                  </span>
                ) : null,
                <span key={`c${i}`} className="chip">
                  {conditionText(meta, c)}
                </span>,
              ])}
            </div>
          ) : (
            <span className="muted small">any lead</span>
          )}
        </div>
        <div className="row wrap mt-8" style={{ gap: '8px' }}>
          <span className="badge badge-success" style={{ flex: '0 0 auto' }}>
            THEN
          </span>
          <span className="small">{describeStrategy(meta, rule)}</span>
        </div>
      </div>
    </section>
  );
}

/** Dry run of the rule chain for a made-up lead. Nothing is created. */
function TestRulesModal({ meta, onClose }) {
  const [sourceId, setSourceId] = useState('');
  const [stateName, setStateName] = useState('');
  const [expectedValue, setExpectedValue] = useState('');
  const [result, setResult] = useState(null);

  async function run() {
    try {
      const res = await api.post('/api/automation/assignment-rules/test', {
        lead: {
          sourceId: sourceId || null,
          state: stateName || null,
          expectedValue: expectedValue ? Number(expectedValue) : null,
        },
      });
      setResult(res.data);
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <Modal
      title="Test the assignment rules"
      subtitle="A dry run. Nothing is created and no rotation counter moves."
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <BusyButton className="btn btn-primary" onClick={run}>
            Run test
          </BusyButton>
        </div>
      }
    >
      <div className="form-grid">
        <Field label="Lead source">
          <Select
            options={meta.options.sources.map((s) => ({ value: s.id, label: s.name }))}
            placeholder="Any source"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
          />
        </Field>
        <Field label="State">
          <Input placeholder="Haryana" value={stateName} onChange={(e) => setStateName(e.target.value)} />
        </Field>
        <Field label="Expected value">
          <Input
            type="number"
            placeholder="500000"
            value={expectedValue}
            onChange={(e) => setExpectedValue(e.target.value)}
          />
        </Field>
      </div>
      {result ? (
        <div className="mt-16">
          {result.firstMatch ? (
            <div className="alert success mb-16">
              <Icon name="check" size={16} />
              <div>
                <strong>Matched</strong>
                {`“${result.firstMatch.name}” would assign this lead.`}
              </div>
            </div>
          ) : (
            <div className="alert warning mb-16">
              <Icon name="alert" size={16} />
              <div>
                <strong>No rule matched</strong>
                The default load-balanced fallback would be used.
              </div>
            </div>
          )}
          <div className="col" style={{ gap: '5px' }}>
            {result.evaluation.map((r) => (
              <div key={r.id} className="row-between small">
                <span>{`#${r.priority} ${r.name}`}</span>
                <span className={r.matched ? 'badge badge-success' : 'badge'}>{r.matched ? 'match' : 'no match'}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

// ===========================================================================
// Scoring
// ===========================================================================
function ScoringRules({ meta, rules, reload, onNew, onEdit }) {
  const { can } = useAuth();

  const bands = (
    <Panel title="Score bands" subtitle="Scores are clamped to 0-100 and mapped to these bands.">
      <div className="row wrap" style={{ gap: '10px' }}>
        {meta.scoreBands.map((band) => (
          <div
            key={band.key}
            style={{
              flex: '1 1 130px',
              padding: '12px',
              borderRadius: '10px',
              border: `1px solid ${band.color}44`,
              background: `${band.color}14`,
            }}
          >
            <div className="strong" style={{ color: band.color }}>
              {band.label}
            </div>
            <div className="tiny muted">{`${band.min} points and above`}</div>
          </div>
        ))}
      </div>
    </Panel>
  );

  if (!rules.length) {
    return (
      <>
        {bands}
        <div className="card mt-16">
          <EmptyState
            iconName="trending"
            title="No scoring rules"
            message="Without rules every lead scores zero."
            action={
              can('automation', 'create') ? (
                <button type="button" className="btn btn-primary" onClick={onNew}>
                  Add a rule
                </button>
              ) : null
            }
          />
        </div>
      </>
    );
  }

  async function toggleActive(rule) {
    try {
      await api.patch(`/api/automation/scoring-rules/${rule.id}`, { isActive: !rule.isActive });
      reload();
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <>
      {bands}
      <div className="mt-16">
        <Panel title="Scoring rules" flush>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Condition</th>
                  <th className="right">Points</th>
                  <th>Status</th>
                  <th style={{ width: '48px' }} />
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td className="cell-main">{rule.name}</td>
                    <td className="small muted">{describeScoringRule(meta, rule)}</td>
                    <td className="right">
                      <span className={rule.points >= 0 ? 'badge badge-success' : 'badge badge-danger'}>
                        {`${rule.points > 0 ? '+' : ''}${rule.points}`}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${rule.isActive ? 'badge-success' : ''}`}>
                        {rule.isActive ? 'Active' : 'Paused'}
                      </span>
                    </td>
                    <td>
                      {can('automation', 'update') ? (
                        <Dropdown trigger={moreButton('Actions')}>
                          <MenuItem iconName="edit" onClick={() => onEdit(rule)}>
                            Edit
                          </MenuItem>
                          <MenuItem iconName={rule.isActive ? 'close' : 'check'} onClick={() => toggleActive(rule)}>
                            {rule.isActive ? 'Pause' : 'Activate'}
                          </MenuItem>
                          {can('automation', 'delete') ? (
                            <MenuItem
                              iconName="trash"
                              danger
                              onClick={() =>
                                confirmAndDelete({
                                  title: 'Delete this rule?',
                                  name: rule.name,
                                  path: `/api/automation/scoring-rules/${rule.id}`,
                                  done: 'Deleted',
                                  reload,
                                })
                              }
                            >
                              Delete
                            </MenuItem>
                          ) : null}
                        </Dropdown>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </>
  );
}

// ===========================================================================
// Workflows
// ===========================================================================
function Workflows({ meta, workflows, reload, onNew, onEdit, onRuns }) {
  const { can } = useAuth();

  if (!workflows.length) {
    return (
      <div className="card">
        <EmptyState
          iconName="automation"
          title="No workflows yet"
          message="A workflow reacts to an event — a lead is created, a status changes, a deal is won — and runs actions for you."
          action={
            can('automation', 'create') ? (
              <button type="button" className="btn btn-primary" onClick={onNew}>
                Create a workflow
              </button>
            ) : null
          }
        />
      </div>
    );
  }

  async function toggleActive(wf) {
    try {
      await api.patch(`/api/automation/workflows/${wf.id}`, { isActive: !wf.isActive });
      toast.success(wf.isActive ? 'Workflow paused' : 'Workflow activated');
      reload();
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <div className="col" style={{ gap: '10px' }}>
      {workflows.map((wf) => {
        const trigger = meta.triggers.find((t) => t.key === wf.trigger);
        const conditions = wf.conditions?.conditions || [];
        return (
          <section key={wf.id} className="card">
            <div className="card-head">
              <div style={{ minWidth: 0 }}>
                <h3 className="row" style={{ gap: '8px' }}>
                  {wf.name}
                  {wf.isActive ? null : <span className="badge badge-warning">Paused</span>}
                </h3>
                <div className="sub">{wf.description || `Runs when: ${trigger?.label || wf.trigger}`}</div>
              </div>
              <div className="row" style={{ gap: '8px' }}>
                <span className="badge">{`${number(wf.runCount)} runs`}</span>
                {wf.lastRunAt ? <span className="badge">{`Last ${relative(wf.lastRunAt)}`}</span> : null}
                {can('automation', 'update') ? (
                  <Dropdown trigger={moreButton('Workflow actions')}>
                    <MenuItem iconName="edit" onClick={() => onEdit(wf)}>
                      Edit
                    </MenuItem>
                    <MenuItem iconName="list" onClick={() => onRuns(wf)}>
                      Run history
                    </MenuItem>
                    <MenuItem iconName={wf.isActive ? 'close' : 'check'} onClick={() => toggleActive(wf)}>
                      {wf.isActive ? 'Pause' : 'Activate'}
                    </MenuItem>
                    {can('automation', 'delete') ? (
                      <MenuItem
                        iconName="trash"
                        danger
                        onClick={() =>
                          confirmAndDelete({
                            title: 'Delete this workflow?',
                            name: wf.name,
                            path: `/api/automation/workflows/${wf.id}`,
                            done: 'Deleted',
                            reload,
                          })
                        }
                      >
                        Delete
                      </MenuItem>
                    ) : null}
                  </Dropdown>
                ) : null}
              </div>
            </div>
            <div className="card-body">
              <div className="row wrap mb-8" style={{ gap: '8px' }}>
                <span className="badge badge-brand">WHEN</span>
                <span className="small strong">{trigger?.label || wf.trigger}</span>
              </div>
              {conditions.length ? (
                <div className="row wrap mb-8" style={{ gap: '6px' }}>
                  <span className="badge badge-info">IF</span>
                  {conditions.map((c, i) => (
                    <span key={i} className="chip">
                      {conditionText(meta, c)}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="row wrap" style={{ gap: '6px' }}>
                <span className="badge badge-success">THEN</span>
                {(wf.actions || []).map((a, i) => (
                  <span key={i} className="chip">
                    {meta.actions.find((x) => x.key === a.type)?.label || a.type}
                  </span>
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function WorkflowRunsDrawer({ workflow, onClose }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .data(`/api/automation/workflows/${workflow.id}/runs`, undefined, { signal: ctrl.signal })
      .then(setRuns)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => ctrl.abort();
  }, [workflow.id]);

  let content;
  if (error) {
    content = <EmptyState iconName="alert" title="Could not load runs" message={error.message} />;
  } else if (!runs) {
    content = <PageLoader />;
  } else if (!runs.length) {
    content = <EmptyState iconName="automation" title="No runs yet" message="This workflow has not been triggered." />;
  } else {
    content = (
      <div className="col" style={{ gap: '8px' }}>
        {runs.map((run) => (
          <div key={run.id} style={{ padding: '11px', border: '1px solid var(--line)', borderRadius: '10px' }}>
            <div className="row-between mb-8">
              <span className={`badge ${RUN_TONE[run.status] || ''}`}>{titleCase(run.status)}</span>
              <span className="tiny muted">{dateTime(run.createdAt)}</span>
            </div>
            {run.error ? <div className="small text-danger mb-8">{run.error}</div> : null}
            {run.log?.length ? (
              <ul className="small muted" style={{ margin: 0, paddingLeft: '18px' }}>
                {run.log.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : (
              <div className="tiny muted">No actions logged.</div>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <Drawer title={`${workflow.name} runs`} subtitle="Most recent first" wide onClose={onClose}>
      {content}
    </Drawer>
  );
}

// ===========================================================================
// Sequences
// ===========================================================================
function Sequences({ sequences, reload, onNew, onEdit }) {
  const { can } = useAuth();

  if (!sequences.length) {
    return (
      <div className="card">
        <EmptyState
          iconName="clock"
          title="No follow-up sequences"
          message="A sequence schedules the next follow-up date on the lead as it moves through the funnel."
          action={
            can('automation', 'create') ? (
              <button type="button" className="btn btn-primary" onClick={onNew}>
                Create a sequence
              </button>
            ) : null
          }
        />
      </div>
    );
  }

  return (
    <div className="chart-grid half">
      {sequences.map((seq) => (
        <section key={seq.id} className="card">
          <div className="card-head">
            <div>
              <h3 className="row" style={{ gap: '8px' }}>
                {seq.name}
                {seq.isActive ? null : <span className="badge badge-warning">Paused</span>}
              </h3>
              <div className="sub">
                {seq.description ||
                  (seq.applyOnCreate
                    ? 'Applied to every new lead'
                    : seq.triggerStatusKey
                      ? `Applied when status becomes ${seq.triggerStatusKey}`
                      : 'Applied manually')}
              </div>
            </div>
            {can('automation', 'update') ? (
              <Dropdown trigger={moreButton('Sequence actions')}>
                <MenuItem iconName="edit" onClick={() => onEdit(seq)}>
                  Edit
                </MenuItem>
                {can('automation', 'delete') ? (
                  <MenuItem
                    iconName="trash"
                    danger
                    onClick={() =>
                      confirmAndDelete({
                        title: 'Delete this sequence?',
                        name: seq.name,
                        path: `/api/automation/sequences/${seq.id}`,
                        done: 'Deleted',
                        reload,
                      })
                    }
                  >
                    Delete
                  </MenuItem>
                ) : null}
              </Dropdown>
            ) : null}
          </div>
          <div className="card-body">
            <div className="timeline">
              {seq.steps.map((step, i) => (
                <div key={step.id || i} className="tl-item">
                  <div className="tl-dot">
                    <Icon name="clock" size={11} />
                  </div>
                  <div className="tl-head">
                    <span className="tl-title">{step.title}</span>
                    <span className="tl-time">{`Day ${step.dayOffset}`}</span>
                  </div>
                  <div className="tl-meta">
                    <span className="badge">{titleCase(step.taskType)}</span>
                    <span className="badge">{titleCase(step.priority)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
