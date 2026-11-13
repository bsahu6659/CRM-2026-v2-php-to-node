/**
 * Super Admin: one client company. Port of the PHP edition's
 * `views/clientDetail.js`.
 *
 * Read-only windows into their users, teams, projects and leads, so support
 * questions can be answered without switching context - plus branding, the
 * communication configuration, and the lifecycle controls.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../lib/api.js';
import { date, dateTime, number, titleCase } from '../lib/format.js';
import { useQueryParams } from '../lib/query.js';
import { switchToClient } from '../lib/tenant.js';
import { useAuth } from '../context/AuthContext.jsx';
import Icon from '../components/Icon.jsx';
import { NoAccess, PageHead, Panel } from '../components/shared.jsx';
import {
  Alert,
  Avatar,
  DataTable,
  EmptyState,
  Field,
  Input,
  KpiCard,
  Modal,
  PageLoader,
  Select,
  Tabs,
  Textarea,
  confirmDialog,
  openOverlay,
  reportError,
  toast,
} from '../components/ui/index.js';
import { BILLING_STATUSES, COMPANY_TYPES } from './Clients.jsx';
import { ConfigurationCard } from './Communication.jsx';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'branding', label: 'Branding' },
  { key: 'billing', label: 'Billing & access' },
  { key: 'messaging', label: 'Messaging' },
  { key: 'users', label: 'Users' },
  { key: 'teams', label: 'Teams' },
  { key: 'projects', label: 'Projects' },
  { key: 'leads', label: 'Leads' },
  { key: 'danger', label: 'Lifecycle' },
];

export default function ClientDetail() {
  const { isPlatformAdmin } = useAuth();
  if (!isPlatformAdmin()) return <NoAccess what="the platform administration area" />;
  return <ClientDetailPage />;
}

function ClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [query] = useQueryParams();
  const active = query.tab || 'overview';
  // `version` bumps on every successful load; the record-backed tabs are keyed
  // on it so their forms re-seed from the fresh record, as the original's
  // load() rebuilt the whole page.
  const [state, setState] = useState({ status: 'loading', client: null, error: null, version: 0 });

  const load = useCallback(
    async (signal) => {
      try {
        const client = (await api.get(`/api/platform/clients/${id}`, undefined, { signal })).data;
        setState((s) => ({ status: 'ready', client, error: null, version: s.version + 1 }));
      } catch (err) {
        if (err.name === 'AbortError') return;
        setState((s) => ({ ...s, status: 'error', error: err }));
      }
    },
    [id]
  );

  // The original re-rendered (and re-read the client) on every tab switch,
  // which keeps the header counts and the record-backed tabs current.
  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load, active]);

  const reload = () => load();

  if (state.status === 'loading') {
    return (
      <div>
        <PageLoader label="Loading client" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div>
        <div className="card">
          <EmptyState
            iconName="building"
            title="Client not found"
            message={state.error.message}
            action={
              <Link className="btn btn-primary" to="/clients">
                Back to clients
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const { client, version } = state;

  let panel;
  if (['users', 'teams', 'projects', 'leads'].includes(active)) {
    // The list tabs fetch their own rows, so they are not rebuilt by a reload.
    panel = <ListTab key={active} clientId={client.id} kind={active} />;
  } else {
    const panels = {
      overview: () => <OverviewTab client={client} />,
      branding: () => <BrandingTab client={client} reload={reload} />,
      billing: () => <BillingTab client={client} reload={reload} />,
      messaging: () => <MessagingTab client={client} />,
      danger: () => <LifecycleTab client={client} reload={reload} />,
    };
    panel = <div key={`${active}-${version}`}>{(panels[active] || panels.overview)()}</div>;
  }

  return (
    <div>
      <PageHead
        title={client.name}
        subtitle={`${titleCase(client.companyType)} · ${number(client.stats.users)} users · ${number(client.stats.leads)} leads`}
        breadcrumbs={[{ label: 'Clients', path: '/clients' }, { label: client.name }]}
        actions={[
          <button key="open" type="button" className="btn btn-primary" onClick={() => switchToClient(client.id, client.name)}>
            <Icon name="eye" size={15} />
            Open their CRM
          </button>,
        ]}
      />
      <Tabs items={TABS} active={active} onSelect={(key) => navigate(`/clients/${id}?tab=${key}`)} />
      <div>{panel}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function OverviewTab({ client }) {
  const stats = [
    ['Users', client.stats.users],
    ['Teams', client.stats.teams],
    ['Projects', client.stats.projects],
    ['Leads', client.stats.leads],
    ['Leads today', client.stats.leadsToday],
    ['Leads this month', client.stats.leadsThisMonth],
  ];
  const details = [
    ['Company type', titleCase(client.companyType)],
    ['Uses global projects', client.usesGlobalProjects ? 'Yes' : 'No'],
    ['Status', titleCase(client.status)],
    ['Website', client.website || '—'],
    ['Email', client.email || '—'],
    ['Phone', client.phone || '—'],
    ['City', client.city || '—'],
    ['Currency', client.currency],
    ['Timezone', client.timezone],
    ['Created', dateTime(client.createdAt)],
  ];

  return (
    <div className="detail-layout">
      <div>
        <Panel title="At a glance">
          <div className="kpi-grid">
            {stats.map(([label, value]) => (
              <KpiCard key={label} label={label} value={number(value)} />
            ))}
          </div>
        </Panel>
        <Panel title="Administrators">
          <div>
            {client.admins?.length ? (
              client.admins.map((u) => (
                <div key={u.id} className="row" style={{ gap: '10px', padding: '8px 0' }}>
                  <Avatar name={`${u.firstName} ${u.lastName || ''}`} size="sm" />
                  <div className="grow">
                    <div className="strong">{`${u.firstName} ${u.lastName || ''}`.trim()}</div>
                    <div className="cell-sub">{u.email}</div>
                  </div>
                  <div className="tiny muted">{u.lastLoginAt ? `Last in ${dateTime(u.lastLoginAt)}` : 'Never signed in'}</div>
                </div>
              ))
            ) : (
              <div className="muted small">No administrators found.</div>
            )}
          </div>
        </Panel>
      </div>
      <div>
        <Panel title="Details">
          <div className="info-list">
            {details.map(([label, value]) => (
              <div key={label} className="info-row">
                <span className="muted">{label}</span>
                <span className="strong">{String(value)}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function BrandingTab({ client, reload }) {
  const [form, setForm] = useState(() => ({
    name: client.name || '',
    legalName: client.legalName || '',
    companyType: client.companyType,
    brandPrimary: client.brandPrimary || '#35e06f',
    brandAccent: client.brandAccent || '#0d1b2a',
    loginHeadline: client.loginHeadline || '',
  }));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const bind = (key) => ({
    value: form[key],
    onChange: (e) => {
      const { value } = e.target;
      setForm((f) => ({ ...f, [key]: value }));
    },
  });

  // The logo is uploaded as soon as it is picked; the rest waits for Save.
  const onLogo = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const upload = new FormData();
    upload.append('file', file);
    try {
      await api.upload(`/api/platform/clients/${client.id}/logo`, upload);
      toast.success('Logo updated');
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/platform/clients/${client.id}`, {
        name: form.name.trim(),
        legalName: form.legalName.trim() || null,
        companyType: form.companyType,
        brandPrimary: form.brandPrimary,
        brandAccent: form.brandAccent,
        loginHeadline: form.loginHeadline.trim() || null,
      });
      toast.success('Branding saved');
      reload();
    } catch (err) {
      setSaving(false);
      setError(err.message);
    }
  }

  return (
    <Panel title="Company branding">
      <div>
        {error ? (
          <Alert tone="danger" className="mb-16">
            {error}
          </Alert>
        ) : null}
        <p className="muted small" style={{ marginTop: 0 }}>
          The logo and name appear on this client’s login screen, sidebar, reports and exports.
        </p>
        <div className="row" style={{ gap: '16px', alignItems: 'flex-start' }}>
          <div
            className="center"
            style={{
              width: '80px',
              height: '80px',
              borderRadius: '12px',
              background: 'var(--bg-2)',
              display: 'flex',
              color: 'var(--ink-3)',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {client.logoUrl ? (
              <img
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
                src={client.logoUrl}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <Icon name="building" size={32} />
            )}
          </div>
          <div className="grow">
            <Field label="Logo">
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={onLogo} />
            </Field>
          </div>
        </div>
        <div className="form-grid">
          <Field label="Company name">
            <Input {...bind('name')} />
          </Field>
          <Field label="Legal name">
            <Input {...bind('legalName')} />
          </Field>
          <Field label="Company type">
            <Select options={COMPANY_TYPES.map((t) => ({ value: t.value, label: t.label }))} {...bind('companyType')} />
          </Field>
          <Field label="Primary colour">
            <Input type="color" {...bind('brandPrimary')} />
          </Field>
          <Field label="Accent colour">
            <Input type="color" {...bind('brandAccent')} />
          </Field>
        </div>
        <Field label="Login headline">
          <Input placeholder="Shown on their sign-in screen" {...bind('loginHeadline')} />
        </Field>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
          Save branding
        </button>
      </div>
    </Panel>
  );
}

/**
 * Subscription and sign-in access for one client.
 *
 * The block switch is deliberately its own control rather than a side effect of
 * the billing status: being a day late should not lock out a sales floor, so a
 * human decides when non-payment becomes a lockout. Blocking ends every open
 * session at once, and the reason typed here is what the customer reads on the
 * sign-in screen — so it should name the invoice, not just say "blocked".
 */
function BillingTab({ client, reload }) {
  const b = client.billing || {};
  const [form, setForm] = useState(() => ({
    status: b.status || 'ACTIVE',
    planName: b.planName || '',
    seats: b.seats ?? '',
    monthlyFee: b.monthlyFee ?? '',
    trialEndsAt: b.trialEndsAt || '',
    renewsAt: b.renewsAt || '',
    lastPaymentAt: (b.lastPaymentAt || '').slice(0, 10),
    notes: b.notes || '',
  }));
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
    setSaving(true);
    try {
      await api.patch(`/api/platform/clients/${client.id}`, {
        billingStatus: form.status,
        planName: form.planName.trim() || null,
        seats: form.seats === '' ? null : Number(form.seats),
        monthlyFee: form.monthlyFee === '' ? null : Number(form.monthlyFee),
        trialEndsAt: form.trialEndsAt || null,
        renewsAt: form.renewsAt || null,
        lastPaymentAt: form.lastPaymentAt || null,
        billingNotes: form.notes.trim() || null,
      });
      toast.success('Subscription updated');
      reload();
    } catch (err) {
      setSaving(false);
      setError(err.message);
    }
  }

  const setAccess = async (blocked, reason) => {
    try {
      const res = await api.post(`/api/platform/clients/${client.id}/access`, { blocked, reason });
      const ended = res.data?.sessionsEnded || 0;
      toast.success(
        blocked ? 'Sign-in blocked for this company' : 'Sign-in restored',
        blocked
          ? `${ended} open session${ended === 1 ? '' : 's'} ended. Their people see the reason on the sign-in screen.`
          : 'Their people can sign in again straight away.'
      );
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  const openBlockDialog = () =>
    openOverlay((close) => (
      <BlockAccessDialog client={client} billing={b} onClose={close} onConfirm={(reason) => setAccess(true, reason)} />
    ));

  const renewalLine = b.renewsAt
    ? b.daysUntilRenewal >= 0
      ? `Renews in ${b.daysUntilRenewal} day${b.daysUntilRenewal === 1 ? '' : 's'} (${date(b.renewsAt)})`
      : `Renewal lapsed ${Math.abs(b.daysUntilRenewal)} day${Math.abs(b.daysUntilRenewal) === 1 ? '' : 's'} ago`
    : 'No renewal date set';

  return (
    <div>
      {b.accessBlocked ? (
        <div className="alert danger mb-16">
          <div>
            <strong>Sign-in is blocked for this company. </strong>
            {b.accessBlockedReason || 'No reason recorded.'}
            {b.accessBlockedAt ? <div className="tiny mt-8">{`Blocked ${dateTime(b.accessBlockedAt)}`}</div> : null}
          </div>
        </div>
      ) : null}
      {!b.accessBlocked && b.overdue ? (
        <div className="alert warning mb-16">
          <div>
            <strong>Payment is overdue. </strong>
            {b.renewsAt ? `Renewal date was ${date(b.renewsAt)}. ` : ''}
            They can still sign in — block access below if you want that to stop.
          </div>
        </div>
      ) : null}

      <Panel title="Sign-in access" subtitle="Blocking takes effect immediately and ends open sessions.">
        <div>
          <p className="muted small" style={{ marginTop: 0 }}>
            {b.accessBlocked
              ? 'Nobody at this company can sign in right now.'
              : 'Everyone at this company can sign in normally.'}
          </p>
          <div className="row" style={{ gap: '8px' }}>
            {b.accessBlocked ? (
              <button type="button" className="btn btn-primary" onClick={() => setAccess(false, null)}>
                <Icon name="check" size={15} />
                Restore sign-in
              </button>
            ) : (
              <button type="button" className="btn btn-danger" onClick={openBlockDialog}>
                <Icon name="alert" size={15} />
                Block sign-in for non-payment
              </button>
            )}
          </div>
        </div>
      </Panel>

      <Panel title="Subscription">
        <div>
          {error ? (
            <Alert tone="danger" className="mb-16">
              {error}
            </Alert>
          ) : null}
          <div className="form-grid">
            <Field label="Billing status">
              <Select options={BILLING_STATUSES.map((s) => ({ value: s.value, label: s.label }))} {...bind('status')} />
            </Field>
            <Field label="Plan">
              <Input placeholder="Growth" {...bind('planName')} />
            </Field>
            <Field label="Seats">
              <Input type="number" min="0" {...bind('seats')} />
            </Field>
            <Field label="Monthly fee" hint={client.currency || 'INR'}>
              <Input type="number" min="0" step="100" placeholder="15000" {...bind('monthlyFee')} />
            </Field>
            <Field label="Trial ends">
              <Input type="date" {...bind('trialEndsAt')} />
            </Field>
            <Field label="Renews on" hint={renewalLine}>
              <Input type="date" {...bind('renewsAt')} />
            </Field>
            <Field label="Last payment">
              <Input type="date" {...bind('lastPaymentAt')} />
            </Field>
          </div>
          <Field label="Billing notes">
            <Textarea rows={2} placeholder="PO number, billing contact, anything worth remembering." {...bind('notes')} />
          </Field>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
            Save subscription
          </button>
        </div>
      </Panel>
    </div>
  );
}

/** "Block sign-in" confirmation with the reason the customer will read. */
function BlockAccessDialog({ client, billing, onClose, onConfirm }) {
  const [reason, setReason] = useState(
    billing.accessBlockedReason ||
      `Subscription payment outstanding${billing.planName ? ` on the ${billing.planName} plan` : ''}.`
  );

  return (
    <Modal
      title={`Block sign-in for ${client.name}?`}
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              onClose();
              onConfirm(reason.trim());
            }}
          >
            Block sign-in now
          </button>
        </div>
      }
    >
      <div>
        <div className="alert warning mb-16">
          {'Everyone at this company is signed out immediately and cannot sign back in. ' +
            'Their data is untouched, and you can restore access in one click.'}
        </div>
        <Field
          label="Reason shown on their sign-in screen"
          required
          hint="Name the invoice if you can — it saves a support call."
        >
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function MessagingTab({ client }) {
  return (
    <div>
      <p className="muted small">
        Green means this client could send a message right now. Orange means the switch is on but the setup is unfinished.
      </p>
      <div className="form-grid">
        <ConfigurationCard channel="WhatsApp" verdict={client.messaging?.whatsapp} readOnly />
        <ConfigurationCard channel="Email" verdict={client.messaging?.email} readOnly />
      </div>
      <Link className="btn mt-16" to={`/communication?organizationId=${client.id}`}>
        <Icon name="settings" size={15} />
        {`Configure messaging for ${client.name}`}
      </Link>
    </div>
  );
}

const personName = (r) => `${r.firstName} ${r.lastName || ''}`.trim();

const LIST_CONFIG = {
  users: {
    title: 'Users',
    columns: [
      {
        label: 'Name',
        render: (r) => (
          <div>
            <div className="cell-main">{personName(r)}</div>
            <div className="cell-sub">{r.email}</div>
          </div>
        ),
      },
      { label: 'Role', render: (r) => r.roleName || '—' },
      { label: 'Team', render: (r) => r.teamName || '—' },
      { label: 'Designation', cellClass: 'hide-sm', render: (r) => r.designation || '—' },
      {
        label: 'Status',
        render: (r) => <span className={`badge ${r.isActive ? 'badge-success' : ''}`}>{r.isActive ? 'Active' : 'Inactive'}</span>,
      },
      { label: 'Last seen', cellClass: 'hide-sm', render: (r) => (r.lastLoginAt ? dateTime(r.lastLoginAt) : 'Never') },
    ],
  },
  teams: {
    title: 'Teams',
    columns: [
      { label: 'Team', render: (r) => <div className="cell-main">{r.name}</div> },
      { label: 'Region', render: (r) => r.region || '—' },
      { label: 'Members', cellClass: 'right', render: (r) => number(r.memberCount) },
    ],
  },
  projects: {
    title: 'Projects',
    columns: [
      {
        label: 'Project',
        render: (r) => (
          <div>
            <div className="cell-main">{r.name}</div>
            <div className="cell-sub">{`${r.code} · ${r.developerName}`}</div>
          </div>
        ),
      },
      { label: 'Location', render: (r) => r.location },
      { label: 'Type', render: (r) => titleCase(r.projectType) },
      { label: 'Visibility', render: (r) => <span className="badge">{titleCase(r.visibility)}</span> },
    ],
  },
  leads: {
    title: 'Leads',
    columns: [
      {
        label: 'Lead',
        render: (r) => (
          <div>
            <div className="cell-main">{personName(r)}</div>
            <div className="cell-sub">{r.code}</div>
          </div>
        ),
      },
      { label: 'Phone', render: (r) => r.phone || '—' },
      { label: 'Project', render: (r) => r.projectName || '—' },
      { label: 'Source', cellClass: 'hide-sm', render: (r) => r.sourceName || '—' },
      { label: 'Status', render: (r) => r.statusName || '—' },
      {
        label: 'Owner',
        render: (r) => (r.ownerFirstName ? `${r.ownerFirstName} ${r.ownerLastName || ''}`.trim() : 'Unassigned'),
      },
      { label: 'Created', cellClass: 'hide-sm', render: (r) => date(r.createdAt) },
    ],
  },
};

function ListTab({ clientId, kind }) {
  const cfg = LIST_CONFIG[kind];
  return (
    <Panel title={cfg.title} subtitle="Read-only view." flush>
      <DataTable
        columns={cfg.columns}
        // The users query joins team membership, so someone in two teams comes
        // back twice with the same id; a positional key keeps React's rows apart.
        load={(params) =>
          api.get(`/api/platform/clients/${clientId}/${kind}`, params).then((res) => ({
            ...res,
            data: (res?.data || []).map((r, i) => ({ ...r, rowKey: `${r.id}-${i}` })),
          }))
        }
        rowKey={(r) => r.rowKey}
        emptyTitle={`No ${kind} yet`}
        emptyMessage={`This company has not created any ${kind}.`}
      />
    </Panel>
  );
}

function LifecycleTab({ client, reload }) {
  const navigate = useNavigate();

  const setStatus = async (status) => {
    if (status !== 'ACTIVE') {
      const ok = await confirmDialog({
        title: status === 'SUSPENDED' ? `Suspend ${client.name}?` : `Deactivate ${client.name}?`,
        message:
          'Everyone at this company is signed out immediately and cannot sign in again until you reactivate them. Their data is untouched.',
        confirmLabel: titleCase(status),
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api.patch(`/api/platform/clients/${client.id}`, { status });
      toast.success('Status updated');
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  const deleteClient = async () => {
    const ok = await confirmDialog({
      title: `Permanently delete ${client.name}?`,
      message: `This removes ${number(client.stats.users)} users, ${number(client.stats.projects)} projects and ${number(client.stats.leads)} leads. It cannot be undone.`,
      confirmLabel: 'Delete this company forever',
      danger: true,
      requireText: client.name,
    });
    if (!ok) return;
    try {
      await api.del(`/api/platform/clients/${client.id}`, { body: { confirmName: client.name } });
      toast.success('Company deleted');
      navigate('/clients');
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <div>
      <Panel title="Status">
        <div>
          <p className="muted small" style={{ marginTop: 0 }}>{`This company is currently ${titleCase(client.status)}.`}</p>
          <div className="row" style={{ gap: '8px' }}>
            {client.status !== 'ACTIVE' ? (
              <button type="button" className="btn btn-primary" onClick={() => setStatus('ACTIVE')}>
                Reactivate
              </button>
            ) : null}
            {client.status !== 'SUSPENDED' ? (
              <button type="button" className="btn" onClick={() => setStatus('SUSPENDED')}>
                Suspend
              </button>
            ) : null}
            {client.status !== 'INACTIVE' ? (
              <button type="button" className="btn" onClick={() => setStatus('INACTIVE')}>
                Deactivate
              </button>
            ) : null}
          </div>
        </div>
      </Panel>
      <Panel title="Delete company">
        <div>
          <div className="alert danger mb-16">
            Deleting a company removes every user, team, project, lead, note and report it owns. There is no undo and no
            backup taken.
          </div>
          <button type="button" className="btn btn-danger" onClick={deleteClient}>
            Delete this company
          </button>
        </div>
      </Panel>
    </div>
  );
}
