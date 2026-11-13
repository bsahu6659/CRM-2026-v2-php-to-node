import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { dateTime, duration, number, relative, titleCase } from '../lib/format.js';
import Icon, { ACTIVITY_ICONS } from '../components/Icon.jsx';
import { BarList, DonutChart, PALETTE } from '../components/charts.jsx';
import { FilterBar, LinkTo, NoAccess, PageHead, Panel } from '../components/shared.jsx';
import { Avatar, DataTable, EmptyState, KpiCard, Select, reportError } from '../components/ui/index.js';

/**
 * Activity feed and communication mix across every record in scope.
 * Port of the PHP edition's `views/activities.js`.
 */
const TYPES = ['CALL', 'EMAIL', 'MEETING', 'WHATSAPP', 'SMS', 'NOTE', 'STATUS_CHANGE', 'ASSIGNMENT', 'CONVERSION', 'SYSTEM'];
const TYPE_OPTIONS = [{ value: '', label: 'All activity types' }, ...TYPES.map((t) => ({ value: t, label: titleCase(t) }))];

/**
 * The original read its starting filters from the URL once and then kept
 * them in memory without writing them back, so "All time" (an empty range)
 * is a state the URL cannot express. Filters therefore live in component
 * state, seeded from the query, and are re-seeded only when the URL itself
 * changes (someone links here with different filters).
 */
function filtersFromSearch(search) {
  const q = new URLSearchParams(search);
  return {
    range: q.get('range') || 'last_30_days',
    type: q.get('type') || '',
    userId: q.get('userId') || '',
  };
}

const fullName = (person) => `${person.firstName} ${person.lastName || ''}`.trim();

export default function Activities() {
  const { can } = useAuth();
  if (!can('activities', 'read')) return <NoAccess what="activities" />;
  return <ActivitiesPage />;
}

function ActivitiesPage() {
  const { search } = useLocation();
  const [filters, setFilters] = useState(() => filtersFromSearch(search));
  const [summary, setSummary] = useState(null);

  const seenSearch = useRef(search);
  useEffect(() => {
    if (seenSearch.current === search) return;
    seenSearch.current = search;
    setFilters(filtersFromSearch(search));
  }, [search]);

  // The summary only depends on the date range.
  useEffect(() => {
    let cancelled = false;
    api
      .data('/api/activities/communication-summary', { range: filters.range })
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch((err) => {
        if (!cancelled) reportError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [filters.range]);

  const onFilterBar = (patch) => {
    setFilters((f) => ({
      ...f,
      ...(patch.range !== undefined ? { range: patch.range } : {}),
      ...(patch.ownerId !== undefined ? { userId: patch.ownerId } : {}),
    }));
  };

  const toolbar = (
    <div className="toolbar">
      <Select
        options={TYPE_OPTIONS}
        value={filters.type}
        onChange={(e) => {
          const type = e.target.value;
          setFilters((f) => ({ ...f, type }));
        }}
      />
      <FilterBar
        filters={['range', 'owner']}
        current={{ range: filters.range, ownerId: filters.userId }}
        onChange={onFilterBar}
      />
    </div>
  );

  const columns = [
    {
      label: 'Activity',
      render: (row) => (
        <div className="row" style={{ gap: '10px' }}>
          <span
            style={{
              width: '28px', height: '28px', borderRadius: '8px', display: 'grid', placeItems: 'center',
              background: 'var(--surface-3)', color: 'var(--ink-2)', flex: '0 0 28px',
            }}
          >
            <Icon name={ACTIVITY_ICONS[row.type] || 'info'} size={14} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="cell-main truncate">{row.subject || titleCase(row.type)}</div>
            {row.body ? <div className="cell-sub truncate">{row.body}</div> : null}
          </div>
        </div>
      ),
    },
    { label: 'Type', render: (row) => <span className="badge">{titleCase(row.type)}</span> },
    {
      label: 'Related to',
      render: (row) => {
        if (row.lead) return <LinkTo to={`/leads/${row.lead.id}`}>{fullName(row.lead)}</LinkTo>;
        // Contacts were removed from this edition, so there is no page to
        // link a legacy contact activity to; show the name only.
        if (row.contact) return <span>{fullName(row.contact)}</span>;
        return <span className="muted">—</span>;
      },
    },
    {
      label: 'By',
      cellClass: 'hide-sm',
      render: (row) =>
        row.user ? (
          <div className="row" style={{ gap: '7px' }}>
            <Avatar name={`${row.user.firstName} ${row.user.lastName || ''}`} size="sm" url={row.user.avatarUrl} />
            <span className="truncate">{fullName(row.user)}</span>
          </div>
        ) : (
          <span className="badge">System</span>
        ),
    },
    {
      label: 'Outcome',
      cellClass: 'hide-sm',
      render: (row) => (row.outcome ? <span className="badge badge-info">{titleCase(row.outcome)}</span> : '—'),
    },
    {
      label: 'Duration',
      cellClass: 'right hide-sm',
      render: (row) => (row.durationSec ? duration(row.durationSec) : '—'),
    },
    {
      label: 'When',
      render: (row) => (
        <span className="small muted" title={dateTime(row.occurredAt)}>
          {relative(row.occurredAt)}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHead
        title="Activity Feed"
        subtitle="Every call, email, meeting and system event you are allowed to see."
      />
      <div className="mb-16">{summary ? <CommunicationSummary data={summary} /> : null}</div>
      <DataTable
        toolbar={toolbar}
        params={filters}
        load={(params) => api.get('/api/activities', params)}
        emptyTitle="No activity in this window"
        emptyMessage="Widen the date range or clear the type filter."
        columns={columns}
      />
    </div>
  );
}

function CommunicationSummary({ data }) {
  const total = data.byChannel.reduce((sum, c) => sum + c.count, 0);
  const directionCount = (direction) => data.byDirection.find((d) => d.direction === direction)?.count || 0;
  const outcomeCount = (outcome) => data.callOutcomes.find((o) => o.outcome === outcome)?.count || 0;

  return (
    <>
      <div className="kpi-grid mb-16">
        <KpiCard
          label="Interactions"
          value={number(total)}
          foot="Calls, emails, meetings and messages"
          accent={PALETTE[0]}
        />
        <KpiCard
          label="Call time"
          value={duration(data.totalCallSeconds)}
          foot={`Average ${duration(data.averageCallSeconds)}`}
          accent={PALETTE[1]}
        />
        <KpiCard
          label="Outbound"
          value={number(directionCount('OUTBOUND'))}
          foot={`${number(directionCount('INBOUND'))} inbound`}
          accent={PALETTE[3]}
        />
        <KpiCard
          label="Connected calls"
          value={number(outcomeCount('CONNECTED'))}
          foot={`${number(outcomeCount('NO_ANSWER'))} no answer`}
          accent={PALETTE[2]}
        />
      </div>
      <div className="chart-grid two">
        <Panel title="Channel mix">
          {data.byChannel.length ? (
            <DonutChart
              slices={data.byChannel.map((c) => ({ label: titleCase(c.channel), value: c.count }))}
              centerLabel="Interactions"
            />
          ) : (
            <EmptyState title="No interactions logged" />
          )}
        </Panel>
        <Panel title="Call outcomes">
          {data.callOutcomes.length ? (
            <BarList rows={data.callOutcomes.map((o) => ({ label: titleCase(o.outcome), value: o.count }))} />
          ) : (
            <EmptyState title="No calls logged" />
          )}
        </Panel>
      </div>
    </>
  );
}
