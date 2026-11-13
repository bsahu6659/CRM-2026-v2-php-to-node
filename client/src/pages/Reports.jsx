/**
 * Reports: lead and source analytics with a shared filter bar and CSV
 * export for each tabular report. Port of the PHP edition's `js/views/reports.js`.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { loadReference } from '../lib/reference.js';
import { money, number, percent, date } from '../lib/format.js';
import Icon from '../components/Icon.jsx';
import { BarList, DonutChart, LineChart, PALETTE } from '../components/charts.jsx';
import { PageHead, FilterBar, NoAccess, Panel } from '../components/shared.jsx';
import { EmptyState, KpiCard, PageLoader, Select, Tabs, reportError, toast } from '../components/ui/index.js';

const TABS = [
  { key: 'leads', label: 'Lead reports' },
  { key: 'marketing', label: 'Marketing & attribution' },
];

export default function Reports() {
  const { can } = useAuth();
  if (!can('reports', 'read')) return <NoAccess what="reports" />;
  return <ReportsPage />;
}

/**
 * The report state lives in the URL, as the original's syncHash() kept it
 * there. `range` is special: its default (last 30 days) applies only when the
 * key is absent, and "All time" is written as an explicit empty `range=` -
 * otherwise dropping the empty value would silently turn it back into the
 * default.
 */
function useReportQuery() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab = TABS.some((t) => t.key === tabParam) ? tabParam : 'leads';
  const dimension = searchParams.get('dimension') || 'source';
  const filters = {
    range: searchParams.has('range') ? searchParams.get('range') : 'last_30_days',
    ownerId: searchParams.get('ownerId') || '',
    teamId: searchParams.get('teamId') || '',
    sourceId: searchParams.get('sourceId') || '',
    projectId: searchParams.get('projectId') || '',
  };

  const update = useCallback(
    (patch) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (key === 'range') next.set('range', value || '');
            else if (value) next.set(key, value);
            else next.delete(key);
          }
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  return { tab, dimension, filters, update };
}

function ReportsPage() {
  const { can } = useAuth();
  const { tab, dimension, filters, update } = useReportQuery();

  // Bumped where the original called load() without changing any state (a
  // click on the active tab).
  const [tick, setTick] = useState(0);
  const loadKey = JSON.stringify({ tab, dimension, filters, tick });
  const [view, setView] = useState({ key: null, status: 'loading', data: null, error: null });

  useEffect(() => {
    const ctrl = new AbortController();
    const { signal } = ctrl;
    const req = JSON.parse(loadKey);
    setView({ key: loadKey, status: 'loading', data: null, error: null });
    (async () => {
      try {
        let data;
        if (req.tab === 'leads') {
          const ref = await loadReference();
          const [report, trend] = await Promise.all([
            api.data('/api/reports/leads', { ...req.filters, dimension: req.dimension }, { signal }),
            api.data('/api/reports/trend', req.filters, { signal }),
          ]);
          data = { dimensions: ref.dimensions || [], report, trend };
        } else {
          data = await api.data('/api/reports/marketing', req.filters, { signal });
        }
        if (!signal.aborted) setView({ key: loadKey, status: 'ready', data, error: null });
      } catch (err) {
        if (signal.aborted) return;
        reportError(err);
        setView({ key: loadKey, status: 'error', data: null, error: err });
      }
    })();
    return () => ctrl.abort();
  }, [loadKey]);

  const current = view.key === loadKey ? view : { status: 'loading' };

  let body;
  if (current.status === 'loading') {
    body = <PageLoader label="Crunching numbers" />;
  } else if (current.status === 'error') {
    body = (
      <div className="card">
        <EmptyState iconName="alert" title="Report unavailable" message={current.error?.message} />
      </div>
    );
  } else if (tab === 'leads') {
    body = (
      <LeadReports data={current.data} dimension={dimension} onDimension={(value) => update({ dimension: value })} />
    );
  } else {
    body = <MarketingReports data={current.data} />;
  }

  const actions = [
    <div key="filters" className="row wrap filter-row" style={{ gap: '8px' }}>
      <FilterBar
        filters={['range', 'project', 'owner', 'team', 'source']}
        current={filters}
        onChange={(patch) => update(patch)}
      />
    </div>,
    can('reports', 'export') ? (
      <button
        key="export"
        type="button"
        className="btn"
        onClick={() =>
          api
            .download(`/api/reports/export/${tab === 'marketing' ? 'marketing' : tab}`, { ...filters, dimension })
            .then(() => toast.success('Report exported'))
            .catch(reportError)
        }
      >
        <Icon name="download" size={15} />
        Export CSV
      </button>
    ) : null,
  ].filter(Boolean);

  return (
    <div>
      <PageHead title="Reports & Analytics" subtitle="Everything filtered to what your role can see." actions={actions} />
      <div className="mb-16">
        <Tabs
          items={TABS}
          active={tab}
          onSelect={(key) => {
            update({ tab: key });
            setTick((t) => t + 1);
          }}
        />
      </div>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lead reports
// ---------------------------------------------------------------------------

function LeadReports({ data, dimension, onDimension }) {
  const { report, trend, dimensions } = data;

  const totals = report.rows.reduce(
    (acc, r) => ({
      leads: acc.leads + r.leads,
      qualified: acc.qualified + r.qualified,
      converted: acc.converted + r.converted,
      value: acc.value + r.expectedValue,
    }),
    { leads: 0, qualified: 0, converted: 0, value: 0 }
  );

  const dimensionSelect = (
    <Select
      options={dimensions.map((d) => ({ value: d.key, label: d.label }))}
      value={dimension}
      onChange={(e) => onDimension(e.target.value)}
    />
  );

  const dimLabel = report.dimensionLabel.toLowerCase();

  return (
    <div>
      <div className="kpi-grid mb-16">
        <KpiCard label="Leads" value={number(totals.leads)} accent={PALETTE[0]} />
        <KpiCard
          label="Qualified"
          value={number(totals.qualified)}
          foot={percent(totals.leads ? (totals.qualified / totals.leads) * 100 : 0)}
          accent={PALETTE[1]}
        />
        <KpiCard
          label="Converted"
          value={number(totals.converted)}
          foot={percent(totals.leads ? (totals.converted / totals.leads) * 100 : 0)}
          accent={PALETTE[2]}
        />
        <KpiCard label="Expected value" value={money(totals.value, { compact: true })} accent={PALETTE[3]} />
      </div>

      <div className="chart-grid two mb-16">
        <Panel title="Lead trend">
          {trend.length ? (
            <LineChart
              series={[
                { key: 'leads', label: 'Leads', color: PALETTE[0], values: trend.map((d) => d.leads) },
                { key: 'qualified', label: 'Qualified', color: PALETTE[1], values: trend.map((d) => d.qualified) },
                { key: 'converted', label: 'Converted', color: PALETTE[2], values: trend.map((d) => d.converted) },
              ]}
              labels={trend.map((d) => date(d.date, { day: '2-digit', month: 'short', year: undefined }))}
              height={250}
            />
          ) : (
            <EmptyState title="No leads in this window" />
          )}
        </Panel>
        <Panel title={`Share by ${dimLabel}`}>
          {report.rows.length ? (
            <DonutChart
              slices={report.rows.slice(0, 8).map((r) => ({ label: r.label, value: r.leads }))}
              centerLabel="Leads"
            />
          ) : (
            <EmptyState title="No data" />
          )}
        </Panel>
      </div>

      <Panel title={`Leads by ${dimLabel}`} action={dimensionSelect} flush>
        {report.rows.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{report.dimensionLabel}</th>
                  <th className="right">Leads</th>
                  <th className="right">Qualified</th>
                  <th className="right">Site visits</th>
                  <th className="right">Converted</th>
                  <th className="right hide-sm">Qual. rate</th>
                  <th className="right">Conv. rate</th>
                  <th className="right hide-sm">Expected value</th>
                  <th className="right hide-sm">Share</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r, i) => (
                  <tr key={r.key ?? `${r.label}-${i}`}>
                    <td className="cell-main">{r.label}</td>
                    <td className="right">{number(r.leads)}</td>
                    <td className="right">{number(r.qualified)}</td>
                    <td className="right">{number(r.siteVisits)}</td>
                    <td className="right">{number(r.converted)}</td>
                    <td className="right hide-sm">{percent(r.qualificationRate)}</td>
                    <td className="right">
                      <span className={r.conversionRate >= 20 ? 'text-success strong' : ''}>{percent(r.conversionRate)}</span>
                    </td>
                    <td className="right hide-sm">{money(r.expectedValue, { compact: true })}</td>
                    <td className="right hide-sm muted">{percent(r.share)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No leads match these filters" />
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source performance. Campaign objects are gone, so attribution is grouped by
// lead source, by UTM campaign, and by project.
// ---------------------------------------------------------------------------

function MarketingReports({ data }) {
  const t = data.totals;

  return (
    <div>
      <div className="kpi-grid mb-16">
        <KpiCard label="Marketing spend" value={money(t.spend, { compact: true })} accent={PALETTE[3]} />
        <KpiCard label="Leads generated" value={number(t.leads)} accent={PALETTE[0]} />
        <KpiCard label="Blended cost per lead" value={money(t.costPerLead)} accent={PALETTE[5]} />
        <KpiCard label="Booking value" value={money(t.revenue, { compact: true })} accent={PALETTE[2]} />
        <KpiCard
          label="Return on spend"
          value={t.roi === null ? '—' : percent(t.roi, 0)}
          accent={t.roi >= 0 ? PALETTE[2] : PALETTE[4]}
        />
      </div>

      <Panel title="Lead source performance" flush>
        {data.sources.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="right hide-sm">Spend</th>
                  <th className="right">Leads</th>
                  <th className="right hide-sm">Qualified</th>
                  <th className="right">Site visits</th>
                  <th className="right">Bookings</th>
                  <th className="right hide-sm">Cost / lead</th>
                  <th className="right hide-sm">Cost / booking</th>
                  <th className="right">Conv. %</th>
                  <th className="right hide-sm">ROI %</th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((r, i) => (
                  <tr key={r.sourceId ?? `${r.label}-${i}`}>
                    <td className="cell-main">{r.label}</td>
                    <td className="right hide-sm">{r.spend ? money(r.spend, { compact: true }) : '—'}</td>
                    <td className="right">{number(r.leads)}</td>
                    <td className="right hide-sm">{number(r.qualified)}</td>
                    <td className="right">{number(r.siteVisits)}</td>
                    <td className="right strong">{number(r.converted)}</td>
                    <td className="right hide-sm">{r.costPerLead ? money(r.costPerLead) : '—'}</td>
                    <td className="right hide-sm">{r.costPerBooking ? money(r.costPerBooking) : '—'}</td>
                    <td className="right">{percent(r.conversionRate)}</td>
                    <td className={`right hide-sm ${r.roi !== null && r.roi >= 0 ? 'text-success strong' : ''}`}>
                      {r.roi === null ? '—' : percent(r.roi, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No source data" message="Attribute leads to a source to populate this report." />
        )}
      </Panel>

      <div className="chart-grid two mt-16">
        <Panel title="Ad campaigns (UTM)" subtitle="From the utm_campaign on each lead" flush>
          {data.campaigns.length ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Source</th>
                    <th className="right">Leads</th>
                    <th className="right">Booked</th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaigns.map((c, i) => (
                    <tr key={`${c.label}-${c.source}-${i}`}>
                      <td className="cell-main truncate">{c.label}</td>
                      <td className="muted small">{c.source}</td>
                      <td className="right">{number(c.leads)}</td>
                      <td className="right strong">{number(c.converted)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No UTM campaigns" message="Tag your ad URLs with utm_campaign to see them here." />
          )}
        </Panel>

        <Panel title="Projects" subtitle="Enquiries per project">
          {data.projects.length ? (
            <BarList rows={data.projects.map((p) => ({ label: p.label, value: p.leads }))} />
          ) : (
            <EmptyState title="No project attribution" />
          )}
        </Panel>
      </div>
    </div>
  );
}
