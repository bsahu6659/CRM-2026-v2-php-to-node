/**
 * WhatsApp and Email welcome automation.
 * Port of the PHP edition's `views/communication.js`.
 *
 * The rule this screen exists to make visible (spec sections 31 and 35) is
 * that turning the switch on is not the same as being ready to send:
 *
 *   RED     off
 *   ORANGE  on, but something required is missing or unproven
 *   GREEN   on, complete, and proven by a successful test send
 *
 * The verdict and the checklist both come from the server, which re-derives
 * them before every send. Nothing here computes its own colour, because a
 * screen that decided its own status could disagree with the thing that
 * actually sends the message.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import { dateTime, titleCase } from '../lib/format.js';
import { useQueryParams } from '../lib/query.js';
import { useAuth } from '../context/AuthContext.jsx';
import Icon from '../components/Icon.jsx';
import { NoAccess, PageHead, Panel } from '../components/shared.jsx';
import {
  Alert,
  DataTable,
  Drawer,
  Field,
  Input,
  Modal,
  PageLoader,
  Select,
  SwitchToggle,
  Tabs,
  Textarea,
  openOverlay,
  reportError,
  toast,
} from '../components/ui/index.js';

const TONE = {
  GREEN: { color: 'var(--success)', label: 'ACTIVE', emoji: '🟢' },
  ORANGE: { color: 'var(--warning)', label: 'CONFIGURATION INCOMPLETE', emoji: '🟠' },
  RED: { color: 'var(--danger)', label: 'OFF', emoji: '🔴' },
};

const MESSAGE = {
  WhatsApp: {
    GREEN: 'WhatsApp welcome messages are active and ready to send.',
    ORANGE:
      'WhatsApp welcome messages are turned ON, but the configuration is incomplete. Complete the required configuration to activate automatic WhatsApp messages.',
    RED: 'WhatsApp welcome messages are disabled.',
  },
  Email: {
    GREEN: 'Welcome emails are active and ready to send.',
    ORANGE:
      'Welcome emails are turned ON, but the configuration is incomplete. Complete the required configuration to activate automatic emails.',
    RED: 'Welcome emails are disabled.',
  },
};

/** `?organizationId=…` for the write endpoints, which take the tenant in the URL. */
const suffix = (qs) => (qs.organizationId ? `?organizationId=${qs.organizationId}` : '');

/**
 * The status card. Shared with the Super Admin client screen, which renders it
 * read-only, so one component is the single visual definition of the states.
 * Vanilla `configurationCard(channel, verdict, { readOnly, onToggle, onManage, onTest })`.
 *
 * The switch is uncontrolled, as the original's was: it flips at once and
 * reports the change. The page remounts the card after every reload, which
 * re-seeds it from the server's verdict.
 */
export function ConfigurationCard({ channel, verdict, readOnly = false, onToggle, onManage, onTest }) {
  const status = verdict?.status || 'RED';
  const tone = TONE[status] || TONE.RED;
  const checklist = verdict?.checklist || [];

  return (
    <div className="card" style={{ borderTop: `3px solid ${tone.color}` }}>
      <div className="card-body">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="row" style={{ gap: '8px', alignItems: 'center' }}>
              <span style={{ fontSize: '15px' }}>{tone.emoji}</span>
              <strong>{`${channel} welcome message`}</strong>
            </div>
            <div className="tiny" style={{ color: tone.color, fontWeight: '700', letterSpacing: '.04em', marginTop: '3px' }}>
              {tone.label}
            </div>
          </div>
          {readOnly ? null : (
            <SwitchToggle label="" defaultChecked={Boolean(verdict?.enabled)} onChange={(checked) => onToggle?.(checked)} />
          )}
        </div>

        <p className="small muted" style={{ marginTop: '10px' }}>
          {MESSAGE[channel]?.[status] || ''}
        </p>

        {/* The missing items are always itemised. "Something is wrong" is not
            an actionable message for a sales admin. */}
        {status === 'ORANGE' && verdict?.missing?.length ? (
          <div className="field">
            <label>Still needed</label>
            <div>
              {checklist.map((item, i) => (
                <div key={item.key ?? i} className="row" style={{ gap: '7px', alignItems: 'center', padding: '2px 0' }}>
                  <span style={{ color: item.ok ? 'var(--success)' : 'var(--danger)', fontWeight: '700', width: '12px' }}>
                    {item.ok ? '✓' : '✗'}
                  </span>
                  <span className="small" style={{ color: item.ok ? 'var(--ink-2)' : 'var(--ink)' }}>
                    {item.label}
                  </span>
                  {item.detail ? <span className="tiny muted">{`— ${item.detail}`}</span> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {status === 'GREEN' && verdict?.lastTestAt ? (
          <div className="tiny muted mt-8">{`Last verified ${dateTime(verdict.lastTestAt)}`}</div>
        ) : null}

        {readOnly ? null : (
          <div className="row wrap mt-16" style={{ gap: '8px' }}>
            <button type="button" className={status === 'GREEN' ? 'btn' : 'btn btn-primary'} onClick={() => onManage?.()}>
              {status === 'GREEN' ? 'Manage configuration' : 'Complete configuration'}
            </button>
            <button type="button" className="btn" onClick={() => onTest?.()}>
              <Icon name="play" size={14} />
              {`Test ${channel.toLowerCase()}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Alerts that go to your own team, not to the buyer.
 *
 * Kept apart from the welcome-message cards above because they answer a
 * different question: those decide what a buyer hears, these decide whether the
 * salesperson finds out at all. A company usually wants the second long before
 * it has agreed the wording of the first.
 *
 * They do NOT ride on the channel above. Staff alerts leave from Growvanta's
 * own mailbox, so they work on a company's first day, before anyone has opened
 * this screen. The card says so, because the obvious assumption is the opposite.
 *
 * Each control saves on its own change, like the original; they are
 * uncontrolled and re-seeded by the page's remount after each reload.
 */
function StaffAlertsCard({ em, qs, reload }) {
  // /api/email returns the settings flat, with `configuration` nested inside.
  const s = em || {};

  const save = async (payload) => {
    try {
      await api.patch(`/api/email${suffix(qs)}`, payload);
      toast.success('Alert settings saved');
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  const minuteOptions = [15, 30, 60, 120, 240].map((m) => ({
    value: String(m),
    label: m >= 60 ? `${m / 60} hour${m === 60 ? '' : 's'} before` : `${m} minutes before`,
  }));

  // Whole hours only: the digest is a "what is on me today" email, not an
  // appointment, and an odd minute would only imply a precision the sweep does
  // not have.
  const hourOptions = Array.from({ length: 24 }, (_, i) => ({
    value: String(i),
    label: `${((i + 11) % 12) + 1}:00 ${i < 12 ? 'am' : 'pm'}`,
  }));

  // The original listened for the input's native `change`, which fires once
  // the edit is committed (blur or Enter), not on every keystroke.
  const ccCommitted = useRef(s.notifyCcEmail || '');
  const commitCc = (e) => {
    const { value } = e.target;
    if (value === ccCommitted.current) return;
    ccCommitted.current = value;
    save({ notifyCcEmail: value.trim() });
  };

  return (
    <div className="card mt-16">
      <div className="card-body">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div>
            <strong>Alerts to your team</strong>
            <div className="tiny muted" style={{ marginTop: '3px' }}>
              Emails sent to the person who owns the lead.
            </div>
          </div>
          <span className="badge badge-info">Sent by Growvanta</span>
        </div>

        <div className="row-between mt-16" style={{ alignItems: 'center', gap: '12px' }}>
          <div>
            <div>New lead arrives</div>
            <div className="tiny muted">The owner is emailed the moment a lead lands or is handed to them.</div>
          </div>
          <SwitchToggle label="" defaultChecked={Boolean(s.notifyNewLead)} onChange={(checked) => save({ notifyNewLead: checked })} />
        </div>

        <div className="row-between mt-16" style={{ alignItems: 'center', gap: '12px' }}>
          <div>
            <div>Follow-up is coming up</div>
            <div className="tiny muted">A warning before the follow-up time, not after it has been missed.</div>
          </div>
          <SwitchToggle label="" defaultChecked={Boolean(s.notifyFollowup)} onChange={(checked) => save({ notifyFollowup: checked })} />
        </div>

        {s.notifyFollowup ? (
          <div className="mt-16">
            <Field label="Warn me" hint="The reminder runs every 15 minutes, so anything shorter would arrive late.">
              <Select
                options={minuteOptions}
                defaultValue={String(s.followupLeadMinutes || 60)}
                onChange={(e) => save({ followupLeadMinutes: Number(e.target.value) })}
              />
            </Field>
          </div>
        ) : null}

        <div className="row-between mt-16" style={{ alignItems: 'center', gap: '12px' }}>
          <div>
            <div>Morning summary</div>
            <div className="tiny muted">One email listing today’s follow-ups and site visits.</div>
          </div>
          <SwitchToggle
            label=""
            defaultChecked={Boolean(s.notifyDailySummary)}
            onChange={(checked) => save({ notifyDailySummary: checked })}
          />
        </div>

        {s.notifyDailySummary ? (
          <div className="mt-16">
            <Field
              label="Send it at"
              hint={'Nobody is emailed an empty list — a digest that always says "nothing today" stops being read.'}
            >
              <Select
                options={hourOptions}
                defaultValue={String(s.dailySummaryHour ?? 8)}
                onChange={(e) => save({ dailySummaryHour: Number(e.target.value) })}
              />
            </Field>
          </div>
        ) : null}

        <div className="mt-16">
          <Field
            label="Also copy every new-lead alert to"
            hint="Optional — for a sales head who wants to see the flow without owning any of it."
          >
            <Input
              type="email"
              id="gv-notify-cc"
              defaultValue={s.notifyCcEmail || ''}
              placeholder="sales.head@yourcompany.com"
              onBlur={commitCc}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitCc(e);
              }}
            />
          </Field>
        </div>

        <div className="alert info mt-16">
          <strong>No setup needed. </strong>
          {'These go out from Growvanta’s own mailbox, so they work whether or not you have ' +
            'configured the email channel above. That one is what your buyers hear from; this is ' +
            'what your team hears from.'}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function Communication() {
  const { can } = useAuth();
  const [query] = useQueryParams();
  if (!(can('whatsapp', 'read') || can('email', 'read'))) return <NoAccess what="messaging settings" />;
  // A different tenant is a different page: start again from the loader
  // rather than briefly showing the previous company's settings.
  return <CommunicationPage key={query.organizationId || ''} />;
}

function CommunicationPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [query] = useQueryParams();

  // A Super Admin may configure a selected client (spec section 27).
  const orgId = query.organizationId || null;
  const qs = useMemo(() => (orgId ? { organizationId: orgId } : {}), [orgId]);
  const activeTab = query.tab || 'automation';
  const canWhatsapp = can('whatsapp', 'read');
  const canEmail = can('email', 'read');

  // `version` bumps on each successful load; the automation tab is keyed on
  // it so its uncontrolled switches and inputs re-seed from the server.
  const [state, setState] = useState({ status: 'loading', wa: null, em: null, error: null, version: 0 });

  const load = useCallback(
    async (signal) => {
      try {
        const [wa, em] = await Promise.all([
          canWhatsapp ? api.data('/api/whatsapp', qs, { signal }) : Promise.resolve(null),
          canEmail ? api.data('/api/email', qs, { signal }) : Promise.resolve(null),
        ]);
        setState((s) => ({ status: 'ready', wa, em, error: null, version: s.version + 1 }));
      } catch (err) {
        if (err.name === 'AbortError') return;
        setState((s) => ({ ...s, status: 'error', error: err }));
      }
    },
    [qs, canWhatsapp, canEmail]
  );

  // The original rebuilt the view (and re-read both channels) on every tab
  // switch, so a verdict changed by a template edit is fresh when the
  // Automation tab is opened again.
  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load, activeTab]);

  const reload = () => load();

  if (state.status === 'loading') {
    return (
      <div>
        <PageLoader label="Loading messaging settings" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div>
        <div className="card">
          <div className="alert danger">{state.error.message}</div>
        </div>
      </div>
    );
  }

  const { wa, em, version } = state;

  let tabBody;
  if (activeTab === 'templates') {
    tabBody = <TemplatesPanel qs={qs} />;
  } else if (activeTab === 'logs') {
    tabBody = <LogsPanel qs={qs} />;
  } else {
    tabBody = (
      <div key={version}>
        <div className="form-grid mt-16">
          {wa ? (
            <ConfigurationCard
              channel="WhatsApp"
              verdict={wa.configuration}
              onToggle={(checked) => toggle('whatsapp', { welcomeEnabled: checked }, qs, reload)}
              onManage={() => openOverlay((close) => <WhatsAppConfig wa={wa} qs={qs} reload={reload} onClose={close} />)}
              onTest={() => openOverlay((close) => <TestDialog channel="WhatsApp" qs={qs} reload={reload} onClose={close} />)}
            />
          ) : null}
          {em ? (
            <ConfigurationCard
              channel="Email"
              verdict={em.configuration}
              onToggle={(checked) => toggle('email', { welcomeEnabled: checked }, qs, reload)}
              onManage={() => openOverlay((close) => <EmailConfig em={em} qs={qs} reload={reload} onClose={close} />)}
              onTest={() => openOverlay((close) => <TestDialog channel="Email" qs={qs} reload={reload} onClose={close} />)}
            />
          ) : null}
        </div>
        {em ? <StaffAlertsCard em={em} qs={qs} reload={reload} /> : null}
        <div className="alert info mt-16">
          <strong>How this is enforced: </strong>
          {'the server re-checks this configuration before every single message. ' +
            'A channel that is not green will record why it skipped, in the delivery log, rather than failing silently.'}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHead
        title="Messaging & automation"
        subtitle={
          orgId
            ? 'Configuring a client company on their behalf.'
            : 'Welcome messages sent automatically when a new lead arrives.'
        }
        breadcrumbs={orgId ? [{ label: 'Clients', path: '/clients' }, { label: 'Messaging' }] : undefined}
      />
      <Tabs
        items={[
          { key: 'automation', label: 'Automation' },
          { key: 'templates', label: 'Templates' },
          { key: 'logs', label: 'Delivery log' },
        ]}
        active={activeTab}
        onSelect={(key) => navigate(`/communication?tab=${key}${orgId ? `&organizationId=${orgId}` : ''}`)}
      />
      <div>{tabBody}</div>
    </div>
  );
}

async function toggle(channel, payload, qs, reload) {
  try {
    const res = await api.patch(`/api/${channel}${suffix(qs)}`, payload);
    const status = res.data?.status;
    if (payload.welcomeEnabled && status === 'ORANGE') {
      // Being explicit here prevents the "I switched it on, why is nothing
      // sending" support ticket.
      toast('Switched on, but not sending yet', {
        body: 'The configuration is incomplete. Finish the checklist to activate.',
        type: 'warning',
      });
    } else if (payload.welcomeEnabled && status === 'GREEN') {
      toast.success('Welcome messages are now active');
    } else {
      toast.success('Welcome messages disabled');
    }
    reload();
  } catch (err) {
    reportError(err);
    reload();
  }
}

// ---------------------------------------------------------------------------
function WhatsAppConfig({ wa, qs, reload, onClose }) {
  const [form, setForm] = useState({
    accessToken: '',
    phoneNumberId: wa.phoneNumberId || '',
    wabaId: wa.wabaId || '',
    senderNumber: wa.senderNumber || '',
    apiBaseUrl: wa.apiBaseUrl || '',
    welcomeTemplateId: wa.welcomeTemplateId || '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const bind = (key) => ({
    value: form[key],
    onChange: (e) => {
      const { value } = e.target;
      setForm((f) => ({ ...f, [key]: value }));
    },
  });

  async function save() {
    const payload = {
      phoneNumberId: form.phoneNumberId.trim(),
      wabaId: form.wabaId.trim(),
      senderNumber: form.senderNumber.trim(),
      apiBaseUrl: form.apiBaseUrl.trim() || null,
      welcomeTemplateId: form.welcomeTemplateId || null,
    };
    // Only send the token when one was typed, so saving other fields does not
    // wipe a stored credential.
    if (form.accessToken) payload.accessToken = form.accessToken;

    setSaving(true);
    try {
      await api.patch(`/api/whatsapp${suffix(qs)}`, payload);
      toast.success('WhatsApp configuration saved', 'Send a test message to activate it.');
      onClose();
      reload();
    } catch (err) {
      setSaving(false);
      setError(err.message);
    }
  }

  return (
    <Drawer
      title="WhatsApp configuration"
      subtitle="Meta WhatsApp Cloud API"
      wide
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: '8px' }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
            Save configuration
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
        <div className="alert info mb-16">
          {'Business-initiated WhatsApp messages must use a template that Meta has approved. ' +
            'Growvanta will not mark this channel active until a live test send succeeds.'}
        </div>
        <Field label="Access token" required hint="Stored encrypted and never shown again.">
          <Input
            type="password"
            placeholder={wa.hasAccessToken ? '•••••••• (leave blank to keep)' : 'Permanent access token'}
            {...bind('accessToken')}
          />
        </Field>
        <div className="form-grid">
          <Field label="Phone number ID" required>
            <Input placeholder="1234567890" {...bind('phoneNumberId')} />
          </Field>
          <Field label="Business account ID" required>
            <Input placeholder="WhatsApp Business Account ID" {...bind('wabaId')} />
          </Field>
          <Field label="Sender number" required>
            <Input placeholder="+91 90000 00000" {...bind('senderNumber')} />
          </Field>
          <Field label="API base URL" hint="Leave blank for the default.">
            <Input placeholder="https://graph.facebook.com/v21.0" {...bind('apiBaseUrl')} />
          </Field>
        </div>
        <Field label="Welcome template" required hint="Only approved templates can actually be delivered.">
          <Select
            options={[
              { value: '', label: 'Select a template…' },
              ...(wa.templates || []).map((t) => ({
                value: t.id,
                label: `${t.name}${t.status === 'APPROVED' ? '' : ` (${titleCase(t.status)})`}`,
              })),
            ]}
            {...bind('welcomeTemplateId')}
          />
        </Field>
      </div>
    </Drawer>
  );
}

function EmailConfig({ em, qs, reload, onClose }) {
  const [form, setForm] = useState({
    mode: em.mode || 'SMTP',
    smtpHost: em.smtpHost || '',
    smtpPort: String(em.smtpPort || 587),
    smtpEncryption: em.smtpEncryption || 'TLS',
    smtpUsername: em.smtpUsername || '',
    smtpPassword: '',
    apiKey: '',
    fromEmail: em.fromEmail || '',
    fromName: em.fromName || '',
    replyTo: em.replyTo || '',
    welcomeTemplateId: em.welcomeTemplateId || '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const bind = (key) => ({
    value: form[key],
    onChange: (e) => {
      const { value } = e.target;
      setForm((f) => ({ ...f, [key]: value }));
    },
  });

  async function save() {
    const payload = {
      mode: form.mode,
      smtpHost: form.smtpHost.trim() || null,
      smtpPort: form.smtpPort ? Number(form.smtpPort) : null,
      smtpEncryption: form.smtpEncryption,
      smtpUsername: form.smtpUsername.trim() || null,
      fromEmail: form.fromEmail.trim() || null,
      fromName: form.fromName.trim() || null,
      replyTo: form.replyTo.trim() || null,
      welcomeTemplateId: form.welcomeTemplateId || null,
    };
    // Secrets are write-only: send them only when something was typed.
    if (form.smtpPassword) payload.smtpPassword = form.smtpPassword;
    if (form.apiKey) payload.apiKey = form.apiKey;

    setSaving(true);
    try {
      await api.patch(`/api/email${suffix(qs)}`, payload);
      toast.success('Email configuration saved', 'Send a test email to activate it.');
      onClose();
      reload();
    } catch (err) {
      setSaving(false);
      setError(err.message);
    }
  }

  return (
    <Drawer
      title="Email configuration"
      subtitle="Outgoing mail for welcome messages and notifications"
      wide
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: '8px' }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
            Save configuration
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
        <Field label="Send using">
          <Select
            options={[
              { value: 'SMTP', label: 'SMTP server' },
              { value: 'API', label: 'Email API provider' },
            ]}
            {...bind('mode')}
          />
        </Field>
        <div>
          {form.mode === 'SMTP' ? (
            <div>
              <div className="form-grid">
                <Field label="SMTP host" required>
                  <Input placeholder="smtp.yourhost.com" {...bind('smtpHost')} />
                </Field>
                <Field label="Port" required>
                  <Input type="number" {...bind('smtpPort')} />
                </Field>
                <Field label="Encryption">
                  <Select
                    options={[
                      { value: 'TLS', label: 'STARTTLS (587)' },
                      { value: 'SSL', label: 'SSL/TLS (465)' },
                      { value: 'NONE', label: 'None' },
                    ]}
                    {...bind('smtpEncryption')}
                  />
                </Field>
                <Field label="Username">
                  <Input {...bind('smtpUsername')} />
                </Field>
              </div>
              <Field label="Password" hint="Stored encrypted.">
                <Input
                  type="password"
                  placeholder={em.hasSmtpPassword ? '•••••••• (leave blank to keep)' : 'SMTP password'}
                  {...bind('smtpPassword')}
                />
              </Field>
            </div>
          ) : (
            <div>
              <Field label="API key" hint="Stored encrypted.">
                <Input
                  type="password"
                  placeholder={em.hasApiKey ? '•••••••• (leave blank to keep)' : 'Provider API key'}
                  {...bind('apiKey')}
                />
              </Field>
            </div>
          )}
        </div>
        <div className="form-grid">
          <Field label="From email" required>
            <Input type="email" placeholder="sales@yourcompany.com" {...bind('fromEmail')} />
          </Field>
          <Field label="From name" required>
            <Input placeholder="ABC Realty Sales" {...bind('fromName')} />
          </Field>
          <Field label="Reply-to">
            <Input type="email" {...bind('replyTo')} />
          </Field>
        </div>
        <Field label="Welcome email template" required>
          <Select
            options={[
              { value: '', label: 'Select a template…' },
              ...(em.templates || []).map((t) => ({ value: t.id, label: t.name })),
            ]}
            {...bind('welcomeTemplateId')}
          />
        </Field>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
function TestDialog({ channel, qs, reload, onClose }) {
  const { user } = useAuth();
  const isWhatsApp = channel === 'WhatsApp';
  const [target, setTarget] = useState(isWhatsApp ? '' : user?.email || '');
  // null | { kind: 'pending' } | { kind: 'ok' } | { kind: 'rejected', message } | { kind: 'error', message }
  const [result, setResult] = useState(null);
  const [sending, setSending] = useState(false);

  async function send() {
    if (!target.trim()) return;
    setSending(true);
    setResult({ kind: 'pending' });
    try {
      const path = `/api/${isWhatsApp ? 'whatsapp' : 'email'}/test${suffix(qs)}`;
      const res = await api.post(path, isWhatsApp ? { phone: target.trim() } : { email: target.trim() });
      const data = res.data;
      setResult(data.ok ? { kind: 'ok' } : { kind: 'rejected', message: data.error || 'Unknown error' });
      reload();
    } catch (err) {
      setResult({ kind: 'error', message: err.message });
    } finally {
      setSending(false);
    }
  }

  let resultNode = null;
  if (result?.kind === 'pending') {
    resultNode = <div className="muted small mt-8">Contacting the provider…</div>;
  } else if (result?.kind === 'ok') {
    resultNode = <div className="alert success mt-8">Delivered. This channel is now verified.</div>;
  } else if (result?.kind === 'rejected') {
    resultNode = (
      <div className="alert danger mt-8">
        <strong>The provider rejected it: </strong>
        {result.message}
      </div>
    );
  } else if (result?.kind === 'error') {
    resultNode = <div className="alert danger mt-8">{result.message}</div>;
  }

  return (
    <Modal
      title={`Test ${channel.toLowerCase()}`}
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: '8px' }}>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" disabled={sending} onClick={send}>
            {sending ? 'Sending…' : 'Send test'}
          </button>
        </div>
      }
    >
      <div>
        <p className="muted small" style={{ marginTop: 0 }}>
          A successful test is what marks this channel as verified. Test messages are logged separately and never counted
          as lead activity.
        </p>
        <Field label={isWhatsApp ? 'Send to WhatsApp number' : 'Send to email address'} required>
          <Input
            type={isWhatsApp ? 'tel' : 'email'}
            placeholder={isWhatsApp ? '+91 98765 43210' : 'you@yourcompany.com'}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </Field>
        <div>{resultNode}</div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function TemplatesPanel({ qs }) {
  const { can } = useAuth();
  const [state, setState] = useState({ status: 'loading', rows: [], error: null });

  // Shows the loader on every repaint, as the original did.
  const paint = useCallback(async () => {
    setState({ status: 'loading', rows: [], error: null });
    try {
      const rows = await api.data('/api/templates', qs);
      setState({ status: 'ready', rows: rows || [], error: null });
    } catch (err) {
      setState({ status: 'error', rows: [], error: err });
    }
  }, [qs]);

  useEffect(() => {
    paint();
  }, [paint]);

  const openForm = (template) =>
    openOverlay((close) => <TemplateForm template={template} qs={qs} reload={paint} onClose={close} />);

  let body;
  if (state.status === 'loading') {
    body = <PageLoader label="Loading templates" />;
  } else if (state.status === 'error') {
    body = <div className="alert danger">{state.error.message}</div>;
  } else {
    body = (
      <>
        {!state.rows.length ? <div className="muted small">No templates yet.</div> : null}
        {state.rows.map((t) => (
          <div key={t.id} className="card mb-16">
            <div className="card-body">
              <div className="row-between">
                <div>
                  <strong>{t.name}</strong>
                  <div className="cell-sub">{`${titleCase(t.channel)} · ${t.key}`}</div>
                </div>
                <div className="row" style={{ gap: '6px' }}>
                  <span className={`badge ${t.status === 'APPROVED' ? 'badge-success' : 'badge-warning'}`}>
                    {titleCase(t.status)}
                  </span>
                  {can('templates', 'update') ? (
                    <button type="button" className="btn btn-sm" onClick={() => openForm(t)}>
                      Edit
                    </button>
                  ) : null}
                </div>
              </div>
              {t.subject ? (
                <div className="small mt-8">
                  <strong>Subject: </strong>
                  {t.subject}
                </div>
              ) : null}
              <pre className="code-block mt-8" style={{ whiteSpace: 'pre-wrap', maxHeight: '150px', overflow: 'auto' }}>
                {t.body}
              </pre>
              {t.unknownVariables?.length ? (
                <div className="alert warning mt-8">
                  {`These variables are not recognised and will render blank: ${t.unknownVariables.join(', ')}`}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </>
    );
  }

  return (
    <Panel
      title="Message templates"
      subtitle="Use {{customer_name}}, {{project_name}}, {{company_name}} and friends."
      action={
        can('templates', 'create') ? (
          <button type="button" className="btn btn-sm" onClick={() => openForm(null)}>
            <Icon name="plus" size={14} />
            New template
          </button>
        ) : null
      }
    >
      <div>{body}</div>
    </Panel>
  );
}

function TemplateForm({ template, qs, reload, onClose }) {
  const isEdit = Boolean(template);
  const [form, setForm] = useState({
    name: template?.name || '',
    channel: template?.channel || 'WHATSAPP',
    providerName: template?.providerName || '',
    subject: template?.subject || '',
    body: template?.body || '',
  });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const bind = (key) => ({
    value: form[key],
    onChange: (e) => {
      const { value } = e.target;
      setForm((f) => ({ ...f, [key]: value }));
    },
  });

  const runPreview = async () => {
    try {
      const res = await api.post(`/api/templates/preview${suffix(qs)}`, { body: form.body, subject: form.subject });
      setPreview(res.data);
    } catch (err) {
      reportError(err);
    }
  };

  async function save() {
    const payload = {
      name: form.name.trim(),
      channel: form.channel,
      providerName: form.providerName.trim() || null,
      subject: form.subject.trim() || null,
      body: form.body,
    };
    setSaving(true);
    try {
      if (isEdit) await api.patch(`/api/templates/${template.id}${suffix(qs)}`, payload);
      else await api.post(`/api/templates${suffix(qs)}`, payload);
      toast.success(isEdit ? 'Template saved' : 'Template created');
      onClose();
      reload();
    } catch (err) {
      setSaving(false);
      setError(err.message);
    }
  }

  return (
    <Drawer
      title={isEdit ? 'Edit template' : 'New template'}
      wide
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: '8px' }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
            {isEdit ? 'Save template' : 'Create template'}
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
        <div className="form-grid">
          <Field label="Template name" required>
            <Input {...bind('name')} />
          </Field>
          <Field label="Channel" required>
            <Select
              options={[
                { value: 'WHATSAPP', label: 'WhatsApp' },
                { value: 'EMAIL', label: 'Email' },
              ]}
              disabled={isEdit}
              {...bind('channel')}
            />
          </Field>
          <Field label="Provider template name" hint="WhatsApp only: the name Meta approved.">
            <Input placeholder="Name registered at the provider" {...bind('providerName')} />
          </Field>
        </div>
        <Field label="Subject" hint="Email only.">
          <Input {...bind('subject')} />
        </Field>
        <Field
          label="Message body"
          required
          hint="Available: {{customer_name}} {{first_name}} {{project_name}} {{project_location}} {{company_name}} {{sales_person_name}} {{sales_person_phone}} {{phone}} {{email}} {{budget}} {{configuration}} {{lead_source}} {{lead_code}}"
        >
          <Textarea rows={8} {...bind('body')} />
        </Field>
        <button type="button" className="btn btn-sm" onClick={runPreview}>
          <Icon name="eye" size={14} />
          Preview with sample data
        </button>
        <div>
          {preview ? (
            <div className="card mt-8">
              <div className="card-body">
                {preview.subject ? (
                  <div className="small mb-8">
                    <strong>Subject: </strong>
                    {preview.subject}
                  </div>
                ) : null}
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                  {preview.body}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
function LogsPanel({ qs }) {
  const [channel, setChannel] = useState('whatsapp');

  return (
    <Panel title="Delivery log" subtitle="Every attempt, including the ones deliberately skipped.">
      <div>
        <div className="row mb-16" style={{ gap: '10px' }}>
          <Select
            options={[
              { value: 'whatsapp', label: 'WhatsApp' },
              { value: 'email', label: 'Email' },
            ]}
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          />
        </div>
        <div>
          {/* A new table per channel, as the original rebuilt it on change. */}
          <DataTable
            key={channel}
            load={(params) => api.get(`/api/${channel}/logs`, { ...params, ...qs })}
            emptyTitle="Nothing sent yet"
            emptyMessage="Messages, and the reasons any were skipped, appear here."
            columns={[
              {
                label: 'Status',
                render: (row) => (
                  <span
                    className={`badge ${{ SENT: 'badge-success', FAILED: 'badge-danger', SKIPPED: 'badge-warning' }[row.status] || ''}`}
                  >
                    {titleCase(row.status)}
                  </span>
                ),
              },
              { label: 'Recipient', render: (row) => row.recipient || '—' },
              { label: 'Lead', render: (row) => row.leadCode || (row.isTest ? 'Test message' : '—') },
              {
                label: 'Reason',
                render: (row) => (
                  <span className="small" title={row.reason || ''}>
                    {row.reason ? String(row.reason).slice(0, 90) : '—'}
                  </span>
                ),
              },
              { label: 'When', cellClass: 'hide-sm', render: (row) => dateTime(row.createdAt) },
            ]}
          />
        </div>
      </div>
    </Panel>
  );
}
