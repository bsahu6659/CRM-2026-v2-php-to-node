/**
 * Web form builder.
 *
 * Admins compose the field list, map each field onto a lead column, choose the
 * routing, and copy either the script embed or the iframe. The same definition
 * drives the hosted page, the embed script and server-side validation.
 *
 * The hosted page (/f/KEY) and embed script (/embed/KEY.js) are served by the
 * API, not by this app, so they are plain links (the server hands back their
 * full URLs), never router <Link>s.
 */
import { useCallback, useEffect, useState } from 'react';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useReference } from '../lib/reference.js';
import { date, number, relative, titleCase } from '../lib/format.js';
import Icon from '../components/Icon.jsx';
import { NoAccess, PageHead } from '../components/shared.jsx';
import {
  Alert,
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
  SwitchToggle,
  Textarea,
  confirmDialog,
  copyToClipboard,
  openOverlay,
  reportError,
  toast,
} from '../components/ui/index.js';

const FIELD_TYPES = ['text', 'email', 'tel', 'number', 'textarea', 'select', 'checkbox', 'hidden'];
const MAPPABLE = [
  '', 'firstName', 'lastName', 'email', 'phone', 'altPhone', 'company', 'jobTitle', 'website',
  'country', 'state', 'city', 'address', 'pincode', 'notes', 'expectedValue',
];

const SUBMISSION_TONE = { ACCEPTED: 'badge-success', DUPLICATE: 'badge-warning', REJECTED: 'badge-danger' };

const DEFAULT_FIELDS = [
  { key: 'firstName', label: 'First name', type: 'text', required: true, mapTo: 'firstName' },
  { key: 'lastName', label: 'Last name', type: 'text', required: false, mapTo: 'lastName' },
  { key: 'email', label: 'Work email', type: 'email', required: true, mapTo: 'email' },
  { key: 'phone', label: 'Phone', type: 'tel', required: true, mapTo: 'phone' },
  { key: 'company', label: 'Company', type: 'text', required: false, mapTo: 'company' },
  { key: 'notes', label: 'How can we help?', type: 'textarea', required: false, mapTo: 'notes' },
];

/** `div.alert.info` with the info icon (the shared <Alert> draws the warning glyph). */
function InfoNote({ className, children }) {
  return (
    <div className={['alert info', className].filter(Boolean).join(' ')}>
      <Icon name="info" size={16} />
      <div>{children}</div>
    </div>
  );
}

/**
 * A <select> that shows a blank choice when its value matches none of the
 * options, as the original `select()` did. A field mapped (through the API)
 * to a column this picker does not list - `utmSource`, say - would otherwise
 * appear as "Custom field" while still saving the real mapping.
 */
function ChoiceSelect({ options, value, onChange }) {
  const current = value === null || value === undefined ? '' : String(value);
  const matches = options.some((o) => String(o.value) === current);
  return (
    <select className="select" value={current} onChange={onChange}>
      {matches ? null : <option value={current} disabled hidden />}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const slugKey = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export default function Forms() {
  const { can } = useAuth();
  if (!can('forms', 'read')) return <NoAccess what="web forms" />;
  return <FormsPage />;
}

function FormsPage() {
  const { can } = useAuth();
  const [forms, setForms] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setForms(await api.data('/api/forms'));
      setError(null);
    } catch (err) {
      reportError(err);
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openBuilder = (form = null) =>
    openOverlay((close) => <FormBuilder form={form} onClose={close} onSaved={() => load()} />);

  let body;
  if (error) {
    body = (
      <div className="card">
        <EmptyState iconName="alert" title="Could not load forms" message={error.message} />
      </div>
    );
  } else if (!forms) {
    body = <PageLoader label="Loading forms" />;
  } else if (!forms.length) {
    body = (
      <div className="card">
        <EmptyState
          iconName="forms"
          title="No forms yet"
          message="Build a form, paste one line of HTML into your website, and leads land here automatically."
          action={
            can('forms', 'create') ? (
              <button type="button" className="btn btn-primary" onClick={() => openBuilder()}>
                Create your first form
              </button>
            ) : null
          }
        />
      </div>
    );
  } else {
    body = (
      <div className="chart-grid half">
        {forms.map((form) => (
          <FormCard key={form.id} form={form} reload={load} onEdit={openBuilder} />
        ))}
      </div>
    );
  }

  return (
    <div>
      <PageHead
        title="Web Forms"
        subtitle="Embeddable capture forms. Every submission becomes a lead, routed by your rules."
        actions={
          can('forms', 'create')
            ? [
                <button key="new" type="button" className="btn btn-primary" onClick={() => openBuilder()}>
                  <Icon name="plus" size={15} />
                  New form
                </button>,
              ]
            : []
        }
      />
      <div>{body}</div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="tiny muted">{label}</div>
      <div className="strong">{value}</div>
    </div>
  );
}

function FormCard({ form, reload, onEdit }) {
  const { can } = useAuth();
  const showEmbed = () => openOverlay((close) => <EmbedModal form={form} onClose={close} />);
  const showSubmissions = () => openOverlay((close) => <SubmissionsDrawer form={form} onClose={close} />);

  async function toggleActive() {
    try {
      await api.patch(`/api/forms/${form.id}`, { isActive: !form.isActive });
      toast.success(form.isActive ? 'Form paused' : 'Form activated');
      reload();
    } catch (err) {
      reportError(err);
    }
  }

  async function remove() {
    const yes = await confirmDialog({
      title: 'Delete this form?',
      message: `${form.name} will stop accepting submissions immediately. Existing leads are kept.`,
      danger: true,
      confirmLabel: 'Delete',
      requireText: 'DELETE',
    });
    if (!yes) return;
    try {
      await api.del(`/api/forms/${form.id}`);
      toast.success('Form deleted');
      reload();
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="truncate">{form.name}</h3>
          <div className="sub truncate">{form.description || 'No description'}</div>
        </div>
        <div className="row" style={{ gap: '6px' }}>
          <span className={`badge ${form.isActive ? 'badge-success' : ''}`}>{form.isActive ? 'Live' : 'Paused'}</span>
          <Dropdown
            trigger={
              <button type="button" className="icon-btn" aria-label="Form actions">
                <Icon name="more" size={16} />
              </button>
            }
          >
            <MenuItem iconName="eye" onClick={() => window.open(form.hostedUrl, '_blank', 'noopener')}>
              Preview hosted page
            </MenuItem>
            <MenuItem iconName="copy" onClick={showEmbed}>
              Embed code
            </MenuItem>
            <MenuItem iconName="list" onClick={showSubmissions}>
              Submissions
            </MenuItem>
            {can('forms', 'update') ? (
              <MenuItem iconName="edit" onClick={() => onEdit(form)}>
                Edit
              </MenuItem>
            ) : null}
            {can('forms', 'update') ? (
              <MenuItem iconName={form.isActive ? 'close' : 'check'} onClick={toggleActive}>
                {form.isActive ? 'Pause' : 'Activate'}
              </MenuItem>
            ) : null}
            {can('forms', 'delete') ? (
              <MenuItem iconName="trash" danger onClick={remove}>
                Delete
              </MenuItem>
            ) : null}
          </Dropdown>
        </div>
      </div>
      <div className="card-body">
        <div className="row wrap mb-16" style={{ gap: '18px' }}>
          <Stat label="Submissions" value={number(form.submissionCount)} />
          <Stat label="Fields" value={number(form.fields.length)} />
          <Stat label="Created" value={date(form.createdAt)} />
        </div>
        <div className="row wrap" style={{ gap: '6px' }}>
          <button type="button" className="btn btn-sm" onClick={showEmbed}>
            <Icon name="copy" size={14} />
            Embed code
          </button>
          <a className="btn btn-sm" href={form.hostedUrl} target="_blank" rel="noopener">
            <Icon name="link" size={14} />
            Open hosted page
          </a>
          <button type="button" className="btn btn-sm" onClick={showSubmissions}>
            <Icon name="list" size={14} />
            Submissions
          </button>
        </div>
      </div>
    </section>
  );
}

const EMBED_MODES = [
  ['script', 'Script embed'],
  ['iframe', 'iframe'],
  ['api', 'Direct API'],
];

function EmbedModal({ form, onClose }) {
  const [mode, setMode] = useState('script');

  let code;
  if (mode === 'script') code = form.embedScript;
  else if (mode === 'iframe') code = form.iframeEmbed;
  else {
    code = `POST ${form.apiEndpoint}\nContent-Type: application/json\n\n${JSON.stringify(
      Object.fromEntries(form.fields.map((f) => [f.key, `<${f.label}>`])),
      null,
      2
    )}`;
  }

  return (
    <Modal
      title="Embed this form"
      subtitle="Paste it wherever the form should appear. It works on any site."
      size="wide"
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={() => copyToClipboard(code, 'Embed code copied')}>
            <Icon name="copy" size={15} />
            Copy
          </button>
        </div>
      }
    >
      <div className="btn-group mb-16">
        {EMBED_MODES.map(([key, label]) => (
          <button key={key} type="button" className={mode === key ? 'active' : ''} onClick={() => setMode(key)}>
            {label}
          </button>
        ))}
      </div>
      <pre className="code-block">{code}</pre>
      <InfoNote className="mt-16">
        <strong>Origin restrictions</strong>
        {form.allowedOrigins
          ? `Only accepted from: ${form.allowedOrigins}`
          : 'This form accepts submissions from any website. Add allowed origins when you edit it to lock that down.'}
      </InfoNote>
    </Modal>
  );
}

function SubmissionsDrawer({ form, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .get(`/api/forms/${form.id}/submissions`, { limit: 50 }, { signal: ctrl.signal })
      .then((res) => setRows(res.data))
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => ctrl.abort();
  }, [form.id]);

  let content;
  if (error) {
    content = <EmptyState iconName="alert" title="Could not load submissions" message={error.message} />;
  } else if (!rows) {
    content = <PageLoader />;
  } else if (!rows.length) {
    content = <EmptyState iconName="forms" title="No submissions yet" message="Nothing has been submitted through this form." />;
  } else {
    content = (
      <div className="col" style={{ gap: '10px' }}>
        {rows.map((sub) => (
          <div key={sub.id} style={{ padding: '12px', border: '1px solid var(--line)', borderRadius: '10px' }}>
            <div className="row-between mb-8">
              <span className={`badge ${SUBMISSION_TONE[sub.status] || ''}`}>{titleCase(sub.status)}</span>
              <span className="tiny muted">{relative(sub.createdAt)}</span>
            </div>
            {sub.message ? <div className="tiny muted mb-8">{sub.message}</div> : null}
            <div className="col tiny" style={{ gap: '2px' }}>
              {/* Keys starting with "_" are capture metadata (honeypot, page URL…), not answers. */}
              {Object.entries(sub.payload || {})
                .filter(([key]) => !key.startsWith('_'))
                .map(([key, value]) => (
                  <div key={key} className="row" style={{ gap: '8px' }}>
                    <span className="muted" style={{ minWidth: '110px' }}>
                      {key}
                    </span>
                    <span className="truncate">{String(value)}</span>
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <Drawer
      title={`${form.name} submissions`}
      subtitle={`${number(form.submissionCount)} total`}
      wide
      onClose={onClose}
    >
      {content}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * The pickers need reference data (sources, projects, users, teams). The
 * original awaited it before opening; here the drawer opens at once and shows
 * a loader until the cache answers (the shell warms it at boot, so usually it
 * already has).
 */
function FormBuilder({ form = null, onClose, onSaved }) {
  const ref = useReference();
  if (!ref) {
    return (
      <Drawer
        title={form?.id ? 'Edit form' : 'New web form'}
        subtitle="Fields, routing and the thank-you behaviour."
        wide
        onClose={onClose}
      >
        <PageLoader />
      </Drawer>
    );
  }
  return <FormBuilderDrawer form={form} reference={ref} onClose={onClose} onSaved={onSaved} />;
}

let fieldUid = 0;
/** Client-only identity for a field row, so React keeps each row's inputs as rows move. Never sent. */
const withUid = (f) => ({ ...f, _uid: ++fieldUid });

function FormBuilderDrawer({ form, reference, onClose, onSaved }) {
  const isEdit = Boolean(form?.id);
  const [name, setName] = useState(form?.name || '');
  const [description, setDescription] = useState(form?.description || '');
  const [submitLabel, setSubmitLabel] = useState(form?.submitLabel || 'Submit');
  const [successMessage, setSuccessMessage] = useState(
    form?.successMessage || 'Thanks! Our team will contact you shortly.'
  );
  const [redirectUrl, setRedirectUrl] = useState(form?.redirectUrl || '');
  const [allowedOrigins, setAllowedOrigins] = useState(form?.allowedOrigins || '');
  const [sourceId, setSourceId] = useState(
    form?.sourceId || reference.sources.find((s) => s.key === 'website')?.id || ''
  );
  const [projectId, setProjectId] = useState(form?.projectId || '');
  const [userId, setUserId] = useState(form?.assignToUserId || '');
  const [teamId, setTeamId] = useState(form?.assignToTeamId || '');
  const [useRules, setUseRules] = useState(form ? Boolean(form.useAssignmentRules) : true);
  const [fields, setFields] = useState(() => (form?.fields ? structuredClone(form.fields) : DEFAULT_FIELDS).map(withUid));
  const [error, setError] = useState('');

  const editField = (index, fn) => setFields((list) => list.map((f, i) => (i === index ? fn(f) : f)));
  const swap = (a, b) =>
    setFields((list) => {
      const next = [...list];
      [next[a], next[b]] = [next[b], next[a]];
      return next;
    });

  async function save() {
    setError('');
    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      fields: fields.map((f) => ({
        key: f.key || f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        label: f.label,
        type: f.type,
        required: Boolean(f.required),
        placeholder: f.placeholder || null,
        options: f.options || [],
        mapTo: f.mapTo || null,
      })),
      sourceId: sourceId || null,
      projectId: projectId || null,
      assignToUserId: userId || null,
      assignToTeamId: teamId || null,
      useAssignmentRules: useRules,
      submitLabel: submitLabel.trim() || 'Submit',
      // Left out when blank, so the server keeps (or defaults) the message.
      successMessage: successMessage.trim() || undefined,
      redirectUrl: redirectUrl.trim() || null,
      allowedOrigins: allowedOrigins.trim(),
    };
    if (!payload.name) {
      setError('The form needs a name.');
      return;
    }
    try {
      const res = isEdit ? await api.patch(`/api/forms/${form.id}`, payload) : await api.post('/api/forms', payload);
      toast.success(isEdit ? 'Form saved' : 'Form created', 'Copy the embed code to put it on your site.');
      onClose();
      onSaved?.(res.data);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Drawer
      title={isEdit ? 'Edit form' : 'New web form'}
      subtitle="Fields, routing and the thank-you behaviour."
      wide
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <BusyButton className="btn btn-primary" onClick={save}>
            {isEdit ? 'Save form' : 'Create form'}
          </BusyButton>
        </div>
      }
    >
      {error ? (
        <Alert tone="danger" className="mb-16">
          {error}
        </Alert>
      ) : null}
      <Field label="Form name" required>
        <Input value={name} placeholder="Request a Demo" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description">
        <Textarea
          rows={2}
          value={description}
          placeholder="Shown above the form."
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <h4 className="mt-16 mb-8">Fields</h4>
      <InfoNote className="mb-16">
        One field must map to First name, and at least one to Email or Phone, so leads can be de-duplicated.
      </InfoNote>
      <div className="col" style={{ gap: '10px' }}>
        {fields.map((f, index) => (
          <div
            key={f._uid}
            style={{ padding: '12px', border: '1px solid var(--line)', borderRadius: '10px', background: 'var(--surface-2)' }}
          >
            <div className="row-between mb-8">
              <span className="strong small">{`Field ${index + 1}`}</span>
              <div className="row" style={{ gap: '4px' }}>
                <button
                  type="button"
                  className="icon-btn"
                  title="Move up"
                  disabled={index === 0}
                  onClick={() => swap(index - 1, index)}
                >
                  <Icon name="arrowUp" size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Move down"
                  disabled={index === fields.length - 1}
                  onClick={() => swap(index + 1, index)}
                >
                  <Icon name="arrowDown" size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Remove"
                  onClick={() => setFields((list) => list.filter((_, i) => i !== index))}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>
            <div className="form-grid">
              <Field label="Label">
                <Input
                  value={f.label}
                  onChange={(e) => {
                    const label = e.target.value;
                    // An unmapped field's key follows its label; a mapped one keeps the column name.
                    editField(index, (x) => ({ ...x, label, key: x.mapTo ? x.key : slugKey(label) || x.key }));
                  }}
                />
              </Field>
              <Field label="Type">
                <Select
                  options={FIELD_TYPES.map((t) => ({ value: t, label: titleCase(t) }))}
                  value={f.type}
                  onChange={(e) => editField(index, (x) => ({ ...x, type: e.target.value }))}
                />
              </Field>
              <Field label="Maps to lead field">
                <ChoiceSelect
                  options={MAPPABLE.map((m) => ({ value: m, label: m || 'Custom field (stored as-is)' }))}
                  value={f.mapTo || ''}
                  onChange={(e) => {
                    const mapTo = e.target.value || null;
                    editField(index, (x) => ({ ...x, mapTo, key: mapTo || x.key }));
                  }}
                />
              </Field>
              <Field label="Placeholder">
                <Input
                  value={f.placeholder || ''}
                  onChange={(e) => editField(index, (x) => ({ ...x, placeholder: e.target.value }))}
                />
              </Field>
            </div>
            {f.type === 'select' ? (
              <Field label="Options (one per line)">
                {/* The raw text is kept beside the parsed list, or the blank line
                    being typed would be dropped before the next option arrives. */}
                <Textarea
                  rows={3}
                  value={f.optionsText ?? (f.options || []).join('\n')}
                  onChange={(e) => {
                    const text = e.target.value;
                    editField(index, (x) => ({
                      ...x,
                      optionsText: text,
                      options: text
                        .split('\n')
                        .map((v) => v.trim())
                        .filter(Boolean),
                    }));
                  }}
                />
              </Field>
            ) : null}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={Boolean(f.required)}
                onChange={(e) => editField(index, (x) => ({ ...x, required: e.target.checked }))}
              />
              Required
            </label>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-sm mt-8"
        onClick={() =>
          setFields((list) => [
            ...list,
            withUid({ key: `field_${list.length + 1}`, label: 'New field', type: 'text', required: false, mapTo: null }),
          ])
        }
      >
        <Icon name="plus" size={14} />
        Add field
      </button>

      <h4 className="mt-16 mb-8">Attribution &amp; routing</h4>
      <div className="form-grid">
        <Field label="Lead source">
          <Select
            options={reference.sources.map((s) => ({ value: s.id, label: s.name }))}
            placeholder="No source"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
          />
        </Field>
        <Field label="Project">
          <Select
            options={(reference.projects || []).map((p) => ({ value: p.id, label: p.name }))}
            placeholder="No specific project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          />
        </Field>
      </div>
      <div className="mb-16">
        <SwitchToggle label="Run the assignment rules on each submission" checked={useRules} onChange={setUseRules} />
      </div>
      <div className="form-grid">
        <Field label="Or always assign to" hint="Overrides the rules when set.">
          <Select
            options={reference.users.map((u) => ({ value: u.id, label: u.fullName || u.name }))}
            placeholder="Use the assignment rules"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
        </Field>
        <Field label="Route to team">
          <Select
            options={reference.teams.map((t) => ({ value: t.id, label: t.name }))}
            placeholder="No specific team"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
          />
        </Field>
      </div>

      <h4 className="mt-16 mb-8">After submission</h4>
      <div className="form-grid">
        <Field label="Submit button label">
          <Input value={submitLabel} onChange={(e) => setSubmitLabel(e.target.value)} />
        </Field>
        <Field label="Success message">
          <Input value={successMessage} onChange={(e) => setSuccessMessage(e.target.value)} />
        </Field>
        <Field label="Redirect URL" hint="Optional. Sent after the success message.">
          <Input
            value={redirectUrl}
            placeholder="https://yoursite.com/thank-you"
            onChange={(e) => setRedirectUrl(e.target.value)}
          />
        </Field>
        <Field label="Allowed origins" hint="Comma separated. Leave blank to accept any website.">
          <Input
            value={allowedOrigins}
            placeholder="https://yoursite.com, https://www.yoursite.com"
            onChange={(e) => setAllowedOrigins(e.target.value)}
          />
        </Field>
      </div>
    </Drawer>
  );
}
