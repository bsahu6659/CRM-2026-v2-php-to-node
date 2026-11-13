/**
 * Organisation settings: profile, lead statuses, lead sources, custom fields,
 * tags. Port of the PHP edition's `views/settings.js`.
 *
 * The active tab lives in the URL (`/settings?tab=statuses`), as the original
 * wrote it into the hash, so a tab can be linked to and survives a reload.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../lib/api.js';
import { date, number, titleCase } from '../lib/format.js';
import { useQueryParams } from '../lib/query.js';
import { refreshReference } from '../lib/reference.js';
import { useAuth } from '../context/AuthContext.jsx';
import Icon from '../components/Icon.jsx';
import { NoAccess, PageHead, Panel } from '../components/shared.jsx';
import {
  BusyButton,
  Dropdown,
  EmptyState,
  Field,
  Input,
  MenuItem,
  Modal,
  PageLoader,
  Select,
  SwitchToggle,
  Tabs,
  Textarea,
  openOverlay,
  reportError,
  toast,
  useConfirm,
} from '../components/ui/index.js';

const TABS = [
  { key: 'organization', label: 'Organisation' },
  { key: 'statuses', label: 'Lead statuses' },
  { key: 'sources', label: 'Lead sources' },
  { key: 'fields', label: 'Custom fields' },
  { key: 'tags', label: 'Tags' },
];

const ENDPOINTS = {
  organization: '/api/settings/organization',
  statuses: '/api/settings/lead-statuses',
  sources: '/api/settings/lead-sources',
  fields: '/api/settings/custom-fields',
  tags: '/api/settings/tags',
};

export default function Settings() {
  const { can } = useAuth();
  if (!can('settings', 'read')) return <NoAccess what="settings" />;
  return <SettingsPage />;
}

function SettingsPage() {
  const { can } = useAuth();
  const editable = can('settings', 'update');
  const [query, setQuery] = useQueryParams();
  const tab = TABS.some((t) => t.key === query.tab) ? query.tab : 'organization';
  // Re-selecting the active tab reloads it, as every tab click did originally.
  const [tick, setTick] = useState(0);
  const [state, setState] = useState({ status: 'loading', tab, data: null, error: null });
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const token = ++requestRef.current;
    setState({ status: 'loading', tab, data: null, error: null });
    try {
      const data = await api.data(ENDPOINTS[tab]);
      if (token !== requestRef.current) return; // a newer tab or reload superseded this one
      setState({ status: 'ready', tab, data, error: null });
    } catch (err) {
      if (token !== requestRef.current) return;
      reportError(err);
      setState({ status: 'error', tab, data: null, error: err });
    }
  }, [tab]);

  useEffect(() => {
    load();
  }, [load, tick]);

  // Nothing settles after the page is gone.
  useEffect(() => () => void (requestRef.current += 1), []);

  const selectTab = (key) => {
    setQuery({ tab: key }, { merge: false });
    setTick((t) => t + 1);
  };

  const ready = state.status === 'ready' && state.tab === tab;

  // The "New …" button belongs to the tab and appears once its list has loaded.
  let action = null;
  if (ready && editable) {
    const button = (label, open) => (
      <button key="new" type="button" className="btn btn-primary" onClick={open}>
        <Icon name="plus" size={15} />
        {label}
      </button>
    );
    if (tab === 'statuses') {
      action = button('New status', () => openOverlay((close) => <StatusForm onClose={close} onSaved={load} />));
    } else if (tab === 'sources') {
      action = button('New source', () => openOverlay((close) => <SourceForm onClose={close} onSaved={load} />));
    } else if (tab === 'fields') {
      action = button('New field', () => openOverlay((close) => <CustomFieldForm onClose={close} onSaved={load} />));
    }
  }

  let body;
  if (state.status === 'error' && state.tab === tab) {
    body = (
      <div className="card">
        <EmptyState iconName="alert" title="Could not load" message={state.error.message} />
      </div>
    );
  } else if (!ready) {
    body = <PageLoader />;
  } else if (tab === 'organization') {
    body = <OrganizationTab org={state.data} editable={editable} />;
  } else if (tab === 'statuses') {
    body = <StatusesTab statuses={state.data} editable={editable} reload={load} />;
  } else if (tab === 'sources') {
    body = <SourcesTab sources={state.data} editable={editable} reload={load} />;
  } else if (tab === 'fields') {
    body = <CustomFieldsTab fields={state.data} editable={editable} reload={load} />;
  } else {
    body = <TagsTab tags={state.data} editable={editable} reload={load} />;
  }

  return (
    <div>
      <PageHead
        title="Settings"
        subtitle="How the CRM behaves for everyone in your organisation."
        actions={action}
      />
      <div className="mb-16">
        <Tabs items={TABS} active={tab} onSelect={selectTab} />
      </div>
      <div>{body}</div>
    </div>
  );
}

const InfoRow = ({ label, value }) => (
  <div className="info-row">
    <div className="i-label">{label}</div>
    <div className="i-value">{value}</div>
  </div>
);

// =========================================================================
// Organisation
// =========================================================================
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'];
const LOCALES = ['en-IN', 'en-US', 'en-GB', 'en-AE', 'en-SG'];
const DUPLICATE_POLICIES = [
  { value: 'FLAG', label: 'Warn, but allow the lead through' },
  { value: 'REJECT', label: 'Reject duplicates outright' },
  { value: 'ALLOW', label: 'Do not check at all' },
];

function OrganizationTab({ org, editable }) {
  const { refresh } = useAuth();
  const settings = org.settings || {};
  const [profile, setProfile] = useState(() => ({
    name: org.name || '',
    domain: org.domain || '',
    currency: org.currency || '',
    locale: org.locale || '',
    timezone: org.timezone || '',
  }));
  const [duplicatePolicy, setDuplicatePolicy] = useState(settings.duplicatePolicy || 'FLAG');
  const [autoAssign, setAutoAssign] = useState(settings.autoAssignFallback !== false);

  const set = (name) => (e) => setProfile((p) => ({ ...p, [name]: e.target.value }));

  const saveProfile = async () => {
    try {
      await api.patch('/api/settings/organization', {
        name: profile.name.trim(),
        domain: profile.domain.trim() || null,
        currency: profile.currency,
        locale: profile.locale,
        timezone: profile.timezone.trim(),
      });
      toast.success('Organisation updated');
      // Currency, locale and name feed the formatter and the shell.
      await refresh();
    } catch (err) {
      reportError(err);
    }
  };

  const saveLeadHandling = async () => {
    try {
      await api.patch('/api/settings/organization', {
        settings: { duplicatePolicy, autoAssignFallback: autoAssign },
      });
      toast.success('Lead handling updated');
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <div className="chart-grid two">
      <Panel title="Organisation profile">
        <div>
          <div className="form-grid">
            <Field label="Name">
              <Input value={profile.name} disabled={!editable} onChange={set('name')} />
            </Field>
            <Field label="Primary domain">
              <Input value={profile.domain} placeholder="growvanta.com" disabled={!editable} onChange={set('domain')} />
            </Field>
            <Field label="Currency">
              <Select
                options={CURRENCIES.map((c) => ({ value: c, label: c }))}
                value={profile.currency}
                disabled={!editable}
                onChange={set('currency')}
              />
            </Field>
            <Field label="Locale" hint="Controls number, date and currency formatting.">
              <Select
                options={LOCALES.map((l) => ({ value: l, label: l }))}
                value={profile.locale}
                disabled={!editable}
                onChange={set('locale')}
              />
            </Field>
            <Field label="Timezone">
              <Input value={profile.timezone} disabled={!editable} onChange={set('timezone')} />
            </Field>
          </div>
          {editable ? (
            <BusyButton className="btn btn-primary mt-8" onClick={saveProfile}>
              Save profile
            </BusyButton>
          ) : null}
        </div>
      </Panel>

      <Panel title="Lead handling">
        <div>
          <Field label="Duplicate policy" hint="Applies to manual entry, forms, the API and imports.">
            <Select
              options={DUPLICATE_POLICIES}
              value={duplicatePolicy}
              disabled={!editable}
              onChange={(e) => setDuplicatePolicy(e.target.value)}
            />
          </Field>
          <div className="mb-16">
            <SwitchToggle
              label="Fall back to load-balanced round robin when no assignment rule matches"
              checked={autoAssign}
              onChange={(v) => setAutoAssign(v)}
            />
          </div>
          {editable ? (
            <BusyButton className="btn btn-primary" onClick={saveLeadHandling}>
              Save lead handling
            </BusyButton>
          ) : null}
          <div className="info-list mt-16">
            <InfoRow label="Users" value={number(org.stats?.users)} />
            <InfoRow label="Leads" value={number(org.stats?.leads)} />
            <InfoRow label="Workspace created" value={date(org.createdAt)} />
            <InfoRow label="Plan" value={titleCase(org.plan)} />
          </div>
        </div>
      </Panel>
    </div>
  );
}

// =========================================================================
// Lead statuses
// =========================================================================
function StatusesTab({ statuses, editable, reload }) {
  const confirm = useConfirm();

  const reorder = async (from, to) => {
    const order = statuses.map((s) => s.id);
    [order[from], order[to]] = [order[to], order[from]];
    try {
      await api.post('/api/settings/lead-statuses/reorder', { order });
      refreshReference();
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  const remove = async (status) => {
    const yes = await confirm({
      title: 'Delete this status?',
      message: status.leadCount > 0 ? `${status.leadCount} lead(s) still use it — move them first.` : status.name,
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!yes) return;
    try {
      await api.del(`/api/settings/lead-statuses/${status.id}`);
      toast.success('Status deleted');
      refreshReference();
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <>
      <div className="alert info mb-16">
        <Icon name="info" size={16} />
        <div>
          Statuses are the columns of the lead Kanban board. Order decides the column order; probability feeds the
          weighted value estimate.
        </div>
      </div>
      <Panel title="Lead statuses" flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: '40px' }} />
                <th>Status</th>
                <th className="right">Probability</th>
                <th className="right">Leads</th>
                <th>Flags</th>
                <th style={{ width: '48px' }} />
              </tr>
            </thead>
            <tbody>
              {statuses.map((status, index) => (
                <tr key={status.id}>
                  <td>
                    <span style={{ display: 'block', width: '12px', height: '12px', borderRadius: '4px', background: status.color }} />
                  </td>
                  <td>
                    <div className="cell-main">{status.name}</div>
                    <div className="cell-sub mono">{status.key}</div>
                  </td>
                  <td className="right">{`${status.probability}%`}</td>
                  <td className="right">{number(status.leadCount)}</td>
                  <td>
                    <div className="row wrap" style={{ gap: '4px' }}>
                      {status.isDefault ? <span className="badge badge-brand">Default</span> : null}
                      {status.isQualified ? <span className="badge badge-info">Qualified</span> : null}
                      {status.isConverted ? <span className="badge badge-success">Converted</span> : null}
                      {status.isLost ? <span className="badge badge-danger">Lost</span> : null}
                      {status.isJunk ? <span className="badge">Junk</span> : null}
                      {status.isActive ? null : <span className="badge badge-warning">Inactive</span>}
                    </div>
                  </td>
                  <td>
                    {editable ? (
                      <Dropdown
                        trigger={
                          <button type="button" className="icon-btn" aria-label="Status actions">
                            <Icon name="more" size={16} />
                          </button>
                        }
                      >
                        <div>
                          <MenuItem
                            iconName="edit"
                            onClick={() => openOverlay((close) => <StatusForm status={status} onClose={close} onSaved={reload} />)}
                          >
                            Edit
                          </MenuItem>
                          {index > 0 ? (
                            <MenuItem iconName="arrowUp" onClick={() => reorder(index, index - 1)}>
                              Move up
                            </MenuItem>
                          ) : null}
                          {index < statuses.length - 1 ? (
                            <MenuItem iconName="arrowDown" onClick={() => reorder(index, index + 1)}>
                              Move down
                            </MenuItem>
                          ) : null}
                          <MenuItem iconName="trash" danger onClick={() => remove(status)}>
                            Delete
                          </MenuItem>
                        </div>
                      </Dropdown>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

const STATUS_FLAGS = [
  ['isDefault', 'Default status for new leads'],
  ['isQualified', 'Counts as qualified'],
  ['isConverted', 'Marks the lead converted'],
  ['isLost', 'Counts as lost'],
  ['isJunk', 'Counts as junk'],
  ['isActive', 'Active (shown on the board)'],
];

function StatusForm({ status = null, onSaved, onClose }) {
  const isEdit = Boolean(status?.id);
  const nameRef = useRef(null);
  const [name, setName] = useState(status?.name || '');
  const [color, setColor] = useState(status?.color || '#35e06f');
  const [probability, setProbability] = useState(String(status?.probability ?? 0));
  // The server sends TINYINT flags as 1/0.
  const [flags, setFlags] = useState(() =>
    Object.fromEntries(STATUS_FLAGS.map(([key]) => [key, status ? Boolean(status[key]) : key === 'isActive']))
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) {
      nameRef.current?.focus();
      return;
    }
    const payload = {
      name: name.trim(),
      color,
      probability: Number(probability) || 0,
      ...flags,
    };
    setSaving(true);
    try {
      if (isEdit) await api.patch(`/api/settings/lead-statuses/${status.id}`, payload);
      else await api.post('/api/settings/lead-statuses', payload);
      toast.success(isEdit ? 'Status updated' : 'Status created');
      refreshReference();
      onClose();
      onSaved?.();
    } catch (err) {
      setSaving(false);
      reportError(err);
    }
  };

  return (
    <Modal
      title={isEdit ? 'Edit lead status' : 'New lead status'}
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
            {isEdit ? 'Save' : 'Create'}
          </button>
        </div>
      }
    >
      <div>
        <div className="form-grid">
          <Field label="Name" required>
            <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Colour">
            <input
              type="color"
              className="input"
              value={color}
              style={{ padding: '4px', height: '38px' }}
              onChange={(e) => setColor(e.target.value)}
            />
          </Field>
          <Field label="Probability %" hint="Used for weighted value estimates.">
            <Input type="number" min="0" max="100" value={probability} onChange={(e) => setProbability(e.target.value)} />
          </Field>
        </div>
        <Field label="Behaviour">
          <div className="col" style={{ gap: '6px' }}>
            {STATUS_FLAGS.map(([key, label]) => (
              <label key={key} className="checkbox">
                <input
                  type="checkbox"
                  checked={flags[key]}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setFlags((f) => ({ ...f, [key]: checked }));
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

// =========================================================================
// Lead sources
// =========================================================================
const SOURCE_CATEGORIES = ['PAID', 'ORGANIC', 'SOCIAL', 'REFERRAL', 'DIRECT', 'OTHER'];

function SourcesTab({ sources, editable, reload }) {
  const confirm = useConfirm();

  const remove = async (source) => {
    const yes = await confirm({
      title: 'Delete this source?',
      message: source.leadCount > 0 ? `${source.leadCount} lead(s) reference it — deactivate it instead.` : source.name,
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!yes) return;
    try {
      await api.del(`/api/settings/lead-sources/${source.id}`);
      toast.success('Source deleted');
      refreshReference();
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <Panel title="Lead sources" subtitle="Cost per lead feeds the marketing ROI report." flush>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Source</th>
              <th>Category</th>
              <th className="right">Cost per lead</th>
              <th className="right">Leads</th>
              <th>Status</th>
              <th style={{ width: '48px' }} />
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.id}>
                <td>
                  <div className="cell-main">{source.name}</div>
                  <div className="cell-sub mono">{source.key}</div>
                </td>
                <td>
                  <span className="badge">{titleCase(source.category)}</span>
                </td>
                <td className="right">{source.costPerLead ? String(source.costPerLead) : '—'}</td>
                <td className="right">{number(source.leadCount)}</td>
                <td>
                  <span className={`badge ${source.isActive ? 'badge-success' : ''}`}>{source.isActive ? 'Active' : 'Inactive'}</span>
                </td>
                <td>
                  {editable ? (
                    <Dropdown
                      trigger={
                        <button type="button" className="icon-btn" aria-label="Source actions">
                          <Icon name="more" size={16} />
                        </button>
                      }
                    >
                      <div>
                        <MenuItem
                          iconName="edit"
                          onClick={() => openOverlay((close) => <SourceForm source={source} onClose={close} onSaved={reload} />)}
                        >
                          Edit
                        </MenuItem>
                        <MenuItem iconName="trash" danger onClick={() => remove(source)}>
                          Delete
                        </MenuItem>
                      </div>
                    </Dropdown>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function SourceForm({ source = null, onSaved, onClose }) {
  const isEdit = Boolean(source?.id);
  const nameRef = useRef(null);
  const [name, setName] = useState(source?.name || '');
  const [category, setCategory] = useState(source?.category || 'OTHER');
  const [costPerLead, setCostPerLead] = useState(
    source?.costPerLead === null || source?.costPerLead === undefined ? '' : String(source.costPerLead)
  );
  const [active, setActive] = useState(source ? Boolean(source.isActive) : true);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) {
      nameRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        category,
        costPerLead: costPerLead === '' ? null : Number(costPerLead),
        isActive: active,
      };
      if (isEdit) await api.patch(`/api/settings/lead-sources/${source.id}`, payload);
      else await api.post('/api/settings/lead-sources', payload);
      toast.success(isEdit ? 'Source updated' : 'Source created');
      refreshReference();
      onClose();
      onSaved?.();
    } catch (err) {
      setSaving(false);
      reportError(err);
    }
  };

  return (
    <Modal
      title={isEdit ? 'Edit lead source' : 'New lead source'}
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
            {isEdit ? 'Save' : 'Create'}
          </button>
        </div>
      }
    >
      <div>
        <Field label="Name" required>
          <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="Category">
            <Select
              options={SOURCE_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          </Field>
          <Field label="Cost per lead" hint="Optional. Used for source-level ROI.">
            <Input type="number" min="0" value={costPerLead} onChange={(e) => setCostPerLead(e.target.value)} />
          </Field>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
      </div>
    </Modal>
  );
}

// =========================================================================
// Custom fields
// =========================================================================
const FIELD_ENTITIES = ['LEAD', 'CONTACT', 'ACCOUNT', 'OPPORTUNITY'];
const FIELD_TYPES = ['TEXT', 'TEXTAREA', 'NUMBER', 'DECIMAL', 'DATE', 'BOOLEAN', 'SELECT', 'MULTISELECT', 'EMAIL', 'PHONE', 'URL'];

function CustomFieldsTab({ fields, editable, reload }) {
  const confirm = useConfirm();
  const openForm = (customField = null) =>
    openOverlay((close) => <CustomFieldForm customField={customField} onClose={close} onSaved={reload} />);

  if (!fields.length) {
    return (
      <div className="card">
        <EmptyState
          iconName="forms"
          title="No custom fields"
          message="Add fields specific to your business — industry, team size, budget band — without a schema change."
          action={
            editable ? (
              <button type="button" className="btn btn-primary" onClick={() => openForm()}>
                Add a field
              </button>
            ) : null
          }
        />
      </div>
    );
  }

  const byEntity = new Map();
  for (const f of fields) {
    if (!byEntity.has(f.entity)) byEntity.set(f.entity, []);
    byEntity.get(f.entity).push(f);
  }

  const remove = async (f) => {
    const yes = await confirm({
      title: 'Delete this field?',
      message: `${f.label}. Stored values are dropped the next time each record is saved.`,
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!yes) return;
    try {
      await api.del(`/api/settings/custom-fields/${f.id}`);
      toast.success('Field deleted');
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <div className="col" style={{ gap: '14px' }}>
      {[...byEntity.entries()].map(([entity, list]) => (
        <Panel key={entity} title={`${titleCase(entity)} fields`} flush>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Key</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th style={{ width: '48px' }} />
                </tr>
              </thead>
              <tbody>
                {list.map((f) => (
                  <tr key={f.id}>
                    <td className="cell-main">{f.label}</td>
                    <td className="mono small">{f.key}</td>
                    <td>
                      <span className="badge">{titleCase(f.type)}</span>
                    </td>
                    <td>
                      {f.isRequired ? <span className="badge badge-warning">Required</span> : <span className="muted">—</span>}
                    </td>
                    <td>
                      {editable ? (
                        <Dropdown
                          trigger={
                            <button type="button" className="icon-btn" aria-label="Field actions">
                              <Icon name="more" size={16} />
                            </button>
                          }
                        >
                          <div>
                            <MenuItem iconName="edit" onClick={() => openForm(f)}>
                              Edit
                            </MenuItem>
                            <MenuItem iconName="trash" danger onClick={() => remove(f)}>
                              Delete
                            </MenuItem>
                          </div>
                        </Dropdown>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ))}
    </div>
  );
}

function CustomFieldForm({ customField = null, onSaved, onClose }) {
  const isEdit = Boolean(customField?.id);
  const labelRef = useRef(null);
  const [label, setLabel] = useState(customField?.label || '');
  const [entity, setEntity] = useState(customField?.entity || 'LEAD');
  const [type, setType] = useState(customField?.type || 'TEXT');
  const [options, setOptions] = useState((customField?.options || []).join('\n'));
  const [helpText, setHelpText] = useState(customField?.helpText || '');
  const [required, setRequired] = useState(Boolean(customField?.isRequired));
  const [showInList, setShowInList] = useState(Boolean(customField?.showInList));
  const [saving, setSaving] = useState(false);

  const isChoice = ['SELECT', 'MULTISELECT'].includes(type);

  const save = async () => {
    if (!label.trim()) {
      labelRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const payload = {
        label: label.trim(),
        entity,
        type,
        options: options
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean),
        helpText: helpText.trim() || null,
        isRequired: required,
        showInList,
      };
      if (isEdit) await api.patch(`/api/settings/custom-fields/${customField.id}`, payload);
      else await api.post('/api/settings/custom-fields', payload);
      toast.success(isEdit ? 'Field updated' : 'Field created');
      onClose();
      onSaved?.();
    } catch (err) {
      setSaving(false);
      reportError(err);
    }
  };

  return (
    <Modal
      title={isEdit ? 'Edit custom field' : 'New custom field'}
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
            {isEdit ? 'Save' : 'Create'}
          </button>
        </div>
      }
    >
      <div>
        <div className="form-grid">
          <Field label="Label" required>
            <Input ref={labelRef} placeholder="Budget band" value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Applies to" hint={isEdit ? 'Cannot be changed after creation.' : undefined}>
            <Select
              options={FIELD_ENTITIES.map((e) => ({ value: e, label: titleCase(e) }))}
              value={entity}
              disabled={isEdit}
              onChange={(e) => setEntity(e.target.value)}
            />
          </Field>
          <Field label="Type">
            <Select
              options={FIELD_TYPES.map((t) => ({ value: t, label: titleCase(t) }))}
              value={type}
              onChange={(e) => setType(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Options" className={isChoice ? undefined : 'hidden'}>
          <Textarea rows={4} placeholder="One option per line" value={options} onChange={(e) => setOptions(e.target.value)} />
        </Field>
        <Field label="Help text">
          <Input value={helpText} onChange={(e) => setHelpText(e.target.value)} />
        </Field>
        <label className="checkbox">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
          Required
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={showInList} onChange={(e) => setShowInList(e.target.checked)} />
          Show in list views
        </label>
      </div>
    </Modal>
  );
}

// =========================================================================
// Tags
// =========================================================================
function TagsTab({ tags, editable, reload }) {
  const confirm = useConfirm();

  if (!tags.length) {
    return (
      <div className="card">
        <EmptyState iconName="star" title="No tags yet" message="Tags are created as you use them on leads." />
      </div>
    );
  }

  const remove = async (tag) => {
    const yes = await confirm({
      title: 'Delete this tag?',
      message: `“${tag.name}” is used on ${tag.usageCount} lead(s).`,
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!yes) return;
    try {
      await api.del(`/api/settings/tags/${tag.id}`);
      toast.success('Tag deleted');
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <Panel title="Tags" subtitle="The number shows how many leads carry each tag.">
      <div className="row wrap" style={{ gap: '8px' }}>
        {tags.map((tag) => (
          <span
            key={tag.id}
            className="chip"
            style={{ background: `${tag.color}1f`, color: tag.color, borderColor: `${tag.color}44` }}
          >
            {tag.name}
            <span className="tiny muted">{number(tag.usageCount)}</span>
            {editable ? (
              <button type="button" aria-label={`Delete ${tag.name}`} onClick={() => remove(tag)}>
                ×
              </button>
            ) : null}
          </span>
        ))}
      </div>
    </Panel>
  );
}
