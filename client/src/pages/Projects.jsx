/**
 * Project master. Port of the PHP edition's `views/projects.js`.
 *
 * A broker's list mixes two very different things: stock they created and
 * stock a developer or the platform shared with them. The "Ownership" filter
 * and the "Shared" badge exist so that distinction is never ambiguous - you
 * can sell a shared project but you cannot edit it, and the UI has to make
 * that obvious before the user clicks Edit and gets a 403.
 *
 * Besides the page this module owns the project form (the topbar Create menu
 * and ProjectDetail both open it) and the small helpers ProjectDetail shares.
 */
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import { money, number, titleCase } from '../lib/format.js';
import { useQueryParams } from '../lib/query.js';
import { useAuth } from '../context/AuthContext.jsx';
import Icon from '../components/Icon.jsx';
import { NoAccess, PageHead } from '../components/shared.jsx';
import {
  Alert,
  DataTable,
  Drawer,
  Field,
  Input,
  SearchBox,
  Select,
  Textarea,
  confirmDialog,
  openOverlay,
  reportError,
  toast,
} from '../components/ui/index.js';

export const PROJECT_TYPES = ['RESIDENTIAL', 'COMMERCIAL', 'MIXED_USE', 'PLOTTED', 'VILLA'];
export const PROJECT_STATUSES = [
  'PRE_LAUNCH', 'NEW_LAUNCH', 'ONGOING', 'READY_TO_MOVE', 'COMPLETED', 'SOLD_OUT', 'ON_HOLD',
];

const STATUS_TONE = {
  PRE_LAUNCH: 'badge-info',
  NEW_LAUNCH: 'badge-brand',
  ONGOING: 'badge-success',
  READY_TO_MOVE: 'badge-success',
  COMPLETED: '',
  SOLD_OUT: 'badge-warning',
  ON_HOLD: 'badge-danger',
};

/** "₹75L – ₹1.5Cr", a single bound, or "—". Used by the list and the detail facts. */
export const priceRange = (row) => {
  if (!row.priceMin && !row.priceMax) return '—';
  if (row.priceMin && row.priceMax) {
    return `${money(row.priceMin, { compact: true })} – ${money(row.priceMax, { compact: true })}`;
  }
  return money(row.priceMin || row.priceMax, { compact: true });
};

export default function Projects() {
  const { can } = useAuth();
  if (!can('projects', 'read')) return <NoAccess what="projects" />;
  return <ProjectsPage />;
}

function ProjectsPage() {
  const { can, onPlatform, organization } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useQueryParams();
  const tableRef = useRef(null);

  // A platform admin outside any client sees projects from every company.
  const platformView = onPlatform();

  const filters = {
    q: query.q || '',
    projectType: query.projectType || '',
    status: query.status || '',
    ownership: query.ownership || '',
  };

  const openForm = () =>
    openOverlay((close) => <ProjectForm onClose={close} onSaved={() => tableRef.current?.refresh()} />);

  const actions = [
    can('projects', 'export') ? (
      <button
        key="export"
        type="button"
        className="btn"
        onClick={() =>
          api
            .download('/api/projects/export')
            .then(() => toast.success('Export downloaded'))
            .catch(reportError)
        }
      >
        <Icon name="download" size={15} />
        Export
      </button>
    ) : null,
    can('projects', 'create') ? (
      <button key="create" type="button" className="btn btn-primary" onClick={openForm}>
        <Icon name="plus" size={15} />
        New project
      </button>
    ) : null,
  ].filter(Boolean);

  const columns = [
    {
      label: 'Project',
      sortKey: 'name',
      render: (row) => (
        <div className="row" style={{ gap: '10px' }}>
          <ProjectThumb project={row} />
          <div style={{ minWidth: 0 }}>
            <div className="cell-main truncate">{row.name}</div>
            <div className="cell-sub truncate">{`${row.code} · ${row.developerName}`}</div>
          </div>
        </div>
      ),
    },
    {
      label: 'Location',
      sortKey: 'location',
      render: (row) => (
        <div>
          <div className="truncate">{row.location}</div>
          {row.city ? <div className="cell-sub">{row.city}</div> : null}
        </div>
      ),
    },
    {
      label: 'Type',
      cellClass: 'hide-sm',
      render: (row) => <span className="badge">{titleCase(row.projectType)}</span>,
    },
    {
      label: 'Status',
      render: (row) => <span className={`badge ${STATUS_TONE[row.status] || ''}`}>{titleCase(row.status)}</span>,
    },
    {
      label: 'Price range',
      cellClass: 'right hide-sm',
      sortKey: 'priceMin',
      render: (row) => priceRange(row),
    },
    {
      label: 'Leads',
      cellClass: 'right',
      // Always this tenant's own count, even on a shared project.
      render: (row) => number(row.leadCount),
    },
    {
      // A platform admin sees projects from every company, so "Shared" would
      // be meaningless - they need to know whose listing they are looking at.
      label: platformView ? 'Owned by' : 'Source',
      render: (row) => {
        if (platformView) return <span className="small">{row.ownerOrgName || '—'}</span>;
        return row.isOwner ? (
          <span className="badge badge-brand">Ours</span>
        ) : (
          <span className="badge badge-info" title={`Shared by ${row.ownerOrgName}`}>
            Shared
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <PageHead
        title="Projects"
        subtitle={
          platformView
            ? 'Every project on the platform, whichever company owns it. You can correct any of them.'
            : organization?.usesGlobalProjects
              ? 'Your own inventory plus every project shared with your company.'
              : 'Every project your company is selling.'
        }
        actions={actions}
      />
      <DataTable
        ref={tableRef}
        toolbar={
          <div className="row wrap grow" style={{ gap: '10px' }}>
            <SearchBox
              placeholder="Search by name, location or developer…"
              value={filters.q}
              onSearch={(q) => setQuery({ q })}
            />
            <Select
              options={[
                { value: '', label: 'All projects' },
                { value: 'own', label: 'Created by us' },
                { value: 'shared', label: 'Shared with us' },
              ]}
              value={filters.ownership}
              onChange={(e) => setQuery({ ownership: e.target.value })}
            />
            <Select
              options={[
                { value: '', label: 'All types' },
                ...PROJECT_TYPES.map((t) => ({ value: t, label: titleCase(t) })),
              ]}
              value={filters.projectType}
              onChange={(e) => setQuery({ projectType: e.target.value })}
            />
            <Select
              options={[
                { value: '', label: 'All statuses' },
                ...PROJECT_STATUSES.map((s) => ({ value: s, label: titleCase(s) })),
              ]}
              value={filters.status}
              onChange={(e) => setQuery({ status: e.target.value })}
            />
          </div>
        }
        params={filters}
        defaultSort="name"
        defaultDir="asc"
        onRowClick={(row) => navigate(`/projects/${row.id}`)}
        load={(params) => api.get('/api/projects', params)}
        emptyTitle="No projects yet"
        emptyMessage="Add the projects your team is selling so every lead can be attributed to one."
        emptyAction={
          can('projects', 'create') ? (
            <button type="button" className="btn btn-primary" onClick={openForm}>
              Add a project
            </button>
          ) : null
        }
        columns={columns}
      />
    </div>
  );
}

/** Cover image, or a building glyph on a tinted square. Vanilla `projectThumb(row, size)`. */
export function ProjectThumb({ project, size = 34 }) {
  const style = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '7px',
    objectFit: 'cover',
    flexShrink: 0,
    background: 'var(--bg-2)',
  };
  if (project.coverImageUrl) {
    return <img src={project.coverImageUrl} alt="" style={style} loading="lazy" />;
  }
  return (
    <div className="center" style={{ ...style, display: 'flex', color: 'var(--ink-3)' }}>
      <Icon name="building" size={Math.round(size * 0.5)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------
const listOf = (value) =>
  String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const numOrNull = (value) => (value === '' ? null : Number(value));
// Every form value is held as the string its <input> shows.
const str = (value) => (value === null || value === undefined ? '' : String(value));

/**
 * Create / edit drawer. Contract (docs/CLIENT-UI.md §17):
 * `{ project = null, onSaved(savedProject), onClose() }`.
 */
export function ProjectForm({ project = null, onSaved, onClose }) {
  const { user, organization } = useAuth();
  const isEdit = Boolean(project);

  // Publishing to every client is a platform-owner decision, so the control
  // only appears for one.
  const canPublish = Boolean(user?.isPlatformAdmin);

  const [form, setForm] = useState(() => ({
    name: str(project?.name),
    location: str(project?.location),
    developerName: project?.developerName || organization?.name || '',
    projectType: project?.projectType || 'RESIDENTIAL',
    status: project?.status || 'ONGOING',
    city: str(project?.city),
    state: str(project?.state),
    pincode: str(project?.pincode),
    address: str(project?.address),
    reraNumber: str(project?.reraNumber),
    possessionDate: str(project?.possessionDate),
    priceMin: str(project?.priceMin || ''),
    priceMax: str(project?.priceMax || ''),
    areaMin: str(project?.areaMin || ''),
    areaMax: str(project?.areaMax || ''),
    configurations: (project?.configurations || []).join(', '),
    amenities: (project?.amenities || []).join(', '),
    description: str(project?.description),
    contactName: str(project?.contactName),
    contactPhone: str(project?.contactPhone),
    contactEmail: str(project?.contactEmail),
    visibility: project?.visibility || 'PRIVATE',
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
    const payload = {
      name: form.name.trim(),
      developerName: form.developerName.trim(),
      location: form.location.trim(),
      projectType: form.projectType,
      status: form.status,
      city: form.city.trim() || null,
      state: form.state.trim() || null,
      pincode: form.pincode.trim() || null,
      address: form.address.trim() || null,
      reraNumber: form.reraNumber.trim() || null,
      possessionDate: form.possessionDate || null,
      priceMin: numOrNull(form.priceMin),
      priceMax: numOrNull(form.priceMax),
      areaMin: numOrNull(form.areaMin),
      areaMax: numOrNull(form.areaMax),
      configurations: listOf(form.configurations),
      amenities: listOf(form.amenities),
      description: form.description.trim() || null,
      contactName: form.contactName.trim() || null,
      contactPhone: form.contactPhone.trim() || null,
      contactEmail: form.contactEmail.trim() || null,
    };
    if (canPublish) payload.visibility = form.visibility;

    if (!payload.name || !payload.location || !payload.developerName) {
      setError('Project name, developer and location are all required.');
      return;
    }

    setSaving(true);
    try {
      const res = isEdit
        ? await api.patch(`/api/projects/${project.id}`, payload)
        : await api.post('/api/projects', payload);
      toast.success(isEdit ? 'Project updated' : 'Project created');
      onClose?.();
      onSaved?.(res.data);
    } catch (err) {
      setSaving(false);
      setError(err.message);
      reportError(err);
    }
  }

  return (
    <Drawer
      title={isEdit ? 'Edit project' : 'New project'}
      subtitle={isEdit ? project.code : 'Leads, reports and targets all hang off the project.'}
      wide
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: '8px' }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
            {isEdit ? 'Save changes' : 'Create project'}
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
          <Field label="Project name" required>
            <Input placeholder="ABC Residency" {...bind('name')} />
          </Field>
          <Field label="Developer / brand" required>
            <Input placeholder="Developer or brand name" {...bind('developerName')} />
          </Field>
          <Field label="Location" required hint="The locality buyers would search for.">
            <Input placeholder="Sector 84, Gurugram" {...bind('location')} />
          </Field>
          <Field label="Type" required>
            <Select options={PROJECT_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} {...bind('projectType')} />
          </Field>
          <Field label="Status">
            <Select options={PROJECT_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} {...bind('status')} />
          </Field>
          <Field label="RERA number">
            <Input placeholder="HRERA-GGM-123-2024" {...bind('reraNumber')} />
          </Field>
          <Field label="City">
            <Input placeholder="Gurugram" {...bind('city')} />
          </Field>
          <Field label="State">
            <Input placeholder="Haryana" {...bind('state')} />
          </Field>
          <Field label="Pincode">
            <Input placeholder="122004" {...bind('pincode')} />
          </Field>
          <Field label="Possession date">
            <Input type="date" {...bind('possessionDate')} />
          </Field>
        </div>
        <Field label="Address">
          <Textarea rows={2} {...bind('address')} />
        </Field>
        <div className="form-grid">
          <Field label="Price from">
            <Input type="number" min="0" placeholder="7500000" {...bind('priceMin')} />
          </Field>
          <Field label="Price to">
            <Input type="number" min="0" placeholder="15000000" {...bind('priceMax')} />
          </Field>
          <Field label="Area from (sq ft)">
            <Input type="number" min="0" placeholder="1200" {...bind('areaMin')} />
          </Field>
          <Field label="Area to (sq ft)">
            <Input type="number" min="0" placeholder="2400" {...bind('areaMax')} />
          </Field>
        </div>
        <Field label="Configurations" hint="Comma separated. These become filters on the lead form.">
          <Input placeholder="2 BHK, 3 BHK, 4 BHK" {...bind('configurations')} />
        </Field>
        <Field label="Amenities" hint="Comma separated.">
          <Input placeholder="Clubhouse, Swimming pool, Gym" {...bind('amenities')} />
        </Field>
        <Field label="Description">
          <Textarea rows={3} {...bind('description')} />
        </Field>
        <div className="form-grid">
          <Field label="Site contact name">
            <Input {...bind('contactName')} />
          </Field>
          <Field label="Site contact phone">
            <Input {...bind('contactPhone')} />
          </Field>
          <Field label="Site contact email">
            <Input type="email" {...bind('contactEmail')} />
          </Field>
        </div>
        {canPublish ? (
          <Field label="Visibility" hint="Global publishes this project to every client company on the platform.">
            <Select
              options={[
                { value: 'PRIVATE', label: 'Private - only this company' },
                { value: 'GLOBAL', label: 'Global - every client on the platform' },
              ]}
              {...bind('visibility')}
            />
          </Field>
        ) : null}
      </div>
    </Drawer>
  );
}

/**
 * Delete with the archive rule spelled out: a project that leads point at is
 * archived rather than deleted, so their attribution survives. A plain
 * function (not a hook) so ProjectDetail can call it from a menu item.
 */
export async function confirmArchiveProject(project, onDone) {
  const ok = await confirmDialog({
    title: `Delete ${project.name}?`,
    message: project.leadCount
      ? `${project.leadCount} leads are attached to this project. It will be archived rather than deleted, so their attribution survives.`
      : 'This project has no leads attached and will be permanently deleted.',
    confirmLabel: project.leadCount ? 'Archive project' : 'Delete project',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api.del(`/api/projects/${project.id}`);
    toast.success(res.data?.archived ? 'Project archived' : 'Project deleted');
    onDone?.();
  } catch (err) {
    reportError(err);
  }
}
