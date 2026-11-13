/**
 * Project detail: the brochure a salesperson reads out on a call, plus the
 * gallery, plus - for a platform admin - who the project is shared with.
 * Port of the PHP edition's `views/projectDetail.js`.
 *
 * The lead list at the bottom is deliberately scoped to the signed-in company
 * even when the project itself is shared platform-wide.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../lib/api.js';
import { date, dateTime, number, titleCase } from '../lib/format.js';
import { useAuth } from '../context/AuthContext.jsx';
import Icon from '../components/Icon.jsx';
import { NoAccess, OwnerCell, PageHead, Panel, StatusBadge } from '../components/shared.jsx';
import {
  DataTable,
  Dropdown,
  EmptyState,
  MenuItem,
  PageLoader,
  confirmDialog,
  openOverlay,
  reportError,
  toast,
} from '../components/ui/index.js';
import { ProjectForm, confirmArchiveProject, priceRange } from './Projects.jsx';

export default function ProjectDetail() {
  const { can } = useAuth();
  if (!can('projects', 'read')) return <NoAccess what="projects" />;
  return <ProjectDetailPage />;
}

function ProjectDetailPage() {
  const { id } = useParams();
  const { can, user } = useAuth();
  const navigate = useNavigate();
  // `version` bumps on every successful load. The sections are keyed on it so
  // each reload rebuilds them from the fresh record, as the original's
  // load() cleared and repainted the whole page.
  const [state, setState] = useState({ status: 'loading', project: null, error: null, version: 0 });

  const load = useCallback(
    async (signal) => {
      try {
        const project = (await api.get(`/api/projects/${id}`, undefined, { signal })).data;
        setState((s) => ({ status: 'ready', project, error: null, version: s.version + 1 }));
      } catch (err) {
        if (err.name === 'AbortError') return;
        setState((s) => ({ ...s, status: 'error', error: err }));
      }
    },
    [id]
  );

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const reload = () => load();

  if (state.status === 'loading') {
    return (
      <div>
        <PageLoader label="Loading project" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div>
        <div className="card">
          <EmptyState
            iconName="building"
            title="Project not available"
            message={state.error.message}
            action={
              <Link className="btn btn-primary" to="/projects">
                Back to projects
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const { project, version } = state;

  const actions = [
    // A shared project is read-only here; saying so is friendlier than
    // showing an Edit button that 403s.
    !project.isOwner ? (
      <span
        key="owner"
        className={project.canEdit ? 'badge badge-warning' : 'badge badge-info'}
        title={project.canEdit ? 'You are editing another company’s project' : undefined}
      >
        {`${project.canEdit ? 'Owned by' : 'Shared by'} ${project.ownerOrgName}`}
      </span>
    ) : null,
    project.canEdit && can('projects', 'update') ? (
      <button
        key="edit"
        type="button"
        className="btn"
        onClick={() => openOverlay((close) => <ProjectForm project={project} onClose={close} onSaved={reload} />)}
      >
        <Icon name="edit" size={15} />
        Edit
      </button>
    ) : null,
    project.canEdit && can('projects', 'delete') ? (
      <Dropdown
        key="more"
        trigger={
          <button type="button" className="icon-btn" aria-label="More actions">
            <Icon name="more" size={16} />
          </button>
        }
      >
        <div>
          <MenuItem iconName="trash" danger onClick={() => confirmArchiveProject(project, () => navigate('/projects'))}>
            Delete project
          </MenuItem>
        </div>
      </Dropdown>
    ) : null,
  ].filter(Boolean);

  return (
    <div>
      <PageHead
        title={project.name}
        subtitle={`${project.code} · ${project.developerName} · ${project.location}`}
        breadcrumbs={[{ label: 'Projects', path: '/projects' }, { label: project.name }]}
        actions={actions}
      />
      <div className="detail-layout" key={version}>
        <div>
          <GallerySection project={project} reload={reload} />
          <OverviewSection project={project} />
          <LeadsSection project={project} />
        </div>
        <div>
          <FactsSection project={project} />
          {project.contactName || project.contactPhone ? <ContactSection project={project} /> : null}
          {user?.isPlatformAdmin ? <SharingSection project={project} reload={reload} /> : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function GallerySection({ project, reload }) {
  const { can } = useAuth();
  const canManage = project.canEdit && can('projects', 'manage');
  const fileInput = useRef(null);
  const images = project.images || [];

  const setCover = async (img) => {
    try {
      await api.patch(`/api/projects/${project.id}/images/${img.id}`, { isCover: true });
      toast.success('Cover image updated');
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  const removeImage = async (img) => {
    const ok = await confirmDialog({ title: 'Delete this image?', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/projects/${project.id}/images/${img.id}`);
      toast.success('Image deleted');
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  // One request per file, in order; the first failure stops the batch.
  const onFiles = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const file of files) {
      const form = new FormData();
      form.append('file', file);
      try {
        await api.upload(`/api/projects/${project.id}/images`, form);
      } catch (err) {
        reportError(err);
        break;
      }
    }
    if (files.length) {
      toast.success(files.length === 1 ? 'Image uploaded' : `${files.length} images uploaded`);
      reload();
    }
  };

  return (
    <Panel
      title="Gallery"
      subtitle={canManage ? 'JPG, PNG or WEBP.' : undefined}
      action={
        canManage ? (
          <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" size={14} />
            Upload
          </button>
        ) : null
      }
    >
      <div>
        <div className="row wrap" style={{ gap: '10px' }}>
          {!images.length ? <div className="muted small">No images uploaded yet.</div> : null}
          {images.map((img) => (
            <div key={img.id} style={{ position: 'relative', width: '132px' }}>
              <img
                src={img.url}
                alt={img.caption || ''}
                loading="lazy"
                style={{
                  width: '132px',
                  height: '92px',
                  objectFit: 'cover',
                  borderRadius: '8px',
                  border: img.isCover ? '2px solid var(--brand-500)' : '1px solid var(--line)',
                }}
              />
              {img.isCover ? (
                <span className="badge badge-brand" style={{ position: 'absolute', top: '6px', left: '6px' }}>
                  Cover
                </span>
              ) : null}
              {canManage ? (
                <div className="row" style={{ gap: '4px', marginTop: '4px' }}>
                  {!img.isCover ? (
                    <button type="button" className="btn btn-sm" onClick={() => setCover(img)}>
                      Set cover
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => removeImage(img)}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          style={{ display: 'none' }}
          onChange={onFiles}
        />
      </div>
    </Panel>
  );
}

function Chips({ items }) {
  if (!items?.length) return <span className="muted small">—</span>;
  return (
    <div className="row wrap" style={{ gap: '6px' }}>
      {items.map((c, i) => (
        <span key={`${c}-${i}`} className="chip">
          {c}
        </span>
      ))}
    </div>
  );
}

function OverviewSection({ project }) {
  return (
    <Panel title="Overview">
      <div>
        {project.description ? (
          <p style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{project.description}</p>
        ) : (
          <p className="muted small" style={{ marginTop: 0 }}>
            No description added.
          </p>
        )}
        <div className="field">
          <label>Configurations</label>
          <Chips items={project.configurations} />
        </div>
        <div className="field">
          <label>Amenities</label>
          <Chips items={project.amenities} />
        </div>
      </div>
    </Panel>
  );
}

function FactsSection({ project }) {
  const rows = [
    ['Type', titleCase(project.projectType)],
    ['Status', titleCase(project.status)],
    ['Price range', priceRange(project)],
    [
      'Area',
      project.areaMin || project.areaMax
        ? `${number(project.areaMin || 0)} – ${number(project.areaMax || 0)} ${project.areaUnit || 'SQFT'}`
        : '—',
    ],
    ['Possession', project.possessionDate ? date(project.possessionDate) : '—'],
    ['RERA', project.reraNumber || '—'],
    ['City', project.city || '—'],
    ['State', project.state || '—'],
    ['Pincode', project.pincode || '—'],
    ['Address', project.address || '—'],
    ['Our leads', number(project.leadCount)],
    ['Created', dateTime(project.createdAt)],
  ];
  return (
    <Panel title="Details">
      <div className="info-list">
        {rows.map(([label, value]) => (
          <div key={label} className="info-row">
            <span className="muted">{label}</span>
            <span className="strong">{String(value)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ContactSection({ project }) {
  return (
    <Panel title="Site contact">
      <div className="info-list">
        {project.contactName ? (
          <div className="info-row">
            <span className="muted">Name</span>
            <span>{project.contactName}</span>
          </div>
        ) : null}
        {project.contactPhone ? (
          <div className="info-row">
            <span className="muted">Phone</span>
            <a href={`tel:${project.contactPhone}`}>{project.contactPhone}</a>
          </div>
        ) : null}
        {project.contactEmail ? (
          <div className="info-row">
            <span className="muted">Email</span>
            <a href={`mailto:${project.contactEmail}`}>{project.contactEmail}</a>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * Platform-only. This is the control behind the broker model: a global project
 * every client can sell, or a shortlist of named companies.
 */
function SharingSection({ project, reload }) {
  const [state, setState] = useState({ status: 'loading', clients: [], error: null });
  const [shared, setShared] = useState(() => new Set(project.sharedWith || []));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const clients = (await api.get('/api/platform/clients', { limit: 200 }, { signal: ctrl.signal })).data || [];
        setState({ status: 'ready', clients, error: null });
      } catch (err) {
        if (err.name === 'AbortError') return;
        setState({ status: 'error', clients: [], error: err });
      }
    })();
    return () => ctrl.abort();
  }, []);

  const toggle = (orgId, checked) =>
    setShared((prev) => {
      const next = new Set(prev);
      if (checked) next.add(orgId);
      else next.delete(orgId);
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/projects/${project.id}/access`, { organizationIds: [...shared] });
      toast.success('Sharing updated');
      reload();
    } catch (err) {
      setSaving(false);
      reportError(err);
    }
  };

  let body;
  if (state.status === 'loading') {
    body = <div className="muted small">Loading companies…</div>;
  } else if (state.status === 'error') {
    body = <div className="alert danger">{state.error.message}</div>;
  } else {
    const isGlobal = project.visibility === 'GLOBAL';
    body = (
      <>
        <div className="alert info mb-16">
          {isGlobal
            ? 'This project is GLOBAL: every client company can sell it. Their leads stay private to them.'
            : 'Pick the companies that may sell this project. Their leads stay private to each of them.'}
        </div>
        {!isGlobal ? (
          <>
            <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
              {state.clients.map((c) => (
                <label key={c.id} className="checkbox">
                  <input type="checkbox" checked={shared.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                  <span>
                    {c.name}
                    <span className="muted tiny">{` · ${titleCase(c.companyType)}`}</span>
                  </span>
                </label>
              ))}
            </div>
            <button type="button" className="btn btn-primary btn-sm mt-8" disabled={saving} onClick={save}>
              Save sharing
            </button>
          </>
        ) : null}
      </>
    );
  }

  return (
    <Panel title="Shared with" subtitle="Platform administrators only.">
      <div>{body}</div>
    </Panel>
  );
}

function LeadsSection({ project }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  if (!can('leads', 'read')) return null;
  return (
    <Panel title="Leads from this project" subtitle="Your company only." flush>
      <DataTable
        pageSize={10}
        onRowClick={(row) => navigate(`/leads/${row.id}`)}
        load={(p) => api.get('/api/leads', { ...p, projectId: project.id })}
        emptyTitle="No leads on this project yet"
        emptyMessage="Leads captured against this project will appear here."
        columns={[
          {
            label: 'Lead',
            render: (row) => (
              <div>
                <div className="cell-main">{`${row.firstName} ${row.lastName || ''}`.trim()}</div>
                <div className="cell-sub">{row.code}</div>
              </div>
            ),
          },
          { label: 'Phone', render: (row) => row.phone || '—' },
          { label: 'Status', render: (row) => <StatusBadge name={row.status?.name} color={row.status?.color} /> },
          { label: 'Owner', render: (row) => <OwnerCell owner={row.owner} /> },
          { label: 'Created', cellClass: 'hide-sm', render: (row) => date(row.createdAt) },
        ]}
      />
    </Panel>
  );
}
