/**
 * The four Automation editors: assignment rule, scoring rule, workflow and
 * follow-up sequence. Each owns its field state, validates the one thing the
 * original checked client-side, and shows the server's message in a danger
 * alert at the top of the panel when a save is refused.
 *
 * All of them take the `/api/automation/metadata` payload as `meta`; the page
 * loads it once and every picker here is built from it.
 */
import { useState } from 'react';
import api from '../../lib/api.js';
import { titleCase } from '../../lib/format.js';
import Icon from '../../components/Icon.jsx';
import {
  Alert,
  BusyButton,
  Drawer,
  Field,
  Input,
  Modal,
  Select,
  SwitchToggle,
  toast,
} from '../../components/ui/index.js';
import { ActionList, ConditionBuilder, ROW_BOX, actionsForSave, initialGroup, userName } from './builders.jsx';

/** Strategies that use a target team / a list of target users. */
const TEAM_STRATEGIES = ['TEAM', 'TEAM_ROUND_ROBIN', 'MANAGER', 'ROUND_ROBIN', 'LOAD_BALANCED'];
const USER_STRATEGIES = ['USER', 'ROUND_ROBIN', 'LOAD_BALANCED'];

const TASK_TYPES = ['CALL', 'EMAIL', 'MEETING', 'FOLLOW_UP', 'TASK'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

/** Cancel + primary button row used by every editor's footer. */
function Footer({ onClose, onSave, label }) {
  return (
    <div className="row">
      <button type="button" className="btn" onClick={onClose}>
        Cancel
      </button>
      <BusyButton className="btn btn-primary" onClick={onSave}>
        {label}
      </BusyButton>
    </div>
  );
}

// ===========================================================================
// Assignment rule
// ===========================================================================
export function AssignmentRuleForm({ meta, rule = null, onClose, onSaved }) {
  const isEdit = Boolean(rule?.id);
  const [name, setName] = useState(rule?.name || '');
  const [description, setDescription] = useState(rule?.description || '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 10));
  const [strategy, setStrategy] = useState(rule?.strategy || 'ROUND_ROBIN');
  const [teamId, setTeamId] = useState(rule?.targetTeamId || '');
  const [userIds, setUserIds] = useState(() => new Set(rule?.targetUserIds || []));
  const [stopOnMatch, setStopOnMatch] = useState(rule ? rule.stopOnMatch : true);
  const [conditions, setConditions] = useState(() => initialGroup(rule?.conditions));
  const [error, setError] = useState('');

  const toggleUser = (id, on) =>
    setUserIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  async function save() {
    setError('');
    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      priority: Number(priority) || 10,
      conditions,
      strategy,
      // Sent whatever the strategy, as the original did; the server ignores
      // the targets a strategy does not use.
      targetTeamId: teamId || null,
      // In list order, and only people still on it - the original read the
      // ticked checkboxes, so a deactivated user dropped out on save.
      targetUserIds: meta.options.users.filter((u) => userIds.has(u.id)).map((u) => u.id),
      stopOnMatch,
    };
    if (!payload.name) {
      setError('The rule needs a name.');
      return;
    }
    try {
      if (isEdit) await api.patch(`/api/automation/assignment-rules/${rule.id}`, payload);
      else await api.post('/api/automation/assignment-rules', payload);
      toast.success(isEdit ? 'Rule saved' : 'Rule created');
      onClose();
      onSaved?.();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Drawer
      title={isEdit ? `Edit ${rule.name}` : 'New assignment rule'}
      subtitle="Conditions decide which leads match; the strategy decides who gets them."
      wide
      onClose={onClose}
      footer={<Footer onClose={onClose} onSave={save} label={isEdit ? 'Save rule' : 'Create rule'} />}
    >
      {error ? (
        <Alert tone="danger" className="mb-16">
          {error}
        </Alert>
      ) : null}
      <div className="form-grid">
        <Field label="Rule name" required>
          <Input value={name} placeholder="Delhi NCR territory" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Priority" hint="Lower numbers run first.">
          <Input type="number" min="0" max="999" value={priority} onChange={(e) => setPriority(e.target.value)} />
        </Field>
      </div>
      <Field label="Description">
        <Input value={description} placeholder="What is this rule for?" onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <h4 className="mt-16 mb-8">Conditions</h4>
      <ConditionBuilder meta={meta} value={conditions} onChange={setConditions} />

      <h4 className="mt-16 mb-8">Assignment</h4>
      <Field label="Strategy">
        <Select
          options={meta.strategies.map((s) => ({ value: s.key, label: s.label }))}
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
        />
      </Field>
      <div>
        <Field label="Target team" className={TEAM_STRATEGIES.includes(strategy) ? undefined : 'hidden'}>
          <Select
            options={meta.options.teams.map((t) => ({ value: t.id, label: t.name }))}
            placeholder="Choose a team"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
          />
        </Field>
        <Field
          label="Target users"
          hint="Leads rotate through the people you tick."
          className={USER_STRATEGIES.includes(strategy) ? undefined : 'hidden'}
        >
          <div
            style={{
              maxHeight: '180px',
              overflowY: 'auto',
              border: '1px solid var(--line)',
              borderRadius: '8px',
              padding: '8px',
            }}
          >
            {meta.options.users.map((u) => (
              <label key={u.id} className="checkbox" style={{ display: 'flex', padding: '3px 0' }}>
                <input
                  type="checkbox"
                  value={u.id}
                  checked={userIds.has(u.id)}
                  onChange={(e) => toggleUser(u.id, e.target.checked)}
                />
                {userName(u)}
              </label>
            ))}
          </div>
        </Field>
      </div>
      <div className="mt-8">
        <SwitchToggle
          label="Stop evaluating further rules when this one matches"
          checked={Boolean(stopOnMatch)}
          onChange={setStopOnMatch}
        />
      </div>
    </Drawer>
  );
}

// ===========================================================================
// Scoring rule
// ===========================================================================
export function ScoringRuleForm({ meta, rule = null, onClose, onSaved }) {
  const isEdit = Boolean(rule?.id);
  const [name, setName] = useState(rule?.name || '');
  const [kind, setKind] = useState(rule?.kind || 'FIELD_PRESENT');
  const [fieldName, setFieldName] = useState(rule?.field || '');
  const [value, setValue] = useState(rule?.value || '');
  const [points, setPoints] = useState(String(rule?.points ?? 5));
  const [error, setError] = useState('');

  const kindSpec = meta.scoringKinds.find((k) => k.key === kind);

  async function save() {
    setError('');
    const payload = {
      name: name.trim(),
      kind,
      field: fieldName.trim() || null,
      value: String(value).trim() || null,
      points: Number(points) || 0,
    };
    if (!payload.name) {
      setError('The rule needs a name.');
      return;
    }
    try {
      if (isEdit) await api.patch(`/api/automation/scoring-rules/${rule.id}`, payload);
      else await api.post('/api/automation/scoring-rules', payload);
      toast.success(isEdit ? 'Rule saved' : 'Rule created');
      onClose();
      onSaved?.();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Modal
      title={isEdit ? 'Edit scoring rule' : 'New scoring rule'}
      onClose={onClose}
      footer={<Footer onClose={onClose} onSave={save} label={isEdit ? 'Save' : 'Create'} />}
    >
      {error ? (
        <Alert tone="danger" className="mb-16">
          {error}
        </Alert>
      ) : null}
      <Field label="Rule name" required>
        <Input value={name} placeholder="Visited the pricing page" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Rule type">
        <Select
          options={meta.scoringKinds.map((k) => ({ value: k.key, label: k.label }))}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        />
      </Field>
      <div className="hint">{kindSpec ? `Needs: ${kindSpec.needs.join(', ') || 'nothing else'}` : ''}</div>
      <div className="form-grid">
        <Field label="Field" hint="Lead field name, or activity type for activity counts.">
          <Input value={fieldName} placeholder="email / phone / CALL" onChange={(e) => setFieldName(e.target.value)} />
        </Field>
        <Field label="Value">
          <Input value={value} placeholder="google_ads / 500000 / 1" onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Points" hint="Negative values subtract, e.g. for stale leads.">
          <Input type="number" min="-100" max="100" value={points} onChange={(e) => setPoints(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// ===========================================================================
// Workflow
// ===========================================================================
export function WorkflowForm({ meta, workflow = null, onClose, onSaved }) {
  const isEdit = Boolean(workflow?.id);
  const [name, setName] = useState(workflow?.name || '');
  const [description, setDescription] = useState(workflow?.description || '');
  const [trigger, setTrigger] = useState(workflow?.trigger || 'lead.created');
  const [priority, setPriority] = useState(String(workflow?.priority ?? 10));
  const [conditions, setConditions] = useState(() => initialGroup(workflow?.conditions));
  const [actions, setActions] = useState(() => structuredClone(workflow?.actions || []));
  const [error, setError] = useState('');

  async function save() {
    setError('');
    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      trigger,
      priority: Number(priority) || 10,
      conditions,
      actions: actionsForSave(meta, actions),
    };
    if (!payload.name) {
      setError('The workflow needs a name.');
      return;
    }
    if (!actions.length) {
      setError('Add at least one action.');
      return;
    }
    try {
      if (isEdit) await api.patch(`/api/automation/workflows/${workflow.id}`, payload);
      else await api.post('/api/automation/workflows', payload);
      toast.success(isEdit ? 'Workflow saved' : 'Workflow created');
      onClose();
      onSaved?.();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Drawer
      title={isEdit ? `Edit ${workflow.name}` : 'New workflow'}
      subtitle="When something happens, and the conditions hold, run these actions."
      wide
      onClose={onClose}
      footer={<Footer onClose={onClose} onSave={save} label={isEdit ? 'Save workflow' : 'Create workflow'} />}
    >
      {error ? (
        <Alert tone="danger" className="mb-16">
          {error}
        </Alert>
      ) : null}
      <div className="form-grid">
        <Field label="Workflow name" required>
          <Input value={name} placeholder="Escalate hot website leads" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Priority" hint="Lower runs first.">
          <Input type="number" min="0" value={priority} onChange={(e) => setPriority(e.target.value)} />
        </Field>
      </div>
      <Field label="Description">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <h4 className="mt-16 mb-8">When</h4>
      <Field label="Trigger">
        <Select
          options={meta.triggers.map((t) => ({ value: t.key, label: t.label }))}
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
        />
      </Field>

      <h4 className="mt-16 mb-8">If</h4>
      <ConditionBuilder meta={meta} value={conditions} onChange={setConditions} />

      <h4 className="mt-16 mb-8">Then</h4>
      <ActionList meta={meta} actions={actions} onChange={setActions} />
    </Drawer>
  );
}

// ===========================================================================
// Follow-up sequence
// ===========================================================================
const DEFAULT_STEPS = [
  { dayOffset: 1, taskType: 'CALL', title: 'First follow-up call', priority: 'HIGH' },
  { dayOffset: 3, taskType: 'EMAIL', title: 'Send product overview', priority: 'MEDIUM' },
];

export function SequenceForm({ meta, sequence = null, onClose, onSaved }) {
  const isEdit = Boolean(sequence?.id);
  const [name, setName] = useState(sequence?.name || '');
  const [description, setDescription] = useState(sequence?.description || '');
  const [statusKey, setStatusKey] = useState(sequence?.triggerStatusKey || '');
  const [applyOnCreate, setApplyOnCreate] = useState(sequence?.applyOnCreate || false);
  const [steps, setSteps] = useState(() => structuredClone(sequence?.steps || DEFAULT_STEPS));
  const [error, setError] = useState('');

  const updateStep = (index, patch) => setSteps((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  async function save() {
    setError('');
    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      triggerStatusKey: statusKey || null,
      applyOnCreate,
      // The day-offset box may be momentarily empty while typing; it counts as 0.
      steps: steps
        .filter((s) => String(s.title ?? '').trim())
        .map((s) => ({ ...s, dayOffset: Number(s.dayOffset) || 0 })),
    };
    if (!payload.name || !payload.steps.length) {
      setError('A sequence needs a name and at least one step.');
      return;
    }
    try {
      if (isEdit) await api.patch(`/api/automation/sequences/${sequence.id}`, payload);
      else await api.post('/api/automation/sequences', payload);
      toast.success(isEdit ? 'Sequence saved' : 'Sequence created');
      onClose();
      onSaved?.();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Drawer
      title={isEdit ? `Edit ${sequence.name}` : 'New follow-up sequence'}
      subtitle="Applying a sequence schedules follow-up dates from the day it is applied."
      wide
      onClose={onClose}
      footer={<Footer onClose={onClose} onSave={save} label={isEdit ? 'Save sequence' : 'Create sequence'} />}
    >
      {error ? (
        <Alert tone="danger" className="mb-16">
          {error}
        </Alert>
      ) : null}
      <Field label="Sequence name" required>
        <Input value={name} placeholder="Standard 4-touch follow-up" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Apply automatically when status becomes">
        <Select
          options={meta.options.statuses.map((s) => ({ value: s.key, label: s.name }))}
          placeholder="Apply manually only"
          value={statusKey}
          onChange={(e) => setStatusKey(e.target.value)}
        />
      </Field>
      <div className="mb-16">
        <SwitchToggle
          label="Apply to every newly created lead"
          checked={Boolean(applyOnCreate)}
          onChange={setApplyOnCreate}
        />
      </div>

      <h4 className="mt-16 mb-8">Steps</h4>
      <div className="col" style={{ gap: '8px' }}>
        {steps.map((step, index) => (
          <div key={index} style={ROW_BOX}>
            <div className="row-between mb-8">
              <span className="strong small">{`Step ${index + 1}`}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="Remove step"
                onClick={() => setSteps((list) => list.filter((_, i) => i !== index))}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
            <div className="form-grid">
              <Field label="Task title">
                <Input value={step.title ?? ''} onChange={(e) => updateStep(index, { title: e.target.value })} />
              </Field>
              <Field label="Day offset">
                <Input
                  type="number"
                  min="0"
                  value={step.dayOffset ?? ''}
                  onChange={(e) =>
                    updateStep(index, { dayOffset: e.target.value === '' ? '' : Number(e.target.value) || 0 })
                  }
                />
              </Field>
              <Field label="Type">
                <Select
                  options={TASK_TYPES.map((t) => ({ value: t, label: titleCase(t) }))}
                  value={step.taskType}
                  onChange={(e) => updateStep(index, { taskType: e.target.value })}
                />
              </Field>
              <Field label="Priority">
                <Select
                  options={PRIORITIES.map((p) => ({ value: p, label: titleCase(p) }))}
                  value={step.priority}
                  onChange={(e) => updateStep(index, { priority: e.target.value })}
                />
              </Field>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-sm mt-8"
        onClick={() =>
          setSteps((list) => [
            ...list,
            {
              dayOffset: (Number(list[list.length - 1]?.dayOffset) || 0) + 3,
              taskType: 'FOLLOW_UP',
              title: 'Follow up',
              priority: 'MEDIUM',
            },
          ])
        }
      >
        <Icon name="plus" size={14} />
        Add step
      </button>
    </Drawer>
  );
}
