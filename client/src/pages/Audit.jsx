/**
 * Audit log: immutable, filterable, exportable.
 * Port of the PHP edition's `js/views/audit.js`.
 */
import { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useQueryParams } from '../lib/query.js';
import { dateTime, relative, titleCase, number } from '../lib/format.js';
import Icon from '../components/Icon.jsx';
import { PageHead, NoAccess, FilterBar } from '../components/shared.jsx';
import { Avatar, DataTable, Modal, SearchBox, Select, reportError, toast } from '../components/ui/index.js';

export default function Audit() {
  const { can } = useAuth();
  if (!can('audit', 'read')) return <NoAccess what="the audit log" />;
  return <AuditPage />;
}

function AuditPage() {
  const { can } = useAuth();
  const [query, setQuery] = useQueryParams();
  // The same three filters the original seeded from its query and sent to the table.
  const filters = { action: query.action || '', userId: query.userId || '', q: query.q || '' };
  const [actions, setActions] = useState([]);
  const [entry, setEntry] = useState(null);

  // The action picker is a nicety: if its list cannot load, it just offers "All actions".
  useEffect(() => {
    const ctrl = new AbortController();
    api
      .data('/api/audit-logs/actions', undefined, { signal: ctrl.signal })
      .then((rows) => setActions(rows || []))
      .catch(() => {
        if (!ctrl.signal.aborted) setActions([]);
      });
    return () => ctrl.abort();
  }, []);

  const headActions = can('audit', 'export')
    ? [
        <button
          key="export"
          type="button"
          className="btn"
          onClick={() =>
            api
              .download('/api/audit-logs/export', filters)
              .then(() => toast.success('Audit log exported'))
              .catch(reportError)
          }
        >
          <Icon name="download" size={15} />
          Export
        </button>,
      ]
    : [];

  const toolbar = (
    <div className="toolbar">
      <SearchBox placeholder="Search actions, records, people…" value={filters.q} onSearch={(q) => setQuery({ q })} />
      <Select
        options={[
          { value: '', label: 'All actions' },
          ...actions.map((a) => ({ value: a.action, label: `${a.action} (${number(a.count)})` })),
        ]}
        value={filters.action}
        onChange={(e) => setQuery({ action: e.target.value })}
      />
      {/* The shared owner picker speaks `ownerId`; the audit API filters on `userId`. */}
      <FilterBar
        filters={['owner']}
        current={{ ownerId: filters.userId }}
        onChange={(patch) => setQuery({ userId: patch.ownerId || '' })}
      />
    </div>
  );

  const columns = [
    {
      label: 'When',
      render: (row) => (
        <div>
          <div className="cell-main">{relative(row.createdAt)}</div>
          <div className="cell-sub">{dateTime(row.createdAt)}</div>
        </div>
      ),
    },
    {
      label: 'Who',
      render: (row) =>
        row.user ? (
          <div className="row" style={{ gap: '8px' }}>
            <Avatar name={`${row.user.firstName} ${row.user.lastName || ''}`} size="sm" url={row.user.avatarUrl} />
            <div style={{ minWidth: 0 }}>
              <div className="truncate">{`${row.user.firstName} ${row.user.lastName || ''}`.trim()}</div>
              <div className="cell-sub truncate">{row.user.email}</div>
            </div>
          </div>
        ) : (
          <span className="badge">{row.actorLabel || 'System'}</span>
        ),
    },
    { label: 'Action', render: (row) => <span className="badge badge-brand mono">{row.action}</span> },
    {
      label: 'Record',
      render: (row) => (
        <div>
          <div className="truncate">{row.entityLabel || '—'}</div>
          {row.entityType ? <div className="cell-sub">{titleCase(row.entityType)}</div> : null}
        </div>
      ),
    },
    {
      label: 'Changes',
      cellClass: 'hide-sm',
      render: (row) => {
        const keys = Object.keys(row.changes || {});
        if (!keys.length) return <span className="muted">—</span>;
        return (
          <span className="small">{`${keys.length} field${keys.length === 1 ? '' : 's'}: ${keys.slice(0, 3).join(', ')}`}</span>
        );
      },
    },
    { label: 'IP', cellClass: 'hide-sm', render: (row) => <span className="mono tiny muted">{row.ip || '—'}</span> },
  ];

  return (
    <div>
      <PageHead
        title="Audit Log"
        subtitle="Who did what, when, and from where. Read-only by design."
        actions={headActions}
      />
      <DataTable
        columns={columns}
        load={(params) => api.get('/api/audit-logs', params)}
        params={filters}
        toolbar={toolbar}
        emptyTitle="No audit entries"
        emptyMessage="Nothing matches these filters."
        onRowClick={(row) => setEntry(row)}
      />
      {entry ? <EntryModal entry={entry} onClose={() => setEntry(null)} /> : null}
    </div>
  );
}

function InfoRow({ label, children }) {
  return (
    <div className="info-row">
      <div className="i-label">{label}</div>
      <div className="i-value">{children}</div>
    </div>
  );
}

/**
 * One side of a recorded change. Most entries store `{ from, to }`; anything
 * else (a bare value, a nested object) is shown as-is.
 */
function formatSide(change, side) {
  if (change && typeof change === 'object' && side in change) {
    const v = change[side];
    if (v === null || v === undefined || v === '') return '(empty)';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return typeof change === 'object' ? JSON.stringify(change) : String(change);
}

function EntryModal({ entry, onClose }) {
  const changes = Object.entries(entry.changes || {});
  return (
    <Modal
      title={entry.action}
      subtitle={dateTime(entry.createdAt)}
      size="wide"
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div>
        <div className="info-list mb-16">
          <InfoRow label="Actor">{entry.actorLabel || 'System'}</InfoRow>
          <InfoRow label="Action">
            <span className="mono">{entry.action}</span>
          </InfoRow>
          <InfoRow label="Record">{entry.entityLabel || '—'}</InfoRow>
          <InfoRow label="Record type">{entry.entityType ? titleCase(entry.entityType) : '—'}</InfoRow>
          <InfoRow label="Record ID">{entry.entityId ? <span className="mono small">{entry.entityId}</span> : '—'}</InfoRow>
          <InfoRow label="IP address">{entry.ip || '—'}</InfoRow>
          <InfoRow label="User agent">
            <span className="tiny">{entry.userAgent || '—'}</span>
          </InfoRow>
        </div>
        {changes.length ? (
          <div>
            <h4 className="mb-8">Changes</h4>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Before</th>
                    <th>After</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map(([fieldName, change]) => (
                    <tr key={fieldName}>
                      <td className="cell-main">{titleCase(fieldName)}</td>
                      <td className="small muted">{formatSide(change, 'from')}</td>
                      <td className="small">{formatSide(change, 'to')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="muted">No field-level changes were recorded for this action.</p>
        )}
      </div>
    </Modal>
  );
}
