/**
 * Super Admin: the client companies on the platform.
 * Port of the PHP edition's `views/clients.js`.
 *
 * Creating a client is deliberately one screen and one button. Everything a
 * working CRM needs - roles, statuses, sources, pipeline, both communication
 * channels, the template library - is provisioned server-side, so onboarding a
 * developer or broker is company details plus one admin contact.
 *
 * Tenant switching (`switchToClient` / `exitClientContext`) lives in
 * lib/tenant.js and the platform-admin check in useAuth()/lib/session.js; they
 * are re-exported here only so code written against the original module
 * layout still resolves.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import { number, titleCase } from '../lib/format.js';
import { useQueryParams } from '../lib/query.js';
import { switchToClient } from '../lib/tenant.js';
import { useAuth } from '../context/AuthContext.jsx';
import Icon from '../components/Icon.jsx';
import { NoAccess, PageHead } from '../components/shared.jsx';
import {
  Alert,
  Avatar,
  DataTable,
  Drawer,
  Dropdown,
  Field,
  Input,
  MenuItem,
  SearchBox,
  Select,
  confirmDialog,
  openOverlay,
  reportError,
  toast,
} from '../components/ui/index.js';

export { switchToClient, exitClientContext } from '../lib/tenant.js';
export { isPlatformAdmin } from '../lib/session.js';

export const COMPANY_TYPES = [
  { value: 'DEVELOPER', label: 'Developer', hint: 'Builds and sells its own projects.' },
  { value: 'BROKER', label: 'Broker', hint: 'Sells other developers projects.' },
  { value: 'CHANNEL_PARTNER', label: 'Channel Partner', hint: 'Authorised partner for selected projects.' },
  { value: 'AGENCY', label: 'Agency', hint: 'Runs campaigns and routes leads.' },
];

const STATUS_TONE = { ACTIVE: 'badge-success', INACTIVE: '', SUSPENDED: 'badge-danger' };

// Mirrors BILLING_STATUSES in server/src/lib/tenancy.js.
export const BILLING_STATUSES = [
  { value: 'ACTIVE', label: 'Active', tone: 'badge-success' },
  { value: 'TRIAL', label: 'Trial', tone: 'badge-info' },
  { value: 'PAST_DUE', label: 'Payment overdue', tone: 'badge-warning' },
  { value: 'CANCELLED', label: 'Cancelled', tone: 'badge-danger' },
];

/** Billing state as a badge, with the sign-in block taking visual priority. Vanilla `billingBadge()`. */
export function BillingBadge({ billing }) {
  if (!billing) return <span className="muted">—</span>;
  if (billing.accessBlocked) {
    return (
      <span className="badge badge-danger" title={billing.accessBlockedReason || 'Sign-in blocked'}>
        Sign-in blocked
      </span>
    );
  }
  const found = BILLING_STATUSES.find((s) => s.value === billing.status);
  return (
    <span className={`badge ${found?.tone || ''}`} title={billing.renewsAt ? `Renews ${billing.renewsAt}` : undefined}>
      {found?.label || billing.status}
    </span>
  );
}

/** The RED/ORANGE/GREEN dot used across the platform screens. Vanilla `channelDot(status, label)`. */
export function ChannelDot({ status, label }) {
  const tone = { GREEN: 'var(--success)', ORANGE: 'var(--warning)', RED: 'var(--danger)' }[status] || 'var(--ink-3)';
  const text = { GREEN: 'Active', ORANGE: 'Incomplete', RED: 'Off' }[status] || 'Unknown';
  return (
    <span className="row" style={{ gap: '6px', alignItems: 'center' }} title={`${label}: ${text}`}>
      <span
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: tone,
          flexShrink: 0,
          display: 'inline-block',
        }}
      />
      <span className="tiny muted">{label}</span>
    </span>
  );
}

export default function Clients() {
  const { isPlatformAdmin } = useAuth();
  if (!isPlatformAdmin()) return <NoAccess what="the platform administration area" />;
  return <ClientsPage />;
}

function ClientsPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useQueryParams();
  const tableRef = useRef(null);

  const filters = { q: query.q || '', companyType: query.companyType || '', status: query.status || '' };
  const refresh = () => tableRef.current?.refresh();
  const openWizard = () => openOverlay((close) => <ClientWizard onClose={close} onSaved={refresh} />);

  const columns = [
    {
      label: 'Company',
      render: (row) => (
        <div className="row" style={{ gap: '10px' }}>
          {row.logoUrl ? (
            <img
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
              src={row.logoUrl}
              alt=""
              style={{ width: '32px', height: '32px', borderRadius: '7px', objectFit: 'contain', background: 'var(--bg-2)' }}
            />
          ) : (
            <Avatar name={row.name} size="sm" />
          )}
          <div style={{ minWidth: 0 }}>
            <div className="cell-main truncate">{row.name}</div>
            <div className="cell-sub truncate">{row.email || row.slug}</div>
          </div>
        </div>
      ),
    },
    { label: 'Type', render: (row) => <span className="badge">{titleCase(row.companyType)}</span> },
    { label: 'Billing', render: (row) => <BillingBadge billing={row.billing} /> },
    {
      label: 'Status',
      render: (row) => <span className={`badge ${STATUS_TONE[row.status] || ''}`}>{titleCase(row.status)}</span>,
    },
    { label: 'Users', cellClass: 'right hide-sm', render: (row) => number(row.stats?.users) },
    { label: 'Projects', cellClass: 'right hide-sm', render: (row) => number(row.stats?.projects) },
    { label: 'Leads', cellClass: 'right', render: (row) => number(row.stats?.leads) },
    {
      label: 'Messaging',
      render: (row) => (
        <div style={{ display: 'grid', gap: '3px' }}>
          <ChannelDot status={row.messaging?.whatsapp?.status} label="WhatsApp" />
          <ChannelDot status={row.messaging?.email?.status} label="Email" />
        </div>
      ),
    },
    {
      label: '',
      width: '48px',
      render: (row) => (
        <Dropdown
          trigger={
            <button type="button" className="icon-btn" aria-label="Actions">
              <Icon name="more" size={16} />
            </button>
          }
        >
          <div>
            <MenuItem iconName="eye" onClick={() => switchToClient(row.id, row.name)}>
              Open their CRM
            </MenuItem>
            <MenuItem iconName="building" onClick={() => navigate(`/clients/${row.id}`)}>
              View details
            </MenuItem>
            {row.status === 'SUSPENDED' ? (
              <MenuItem iconName="play" onClick={() => setStatus(row, 'ACTIVE', refresh)}>
                Reactivate
              </MenuItem>
            ) : (
              <MenuItem iconName="alert" danger onClick={() => setStatus(row, 'SUSPENDED', refresh)}>
                Suspend
              </MenuItem>
            )}
          </div>
        </Dropdown>
      ),
    },
  ];

  return (
    <div>
      <PageHead
        title="Client companies"
        subtitle="Every developer, broker, channel partner and agency on the platform."
        actions={[
          <button key="create" type="button" className="btn btn-primary" onClick={openWizard}>
            <Icon name="plus" size={15} />
            Create new client
          </button>,
        ]}
      />
      <DataTable
        ref={tableRef}
        toolbar={
          <div className="row wrap grow" style={{ gap: '10px' }}>
            <SearchBox placeholder="Search companies…" value={filters.q} onSearch={(q) => setQuery({ q })} />
            <Select
              options={[
                { value: '', label: 'All company types' },
                ...COMPANY_TYPES.map((t) => ({ value: t.value, label: t.label })),
              ]}
              value={filters.companyType}
              onChange={(e) => setQuery({ companyType: e.target.value })}
            />
            <Select
              options={[
                { value: '', label: 'All statuses' },
                { value: 'ACTIVE', label: 'Active' },
                { value: 'INACTIVE', label: 'Inactive' },
                { value: 'SUSPENDED', label: 'Suspended' },
              ]}
              value={filters.status}
              onChange={(e) => setQuery({ status: e.target.value })}
            />
          </div>
        }
        params={filters}
        onRowClick={(row) => navigate(`/clients/${row.id}`)}
        load={(params) => api.get('/api/platform/clients', params)}
        emptyTitle="No client companies yet"
        emptyMessage="Create your first client to give them their own branded CRM workspace."
        emptyAction={
          <button type="button" className="btn btn-primary" onClick={openWizard}>
            Create new client
          </button>
        }
        columns={columns}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
async function setStatus(client, status, onDone) {
  if (status === 'SUSPENDED') {
    const ok = await confirmDialog({
      title: `Suspend ${client.name}?`,
      message:
        'Everyone at this company will be signed out immediately and will not be able to sign in until you reactivate them. Their data is kept.',
      confirmLabel: 'Suspend company',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await api.patch(`/api/platform/clients/${client.id}`, { status });
    toast.success(status === 'ACTIVE' ? 'Company reactivated' : 'Company suspended');
    onDone?.();
  } catch (err) {
    reportError(err);
  }
}

// ---------------------------------------------------------------------------
// Create client
// ---------------------------------------------------------------------------
const EMPTY_CLIENT = {
  companyName: '',
  legalName: '',
  companyType: 'DEVELOPER',
  website: '',
  companyEmail: '',
  companyPhone: '',
  address: '',
  city: '',
  state: '',
  pincode: '',
  adminName: '',
  adminEmail: '',
  adminPhone: '',
  password: '',
};

/**
 * One-screen client onboarding. Contract (docs/CLIENT-UI.md §17):
 * `{ onSaved(client), onClose() }`.
 */
export function ClientWizard({ onSaved, onClose }) {
  const [form, setForm] = useState(EMPTY_CLIENT);
  // Logo is uploaded after creation, because the tenant id is what names the
  // stored file. The preview here is local only.
  const [logoFile, setLogoFile] = useState(null);
  const [logoPreview, setLogoPreview] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Object URLs pin the file in memory until revoked.
  useEffect(
    () => () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview);
    },
    [logoPreview]
  );

  const bind = (key) => ({
    value: form[key],
    onChange: (e) => {
      const { value } = e.target;
      setForm((f) => ({ ...f, [key]: value }));
    },
  });

  const typeHint = COMPANY_TYPES.find((t) => t.value === form.companyType)?.hint || '';

  const onLogo = (e) => {
    const file = e.target.files?.[0] || null;
    setLogoFile(file);
    if (!file) return;
    setLogoPreview(URL.createObjectURL(file));
  };

  async function save() {
    const payload = {
      companyName: form.companyName.trim(),
      legalName: form.legalName.trim() || null,
      companyType: form.companyType,
      website: form.website.trim() || null,
      companyEmail: form.companyEmail.trim() || null,
      companyPhone: form.companyPhone.trim() || null,
      address: form.address.trim() || null,
      city: form.city.trim() || null,
      state: form.state.trim() || null,
      pincode: form.pincode.trim() || null,
      adminName: form.adminName.trim(),
      adminEmail: form.adminEmail.trim(),
      adminPhone: form.adminPhone.trim() || null,
      password: form.password,
    };
    if (!payload.companyName || !payload.adminName || !payload.adminEmail || !payload.password) {
      setError('Company name, admin name, admin email and a password are all required.');
      return;
    }

    setSaving(true);
    try {
      const res = await api.post('/api/platform/clients', payload);
      const client = res.data;

      if (logoFile) {
        const upload = new FormData();
        upload.append('file', logoFile);
        try {
          await api.upload(`/api/platform/clients/${client.id}/logo`, upload);
        } catch (err) {
          // The workspace exists; a failed logo is a detail they can retry.
          toast.error('Company created, but the logo upload failed', err.message);
        }
      }

      toast.success(`${client.name} is ready`, 'Their admin can sign in now.');
      onClose?.();
      onSaved?.(client);
    } catch (err) {
      setSaving(false);
      setError(err.message);
    }
  }

  return (
    <Drawer
      title="Create new client"
      subtitle="A complete, branded CRM workspace is provisioned automatically."
      wide
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: '8px' }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
            {saving ? 'Creating workspace…' : 'Create client'}
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
        <h4 className="mt-8">Company</h4>
        <div className="row" style={{ gap: '14px', alignItems: 'flex-start' }}>
          <div
            className="center"
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '10px',
              background: 'var(--bg-2)',
              display: 'flex',
              color: 'var(--ink-3)',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {logoPreview ? (
              <img src={logoPreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            ) : (
              <Icon name="building" size={26} />
            )}
          </div>
          <div className="grow">
            <Field label="Company logo" hint="PNG, JPG, WEBP or SVG. Appears on their login screen, sidebar and reports.">
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={onLogo} />
            </Field>
          </div>
        </div>
        <div className="form-grid">
          <Field label="Company name" required>
            <Input placeholder="ABC Realty" {...bind('companyName')} />
          </Field>
          <Field label="Legal name">
            <Input placeholder="ABC Realty Private Limited" {...bind('legalName')} />
          </Field>
          <Field label="Company type" required>
            <div>
              <Select options={COMPANY_TYPES.map((t) => ({ value: t.value, label: t.label }))} {...bind('companyType')} />
              <div className="tiny muted">{typeHint}</div>
            </div>
          </Field>
          <Field label="Website">
            <Input placeholder="https://abcrealty.com" {...bind('website')} />
          </Field>
          <Field label="Company email">
            <Input type="email" placeholder="hello@abcrealty.com" {...bind('companyEmail')} />
          </Field>
          <Field label="Company phone">
            <Input placeholder="+91 98765 43210" {...bind('companyPhone')} />
          </Field>
        </div>
        <Field label="Address">
          <Input placeholder="Street address" {...bind('address')} />
        </Field>
        <div className="form-grid">
          <Field label="City">
            <Input placeholder="Gurugram" {...bind('city')} />
          </Field>
          <Field label="State">
            <Input placeholder="Haryana" {...bind('state')} />
          </Field>
          <Field label="Pincode">
            <Input placeholder="122004" {...bind('pincode')} />
          </Field>
        </div>

        <h4 className="mt-16">Administrator</h4>
        <p className="muted small" style={{ marginTop: 0 }}>
          This person gets full control of their company workspace: users, teams, projects and settings.
        </p>
        <div className="form-grid">
          <Field label="Admin name" required>
            <Input placeholder="Anita Rao" {...bind('adminName')} />
          </Field>
          <Field label="Admin email" required hint="This is their login.">
            <Input type="email" placeholder="anita@abcrealty.com" {...bind('adminEmail')} />
          </Field>
          <Field label="Admin phone" required>
            <Input placeholder="+91 98765 43210" {...bind('adminPhone')} />
          </Field>
          <Field label="Password" required hint="Upper and lower case plus a number.">
            <Input type="password" placeholder="At least 8 characters" {...bind('password')} />
          </Field>
        </div>
      </div>
    </Drawer>
  );
}
