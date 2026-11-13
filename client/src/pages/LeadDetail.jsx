import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { loadReference } from '../lib/reference.js';
import { emitDataChanged } from '../lib/events.js';
import {
  SCORE_TONE, date, dateTime, duration, fileSize, inputDateTime, money, relative, titleCase,
} from '../lib/format.js';
import Icon, { ACTIVITY_ICONS } from '../components/Icon.jsx';
import { ScoreRing } from '../components/charts.jsx';
import { NoAccess, PageHead, Panel, PriorityBadge } from '../components/shared.jsx';
import {
  Avatar, BusyButton, Dropdown, EmptyState, Field, Input, MenuItem, MenuSeparator, Modal, PageLoader, Select,
  StatusBadge, Tabs, Textarea, copyToClipboard, reportError, toast, useConfirm,
} from '../components/ui/index.js';
import LeadForm from './LeadForm.jsx';

/**
 * Lead 360. Port of the PHP edition's `views/leadDetail.js`.
 *
 * Left column: identity, score, attribution and the editable field summary.
 * Right column: tabbed timeline, activities, documents, duplicates and (for
 * those who may see it) the audit trail.
 *
 * Every action here is a real API call - logging a call updates the timeline,
 * the last-contacted date and the lead score in one round trip.
 */
const LOG_TYPES = ['CALL', 'EMAIL', 'MEETING', 'WHATSAPP', 'SMS', 'NOTE'].map((t) => ({ value: t, label: titleCase(t) }));
const DIRECTIONS = [
  { value: 'OUTBOUND', label: 'Outbound' },
  { value: 'INBOUND', label: 'Inbound' },
];
const OUTCOMES = ['CONNECTED', 'NO_ANSWER', 'BUSY', 'INTERESTED', 'NOT_INTERESTED', 'CALLBACK'].map((o) => ({
  value: o,
  label: titleCase(o),
}));
// Interactions with the person, as opposed to notes and system entries.
const COMMUNICATION_TYPES = ['CALL', 'EMAIL', 'MEETING', 'WHATSAPP', 'SMS'];

const personName = (p) => `${p.firstName} ${p.lastName || ''}`.trim();

export default function LeadDetail() {
  const { can } = useAuth();
  if (!can('leads', 'read')) return <NoAccess what="leads" />;
  return <LeadDetailPage />;
}

function LeadDetailPage() {
  const { id } = useParams();
  const { can, canAny } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [statuses, setStatuses] = useState([]);
  const [activeTab, setActiveTab] = useState('timeline');
  // The open dialog: { kind: 'log' | 'followUp' | 'lost' | 'assign' | 'upload', ... }.
  const [dialog, setDialog] = useState(null);
  const [editing, setEditing] = useState(false);

  const statusesRef = useRef([]);
  const canRef = useRef(can);
  canRef.current = can;
  const token = useRef(0);

  const load = useCallback(async () => {
    const mine = ++token.current;
    try {
      const res = await api.get(`/api/leads/${id}`);
      let nextStatuses = null;
      if (canRef.current('leads', 'change_status') && !statusesRef.current.length) {
        // Its own try: a reference lookup that fails should cost the status
        // picker, not the whole lead page.
        try {
          nextStatuses = (await loadReference()).statuses || [];
        } catch {
          nextStatuses = [];
        }
      }
      if (mine !== token.current) return;
      if (nextStatuses) {
        statusesRef.current = nextStatuses;
        setStatuses(nextStatuses);
      }
      setError(null);
      setData(res.data);
    } catch (err) {
      if (mine !== token.current) return;
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
    return () => {
      token.current += 1;
    };
  }, [load]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  async function patchLead(payload, successMessage) {
    try {
      await api.patch(`/api/leads/${id}`, payload);
      if (successMessage) toast.success(successMessage);
      await load();
      emitDataChanged();
    } catch (err) {
      reportError(err);
    }
  }

  function chooseStatus(status) {
    if (!status.isLost) {
      patchLead({ statusId: status.id }, `Status changed to ${status.name}`);
      return;
    }
    // Losing a lead is the one status change worth a sentence of explanation:
    // it is what the lost-reason reporting is built on.
    setDialog({ kind: 'lost', status });
  }

  async function openAssign() {
    const reference = await loadReference();
    setDialog({ kind: 'assign', reference });
  }

  async function mergeWith(duplicateId) {
    const yes = await confirm({
      title: 'Merge these leads?',
      message:
        'The other lead becomes a duplicate record; its activities, tasks and documents move here. Empty fields on this lead are filled from it.',
      confirmLabel: 'Merge',
    });
    if (!yes) return;
    try {
      await api.post('/api/leads/merge', { targetId: id, sourceIds: [duplicateId] });
      toast.success('Leads merged');
      await load();
    } catch (err) {
      reportError(err);
    }
  }

  async function rescore(lead) {
    try {
      await api.post(`/api/leads/${lead.id}/rescore`);
      toast.success('Score recalculated');
      load();
    } catch (err) {
      reportError(err);
    }
  }

  async function deleteLead(lead, fullName) {
    const yes = await confirm({
      title: 'Delete this lead?',
      message: `${fullName} and its entire history will be removed permanently.`,
      confirmLabel: 'Delete',
      danger: true,
      requireText: 'DELETE',
    });
    if (!yes) return;
    try {
      await api.del(`/api/leads/${lead.id}`);
      toast.success('Lead deleted');
      navigate('/leads');
    } catch (err) {
      reportError(err);
    }
  }

  async function deleteDocument(doc) {
    const yes = await confirm({
      title: `Delete ${doc.fileName}?`,
      message: 'The file is removed from this lead permanently.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!yes) return;
    try {
      await api.del(`/api/documents/${doc.id}`);
      toast.success('Document deleted');
      await load();
    } catch (err) {
      reportError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (error) {
    return (
      <div className="card">
        <EmptyState
          iconName="alert"
          title={error.status === 404 ? 'Lead not found' : 'Could not load this lead'}
          message={error.message}
          action={
            <Link className="btn" to="/leads">
              Back to leads
            </Link>
          }
        />
      </div>
    );
  }
  if (!data) return <PageLoader label="Loading lead" />;

  const lead = data.lead;
  const fullName = `${lead.firstName} ${lead.lastName || ''}`.trim();
  const scoreColor = SCORE_TONE[lead.scoreBand] || 'var(--brand-600)';
  const closeDialog = () => setDialog(null);

  const actions = [
    can('activities', 'create') ? (
      <button key="log" type="button" className="btn" onClick={() => setDialog({ kind: 'log', type: 'CALL' })}>
        <Icon name="phone" size={15} />
        Log call
      </button>
    ) : null,
    can('leads', 'update') ? (
      <button key="follow" type="button" className="btn" onClick={() => setDialog({ kind: 'followUp' })}>
        <Icon name="clock" size={15} />
        Set follow-up
      </button>
    ) : null,
    <Dropdown
      key="more"
      trigger={
        <button type="button" className="btn">
          <Icon name="more" size={16} />
        </button>
      }
    >
      <div>
        {can('leads', 'update') ? (
          <MenuItem iconName="edit" onClick={() => setEditing(true)}>
            Edit lead
          </MenuItem>
        ) : null}
        {canAny([
          ['leads', 'assign'],
          ['leads', 'reassign'],
        ]) ? (
          <MenuItem iconName="user" onClick={openAssign}>
            Reassign
          </MenuItem>
        ) : null}
        {can('documents', 'create') ? (
          <MenuItem iconName="file" onClick={() => setDialog({ kind: 'upload' })}>
            Attach document
          </MenuItem>
        ) : null}
        {can('leads', 'update') ? (
          <MenuItem iconName="refresh" onClick={() => rescore(lead)}>
            Recalculate score
          </MenuItem>
        ) : null}
        <MenuItem
          iconName="link"
          onClick={() => copyToClipboard(`${window.location.origin}/leads/${lead.id}`, 'Lead link copied')}
        >
          Copy lead link
        </MenuItem>
        {can('leads', 'delete') ? <MenuSeparator /> : null}
        {can('leads', 'delete') ? (
          <MenuItem iconName="trash" danger onClick={() => deleteLead(lead, fullName)}>
            Delete lead
          </MenuItem>
        ) : null}
      </div>
    </Dropdown>,
  ].filter(Boolean);

  // ---- left column ----
  const identity = (
    <section className="card">
      <div className="card-body">
        <div className="row" style={{ gap: '14px', alignItems: 'flex-start' }}>
          <Avatar name={fullName} size="lg" />
          <div className="grow" style={{ minWidth: 0 }}>
            <h2 className="truncate">{fullName}</h2>
            <div className="muted small truncate">
              {[lead.jobTitle, lead.company].filter(Boolean).join(' at ') || lead.code}
            </div>
            <div className="row wrap mt-8" style={{ gap: '6px' }}>
              <StatusControl lead={lead} statuses={statuses} onChoose={chooseStatus} />
              <PriorityBadge priority={lead.priority} />
              {lead.isConverted ? <span className="badge badge-success">Converted</span> : null}
            </div>
          </div>
        </div>

        <div className="row mt-16" style={{ gap: '16px' }}>
          <ScoreRing score={lead.score} color={scoreColor} />
          <div className="grow">
            <div className="strong" style={{ color: scoreColor }}>
              {titleCase(lead.scoreBand)}
            </div>
            <div className="muted tiny">{`${lead.score}/100 lead score`}</div>
            {data.score?.breakdown?.length ? (
              <details className="mt-8">
                <summary className="tiny muted" style={{ cursor: 'pointer' }}>
                  How this was calculated
                </summary>
                <div className="col tiny mt-8" style={{ gap: '3px' }}>
                  {data.score.breakdown.map((b, i) => (
                    <div key={i} className="row-between">
                      <span>{b.rule}</span>
                      <span className={b.points >= 0 ? 'text-success' : 'text-danger'}>
                        {`${b.points > 0 ? '+' : ''}${b.points}`}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        </div>

        <div className="row wrap mt-16" style={{ gap: '8px' }}>
          {lead.phone ? (
            <a className="btn btn-sm" href={`tel:${lead.phone}`}>
              <Icon name="phone" size={14} />
              Call
            </a>
          ) : null}
          {lead.email ? (
            <a className="btn btn-sm" href={`mailto:${lead.email}`}>
              <Icon name="mail" size={14} />
              Email
            </a>
          ) : null}
          {lead.phone ? (
            <a
              className="btn btn-sm"
              target="_blank"
              rel="noopener"
              href={`https://wa.me/${lead.phone.replace(/\D/g, '')}`}
            >
              <Icon name="message" size={14} />
              WhatsApp
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );

  const details = (
    <Panel title="Details">
      <div className="info-list">
        <InfoRow label="Lead ID">
          <span className="mono">{lead.code}</span>
        </InfoRow>
        <InfoRow label="Email">
          {lead.email ? <a href={`mailto:${lead.email}`}>{lead.email}</a> : <span className="muted">Not provided</span>}
        </InfoRow>
        <InfoRow label="Phone">{lead.phone || '—'}</InfoRow>
        <InfoRow label="Alternate">{lead.altPhone || '—'}</InfoRow>
        <InfoRow label="Company">{lead.company || '—'}</InfoRow>
        <InfoRow label="Website">
          {lead.website ? (
            <a href={lead.website} target="_blank" rel="noopener noreferrer">
              {lead.website}
            </a>
          ) : (
            '—'
          )}
        </InfoRow>
        <InfoRow label="Location">{[lead.city, lead.state, lead.country].filter(Boolean).join(', ') || '—'}</InfoRow>
        <InfoRow label="Pincode">{lead.pincode || '—'}</InfoRow>
        <InfoRow label="Owner">
          {lead.owner ? personName(lead.owner) : <span className="badge">Unassigned</span>}
        </InfoRow>
        <InfoRow label="Team">{lead.team?.name || '—'}</InfoRow>
        <InfoRow label="Expected value">{lead.expectedValue ? money(lead.expectedValue) : '—'}</InfoRow>
        <InfoRow label="Last contacted">{lead.lastContactedAt ? dateTime(lead.lastContactedAt) : 'Never'}</InfoRow>
        <InfoRow label="Next follow-up">
          {lead.nextFollowUpAt ? (
            <span className={new Date(lead.nextFollowUpAt) < new Date() ? 'badge badge-danger' : 'badge badge-info'}>
              {dateTime(lead.nextFollowUpAt)}
            </span>
          ) : (
            '—'
          )}
        </InfoRow>
        <InfoRow label="Created">
          {`${dateTime(lead.createdAt)}${lead.createdBy ? ` by ${lead.createdBy.firstName}` : ''}`}
        </InfoRow>
        <InfoRow label="Tags">
          {lead.tags?.length ? (
            <div className="row wrap" style={{ gap: '4px' }}>
              {lead.tags.map((t, i) => (
                <span key={t.id ?? i} className="badge" style={{ background: `${t.color}1f`, color: t.color }}>
                  {t.name}
                </span>
              ))}
            </div>
          ) : (
            '—'
          )}
        </InfoRow>
      </div>
    </Panel>
  );

  const touch = (source, at) => (source ? `${source}${at ? ` · ${date(at)}` : ''}` : '—');
  const attribution = (
    <Panel title="Attribution">
      <div className="info-list">
        <InfoRow label="Source">{lead.source?.name || '—'}</InfoRow>
        <InfoRow label="Campaign">
          {/* Campaigns have no screen of their own in this edition, so a link would only reach NotFound. */}
          {lead.campaign ? lead.campaign.name : '—'}
        </InfoRow>
        <InfoRow label="Medium">{lead.medium || '—'}</InfoRow>
        <InfoRow label="First touch">{touch(lead.firstTouchSource, lead.firstTouchAt)}</InfoRow>
        <InfoRow label="Last touch">{touch(lead.lastTouchSource, lead.lastTouchAt)}</InfoRow>
        <InfoRow label="UTM source">{lead.utmSource || '—'}</InfoRow>
        <InfoRow label="UTM medium">{lead.utmMedium || '—'}</InfoRow>
        <InfoRow label="UTM campaign">{lead.utmCampaign || '—'}</InfoRow>
        <InfoRow label="Landing page">
          {lead.landingPage ? (
            <a
              href={lead.landingPage}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate"
              style={{ display: 'inline-block', maxWidth: '100%' }}
            >
              {lead.landingPage}
            </a>
          ) : (
            '—'
          )}
        </InfoRow>
      </div>
    </Panel>
  );

  const customFieldEntries = Object.entries(lead.customFields || {});
  const customPanel = customFieldEntries.length ? (
    <Panel title="Additional details">
      <div className="info-list">
        {customFieldEntries.map(([key, value]) => (
          <InfoRow key={key} label={titleCase(key)}>
            {Array.isArray(value) ? value.join(', ') : String(value)}
          </InfoRow>
        ))}
      </div>
    </Panel>
  ) : null;

  // ---- right column ----
  const tabItems = [
    { key: 'timeline', label: 'Timeline', count: data.activities.length },
    { key: 'documents', label: 'Documents', count: data.documents.length },
    { key: 'duplicates', label: 'Duplicates', count: data.duplicates.length },
  ];
  if (can('audit', 'read')) tabItems.push({ key: 'audit', label: 'Audit', count: data.auditTrail.length });

  let tabBody = <div />;
  if (activeTab === 'timeline') {
    tabBody = <Timeline activities={data.activities} canLog={can('activities', 'create')} onLog={(type) => setDialog({ kind: 'log', type })} />;
  } else if (activeTab === 'documents') {
    tabBody = (
      <Documents
        documents={data.documents}
        canRead={can('documents', 'read')}
        canCreate={can('documents', 'create')}
        canDelete={can('documents', 'delete')}
        onUpload={() => setDialog({ kind: 'upload' })}
        onDelete={deleteDocument}
      />
    );
  } else if (activeTab === 'duplicates') {
    tabBody = (
      <Duplicates
        duplicates={data.duplicates}
        canMerge={can('leads', 'update')}
        onOpen={(dupId) => navigate(`/leads/${dupId}`)}
        onMerge={mergeWith}
      />
    );
  } else if (activeTab === 'audit') {
    tabBody = <AuditTrail entries={data.auditTrail} />;
  }

  return (
    <div>
      <PageHead
        title={fullName}
        subtitle={`${lead.code} · created ${relative(lead.createdAt)}`}
        breadcrumbs={[{ label: 'Leads', path: '/leads' }, { label: fullName }]}
        actions={actions}
      />
      <div className="detail-layout">
        <div className="col" style={{ gap: '14px' }}>
          {identity}
          {details}
          {attribution}
          {customPanel}
        </div>
        <section className="card">
          <div style={{ padding: '0 12px' }}>
            <Tabs items={tabItems} active={activeTab} onSelect={setActiveTab} />
          </div>
          <div className="card-body">{tabBody}</div>
        </section>
      </div>

      {editing ? <LeadForm lead={lead} onClose={() => setEditing(false)} onSaved={() => load()} /> : null}

      {dialog?.kind === 'log' ? (
        <LogActivityDialog
          lead={lead}
          initialType={dialog.type}
          onClose={closeDialog}
          onSaved={async () => {
            await load();
            emitDataChanged();
          }}
        />
      ) : null}
      {dialog?.kind === 'followUp' ? (
        <FollowUpDialog leadId={id} current={lead.nextFollowUpAt} onClose={closeDialog} onSaved={() => load()} />
      ) : null}
      {dialog?.kind === 'lost' ? (
        <LostReasonDialog
          status={dialog.status}
          onClose={closeDialog}
          onSave={(reason) =>
            patchLead(
              { statusId: dialog.status.id, lostReason: reason || undefined },
              `Status changed to ${dialog.status.name}`
            )
          }
        />
      ) : null}
      {dialog?.kind === 'assign' ? (
        <AssignDialog
          lead={lead}
          reference={dialog.reference}
          onClose={closeDialog}
          onSave={(ownerId, teamId) => patchLead({ ownerId: ownerId || null, teamId: teamId || null }, 'Lead reassigned')}
        />
      ) : null}
      {dialog?.kind === 'upload' ? <UploadDialog leadId={id} onClose={closeDialog} onSaved={() => load()} /> : null}
    </div>
  );
}

function InfoRow({ label, children }) {
  return (
    <div className="info-row">
      <div className="i-label">{label}</div>
      <div className="i-value">{children ?? '—'}</div>
    </div>
  );
}

/**
 * The status is what a salesperson touches most often, so it is a control
 * here rather than a read-only badge - no opening the edit form, no bulk
 * selection of one. Anyone holding leads.change_status may move a lead that
 * is already visible to them, which is how the API gates it too.
 */
function StatusControl({ lead, statuses, onChoose }) {
  const { can } = useAuth();
  const badge = <StatusBadge name={lead.status?.name} color={lead.status?.color} />;
  if (!can('leads', 'change_status') || !statuses.length) return badge;

  return (
    <Dropdown
      align="left"
      trigger={
        <button
          type="button"
          className="status-picker"
          title="Change status"
          aria-label={`Status: ${lead.status?.name || 'none'}. Change it.`}
        >
          {badge}
          <Icon name="chevronDown" size={13} />
        </button>
      }
    >
      <div>
        {statuses.map((s) => (
          <MenuItem
            key={s.id}
            iconName={s.id === lead.status?.id ? 'check' : undefined}
            onClick={() => {
              if (s.id !== lead.status?.id) onChoose(s);
            }}
          >
            {s.name}
          </MenuItem>
        ))}
      </div>
    </Dropdown>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function Timeline({ activities, canLog, onLog }) {
  if (!activities.length) {
    return (
      <EmptyState
        iconName="activity"
        title="No activity yet"
        message="Log a call, email or meeting to start the timeline."
        action={
          canLog ? (
            <button type="button" className="btn btn-primary" onClick={() => onLog('CALL')}>
              Log an interaction
            </button>
          ) : null
        }
      />
    );
  }
  return (
    <div>
      {canLog ? (
        <div className="row wrap mb-16" style={{ gap: '6px' }}>
          <button type="button" className="btn btn-sm" onClick={() => onLog('CALL')}>
            <Icon name="phone" size={14} />
            Call
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onLog('EMAIL')}>
            <Icon name="mail" size={14} />
            Email
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onLog('MEETING')}>
            <Icon name="calendar" size={14} />
            Meeting
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onLog('WHATSAPP')}>
            <Icon name="message" size={14} />
            WhatsApp
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onLog('NOTE')}>
            <Icon name="edit" size={14} />
            Note
          </button>
        </div>
      ) : null}
      <div className="timeline">
        {activities.map((a) => (
          <div key={a.id} className="tl-item">
            <div
              className="tl-dot"
              style={
                COMMUNICATION_TYPES.includes(a.type)
                  ? { borderColor: 'var(--brand-400)', color: 'var(--brand-600)' }
                  : undefined
              }
            >
              <Icon name={ACTIVITY_ICONS[a.type] || 'info'} size={11} />
            </div>
            <div className="tl-head">
              <span className="tl-title">{a.subject || titleCase(a.type)}</span>
              <span className="tl-time" title={dateTime(a.occurredAt)}>
                {relative(a.occurredAt)}
              </span>
            </div>
            {a.body ? <div className="tl-body">{a.body}</div> : null}
            <div className="tl-meta">
              <span className="badge">{titleCase(a.type)}</span>
              {a.direction ? <span className="badge">{titleCase(a.direction)}</span> : null}
              {a.outcome ? <span className="badge badge-info">{titleCase(a.outcome)}</span> : null}
              {a.durationSec ? <span className="badge">{duration(a.durationSec)}</span> : null}
              {a.user ? <span className="tiny muted">{personName(a.user)}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Files attached to the lead. The original view listed this tab but never
 * defined its renderer (clicking it threw), so this is built from the
 * server's document shape: name, size, uploader, date, download and delete.
 */
function Documents({ documents, canRead, canCreate, canDelete, onUpload, onDelete }) {
  if (!documents.length) {
    return (
      <EmptyState
        iconName="file"
        title="No documents yet"
        message="Attach a PDF, image, spreadsheet or Word document to keep it with this lead."
        action={
          canCreate ? (
            <button type="button" className="btn btn-primary" onClick={onUpload}>
              Attach document
            </button>
          ) : null
        }
      />
    );
  }
  return (
    <div>
      {canCreate ? (
        <div className="row wrap mb-16" style={{ gap: '6px' }}>
          <button type="button" className="btn btn-sm" onClick={onUpload}>
            <Icon name="upload" size={14} />
            Attach document
          </button>
        </div>
      ) : null}
      <div className="col" style={{ gap: '10px' }}>
        {documents.map((doc) => (
          <div
            key={doc.id}
            className="row-between"
            style={{ padding: '12px', border: '1px solid var(--line)', borderRadius: '10px' }}
          >
            <div className="row" style={{ gap: '10px', minWidth: 0 }}>
              <Icon name="file" size={18} />
              <div style={{ minWidth: 0 }}>
                <div className="strong truncate">{doc.fileName}</div>
                <div className="tiny muted">
                  {[
                    fileSize(doc.sizeBytes),
                    doc.uploadedBy ? personName(doc.uploadedBy) : null,
                    relative(doc.createdAt),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
            </div>
            <div className="row" style={{ gap: '6px' }}>
              {canRead ? (
                <BusyButton
                  className="btn btn-sm"
                  onClick={() =>
                    api.download(`/api/documents/${doc.id}/download`, null, doc.fileName).catch(reportError)
                  }
                >
                  <Icon name="download" size={14} />
                  Download
                </BusyButton>
              ) : null}
              {canDelete ? (
                <button type="button" className="btn btn-sm btn-danger" onClick={() => onDelete(doc)}>
                  <Icon name="trash" size={14} />
                  Delete
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Duplicates({ duplicates, canMerge, onOpen, onMerge }) {
  if (!duplicates.length) {
    return (
      <EmptyState
        iconName="check"
        title="No duplicates found"
        message="No other lead shares this phone number or email address."
      />
    );
  }
  return (
    <div>
      <div className="alert warning mb-16">
        <Icon name="alert" size={16} />
        <div>
          {`${duplicates.length} possible duplicate${duplicates.length === 1 ? '' : 's'}. Merging keeps this lead and folds the others into it.`}
        </div>
      </div>
      <div className="col" style={{ gap: '10px' }}>
        {duplicates.map((dup) => (
          <div
            key={dup.id}
            className="row-between"
            style={{ padding: '12px', border: '1px solid var(--line)', borderRadius: '10px' }}
          >
            <div style={{ minWidth: 0 }}>
              <div className="strong truncate">{personName(dup)}</div>
              <div className="tiny muted">
                {`${dup.code} · ${dup.company || 'No company'} · matched on ${dup.matchedOn.join(', ').toLowerCase()}`}
              </div>
              <div className="tiny muted">
                {`${dup.owner ? `${dup.owner.firstName} ${dup.owner.lastName || ''}` : 'Unassigned'} · created ${relative(dup.createdAt)}`}
              </div>
            </div>
            <div className="row" style={{ gap: '6px' }}>
              <button type="button" className="btn btn-sm" onClick={() => onOpen(dup.id)}>
                Open
              </button>
              {canMerge ? (
                <button type="button" className="btn btn-sm btn-primary" onClick={() => onMerge(dup.id)}>
                  <Icon name="merge" size={14} />
                  Merge
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatChange(change) {
  if (change && typeof change === 'object' && 'from' in change) {
    return `${change.from ?? '(empty)'} → ${change.to ?? '(empty)'}`;
  }
  return typeof change === 'object' ? JSON.stringify(change) : String(change);
}

function AuditTrail({ entries }) {
  if (!entries.length) {
    return (
      <EmptyState iconName="audit" title="No audit entries" message="Changes to this lead will be recorded here." />
    );
  }
  return (
    <div className="timeline">
      {entries.map((entry) => (
        <div key={entry.id} className="tl-item">
          <div className="tl-dot">
            <Icon name="audit" size={11} />
          </div>
          <div className="tl-head">
            <span className="tl-title">{titleCase(entry.action.replace(/\./g, ' '))}</span>
            <span className="tl-time">{dateTime(entry.createdAt)}</span>
          </div>
          <div className="tl-body">{entry.actorLabel || 'System'}</div>
          {Object.keys(entry.changes || {}).length ? (
            <div className="col tiny mt-8" style={{ gap: '2px' }}>
              {Object.entries(entry.changes).map(([fieldName, change]) => (
                <div key={fieldName} className="muted">
                  {`${titleCase(fieldName)}: ${formatChange(change)}`}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function DialogFooter({ onClose, onConfirm, label = 'Save' }) {
  return (
    <div className="row">
      <button type="button" className="btn" onClick={onClose}>
        Cancel
      </button>
      <BusyButton className="btn btn-primary" onClick={onConfirm}>
        {label}
      </BusyButton>
    </div>
  );
}

function LogActivityDialog({ lead, initialType = 'CALL', onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    type: initialType,
    direction: 'OUTBOUND',
    outcome: '',
    subject: '',
    body: '',
    duration: '',
    occurredAt: inputDateTime(new Date()),
    nextFollowUpAt: '',
  }));
  const set = (key) => (e) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  async function save() {
    try {
      await api.post(`/api/leads/${lead.id}/activities`, {
        type: form.type,
        direction: form.type === 'NOTE' ? null : form.direction,
        outcome: form.outcome || null,
        subject: form.subject.trim() || null,
        body: form.body.trim() || null,
        durationSec: form.duration ? Number(form.duration) * 60 : null,
        occurredAt: form.occurredAt || null,
        nextFollowUpAt: form.nextFollowUpAt || null,
      });
      toast.success('Interaction logged');
      onClose();
      await onSaved();
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <Modal
      title="Log an interaction"
      subtitle={`${lead.firstName} ${lead.lastName || ''} · ${lead.code}`.trim()}
      onClose={onClose}
      footer={<DialogFooter onClose={onClose} onConfirm={save} />}
    >
      <div>
        <div className="form-grid">
          <Field label="Type">
            <Select options={LOG_TYPES} value={form.type} onChange={set('type')} />
          </Field>
          <Field label="Direction">
            <Select options={DIRECTIONS} value={form.direction} onChange={set('direction')} />
          </Field>
          <Field label="Outcome">
            <Select options={OUTCOMES} placeholder="Outcome (optional)" value={form.outcome} onChange={set('outcome')} />
          </Field>
          <Field label="Duration (minutes)">
            <Input type="number" min="0" placeholder="Minutes" value={form.duration} onChange={set('duration')} />
          </Field>
        </div>
        <Field label="Subject">
          <Input placeholder="Discussed pricing and timelines" value={form.subject} onChange={set('subject')} />
        </Field>
        <Field label="Notes">
          <Textarea rows={4} placeholder="What was said? What happens next?" value={form.body} onChange={set('body')} />
        </Field>
        <div className="form-grid">
          <Field label="When">
            <Input type="datetime-local" value={form.occurredAt} onChange={set('occurredAt')} />
          </Field>
          <Field label="Next follow-up">
            <Input type="datetime-local" value={form.nextFollowUpAt} onChange={set('nextFollowUpAt')} />
          </Field>
        </div>
        <div className="tiny muted">Setting a next follow-up puts this lead back in the follow-up queue.</div>
      </div>
    </Modal>
  );
}

/** Schedules the lead's next follow-up. Replaces the old "add task" flow. */
function FollowUpDialog({ leadId, current, onClose, onSaved }) {
  const [when, setWhen] = useState(() => inputDateTime(current));

  async function save() {
    try {
      await api.patch(`/api/leads/${leadId}`, { nextFollowUpAt: when || null });
      toast.success(when ? 'Follow-up scheduled' : 'Follow-up cleared');
      onClose();
      await onSaved();
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <Modal
      title="Set next follow-up"
      subtitle="The lead returns to the follow-up queue on this date, and its owner is reminded."
      onClose={onClose}
      footer={<DialogFooter onClose={onClose} onConfirm={save} />}
    >
      <Field label="Next follow-up">
        <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </Field>
    </Modal>
  );
}

function LostReasonDialog({ status, onClose, onSave }) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      title={`Mark as ${status.name}`}
      onClose={onClose}
      footer={
        <DialogFooter
          onClose={onClose}
          onConfirm={async () => {
            onClose();
            await onSave(reason);
          }}
        />
      }
    >
      <div>
        <Field label="Reason" hint="Optional, but it is what the lost-reason report reads.">
          <Input placeholder="Why was this lead lost?" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function AssignDialog({ lead, reference, onClose, onSave }) {
  const [ownerId, setOwnerId] = useState(lead.ownerId || '');
  const [teamId, setTeamId] = useState(lead.teamId || '');
  return (
    <Modal
      title="Assign this lead"
      onClose={onClose}
      footer={
        <DialogFooter
          onClose={onClose}
          onConfirm={async () => {
            onClose();
            await onSave(ownerId, teamId);
          }}
        />
      }
    >
      <div>
        <Field label="Owner">
          <Select
            options={reference.users.map((u) => ({ value: u.id, label: u.fullName || u.name }))}
            placeholder="Unassigned"
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
          />
        </Field>
        <Field label="Team">
          <Select
            options={reference.teams.map((t) => ({ value: t.id, label: t.name }))}
            placeholder="No team"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

function UploadDialog({ leadId, onClose, onSaved }) {
  const fileRef = useRef(null);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.warn('Choose a file first');
      return;
    }
    const formData = new FormData();
    formData.append('file', file);
    formData.append('leadId', leadId);
    try {
      await api.upload('/api/documents', formData);
      toast.success('Document uploaded');
      onClose();
      await onSaved();
    } catch (err) {
      reportError(err);
    }
  }

  return (
    <Modal
      title="Attach a document"
      subtitle="PDF, image, spreadsheet or Word document."
      onClose={onClose}
      footer={<DialogFooter onClose={onClose} onConfirm={upload} label="Upload" />}
    >
      <Field label="File">
        <input ref={fileRef} type="file" className="input" style={{ paddingTop: '7px' }} />
      </Field>
    </Modal>
  );
}
