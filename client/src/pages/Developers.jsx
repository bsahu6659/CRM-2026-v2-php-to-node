/**
 * Developer settings: API keys, webhooks and the in-app API reference.
 * Port of the PHP edition's `js/views/developers.js`.
 *
 * The API docs live here rather than in a README so an integrator working
 * inside the CRM can copy a working curl command with their own endpoint
 * already filled in.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useQueryParams } from '../lib/query.js';
import { number, dateTime, relative, titleCase } from '../lib/format.js';
import Icon from '../components/Icon.jsx';
import { PageHead, NoAccess, Panel } from '../components/shared.jsx';
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
  Tabs,
  copyToClipboard,
  reportError,
  toast,
  useConfirm,
} from '../components/ui/index.js';

const KEY_STATUS_BADGE = { ACTIVE: 'badge-success', REVOKED: 'badge-danger', EXPIRED: 'badge-warning' };

const KEY_SCOPES = [
  ['leads:create', 'Create leads'],
  ['leads:read', 'Read leads'],
];

export default function Developers() {
  const { can } = useAuth();
  if (!can('apikeys', 'read') && !can('webhooks', 'read')) return <NoAccess what="developer settings" />;
  return <DevelopersPage />;
}

function DevelopersPage() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [query, setQuery] = useQueryParams();

  const TABS = [
    can('apikeys', 'read') ? { key: 'keys', label: 'API keys' } : null,
    can('webhooks', 'read') ? { key: 'webhooks', label: 'Webhooks' } : null,
    { key: 'docs', label: 'API reference' },
  ].filter(Boolean);
  const tab = TABS.some((t) => t.key === query.tab) ? query.tab : TABS[0].key;

  // Bumped by every mutation: the original's `load()` re-fetched the active tab.
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  // `key` records which tab/tick the data belongs to, so a render between a tab
  // switch and its fetch never draws webhooks with the keys payload.
  const loadKey = `${tab}:${tick}`;
  const [view, setView] = useState({ key: null, status: 'loading', data: null, error: null });

  useEffect(() => {
    if (tab === 'docs') {
      setView({ key: loadKey, status: 'ready', data: null, error: null });
      return undefined;
    }
    const ctrl = new AbortController();
    const { signal } = ctrl;
    setView({ key: loadKey, status: 'loading', data: null, error: null });
    (async () => {
      try {
        let data;
        if (tab === 'keys') {
          data = { keys: await api.data('/api/api-keys', undefined, { signal }) };
        } else {
          const [hooks, events] = await Promise.all([
            api.data('/api/webhooks', undefined, { signal }),
            api.data('/api/webhooks/events', undefined, { signal }),
          ]);
          data = { hooks, events };
        }
        if (!signal.aborted) setView({ key: loadKey, status: 'ready', data, error: null });
      } catch (err) {
        if (signal.aborted) return;
        reportError(err);
        setView({ key: loadKey, status: 'error', data: null, error: err });
      }
    })();
    return () => ctrl.abort();
    // loadKey encodes both tab and tick, so it is the only dependency needed.
  }, [loadKey]);

  // One overlay at a time, as the original opened each dialog on top of the page.
  // { type: 'createKey' } | { type: 'keyOnce', key } | { type: 'webhook', webhook, events } | { type: 'deliveries', hook }
  const [overlay, setOverlay] = useState(null);
  const closeOverlay = () => setOverlay(null);

  const current = view.key === loadKey ? view : { status: 'loading' };
  const ready = current.status === 'ready';

  const createKey = () => setOverlay({ type: 'createKey' });
  const openWebhookForm = (webhook = null) => setOverlay({ type: 'webhook', webhook, events: current.data.events });

  // The header action appears once the tab's data has loaded, as the original
  // mounted it from inside renderKeys()/renderWebhooks().
  let actions = null;
  if (ready && tab === 'keys' && can('apikeys', 'create')) {
    actions = (
      <button type="button" className="btn btn-primary" onClick={createKey}>
        <Icon name="plus" size={15} />
        New API key
      </button>
    );
  } else if (ready && tab === 'webhooks' && can('webhooks', 'create')) {
    actions = (
      <button type="button" className="btn btn-primary" onClick={() => openWebhookForm()}>
        <Icon name="plus" size={15} />
        New webhook
      </button>
    );
  }

  let body;
  if (current.status === 'loading') {
    body = <PageLoader />;
  } else if (current.status === 'error') {
    body = (
      <div className="card">
        <EmptyState iconName="alert" title="Could not load" message={current.error?.message} />
      </div>
    );
  } else if (tab === 'keys') {
    body = <KeysTab keys={current.data.keys} can={can} confirm={confirm} onCreate={createKey} reload={reload} />;
  } else if (tab === 'webhooks') {
    body = (
      <WebhooksTab
        hooks={current.data.hooks}
        can={can}
        confirm={confirm}
        reload={reload}
        onCreate={() => openWebhookForm()}
        onEdit={(hook) => openWebhookForm(hook)}
        onDeliveries={(hook) => setOverlay({ type: 'deliveries', hook })}
      />
    );
  } else {
    body = <DocsTab />;
  }

  return (
    <div>
      <PageHead
        title="Developers"
        subtitle="Push leads in over the API, and get notified when things change."
        actions={actions}
      />
      <div className="mb-16">
        <Tabs
          items={TABS}
          active={tab}
          onSelect={(key) => {
            setQuery({ tab: key });
            reload();
          }}
        />
      </div>
      {body}

      {overlay?.type === 'createKey' ? (
        <CreateKeyModal
          onClose={closeOverlay}
          onCreated={(key) => {
            setOverlay({ type: 'keyOnce', key });
            reload();
          }}
        />
      ) : null}
      {overlay?.type === 'keyOnce' ? <KeyOnceModal apiKey={overlay.key} onClose={closeOverlay} /> : null}
      {overlay?.type === 'webhook' ? (
        <WebhookForm webhook={overlay.webhook} events={overlay.events} onClose={closeOverlay} onSaved={reload} />
      ) : null}
      {overlay?.type === 'deliveries' ? <DeliveriesDrawer hook={overlay.hook} onClose={closeOverlay} /> : null}
    </div>
  );
}

// ===========================================================================
// API keys
// ===========================================================================

function KeysTab({ keys, can, confirm, onCreate, reload }) {
  if (!keys.length) {
    return (
      <div className="card">
        <EmptyState
          iconName="key"
          title="No API keys"
          message="Create a key so your website, landing pages or ad platform can post leads straight into the CRM."
          action={
            can('apikeys', 'create') ? (
              <button type="button" className="btn btn-primary" onClick={onCreate}>
                Create a key
              </button>
            ) : null
          }
        />
      </div>
    );
  }

  const revoke = async (key) => {
    const yes = await confirm({
      title: 'Revoke this key?',
      message: `${key.name} stops working immediately. Anything using it will start failing.`,
      danger: true,
      confirmLabel: 'Revoke',
      requireText: 'REVOKE',
    });
    if (!yes) return;
    try {
      await api.post(`/api/api-keys/${key.id}/revoke`);
      toast.success('Key revoked');
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <>
      <div className="alert info mb-16">
        <Icon name="shield" size={16} />
        <div>
          <strong>Keys are stored hashed</strong>
          The full key is shown once, at creation. If it is lost, revoke it and issue a new one.
        </div>
      </div>
      <Panel title="API keys" flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Scopes</th>
                <th className="right">Calls</th>
                <th>Last used</th>
                <th>Status</th>
                <th style={{ width: '48px' }} />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td className="cell-main">{key.name}</td>
                  <td className="mono small">{`${key.prefix}••••••••`}</td>
                  <td>
                    <div className="row wrap" style={{ gap: '4px' }}>
                      {key.scopes.map((s) => (
                        <span key={s} className="badge">
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="right">{number(key.useCount)}</td>
                  <td className="small muted">{key.lastUsedAt ? relative(key.lastUsedAt) : 'Never'}</td>
                  <td>
                    <span className={`badge ${KEY_STATUS_BADGE[key.status]}`}>{titleCase(key.status)}</span>
                  </td>
                  <td>
                    {can('apikeys', 'delete') && key.status === 'ACTIVE' ? (
                      <Dropdown
                        trigger={
                          <button type="button" className="icon-btn" aria-label="Key actions">
                            <Icon name="more" size={16} />
                          </button>
                        }
                      >
                        <MenuItem iconName="close" danger onClick={() => revoke(key)}>
                          Revoke
                        </MenuItem>
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

function CreateKeyModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [checked, setChecked] = useState({ 'leads:create': true, 'leads:read': false });
  const nameRef = useRef(null);

  const create = async () => {
    // Listed in display order, as the original read the checked boxes off the DOM.
    const scopes = KEY_SCOPES.filter(([value]) => checked[value]).map(([value]) => value);
    if (!name.trim()) {
      nameRef.current?.focus();
      return;
    }
    if (!scopes.length) {
      toast.warn('Pick at least one scope');
      return;
    }
    try {
      const res = await api.post('/api/api-keys', { name: name.trim(), scopes });
      onClose();
      onCreated(res.data);
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <Modal
      title="New API key"
      subtitle="Give it only the scopes it needs."
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <BusyButton className="btn btn-primary" onClick={create}>
            Create key
          </BusyButton>
        </div>
      }
    >
      <div>
        <Field label="Key name" required hint="Where will this key be used?">
          <Input ref={nameRef} placeholder="Website lead capture" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Scopes">
          <div className="col" style={{ gap: '6px' }}>
            {KEY_SCOPES.map(([value, label]) => (
              <label key={value} className="checkbox">
                <input
                  type="checkbox"
                  value={value}
                  checked={Boolean(checked[value])}
                  onChange={(e) => setChecked((prev) => ({ ...prev, [value]: e.target.checked }))}
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

function KeyOnceModal({ apiKey, onClose }) {
  const curl =
    `curl -X POST ${window.location.origin}/api/v1/leads \\\n` +
    `  -H "X-API-Key: ${apiKey.key}" \\\n` +
    '  -H "Content-Type: application/json" \\\n' +
    "  -d '{\n" +
    '    "firstName": "Aarav",\n' +
    '    "lastName": "Sharma",\n' +
    '    "email": "aarav@example.com",\n' +
    '    "phone": "9876543210",\n' +
    '    "company": "Northwind Traders",\n' +
    '    "utm_source": "google",\n' +
    '    "utm_campaign": "q4_search"\n' +
    "  }'";

  return (
    <Modal
      title="Copy your API key now"
      subtitle="This is the only time it will be shown."
      size="wide"
      // The key is gone for good once this closes, so a stray click outside must not dismiss it.
      closeOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            I have copied it
          </button>
          <button type="button" className="btn btn-primary" onClick={() => copyToClipboard(apiKey.key, 'API key copied')}>
            <Icon name="copy" size={15} />
            Copy key
          </button>
        </div>
      }
    >
      <div>
        <div className="alert warning mb-16">
          <Icon name="alert" size={16} />
          <div>{apiKey.warning}</div>
        </div>
        <div className="code-block mb-16" style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
          {apiKey.key}
        </div>
        <h4 className="mb-8">Try it</h4>
        <pre className="code-block">{curl}</pre>
      </div>
    </Modal>
  );
}

// ===========================================================================
// Webhooks
// ===========================================================================

function WebhooksTab({ hooks, can, confirm, reload, onCreate, onEdit, onDeliveries }) {
  if (!hooks.length) {
    return (
      <div className="card">
        <EmptyState
          iconName="webhook"
          title="No webhooks"
          message="Get an HTTPS call whenever a lead is created, assigned, converted, or a deal is won."
          action={
            can('webhooks', 'create') ? (
              <button type="button" className="btn btn-primary" onClick={onCreate}>
                Add a webhook
              </button>
            ) : null
          }
        />
      </div>
    );
  }

  const sendTest = async (hook) => {
    toast('Sending test event…');
    try {
      const res = await api.post(`/api/webhooks/${hook.id}/test`);
      if (res.data.ok) toast.success(`Endpoint replied ${res.data.statusCode}`);
      else toast.error('Delivery failed', res.data.error);
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  const rotateSecret = async (hook) => {
    const yes = await confirm({
      title: 'Rotate the signing secret?',
      message: 'The old secret stops working immediately. Update your receiver first.',
      danger: true,
      confirmLabel: 'Rotate',
    });
    if (!yes) return;
    try {
      const res = await api.post(`/api/webhooks/${hook.id}/rotate-secret`);
      copyToClipboard(res.data.secret, 'New secret copied to clipboard');
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  const remove = async (hook) => {
    const yes = await confirm({ title: 'Delete this webhook?', message: hook.name, danger: true, confirmLabel: 'Delete' });
    if (!yes) return;
    try {
      await api.del(`/api/webhooks/${hook.id}`);
      toast.success('Deleted');
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <>
      <div className="alert info mb-16">
        <Icon name="shield" size={16} />
        <div>
          <strong>Every payload is signed</strong>
          We send an X-Growvanta-Signature header: sha256=HMAC(secret, rawBody). Verify it before trusting the call.
        </div>
      </div>
      <div className="col" style={{ gap: '10px' }}>
        {hooks.map((hook) => (
          <section key={hook.id} className="card">
            <div className="card-head">
              <div style={{ minWidth: 0 }}>
                <h3 className="row" style={{ gap: '8px' }}>
                  {hook.name}
                  {hook.isActive ? <span className="badge badge-success">Active</span> : <span className="badge">Paused</span>}
                  {hook.failureCount > 0 ? <span className="badge badge-danger">{`${hook.failureCount} failures`}</span> : null}
                </h3>
                <div className="sub mono truncate">{hook.url}</div>
              </div>
              {can('webhooks', 'update') ? (
                <Dropdown
                  trigger={
                    <button type="button" className="icon-btn" aria-label="Webhook actions">
                      <Icon name="more" size={16} />
                    </button>
                  }
                >
                  <MenuItem iconName="play" onClick={() => sendTest(hook)}>
                    Send a test event
                  </MenuItem>
                  <MenuItem iconName="list" onClick={() => onDeliveries(hook)}>
                    Delivery log
                  </MenuItem>
                  <MenuItem iconName="edit" onClick={() => onEdit(hook)}>
                    Edit
                  </MenuItem>
                  <MenuItem iconName="refresh" onClick={() => rotateSecret(hook)}>
                    Rotate secret
                  </MenuItem>
                  {can('webhooks', 'delete') ? (
                    <MenuItem iconName="trash" danger onClick={() => remove(hook)}>
                      Delete
                    </MenuItem>
                  ) : null}
                </Dropdown>
              ) : null}
            </div>
            <div className="card-body">
              <div className="row wrap mb-16" style={{ gap: '5px' }}>
                {hook.events.map((e) => (
                  <span key={e} className="badge badge-brand">
                    {e}
                  </span>
                ))}
              </div>
              <div className="row wrap" style={{ gap: '18px' }}>
                <div>
                  <div className="tiny muted">Signing secret</div>
                  <div className="row" style={{ gap: '6px' }}>
                    <span className="mono small">{`${hook.secret.slice(0, 14)}••••`}</span>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Copy secret"
                      onClick={() => copyToClipboard(hook.secret, 'Signing secret copied')}
                    >
                      <Icon name="copy" size={14} />
                    </button>
                  </div>
                </div>
                <div>
                  <div className="tiny muted">Last delivery</div>
                  <div className="small">
                    {hook.lastFiredAt ? `${relative(hook.lastFiredAt)} · HTTP ${hook.lastStatus ?? '—'}` : 'Never'}
                  </div>
                </div>
                <div>
                  <div className="tiny muted">Deliveries</div>
                  <div className="small">{number(hook.deliveryCount)}</div>
                </div>
              </div>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function DeliveriesDrawer({ hook, onClose }) {
  const [state, setState] = useState({ status: 'loading', rows: [], error: null });

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .data(`/api/webhooks/${hook.id}/deliveries`, undefined, { signal: ctrl.signal })
      .then((rows) => setState({ status: 'ready', rows, error: null }))
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setState({ status: 'error', rows: [], error: err });
      });
    return () => ctrl.abort();
  }, [hook.id]);

  let content;
  if (state.status === 'loading') {
    content = <PageLoader />;
  } else if (state.status === 'error') {
    content = <EmptyState iconName="alert" title="Could not load deliveries" message={state.error?.message} />;
  } else if (!state.rows.length) {
    content = <EmptyState iconName="webhook" title="No deliveries yet" />;
  } else {
    content = (
      <div className="col" style={{ gap: '8px' }}>
        {state.rows.map((d) => (
          <div key={d.id} style={{ padding: '11px', border: '1px solid var(--line)', borderRadius: '10px' }}>
            <div className="row-between mb-8">
              <div className="row" style={{ gap: '8px' }}>
                <span className="badge badge-brand">{d.event}</span>
                <span className={`badge ${d.statusCode >= 200 && d.statusCode < 300 ? 'badge-success' : 'badge-danger'}`}>
                  {d.statusCode ? `HTTP ${d.statusCode}` : 'Failed'}
                </span>
                {d.attempt > 1 ? <span className="badge">{`attempt ${d.attempt}`}</span> : null}
              </div>
              <span className="tiny muted">{`${dateTime(d.createdAt)}${d.durationMs ? ` · ${d.durationMs}ms` : ''}`}</span>
            </div>
            {d.error ? <div className="small text-danger">{d.error}</div> : null}
            {d.response ? <div className="mono tiny muted truncate">{d.response}</div> : null}
          </div>
        ))}
      </div>
    );
  }

  return (
    <Drawer title={`${hook.name} deliveries`} subtitle={hook.url} wide onClose={onClose}>
      <div>{content}</div>
    </Drawer>
  );
}

function WebhookForm({ webhook = null, events, onClose, onSaved }) {
  const isEdit = Boolean(webhook?.id);
  const [name, setName] = useState(webhook?.name || '');
  const [url, setUrl] = useState(webhook?.url || '');
  const [selected, setSelected] = useState(() => new Set(events.filter((e) => webhook?.events?.includes(e))));

  const toggle = (event, on) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(event);
      else next.delete(event);
      return next;
    });

  const save = async () => {
    // In list order, as the original read the checked boxes off the DOM.
    const chosen = events.filter((e) => selected.has(e));
    if (!name.trim() || !url.trim()) {
      toast.warn('Name and URL are required');
      return;
    }
    if (!chosen.length) {
      toast.warn('Select at least one event');
      return;
    }
    try {
      const payload = { name: name.trim(), url: url.trim(), events: chosen };
      if (isEdit) await api.patch(`/api/webhooks/${webhook.id}`, payload);
      else await api.post('/api/webhooks', payload);
      toast.success(isEdit ? 'Webhook saved' : 'Webhook created');
      onClose();
      onSaved?.();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <Modal
      title={isEdit ? 'Edit webhook' : 'New webhook'}
      subtitle="We POST a signed JSON body to your URL when the selected events happen."
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <BusyButton className="btn btn-primary" onClick={save}>
            {isEdit ? 'Save' : 'Create'}
          </BusyButton>
        </div>
      }
    >
      <div>
        <Field label="Name" required>
          <Input value={name} placeholder="Zapier - new leads" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Endpoint URL" required hint="Must be https in production, and cannot point at a private address.">
          <Input
            type="url"
            value={url}
            placeholder="https://hooks.example.com/growvanta"
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label="Events" required>
          <div
            style={{
              maxHeight: '240px',
              overflowY: 'auto',
              border: '1px solid var(--line)',
              borderRadius: '8px',
              padding: '8px',
            }}
          >
            {events.map((e) => (
              <label key={e} className="checkbox" style={{ display: 'flex', padding: '3px 0' }}>
                <input type="checkbox" value={e} checked={selected.has(e)} onChange={(ev) => toggle(e, ev.target.checked)} />
                <span className="mono small">{e}</span>
              </label>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

// ===========================================================================
// API reference
// ===========================================================================

const SESSION_API = [
  ['Auth', '/api/auth/login · logout · me · forgot-password · reset-password · 2fa'],
  ['Leads', '/api/leads · /board · /export · /:id · /:id/convert · /bulk/*'],
  ['Projects', '/api/projects · /options · /:id · /:id/images'],
  ['Reports', '/api/reports/dashboard · leads · sales · marketing · performance'],
  ['Admin', '/api/users · /api/roles · /api/teams · /api/settings · /api/automation'],
  ['Audit', '/api/audit-logs · /export'],
];

function DocsTab() {
  const base = window.location.origin;
  return (
    <div className="col" style={{ gap: '14px' }}>
      <Panel title="Lead ingestion API">
        <div>
          <p className="muted mb-16">
            Authenticate with an API key in the X-API-Key header. Field names accept camelCase or snake_case, so most
            webhook senders work without a translation layer.
          </p>
          <DocBlock
            title="POST /api/v1/leads"
            code={`curl -X POST ${base}/api/v1/leads \\
  -H "X-API-Key: gv_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "first_name": "Aarav",
    "last_name": "Sharma",
    "email": "aarav@northwind.example",
    "phone": "+91 98765 43210",
    "company": "Northwind Traders",
    "city": "Gurugram",
    "state": "Haryana",
    "lead_source": "google_ads",
    "campaign": "GADS_CRM_Q3",
    "utm_source": "google",
    "utm_campaign": "q3_search",
    "message": "Looking for a CRM for 40 reps"
  }'`}
          />
          <p className="small muted mt-8">
            Add ?duplicates=reject to have the API return 409 instead of creating a possible duplicate. The default is to
            create it and return a duplicateWarnings array.
          </p>

          <DocBlock
            title="POST /api/v1/leads/batch"
            code={`{
  "leads": [
    { "name": "Priya Nair", "phone": "9876500001", "company": "Zenith Healthcare" },
    { "name": "Rahul Verma", "email": "rahul@example.com" }
  ]
}`}
          />
          <DocBlock
            title="GET /api/v1/leads?since=2026-01-01"
            code={`curl "${base}/api/v1/leads?since=2026-01-01&limit=50" \\
  -H "X-API-Key: gv_your_key_here"`}
          />
          <DocBlock
            title="GET /api/v1/metadata"
            code={`curl ${base}/api/v1/metadata -H "X-API-Key: gv_your_key_here"
# Returns the source keys, status keys and campaign codes you can send.`}
          />
        </div>
      </Panel>

      <Panel title="Response shape">
        <div>
          <p className="muted mb-16">Every endpoint returns the same envelope.</p>
          <DocBlock
            title="Success"
            code={`{
  "data": { "id": "clx...", "code": "LD-1042", "status": "New", "owner": "Rohan Gupta", "score": 45 },
  "meta": { "page": 1, "limit": 25, "total": 190, "totalPages": 8 }
}`}
          />
          <DocBlock
            title="Error"
            code={`{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [{ "field": "email", "message": "Enter a valid email" }]
  }
}`}
          />
        </div>
      </Panel>

      <Panel title="Webhook verification">
        <div>
          <p className="muted mb-16">
            Compute the HMAC over the raw request body and compare it in constant time. Reject anything that does not
            match.
          </p>
          <DocBlock
            title="Node.js"
            code={`const crypto = require('crypto');

app.post('/growvanta', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.get('x-growvanta-signature');       // "sha256=<hex>"
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.GROWVANTA_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.sendStatus(401);
  }

  const { event, data } = JSON.parse(req.body);
  // handle lead.created, lead.assigned, lead.converted, ...
  res.sendStatus(200);
});`}
          />
        </div>
      </Panel>

      <Panel title="Session API">
        <div>
          <p className="muted mb-16">
            The CRM UI uses the same REST API under /api. It authenticates with an httpOnly session cookie plus an
            X-CSRF-Token header, so it cannot be driven with an API key — use /api/v1 for machine access.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Endpoints</th>
                </tr>
              </thead>
              <tbody>
                {SESSION_API.map(([resource, endpoints]) => (
                  <tr key={resource}>
                    <td className="cell-main">{resource}</td>
                    <td className="mono small">{endpoints}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function DocBlock({ title, code }) {
  return (
    <div className="mb-16">
      <div className="row-between mb-8">
        <span className="strong small mono">{title}</span>
        <button type="button" className="btn btn-sm" onClick={() => copyToClipboard(code, 'Copied')}>
          <Icon name="copy" size={13} />
        </button>
      </div>
      <pre className="code-block">{code}</pre>
    </div>
  );
}
