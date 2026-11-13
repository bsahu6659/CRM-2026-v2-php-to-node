/**
 * Rule-builder pieces for the Automation page: the condition builder shared by
 * assignment rules and workflows, and the workflow action list.
 *
 * Both are controlled: the form owns the value and these only call
 * `onChange` with the next one. The value is exactly what the server stores
 * and evaluates (`{ match, conditions[] }` and `[{ type, params }]`), so what
 * you build is literally what runs - and the server's validator, which
 * rejects unknown keys in a condition group, never sees anything extra.
 */
import Icon from '../../components/Icon.jsx';
import { Field, Input, Select } from '../../components/ui/index.js';
import { titleCase } from '../../lib/format.js';

/** "First Last" for a user row from the automation metadata. */
export const userName = (u) => `${u.firstName} ${u.lastName || ''}`.trim();

const NO_VALUE_OPERATORS = ['is_empty', 'is_not_empty', 'changed'];

/** Card-like box every action, step and field definition sits in. */
export const ROW_BOX = {
  padding: '12px',
  border: '1px solid var(--line)',
  borderRadius: '10px',
  background: 'var(--surface-2)',
};

/**
 * A <select> that shows a blank choice when its value matches none of the
 * options, as the original `select()` did (it assigned `el.value`, which
 * leaves nothing selected). React would otherwise display the first option
 * while the stored value stays '' - the screen and the saved rule would
 * disagree, and a rule would be saved matching a value nobody chose.
 *
 * Options are keyed by position because the lead-field list repeats a key
 * (`utmCampaign` appears twice in the server's catalogue).
 */
export function ChoiceSelect({ options, value, onChange, placeholder, ...rest }) {
  const current = value === null || value === undefined ? '' : String(value);
  const matches = (placeholder && current === '') || options.some((o) => String(o.value) === current);
  return (
    <select className="select" value={current} onChange={onChange} {...rest}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {matches ? null : <option value={current} disabled hidden />}
      {options.map((o, i) => (
        <option key={i} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** The editable copy of a stored condition group (never the original object). */
export function initialGroup(initial) {
  return {
    match: initial?.match || 'ALL',
    conditions: structuredClone(initial?.conditions || []),
  };
}

/** The value picker for one condition, chosen by the field's type. */
function ConditionValue({ meta, cond, onValue }) {
  const def = meta.leadFields.find((f) => f.key === cond.field);
  const pick = (options) => (
    <ChoiceSelect options={options} value={cond.value} onChange={(e) => onValue(e.target.value)} />
  );

  if (NO_VALUE_OPERATORS.includes(cond.operator)) return <span className="muted small">no value needed</span>;
  if (def?.type === 'source') return pick(meta.options.sources.map((s) => ({ value: s.key, label: s.name })));
  if (def?.type === 'status') return pick(meta.options.statuses.map((s) => ({ value: s.key, label: s.name })));
  if (def?.type === 'campaign') {
    return pick((meta.options.pipelines || []).map((p) => ({ value: p.key, label: p.name })));
  }
  if (def?.type === 'project') {
    return pick((meta.options.projects || []).map((p) => ({ value: p.id, label: `${p.name} — ${p.location}` })));
  }
  if (def?.type === 'user') return pick(meta.options.users.map((u) => ({ value: u.id, label: userName(u) })));
  if (def?.type === 'team') return pick(meta.options.teams.map((t) => ({ value: t.id, label: t.name })));
  if (def?.type === 'enum') return pick(def.options.map((o) => ({ value: o, label: titleCase(o) })));
  return (
    <Input
      value={cond.value ?? ''}
      type={def?.type === 'number' ? 'number' : 'text'}
      placeholder={['in', 'not_in'].includes(cond.operator) ? 'comma, separated, values' : 'value'}
      onChange={(e) => onValue(e.target.value)}
    />
  );
}

/**
 * `{ match, conditions[] }` editor. Changing a condition's field clears its
 * value, because a status key means nothing to the project picker.
 */
export function ConditionBuilder({ meta, value, onChange }) {
  const { match, conditions } = value;
  const setConditions = (next) => onChange({ match, conditions: next });
  const update = (index, patch) => setConditions(conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  return (
    <div>
      <div className="row mb-8" style={{ gap: '8px' }}>
        <span className="small muted">Match</span>
        <Select
          options={[
            { value: 'ALL', label: 'all conditions' },
            { value: 'ANY', label: 'any condition' },
          ]}
          value={match}
          onChange={(e) => onChange({ match: e.target.value, conditions })}
        />
      </div>
      <div className="col" style={{ gap: '8px' }}>
        {conditions.map((cond, index) => (
          <div
            key={index}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr auto',
              gap: '8px',
              alignItems: 'center',
              padding: '10px',
              border: '1px solid var(--line)',
              borderRadius: '10px',
              background: 'var(--surface-2)',
            }}
          >
            <ChoiceSelect
              options={meta.leadFields.map((f) => ({ value: f.key, label: f.label }))}
              value={cond.field}
              onChange={(e) => update(index, { field: e.target.value, value: '' })}
            />
            <ChoiceSelect
              options={meta.operators.map((o) => ({ value: o.key, label: o.label }))}
              value={cond.operator}
              onChange={(e) => update(index, { operator: e.target.value })}
            />
            <ConditionValue meta={meta} cond={cond} onValue={(v) => update(index, { value: v })} />
            <button
              type="button"
              className="icon-btn"
              aria-label="Remove condition"
              onClick={() => setConditions(conditions.filter((_, i) => i !== index))}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-sm mt-8"
        onClick={() => setConditions([...conditions, { field: meta.leadFields[0].key, operator: 'eq', value: '' }])}
      >
        <Icon name="plus" size={14} />
        Add condition
      </button>
      <p className="tiny muted mt-8">No conditions means the rule applies to every lead.</p>
    </div>
  );
}

/** One parameter input of a workflow action, chosen by the parameter's type. */
function ActionParam({ meta, param, value, onValue }) {
  const choose = (options, placeholder) => (
    <ChoiceSelect
      options={options}
      value={value || ''}
      placeholder={placeholder}
      onChange={(e) => onValue(e.target.value)}
    />
  );

  let control;
  if (param.type === 'user') {
    control = choose(meta.options.users.map((u) => ({ value: u.id, label: userName(u) })), 'Choose a user');
  } else if (param.type === 'team') {
    control = choose(meta.options.teams.map((t) => ({ value: t.id, label: t.name })), 'Choose a team');
  } else if (param.type === 'status') {
    control = choose(meta.options.statuses.map((s) => ({ value: s.key, label: s.name })), 'Choose a status');
  } else if (param.type === 'sequence') {
    control = choose(meta.options.sequences.map((s) => ({ value: s.id, label: s.name })), 'Choose a sequence');
  } else if (param.type === 'enum') {
    control = (
      <ChoiceSelect
        options={param.options.map((o) => ({ value: o, label: titleCase(o) }))}
        value={value || param.options[0]}
        onChange={(e) => onValue(e.target.value)}
      />
    );
  } else {
    control = (
      <Input type={param.type === 'number' ? 'number' : 'text'} value={value ?? ''} onChange={(e) => onValue(e.target.value)} />
    );
  }
  return (
    <Field label={titleCase(param.key)} required={param.required}>
      {control}
    </Field>
  );
}

/**
 * Workflow "Then" list. Switching an action's type resets its parameters -
 * a userId left over from "Assign to a specific user" would be meaningless
 * (and silently saved) on "Add a tag".
 */
export function ActionList({ meta, actions, onChange }) {
  const setParam = (index, key, v) =>
    onChange(actions.map((a, i) => (i === index ? { ...a, params: { ...a.params, [key]: v } } : a)));

  return (
    <>
      <div className="col" style={{ gap: '8px' }}>
        {actions.map((action, index) => {
          const spec = meta.actions.find((a) => a.key === action.type);
          const params = spec?.params || [];
          return (
            <div key={index} style={ROW_BOX}>
              <div className="row-between mb-8">
                <ChoiceSelect
                  options={meta.actions.map((a) => ({ value: a.key, label: a.label }))}
                  value={action.type}
                  onChange={(e) =>
                    onChange(actions.map((a, i) => (i === index ? { type: e.target.value, params: {} } : a)))
                  }
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Remove action"
                  onClick={() => onChange(actions.filter((_, i) => i !== index))}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
              {params.length ? (
                <div className="form-grid">
                  {params.map((p) => (
                    <ActionParam
                      key={p.key}
                      meta={meta}
                      param={p}
                      value={action.params?.[p.key]}
                      onValue={(v) => setParam(index, p.key, v)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="btn btn-sm mt-8"
        onClick={() => onChange([...actions, { type: meta.actions[0].key, params: {} }])}
      >
        <Icon name="plus" size={14} />
        Add action
      </button>
    </>
  );
}

/**
 * The actions as they are saved. An enum parameter the user never touched
 * shows its first option (the original's `value || options[0]`) but was never
 * written into `params`, so the server rejected "Set priority" saved as it
 * appeared on screen. Writing the displayed default in makes the saved
 * workflow the one the form showed.
 */
export function actionsForSave(meta, actions) {
  return actions.map((action) => {
    const spec = meta.actions.find((a) => a.key === action.type);
    const params = { ...(action.params || {}) };
    for (const p of spec?.params || []) {
      if (p.type === 'enum' && !params[p.key] && p.options?.length) params[p.key] = p.options[0];
    }
    return { ...action, params };
  });
}

