import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { ApiError } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { loadReference } from '../lib/reference.js';
import { emitDataChanged } from '../lib/events.js';
import { inputDate, inputDateTime, titleCase } from '../lib/format.js';
import Icon from '../components/Icon.jsx';
import {
  Alert, Drawer, Field, Input, PageLoader, Select, Textarea, reportError, toast, useBusy,
} from '../components/ui/index.js';

/**
 * Create / edit lead drawer. Port of `openLeadForm()` in the PHP edition's
 * `views/leadForm.js`; the contract (props, side effects) is in
 * docs/CLIENT-UI.md §17 - the topbar Create menu, Leads and LeadDetail all
 * open this component.
 *
 * Runs a live duplicate check as soon as an email or phone is entered, so the
 * user is warned *before* submitting rather than being rejected afterwards.
 * Custom fields are fetched from the org's definitions and rendered inline.
 */
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => ({ value: p, label: titleCase(p) }));

const PURPOSES = [
  { value: 'END_USE', label: 'End use' },
  { value: 'INVESTMENT', label: 'Investment' },
];
const FUNDING = [
  { value: 'SELF', label: 'Self funded' },
  { value: 'HOME_LOAN', label: 'Home loan' },
  { value: 'MIXED', label: 'Part loan' },
];
const POSSESSION = [
  { value: 'IMMEDIATE', label: 'Immediate' },
  { value: 'WITHIN_6_MONTHS', label: 'Within 6 months' },
  { value: 'WITHIN_1_YEAR', label: 'Within a year' },
  { value: 'WITHIN_2_YEARS', label: 'Within 2 years' },
  { value: 'FLEXIBLE', label: 'Flexible' },
];

const CUSTOM_INPUT_TYPES = { EMAIL: 'email', PHONE: 'tel', URL: 'url' };

const str = (v) => (v === null || v === undefined ? '' : String(v));

function initialValues(lead) {
  const v = lead || {};
  return {
    firstName: str(v.firstName),
    lastName: str(v.lastName),
    email: str(v.email),
    phone: str(v.phone),
    altPhone: str(v.altPhone),
    jobTitle: str(v.jobTitle),
    company: str(v.company),
    website: str(v.website),
    city: str(v.city),
    state: str(v.state),
    country: str(v.country ?? 'India'),
    pincode: str(v.pincode),
    address: str(v.address),
    projectId: str(v.projectId),
    configuration: str(v.configuration),
    budgetMin: str(v.budgetMin),
    budgetMax: str(v.budgetMax),
    purpose: str(v.purpose),
    funding: str(v.funding),
    possessionTimeline: str(v.possessionTimeline),
    siteVisitAt: inputDateTime(v.siteVisitAt),
    sourceId: str(v.sourceId),
    statusId: str(v.statusId),
    priority: v.priority || 'MEDIUM',
    expectedValue: str(v.expectedValue),
    nextFollowUpAt: inputDate(v.nextFollowUpAt),
    ownerId: str(v.ownerId),
    teamId: str(v.teamId),
    tags: (lead?.tags || []).map((t) => t.name).join(', '),
    notes: str(v.notes),
  };
}

/** Starting value of every custom field, in the shape its control produces. */
function initialCustomValues(defs, lead) {
  const stored = lead?.customFields || {};
  const out = {};
  for (const def of defs) {
    const value = stored[def.key];
    if (def.type === 'MULTISELECT') out[def.key] = Array.isArray(value) ? value : [];
    else if (def.type === 'BOOLEAN') out[def.key] = Boolean(value);
    else out[def.key] = str(value);
  }
  return out;
}

export default function LeadForm({ lead = null, onSaved, onClose }) {
  const isEdit = Boolean(lead?.id);
  const { can } = useAuth();
  const navigate = useNavigate();
  const canAssign = can('leads', 'assign');
  const statusLocked = isEdit && !can('leads', 'change_status');

  // { reference, customFields, projects } once the preload lands.
  const [setup, setSetup] = useState(null);
  const [values, setValues] = useState(() => initialValues(lead));
  const [custom, setCustom] = useState({});
  const [duplicates, setDuplicates] = useState([]);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  // { text } for a plain error, { duplicate: message } for the 409 refusal.
  const [error, setError] = useState(null);
  const [saving, run] = useBusy();

  const firstNameRef = useRef(null);
  const emailRef = useRef(null);
  const projectRef = useRef(null);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const dupTimer = useRef(null);
  const configListId = `cfg-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  // The original awaited reference data, the custom field definitions and the
  // project list before opening the drawer; here the drawer opens at once and
  // shows a loader until they arrive.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [reference, customFields, projects] = await Promise.all([
        loadReference(),
        api.data('/api/settings/custom-fields', { entity: 'LEAD' }).catch(() => []),
        can('projects', 'read') ? api.data('/api/projects/options').catch(() => []) : Promise.resolve([]),
      ]);
      if (cancelled) return;
      const defs = Array.isArray(customFields) ? customFields : [];
      setCustom(initialCustomValues(defs, lead));
      setSetup({ reference, customFields: defs, projects: Array.isArray(projects) ? projects : [] });
    })();
    return () => {
      cancelled = true;
    };
    // Loaded once per opening of the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => window.clearTimeout(dupTimer.current), []);

  const set = (name) => (e) => {
    const value = e.target.value;
    setValues((v) => ({ ...v, [name]: value }));
  };

  // Debounced like the original (450 ms after the last keystroke in email,
  // phone or company); it reads the latest values when it fires.
  const scheduleDuplicateCheck = () => {
    window.clearTimeout(dupTimer.current);
    dupTimer.current = window.setTimeout(async () => {
      const v = valuesRef.current;
      const email = v.email.trim();
      const phone = v.phone.trim();
      if (!email && !phone) {
        setDuplicates([]);
        return;
      }
      try {
        const matches = await api.post('/api/leads/check-duplicates', {
          email,
          phone,
          firstName: v.firstName.trim(),
          company: v.company.trim(),
          excludeId: lead?.id,
        });
        setDuplicates(matches.data || []);
      } catch {
        /* the duplicate hint is advisory; a failure must not block typing */
      }
    }, 450);
  };

  const setAndCheck = (name) => (e) => {
    set(name)(e);
    scheduleDuplicateCheck();
  };

  async function save(forceDuplicate = false) {
    setError(null);
    const v = values;
    const payload = {
      firstName: v.firstName.trim(),
      lastName: v.lastName.trim() || null,
      email: v.email.trim() || null,
      phone: v.phone.trim() || null,
      altPhone: v.altPhone.trim() || null,
      company: v.company.trim() || null,
      jobTitle: v.jobTitle.trim() || null,
      website: v.website.trim() || null,
      city: v.city.trim() || null,
      state: v.state.trim() || null,
      country: v.country.trim() || null,
      pincode: v.pincode.trim() || null,
      address: v.address.trim() || null,
      sourceId: v.sourceId || null,
      statusId: v.statusId || null,
      priority: v.priority,
      expectedValue: v.expectedValue ? Number(v.expectedValue) : null,
      nextFollowUpAt: v.nextFollowUpAt || null,
      projectId: v.projectId || null,
      configuration: v.configuration.trim() || null,
      budgetMin: v.budgetMin ? Number(v.budgetMin) : null,
      budgetMax: v.budgetMax ? Number(v.budgetMax) : null,
      purpose: v.purpose || null,
      funding: v.funding || null,
      possessionTimeline: v.possessionTimeline || null,
      siteVisitAt: v.siteVisitAt || null,
      notes: v.notes.trim() || null,
      tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean),
      customFields: { ...custom },
      allowDuplicate: forceDuplicate || allowDuplicate,
    };
    if (canAssign) {
      payload.ownerId = v.ownerId || null;
      payload.teamId = v.teamId || null;
    }

    if (!payload.firstName) {
      setError({ text: 'First name is required.' });
      firstNameRef.current?.focus();
      return;
    }
    if (!payload.email && !payload.phone) {
      setError({ text: 'Enter at least an email address or a phone number.' });
      emailRef.current?.focus();
      return;
    }
    // Caught here as well as on the server, so the answer arrives without a
    // round trip and with the cursor already in the field that needs it.
    if (!isEdit && !payload.projectId) {
      setError({
        text: setup?.projects.length
          ? 'Choose the project this enquiry is about.'
          : 'Add a project first — every enquiry has to be attached to one.',
      });
      projectRef.current?.focus();
      return;
    }

    try {
      const res = isEdit ? await api.patch(`/api/leads/${lead.id}`, payload) : await api.post('/api/leads', payload);
      const saved = res.data;
      toast.success(
        isEdit ? 'Lead updated' : `Lead ${saved.code} created`,
        saved.assignment?.ruleName ? `Routed by “${saved.assignment.ruleName}”.` : undefined
      );
      onClose?.();
      onSaved?.(saved);
      emitDataChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError({ duplicate: err.message });
        return;
      }
      const fieldErrors = err instanceof ApiError ? err.fieldErrors : {};
      setError({
        text: Object.entries(fieldErrors).map(([k, msg]) => `${k}: ${msg}`).join(' · ') || err.message,
      });
      reportError(err);
    }
  }

  const footer = (
    <div className="row">
      <button type="button" className="btn" onClick={() => onClose?.()}>
        Cancel
      </button>
      <button type="button" className="btn btn-primary" disabled={saving || !setup} onClick={() => run(save)}>
        {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create lead'}
      </button>
    </div>
  );

  return (
    <Drawer
      title={isEdit ? `Edit ${lead.firstName} ${lead.lastName || ''}`.trim() : 'New lead'}
      subtitle={isEdit ? lead.code : 'Capture a lead manually. Routing, scoring and follow-ups run automatically.'}
      wide
      onClose={() => onClose?.()}
      footer={footer}
    >
      {setup ? renderBody() : <PageLoader />}
    </Drawer>
  );

  function renderBody() {
    const { reference, customFields, projects } = setup;
    // Configurations vary per project, so the suggestion list follows the
    // project picker rather than being a fixed dropdown.
    const chosenProject = projects.find((p) => String(p.id) === String(values.projectId));

    return (
      <div>
        {error?.duplicate !== undefined ? (
          <Alert tone="danger" className="mb-16" title="Duplicate lead">
            {error.duplicate}
            <div className="mt-8">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setAllowDuplicate(true);
                  run(save, true);
                }}
              >
                Create anyway
              </button>
            </div>
          </Alert>
        ) : error ? (
          <Alert tone="danger" className="mb-16">
            {error.text}
          </Alert>
        ) : null}

        {duplicates.length ? (
          <div className="alert warning mb-16">
            <Icon name="alert" size={16} />
            <div className="grow">
              <strong>{`${duplicates.length} possible duplicate${duplicates.length === 1 ? '' : 's'}`}</strong>
              <div className="col" style={{ gap: '5px', marginTop: '6px' }}>
                {duplicates.map((row) => (
                  <div key={row.id} className="row-between">
                    <span className="small">
                      {`${row.firstName} ${row.lastName || ''} · ${row.code} · matched on ${row.matchedOn.join(', ').toLowerCase()}`}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        onClose?.();
                        navigate(`/leads/${row.id}`);
                      }}
                    >
                      Open
                    </button>
                  </div>
                ))}
              </div>
              <label className="checkbox mt-8">
                <input type="checkbox" checked={allowDuplicate} onChange={(e) => setAllowDuplicate(e.target.checked)} />
                Create anyway
              </label>
            </div>
          </div>
        ) : null}

        <h4 className="mb-8">Contact</h4>
        <div className="form-grid">
          <Field label="First name" required>
            <Input ref={firstNameRef} name="firstName" placeholder="Aarav" required value={values.firstName} onChange={set('firstName')} />
          </Field>
          <Field label="Last name">
            <Input name="lastName" placeholder="Sharma" value={values.lastName} onChange={set('lastName')} />
          </Field>
          <Field label="Email">
            <Input
              ref={emailRef}
              name="email"
              type="email"
              placeholder="aarav@company.com"
              value={values.email}
              onChange={setAndCheck('email')}
            />
          </Field>
          <Field label="Phone">
            <Input name="phone" type="tel" placeholder="9876543210" value={values.phone} onChange={setAndCheck('phone')} />
          </Field>
          <Field label="Alternate phone">
            <Input name="altPhone" type="tel" value={values.altPhone} onChange={set('altPhone')} />
          </Field>
          <Field label="Job title">
            <Input name="jobTitle" placeholder="Procurement Head" value={values.jobTitle} onChange={set('jobTitle')} />
          </Field>
        </div>

        <h4 className="mb-8 mt-16">Company</h4>
        <div className="form-grid">
          <Field label="Company">
            <Input name="company" placeholder="Northwind Traders" value={values.company} onChange={setAndCheck('company')} />
          </Field>
          <Field label="Website">
            <Input name="website" type="url" placeholder="https://…" value={values.website} onChange={set('website')} />
          </Field>
          <Field label="City">
            <Input name="city" value={values.city} onChange={set('city')} />
          </Field>
          <Field label="State">
            <Input name="state" value={values.state} onChange={set('state')} />
          </Field>
          <Field label="Country">
            <Input name="country" value={values.country} onChange={set('country')} />
          </Field>
          <Field label="Pincode">
            <Input name="pincode" value={values.pincode} onChange={set('pincode')} />
          </Field>
        </div>
        <Field label="Address">
          <Textarea rows={2} value={values.address} onChange={set('address')} />
        </Field>

        <h4 className="mb-8 mt-16">Requirement</h4>
        <div className="form-grid">
          {/* Required on a lead someone types in: every enquiry is about
              something, and the server refuses a manual lead without it. */}
          <Field
            label="Project"
            required={!isEdit}
            hint={projects.length ? undefined : 'No projects available to your company yet — add one before entering leads.'}
          >
            <Select
              ref={projectRef}
              options={projects.map((p) => ({ value: p.id, label: `${p.name} — ${p.location}` }))}
              value={values.projectId}
              placeholder="Which project are they asking about?"
              onChange={set('projectId')}
            />
          </Field>
          <Field label="Configuration">
            <div>
              <Input value={values.configuration} list={configListId} placeholder="3 BHK" onChange={set('configuration')} />
              <datalist id={configListId}>
                {(chosenProject?.configurations || []).map((cfg) => (
                  <option key={cfg} value={cfg} />
                ))}
              </datalist>
            </div>
          </Field>
          <Field label="Budget from">
            <Input
              name="budgetMin"
              type="number"
              min="0"
              step="100000"
              placeholder="7500000"
              value={values.budgetMin}
              onChange={set('budgetMin')}
            />
          </Field>
          <Field label="Budget to">
            <Input
              name="budgetMax"
              type="number"
              min="0"
              step="100000"
              placeholder="15000000"
              value={values.budgetMax}
              onChange={set('budgetMax')}
            />
          </Field>
          <Field label="Purpose">
            <Select options={PURPOSES} value={values.purpose} placeholder="Not asked yet" onChange={set('purpose')} />
          </Field>
          <Field label="Funding">
            <Select options={FUNDING} value={values.funding} placeholder="Not asked yet" onChange={set('funding')} />
          </Field>
          <Field label="Possession timeline">
            <Select
              options={POSSESSION}
              value={values.possessionTimeline}
              placeholder="Not asked yet"
              onChange={set('possessionTimeline')}
            />
          </Field>
          <Field label="Site visit">
            <Input type="datetime-local" value={values.siteVisitAt} onChange={set('siteVisitAt')} />
          </Field>
        </div>

        <h4 className="mb-8 mt-16">Qualification</h4>
        <div className="form-grid">
          <Field label="Lead source">
            <Select
              options={reference.sources.map((s) => ({ value: s.id, label: s.name }))}
              value={values.sourceId}
              placeholder="Select a source"
              onChange={set('sourceId')}
            />
          </Field>
          {/* Choosing the opening status is part of creating a lead; changing
              it afterwards is a separate grant, so on an edit the control is
              shown but inert rather than failing at save time. */}
          <Field label="Status" hint={statusLocked ? 'You do not have permission to change the status of a lead.' : undefined}>
            <Select
              options={reference.statuses.map((s) => ({ value: s.id, label: s.name }))}
              value={values.statusId}
              placeholder="Default status"
              disabled={statusLocked || undefined}
              onChange={set('statusId')}
            />
          </Field>
          <Field label="Priority">
            <Select options={PRIORITIES} value={values.priority} onChange={set('priority')} />
          </Field>
          <Field label="Expected value">
            <Input
              name="expectedValue"
              type="number"
              min="0"
              step="1000"
              placeholder="250000"
              value={values.expectedValue}
              onChange={set('expectedValue')}
            />
          </Field>
          <Field label="Next follow-up">
            <Input type="date" value={values.nextFollowUpAt} onChange={set('nextFollowUpAt')} />
          </Field>
        </div>

        {canAssign ? (
          <div className="form-grid">
            <Field label="Owner" hint="Leave blank to run the routing rules.">
              <Select
                options={reference.users.map((u) => ({ value: u.id, label: u.fullName || u.name }))}
                value={values.ownerId}
                placeholder="Let the assignment rules decide"
                onChange={set('ownerId')}
              />
            </Field>
            <Field label="Team">
              <Select
                options={reference.teams.map((t) => ({ value: t.id, label: t.name }))}
                value={values.teamId}
                placeholder="No specific team"
                onChange={set('teamId')}
              />
            </Field>
          </div>
        ) : null}

        <Field label="Tags" hint="Comma separated.">
          <Input placeholder="enterprise, warm, referral" value={values.tags} onChange={set('tags')} />
        </Field>
        <Field label="Notes">
          <Textarea rows={3} placeholder="What did they ask for?" value={values.notes} onChange={set('notes')} />
        </Field>

        {customFields.length ? (
          <div>
            <h4 className="mb-8 mt-16">Additional details</h4>
            {customFields.map((def) => (
              <Field key={def.id ?? def.key} label={def.label} hint={def.helpText} required={Boolean(def.isRequired)}>
                {renderCustomControl(def)}
              </Field>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderCustomControl(def) {
    const value = custom[def.key];
    const setCustomValue = (next) => setCustom((c) => ({ ...c, [def.key]: next }));
    const options = def.options || [];

    if (def.type === 'TEXTAREA') {
      return <Textarea rows={3} value={value ?? ''} onChange={(e) => setCustomValue(e.target.value)} />;
    }
    if (def.type === 'SELECT') {
      return (
        <Select
          options={options.map((o) => ({ value: o, label: o }))}
          value={value ?? ''}
          placeholder="Select…"
          onChange={(e) => setCustomValue(e.target.value)}
        />
      );
    }
    if (def.type === 'MULTISELECT') {
      const chosen = Array.isArray(value) ? value : [];
      return (
        <div className="row wrap" style={{ gap: '10px' }}>
          {options.map((option) => (
            <label key={option} className="checkbox">
              <input
                type="checkbox"
                value={option}
                checked={chosen.includes(option)}
                onChange={(e) =>
                  setCustomValue(e.target.checked ? [...chosen, option] : chosen.filter((o) => o !== option))
                }
              />
              {option}
            </label>
          ))}
        </div>
      );
    }
    if (def.type === 'BOOLEAN') {
      return (
        <label className="checkbox">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => setCustomValue(e.target.checked)} />
          {def.label}
        </label>
      );
    }
    if (def.type === 'DATE') {
      return <Input type="date" value={value ?? ''} onChange={(e) => setCustomValue(e.target.value)} />;
    }
    if (def.type === 'NUMBER' || def.type === 'DECIMAL') {
      return (
        <Input
          type="number"
          step={def.type === 'DECIMAL' ? '0.01' : '1'}
          value={value ?? ''}
          onChange={(e) => setCustomValue(e.target.value)}
        />
      );
    }
    return (
      <Input
        type={CUSTOM_INPUT_TYPES[def.type] || 'text'}
        value={value ?? ''}
        onChange={(e) => setCustomValue(e.target.value)}
      />
    );
  }
}
