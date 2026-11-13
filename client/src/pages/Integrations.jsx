/**
 * Integrations.
 *
 * Each provider is a real configuration record. Nothing here claims to be
 * connected until the required credentials exist - the card says exactly what
 * is missing and where to set it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useQueryParams } from '../lib/query.js';
import { relative } from '../lib/format.js';
import Icon from '../components/Icon.jsx';
import { NoAccess, PageHead } from '../components/shared.jsx';
import {
  Alert,
  BusyButton,
  Drawer,
  EmptyState,
  Field,
  Input,
  PageLoader,
  SwitchToggle,
  openOverlay,
  reportError,
  toast,
} from '../components/ui/index.js';

const PROVIDER_ICON = {
  google_ads: 'campaign',
  meta_ads: 'message',
  google_analytics: 'reports',
  whatsapp: 'message',
  smtp: 'mail',
  sms: 'phone',
  zapier: 'integrations',
};

const NL = String.fromCharCode(10);

/**
 * `div.alert` with the icon the original chose for it. The shared <Alert>
 * always draws the warning glyph for info, and its danger tone scrolls itself
 * into view - wrong for a diagnosis report that may list several failures.
 */
function Callout({ tone, iconName, className, children }) {
  return (
    <div className={['alert', tone, className].filter(Boolean).join(' ')}>
      <Icon name={iconName} size={16} />
      <div>{children}</div>
    </div>
  );
}

/** The 38px rounded provider glyph at the left of a card head. */
function ProviderMark({ iconName, on }) {
  return (
    <span
      style={{
        width: '38px',
        height: '38px',
        borderRadius: '11px',
        flex: '0 0 38px',
        display: 'grid',
        placeItems: 'center',
        background: on ? 'var(--success-bg)' : 'var(--surface-3)',
        color: on ? 'var(--success)' : 'var(--ink-3)',
      }}
    >
      <Icon name={iconName} size={19} />
    </span>
  );
}

const LIST_ROW = { padding: '8px 0', borderBottom: '1px solid var(--line-2)', gap: '10px' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function Integrations() {
  const { can } = useAuth();
  if (!can('integrations', 'read')) return <NoAccess what="integrations" />;
  return <IntegrationsPage />;
}

function IntegrationsPage() {
  const { can } = useAuth();
  // The Meta OAuth callback sends the browser back to /integrations with
  // ?meta=choose|cancelled|failed (&reason=…). The page is not remounted when
  // only the query changes, so the outcome is read from the URL on every render.
  const [query] = useQueryParams();
  const canReadProjects = can('projects', 'read');

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [facebook, setFacebook] = useState(null);

  const loadFacebook = useCallback(async () => {
    try {
      const status = await api.data('/api/meta-forms/connect/status');
      const forms = (await api.data('/api/meta-forms')).forms || [];
      // Only needed for the form -> project picker; a missing permission just hides it.
      const projects = canReadProjects ? (await api.data('/api/projects/options').catch(() => [])) || [] : [];
      setFacebook({ status, forms, projects });
    } catch {
      // A server without the connect flow, or no permission to see it. Leaving
      // the section out entirely is better than showing a broken card.
      setFacebook(null);
    }
  }, [canReadProjects]);

  const load = useCallback(async () => {
    loadFacebook();
    try {
      setData(await api.data('/api/integrations'));
      setError(null);
    } catch (err) {
      reportError(err);
      setError(err);
    }
  }, [loadFacebook]);

  useEffect(() => {
    load();
  }, [load]);

  const openConfig = (integration) =>
    openOverlay((close) => <ConfigDrawer integration={integration} onClose={close} onSaved={load} />);

  let body;
  if (error) {
    body = (
      <div className="card">
        <EmptyState iconName="alert" title="Could not load integrations" message={error.message} />
      </div>
    );
  } else if (!data) {
    body = <PageLoader label="Loading integrations" />;
  } else {
    body = (
      <>
        <Callout tone="info" iconName="info" className="mb-16">
          {data.note}
        </Callout>
        <div className="chart-grid half">
          {data.integrations.map((integration) => (
            <IntegrationCard key={integration.provider} integration={integration} onConfigure={openConfig} />
          ))}
        </div>
      </>
    );
  }

  return (
    <div>
      <PageHead
        title="Integrations"
        subtitle="Connect ad platforms, messaging and email. Everything unconfigured stays inert."
      />
      <div>{facebook ? <FacebookCard facebook={facebook} query={query} onReload={load} /> : null}</div>
      <div>{body}</div>
    </div>
  );
}

// ===========================================================================
// Facebook & Instagram Lead Ads
// ===========================================================================

/**
 * Its own card, above the provider list, because it is the one integration a
 * customer completes by pressing a button instead of pasting credentials:
 * they authorise on facebook.com with their own account and come back here to
 * say which of their pages belongs in this CRM. No page id, no access token,
 * no Graph API Explorer.
 */
function FacebookCard({ facebook, query, onReload }) {
  const { can } = useAuth();
  const { status, forms, projects } = facebook;
  const [connecting, setConnecting] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);

  // The OAuth callback sends the browser back with the outcome attached.
  const outcome = query?.meta || null;
  const awaiting = status.awaitingPageChoice || outcome === 'choose';
  const editable = can('integrations', 'update');

  // One row per page, however many forms it carries - the page is what the
  // customer recognises and what was actually subscribed.
  const pages = new Map();
  for (const f of forms) {
    const p = pages.get(f.metaPageId) || { name: f.pageName || f.metaPageId, forms: 0, live: 0, error: null };
    p.forms += 1;
    if (f.subscribedAt) p.live += 1;
    // Facebook's own words about why the page is not subscribed. Worth more
    // than any message we could invent, so it is shown verbatim.
    if (f.lastError && !p.error) p.error = f.lastError;
    pages.set(f.metaPageId, p);
  }

  async function connect() {
    setConnecting(true);
    try {
      const res = await api.post('/api/meta-forms/connect');
      // A full redirect, not a popup: Facebook refuses to render its login
      // screen inside one, and a blocked popup is invisible to the person
      // who just pressed the button. The button stays disabled until we leave.
      window.location.href = res.data.url;
    } catch (err) {
      setConnecting(false);
      reportError(err);
    }
  }

  async function diagnose() {
    setDiagnosing(true);
    try {
      const report = await api.data('/api/meta-forms/diagnose');
      openOverlay((close) => <DiagnosisDrawer report={report} onClose={close} />);
    } catch (err) {
      reportError(err);
    } finally {
      setDiagnosing(false);
    }
  }

  /**
   * The page picker, shown once Facebook has sent the admin back to us. The
   * authorisation behind it lasts fifteen minutes and holds a token that can
   * list every page this person administers, which is why it is spent as soon
   * as they choose.
   */
  async function openPagePicker() {
    let list;
    try {
      list = (await api.data('/api/meta-forms/connect/pages')).pages || [];
    } catch (err) {
      reportError(err);
      return;
    }
    if (!list.length) {
      toast.warn('No pages found', 'This Facebook account does not administer any page.');
      return;
    }
    openOverlay((close) => <PagePicker pages={list} onClose={close} onSaved={onReload} />);
  }

  const connectButton = (
    <button key="connect" type="button" className="btn btn-primary" disabled={connecting} onClick={connect}>
      <Icon name="message" size={15} />
      {pages.size ? 'Connect another page' : 'Connect Facebook'}
    </button>
  );

  return (
    <section className="card mb-16">
      <div className="card-head">
        <div className="row" style={{ gap: '11px', minWidth: 0 }}>
          <ProviderMark iconName="message" on={pages.size > 0} />
          <div style={{ minWidth: 0 }}>
            <h3 className="truncate">Facebook &amp; Instagram Lead Ads</h3>
            <div className="sub">
              Connect your own Facebook page. Every lead form on it starts arriving here, including forms you publish
              later.
            </div>
          </div>
        </div>
        <span className={`badge ${pages.size ? 'badge-success' : ''}`}>
          {pages.size ? `${plural(pages.size, 'page')} connected` : 'Not connected'}
        </span>
      </div>

      <div className="card-body">
        {outcome === 'cancelled' || outcome === 'failed' ? (
          <Callout tone="danger" iconName="alert" className="mb-16">
            <strong>
              {outcome === 'cancelled' ? 'Facebook authorisation was cancelled' : 'Facebook could not be connected'}
            </strong>
            {query.reason || 'Nothing was changed. You can start again below.'}
          </Callout>
        ) : null}

        {!status.configured ? (
          <Callout tone="warning" iconName="alert" className="mb-16">
            <strong>This server has no Facebook app yet</strong>
            META_APP_ID and META_APP_SECRET have to be set in the server&apos;s .env file before anyone can connect.
          </Callout>
        ) : null}

        {awaiting ? (
          <Callout tone="success" iconName="check" className="mb-16">
            <strong>Authorised</strong>
            Now choose which of your pages should send leads into this CRM.
          </Callout>
        ) : null}

        {pages.size ? (
          <div className="mb-16">
            <div className="tiny muted mb-8">Connected pages</div>
            {[...pages.entries()].map(([pageId, p]) => (
              <div key={pageId} className="row-between" style={LIST_ROW}>
                <div style={{ minWidth: 0 }}>
                  <div className="truncate" style={{ fontWeight: '600' }}>
                    {p.name}
                  </div>
                  <div className="tiny muted">{`${plural(p.forms, 'form')} · page ${pageId}`}</div>
                  {p.error ? (
                    <div className="tiny" style={{ color: 'var(--danger)', marginTop: '3px' }}>
                      {p.error}
                    </div>
                  ) : null}
                </div>
                {/* A page that is connected but not subscribed looks perfectly
                    healthy and delivers nothing. Say so where it can be seen. */}
                <span className={`badge ${p.live ? 'badge-success' : 'badge-warning'}`}>
                  {p.live ? 'Receiving leads' : 'Not subscribed'}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {/* A Meta lead form cannot ask which project the buyer means, so it is
            answered here once per form. Every lead from that form is then filed
            under the project, which is what the project reports group on. */}
        {forms.length && projects.length ? (
          <div className="mb-16">
            <div className="tiny muted mb-8">Lead form → project</div>
            {forms.map((f) => (
              <FormProjectRow key={f.id} form={f} projects={projects} editable={editable} />
            ))}
          </div>
        ) : null}

        <div className="row wrap" style={{ gap: '6px' }}>
          {status.configured ? (
            <button type="button" className="btn" disabled={diagnosing} onClick={diagnose}>
              {diagnosing ? (
                'Asking Facebook...'
              ) : (
                <>
                  <Icon name="alert" size={15} />
                  Run diagnosis
                </>
              )}
            </button>
          ) : null}
          {editable && status.configured ? (
            awaiting ? (
              <BusyButton className="btn btn-primary" onClick={openPagePicker}>
                <Icon name="check" size={15} />
                Choose your pages
              </BusyButton>
            ) : (
              connectButton
            )
          ) : null}
          {editable && awaiting ? connectButton : null}
          {!editable ? (
            <span className="small muted" style={{ alignSelf: 'center' }}>
              Ask an administrator to connect a Facebook page.
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** One Meta lead form and the project its leads are filed under. Saves on change. */
function FormProjectRow({ form, projects, editable }) {
  const [projectId, setProjectId] = useState(form.projectId || '');
  const [saving, setSaving] = useState(false);
  const isFallback = String(form.metaFormId || '').startsWith('page-');

  async function change(e) {
    const previous = projectId;
    const next = e.target.value || null;
    setProjectId(next || '');
    setSaving(true);
    try {
      await api.patch(`/api/meta-forms/${form.id}`, { projectId: next });
      const label = next ? projects.find((pr) => pr.id === next)?.name : 'No project';
      toast.success('Saved', `${form.formName || form.metaFormId} → ${label}`);
    } catch (err) {
      setProjectId(previous);
      reportError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="row-between" style={LIST_ROW}>
      <div style={{ minWidth: 0 }}>
        <div className="truncate" style={{ fontWeight: '600' }}>
          {isFallback ? 'Any other form on this page' : form.formName || form.metaFormId}
        </div>
        <div className="tiny muted">
          {`${form.pageName || form.metaPageId}${isFallback ? '' : ` · form ${form.metaFormId}`}`}
        </div>
      </div>
      <select
        className="select"
        style={{ maxWidth: '240px' }}
        disabled={!editable || saving}
        value={projectId}
        onChange={change}
      >
        <option value="">No project</option>
        {projects.map((pr) => (
          <option key={pr.id} value={pr.id}>
            {pr.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Show what Facebook said.
 *
 * Every line is Facebook's own answer, not our guess, and every failure
 * carries the fix next to it. The point is that nobody has to read a log or
 * describe a symptom over the phone: the screen says what is wrong.
 */
function DiagnosisDrawer({ report, onClose }) {
  const tone = { PASS: 'success', FAIL: 'danger', INFO: 'info' };

  function copyReport() {
    // Copying beats retyping when this has to be sent to somebody.
    const lines = [
      'Growvanta CRM - Facebook diagnosis - ' + report.ranAt,
      '',
      ...report.checks.map((c) => `[${c.state}] ${c.name}: ${c.detail}` + (c.fix ? `${NL}        Fix: ${c.fix}` : '')),
      '',
      'PAGES',
      ...(report.pages.length
        ? report.pages.map(
            (p) =>
              `- ${p.name} (${p.pageId}), ${p.formCount} forms, ` +
              (p.healthy ? 'healthy' : 'NOT delivering') +
              (p.problems?.length ? NL + '    ' + p.problems.join(NL + '    ') : '')
          )
        : ['  none']),
    ].join(NL);
    const write = navigator.clipboard?.writeText(lines);
    if (!write) {
      toast.error('Could not copy', 'Your browser blocked clipboard access.');
      return;
    }
    write
      .then(() => toast.success('Copied', 'Paste it wherever you need it.'))
      .catch(() => toast.error('Could not copy', 'Your browser blocked clipboard access.'));
  }

  return (
    <Drawer
      title="Facebook diagnosis"
      subtitle="Asked Facebook directly, just now. Nothing was changed."
      wide
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={copyReport}>
            Copy report
          </button>
        </div>
      }
    >
      {report.checks.map((c, i) => (
        <Callout
          key={i}
          tone={tone[c.state] || 'info'}
          iconName={c.state === 'PASS' ? 'check' : c.state === 'FAIL' ? 'alert' : 'info'}
          className="mb-8"
        >
          <strong>{c.name}</strong>
          {c.detail}
          {c.fix ? (
            <div className="tiny mt-8">
              <strong>Fix: </strong>
              {c.fix}
            </div>
          ) : null}
        </Callout>
      ))}
      <div className="tiny muted mt-16 mb-8">Connected pages</div>
      {report.pages.length ? (
        <div>
          {report.pages.map((p) => (
            <div key={p.pageId} style={{ padding: '12px 0', borderBottom: '1px solid var(--line-2)' }}>
              <div className="row-between" style={{ gap: '10px' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: '600' }}>{p.name}</div>
                  <div className="tiny muted">
                    {`${plural(p.formCount, 'form')} · page ${p.pageId}` +
                      (p.subscribedFields?.length ? ' · fields: ' + p.subscribedFields.join(', ') : '')}
                  </div>
                </div>
                <span className={`badge ${p.healthy ? 'badge-success' : 'badge-warning'}`}>
                  {p.healthy ? 'Receiving leads' : 'Not delivering'}
                </span>
              </div>
              {(p.problems || []).map((t, i) => (
                <div key={i} className="tiny" style={{ color: 'var(--danger)', marginTop: '6px' }}>
                  {t}
                </div>
              ))}
              {p.storedError ? (
                <div className="tiny muted" style={{ marginTop: '4px' }}>
                  {'Last recorded: ' + p.storedError}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="small muted">No page is connected yet.</div>
      )}
      <div className="tiny muted mt-16">{'Run at ' + new Date(report.ranAt).toLocaleString()}</div>
    </Drawer>
  );
}

function PagePicker({ pages, onClose, onSaved }) {
  const [chosen, setChosen] = useState(() => new Set(pages.filter((p) => p.alreadyConnected).map((p) => p.id)));
  const [error, setError] = useState('');

  const toggle = (id, on) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  async function save() {
    setError('');
    if (!chosen.size) {
      setError('Choose at least one page.');
      return;
    }
    try {
      const d = (await api.post('/api/meta-forms/connect/pages', { pageIds: [...chosen] })).data;
      onClose();
      if (d.problems?.length) {
        // Partial success is still success for the pages that worked; naming
        // the ones that did not is the only way they get fixed.
        toast('Connected, with problems', { body: d.problems.join(' '), type: 'warning', timeout: 9000 });
      } else {
        toast.success(
          `${plural(d.pages, 'page')} connected`,
          `${plural(d.forms, 'lead form')} now feeding this CRM.`
        );
      }
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Drawer
      title="Choose your pages"
      subtitle="Leads from the forms on these pages will arrive in this CRM."
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <BusyButton className="btn btn-primary" onClick={save}>
            Connect these pages
          </BusyButton>
        </div>
      }
    >
      {error ? (
        <Alert tone="danger" className="mb-16">
          {error}
        </Alert>
      ) : null}
      {pages.map((p) => (
        <label
          key={p.id}
          className="row"
          style={{
            gap: '11px',
            alignItems: 'flex-start',
            cursor: 'pointer',
            padding: '12px 0',
            borderBottom: '1px solid var(--line-2)',
          }}
        >
          <input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: '600' }}>{p.name}</div>
            <div className="tiny muted" style={{ marginTop: '2px' }}>
              {plural(p.formCount, 'lead form') + (p.alreadyConnected ? ' · already connected' : '')}
            </div>
          </div>
        </label>
      ))}
      <div className="tiny muted mt-16">
        A page with no form yet is still worth connecting - it gets subscribed now, so the first form you publish
        starts delivering straight away.
      </div>
    </Drawer>
  );
}

// ===========================================================================
// Provider cards
// ===========================================================================
function IntegrationCard({ integration, onConfigure }) {
  const { can } = useAuth();
  const configured = integration.status === 'CONFIGURED';
  const missing = [...(integration.missing || []), ...(integration.missingEnv || [])];

  return (
    <section className="card">
      <div className="card-head">
        <div className="row" style={{ gap: '11px', minWidth: 0 }}>
          <ProviderMark iconName={PROVIDER_ICON[integration.provider] || 'integrations'} on={configured} />
          <div style={{ minWidth: 0 }}>
            <h3 className="truncate">{integration.label}</h3>
            <div className="sub">{integration.blurb}</div>
          </div>
        </div>
        <span className={`badge ${integration.isEnabled ? 'badge-success' : configured ? 'badge-info' : ''}`}>
          {integration.isEnabled ? 'Enabled' : configured ? 'Ready' : 'Not configured'}
        </span>
      </div>

      <div className="card-body">
        <div className="mb-16">
          <div className="tiny muted mb-8">What it does</div>
          <div className="row wrap" style={{ gap: '5px' }}>
            {integration.capabilities.map((c) => (
              <span key={c} className="badge">
                {c}
              </span>
            ))}
          </div>
        </div>

        {missing.length ? (
          <Callout tone="warning" iconName="alert" className="mb-16">
            <strong>Still needed</strong>
            {missing.join(', ')}
            {integration.missingEnv?.length ? (
              <div className="tiny mt-8">{`Server variables go in .env: ${integration.missingEnv.join(', ')}`}</div>
            ) : null}
          </Callout>
        ) : (
          <Callout tone="success" iconName="check" className="mb-16">
            All required credentials are present.
          </Callout>
        )}

        {integration.lastSyncedAt ? (
          <div className="tiny muted mb-8">{`Last synced ${relative(integration.lastSyncedAt)}`}</div>
        ) : null}
        {integration.lastError ? <div className="small text-danger mb-8">{integration.lastError}</div> : null}

        <div className="row wrap" style={{ gap: '6px' }}>
          {integration.fields.length && can('integrations', 'update') ? (
            <button type="button" className="btn btn-sm" onClick={() => onConfigure(integration)}>
              <Icon name="settings" size={14} />
              Configure
            </button>
          ) : null}
          <Link className="btn btn-sm" to="/developers?tab=docs">
            <Icon name="file" size={14} />
            Documentation
          </Link>
          {!integration.fields.length ? (
            <span className="small muted" style={{ alignSelf: 'center' }}>
              Uses the REST API and webhooks — no credentials needed here.
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ConfigDrawer({ integration, onClose, onSaved }) {
  // Secret fields come back redacted; sending the dots unchanged tells the
  // server to keep the stored value.
  const [values, setValues] = useState(() =>
    Object.fromEntries(integration.fields.map((f) => [f.key, String(integration.config?.[f.key] ?? '')]))
  );
  const [enabled, setEnabled] = useState(Boolean(integration.isEnabled));
  const [error, setError] = useState('');

  async function save() {
    setError('');
    try {
      await api.patch(`/api/integrations/${integration.provider}`, { config: values, isEnabled: enabled });
      toast.success(`${integration.label} saved`);
      onClose();
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Drawer
      title={`Configure ${integration.label}`}
      subtitle={integration.blurb}
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <BusyButton className="btn btn-primary" onClick={save}>
            Save configuration
          </BusyButton>
        </div>
      }
    >
      {error ? (
        <Alert tone="danger" className="mb-16">
          {error}
        </Alert>
      ) : null}
      {integration.fields.map((f) => (
        <Field
          key={f.key}
          label={f.label}
          required={f.required}
          hint={f.secret ? 'Stored per organisation. Leave the dots untouched to keep the current value.' : undefined}
        >
          <Input
            value={values[f.key] ?? ''}
            type={f.secret ? 'password' : 'text'}
            placeholder={f.placeholder || ''}
            autoComplete="off"
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        </Field>
      ))}
      {integration.envKeys?.length ? (
        <Callout tone="info" iconName="info" className="mt-16">
          <strong>Server-side variables</strong>
          {`${integration.envKeys.join(', ')} live in the server's .env file, not here. See docs/ENVIRONMENT.md.`}
        </Callout>
      ) : null}
      <div className="mt-16">
        <SwitchToggle label="Enable this integration" checked={enabled} onChange={setEnabled} />
      </div>
    </Drawer>
  );
}
