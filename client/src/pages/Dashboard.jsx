import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { date, money, number, percent, relative, titleCase } from '../lib/format.js';
import Icon, { ACTIVITY_ICONS } from '../components/Icon.jsx';
import { BarList, DonutChart, FunnelChart, LineChart, PALETTE } from '../components/charts.jsx';
import { FilterBar, LinkTo, NoAccess, PageHead, Panel } from '../components/shared.jsx';
import { Avatar, EmptyState, KpiCard, PageLoader, reportError } from '../components/ui/index.js';

/**
 * Dashboard: KPI row, lead trend, leads by project, source performance, the
 * enquiry-to-booking funnel, team leaderboard, recent activity and the
 * follow-up queue. Port of the PHP edition's `views/dashboard.js`.
 *
 * Every number here comes from /api/reports/dashboard, which applies the same
 * visibility rules as the lists - so a Team Leader's totals reconcile exactly
 * with the leads they can open.
 */
const DASHBOARD_FILTERS = ['range', 'project', 'owner', 'team', 'source'];

const SCOPE_DESCRIPTIONS = {
  OWN: 'Your own records',
  TEAM: 'Your team',
  TEAM_AND_BELOW: 'Your teams and everything below',
  REGION: 'Your region',
  ORGANIZATION: 'Organisation-wide',
  ALL: 'Full platform access',
};

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/**
 * The range defaults to the last 30 days when the URL names none, which is
 * also how "All time" (an empty range) is written to the URL - so the page
 * keeps its filters in state and only re-reads the URL when somebody else
 * changed it (a link, the sidebar), exactly as the original kept them in
 * memory and replaced the hash behind itself.
 */
function filtersFromSearch(search) {
  const q = new URLSearchParams(search);
  return {
    range: q.get('range') || 'last_30_days',
    ownerId: q.get('ownerId') || '',
    teamId: q.get('teamId') || '',
    sourceId: q.get('sourceId') || '',
    projectId: q.get('projectId') || '',
  };
}

const personName = (p) => `${p.firstName} ${p.lastName || ''}`.trim();

export default function Dashboard() {
  const { can } = useAuth();
  if (!can('dashboard', 'read')) return <NoAccess what="the dashboard" />;
  return <DashboardPage />;
}

function DashboardPage() {
  const { user, organization } = useAuth();
  const navigate = useNavigate();
  const { search } = useLocation();
  const [filters, setFilters] = useState(() => filtersFromSearch(search));
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  // The search string this page wrote itself; anything else came from outside.
  const written = useRef(search);
  useEffect(() => {
    if (written.current === search) return;
    written.current = search;
    setFilters(filtersFromSearch(search));
  }, [search]);

  const filtersKey = JSON.stringify(filters);
  const token = useRef(0);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    const mine = ++token.current;
    setState({ status: 'loading', data: null, error: null });
    try {
      const res = await api.get('/api/reports/dashboard', JSON.parse(filtersKey));
      if (mine !== token.current) return;
      loadedOnce.current = true;
      setState({ status: 'ready', data: res.data, error: null });
    } catch (err) {
      if (mine !== token.current) return;
      reportError(err);
      setState({ status: 'error', data: null, error: err });
    }
  }, [filtersKey]);

  useEffect(() => {
    load();
    return () => {
      token.current += 1;
    };
  }, [load]);

  const applyFilters = (patch) => {
    const next = { ...filters, ...patch };
    const params = new URLSearchParams(Object.entries(next).filter(([, v]) => v));
    const nextSearch = params.toString() ? `?${params}` : '';
    written.current = nextSearch;
    setFilters(next);
    navigate({ search: nextSearch }, { replace: true });
  };

  let body;
  if (state.status === 'loading') {
    body = <PageLoader label={loadedOnce.current ? 'Loading' : 'Building your dashboard'} />;
  } else if (state.status === 'error') {
    body = (
      <div className="card">
        <EmptyState
          iconName="alert"
          title="Dashboard unavailable"
          message={state.error.message}
          action={
            <button type="button" className="btn" onClick={() => load()}>
              Try again
            </button>
          }
        />
      </div>
    );
  } else {
    body = <DashboardBody data={state.data} filters={filters} />;
  }

  return (
    <div>
      <PageHead
        title={`Good ${greeting()}, ${user.firstName}`}
        subtitle={`${organization?.name} · ${user.role?.name} · ${SCOPE_DESCRIPTIONS[user.role?.dataScope] || ''}`}
        actions={
          <div className="row wrap filter-row" style={{ gap: '8px' }}>
            <FilterBar filters={DASHBOARD_FILTERS} current={filters} onChange={applyFilters} />
            <button type="button" className="btn btn-sm" onClick={() => load()}>
              <Icon name="refresh" size={14} />
              Refresh
            </button>
          </div>
        }
      />
      <div>{body}</div>
    </div>
  );
}

function DashboardBody({ data, filters }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const k = data.kpis;

  // KPI tiles open the lead list with the same owner/team/range applied.
  const leadFilterQuery = (extra) => {
    const params = new URLSearchParams();
    if (filters.range) params.set('range', filters.range);
    if (filters.ownerId) params.set('ownerId', filters.ownerId);
    if (filters.teamId) params.set('teamId', filters.teamId);
    for (const [key, value] of Object.entries(extra || {})) params.set(key, value);
    return `/leads?${params.toString()}`;
  };

  const trendSeries = [
    { key: 'leads', label: 'Leads', color: PALETTE[0], values: data.trend.map((d) => d.leads) },
    { key: 'qualified', label: 'Qualified', color: PALETTE[1], values: data.trend.map((d) => d.qualified) },
    { key: 'converted', label: 'Converted', color: PALETTE[2], values: data.trend.map((d) => d.converted) },
  ];
  const trendLabels = data.trend.map((d) => date(d.date, { day: '2-digit', month: 'short', year: undefined }));

  return (
    <div>
      <div className="kpi-grid mb-16">
        <KpiCard
          label="Total leads"
          value={number(k.totalLeads)}
          iconName="leads"
          accent={PALETTE[0]}
          foot={`${number(k.newLeads)} new · ${number(k.unassignedLeads)} unassigned`}
          onClick={() => navigate(leadFilterQuery())}
        />
        <KpiCard
          label="Qualified"
          value={number(k.qualifiedLeads)}
          iconName="check"
          accent={PALETTE[1]}
          foot={`${percent(k.qualificationRate)} of all leads`}
        />
        <KpiCard
          label="Converted"
          value={number(k.convertedLeads)}
          iconName="star"
          accent={PALETTE[2]}
          foot={`${percent(k.conversionRate)} conversion rate`}
          onClick={() => navigate(leadFilterQuery({ converted: 'true' }))}
        />
        <KpiCard
          label="Site visits"
          value={number(k.siteVisitsBooked)}
          iconName="calendar"
          accent={PALETTE[3]}
          foot={`${number(k.siteVisitsUpcoming)} upcoming · ${percent(k.siteVisitRate)} of leads`}
        />
        <KpiCard
          label="Booking value"
          value={money(k.bookedValue, { compact: true })}
          iconName="trending"
          accent={PALETTE[2]}
          foot={`${number(k.bookings)} booking${k.bookings === 1 ? '' : 's'}`}
        />
        <KpiCard
          label="Follow-ups due"
          value={number(k.followUpsDue)}
          iconName="clock"
          accent={k.followUpsOverdue > 0 ? 'var(--danger)' : PALETTE[7]}
          foot={
            k.followUpsOverdue > 0 ? (
              <span className="text-danger strong">{`${number(k.followUpsOverdue)} overdue`}</span>
            ) : (
              'Nothing overdue'
            )
          }
          onClick={() => navigate(leadFilterQuery({ followUp: k.followUpsOverdue > 0 ? 'overdue' : 'today' }))}
        />
        <KpiCard
          label="Lost / junk"
          value={number(k.lostLeads + k.junkLeads)}
          iconName="close"
          accent={PALETTE[4]}
          foot={`${number(k.lostLeads)} lost · ${number(k.junkLeads)} junk`}
        />
      </div>

      <div className="chart-grid two mb-16">
        <Panel title="Lead trend" subtitle="Created, qualified and converted per day">
          {data.trend.length ? (
            <LineChart series={trendSeries} labels={trendLabels} height={250} />
          ) : (
            <EmptyState iconName="reports" title="No leads in this period" />
          )}
        </Panel>
        <Panel title="Lead status mix">
          {data.byStatus.length ? (
            <DonutChart
              slices={data.byStatus.map((s) => ({ label: s.label, value: s.count, color: s.color }))}
              centerLabel="Leads"
            />
          ) : (
            <EmptyState title="Nothing to show yet" />
          )}
        </Panel>
      </div>

      <div className="chart-grid two mb-16">
        <Panel
          title="Leads by project"
          subtitle="Where the enquiries are landing"
          action={can('projects', 'read') ? <LinkTo to="/projects" className="btn btn-sm">All projects</LinkTo> : null}
        >
          {data.byProject?.length ? (
            <BarList rows={data.byProject.map((p) => ({ label: p.label, value: p.count }))} />
          ) : (
            <EmptyState
              iconName="building"
              title="No project attribution yet"
              message="Attach leads to a project to see which inventory is pulling."
            />
          )}
        </Panel>
        <Panel title="Conversion funnel" subtitle="Enquiry to booking">
          <FunnelChart steps={data.funnel} />
        </Panel>
      </div>

      <div className="chart-grid two mb-16">
        <Panel
          title="Lead sources"
          subtitle="Where your leads come from"
          action={can('reports', 'read') ? <LinkTo to="/reports" className="btn btn-sm">Full report</LinkTo> : null}
        >
          {data.bySource.length ? (
            <BarList rows={data.bySource.map((s) => ({ label: s.label, value: s.count }))} />
          ) : (
            <EmptyState title="No source data" />
          )}
        </Panel>
        <Panel title="Leads by owner">
          {data.byOwner.length ? (
            <BarList
              rows={data.byOwner.map((s) => ({ label: s.label, value: s.count }))}
              colorFn={(_, i) => PALETTE[(i + 3) % PALETTE.length]}
            />
          ) : (
            <EmptyState title="No owner data" />
          )}
        </Panel>
      </div>

      <div className="mb-16">
        <Panel title="Team leaderboard" subtitle="Ranked by closed-won revenue" flush>
          {data.leaderboard.length ? <Leaderboard rows={data.leaderboard} /> : <EmptyState iconName="users" title="No performance data yet" />}
        </Panel>
      </div>

      <div className="chart-grid two">
        <Panel
          title="Recent activity"
          action={can('activities', 'read') ? <LinkTo to="/activities" className="btn btn-sm">See all</LinkTo> : null}
        >
          {data.recentActivities.length ? (
            <div className="timeline">
              {data.recentActivities.map((a, i) => (
                <div key={i} className="tl-item">
                  <div className="tl-dot">
                    <Icon name={ACTIVITY_ICONS[a.type] || 'info'} size={11} />
                  </div>
                  <div className="tl-head">
                    <span className="tl-title">{a.subject || titleCase(a.type)}</span>
                    <span className="tl-time">{relative(a.occurredAt)}</span>
                  </div>
                  {a.lead ? (
                    <div className="tl-body">
                      <LinkTo to={`/leads/${a.lead.id}`}>{personName(a.lead)}</LinkTo>
                      {a.user ? ` · ${a.user.firstName} ${a.user.lastName || ''}`.trimEnd() : ''}
                    </div>
                  ) : a.user ? (
                    <div className="tl-body muted">{personName(a.user)}</div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState iconName="activity" title="No activity yet" />
          )}
        </Panel>

        {/* The work queue is leads that are due, now that follow-ups live on the lead. */}
        <Panel
          title="Follow-ups due"
          action={can('leads', 'read') ? <LinkTo to="/leads?followUp=today" className="btn btn-sm">All follow-ups</LinkTo> : null}
        >
          {data.upcomingFollowUps?.length ? (
            <div className="col" style={{ gap: '10px' }}>
              {data.upcomingFollowUps.map((l) => {
                const overdue = l.dueAt && new Date(l.dueAt) < new Date();
                return (
                  <Link
                    key={l.id}
                    to={`/leads/${l.id}`}
                    className="row"
                    style={{ gap: '10px', alignItems: 'flex-start', textDecoration: 'none', color: 'inherit' }}
                  >
                    <span
                      className="badge"
                      style={{
                        background: overdue ? 'var(--danger-bg)' : 'var(--surface-3)',
                        color: overdue ? 'var(--danger)' : 'var(--ink-3)',
                        flex: '0 0 auto',
                      }}
                    >
                      {overdue ? 'Overdue' : relative(l.dueAt)}
                    </span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="truncate strong">{l.name || l.code}</div>
                      <div className="cell-sub truncate">
                        {[l.projectName, l.phone, l.owner ? personName(l.owner) : null].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : (
            <EmptyState iconName="check" title="Nothing due" message="No follow-ups are scheduled." />
          )}
        </Panel>
      </div>
    </div>
  );
}

function Leaderboard({ rows }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>#</th>
            <th>Person</th>
            <th className="right">Leads</th>
            <th className="right hide-sm">Activities</th>
            <th className="right">Converted</th>
            <th className="right hide-sm">Conv. rate</th>
            <th className="right">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id ?? i}>
              <td className="muted">{String(i + 1)}</td>
              <td>
                <div className="row" style={{ gap: '8px' }}>
                  <Avatar name={row.name} size="sm" url={row.avatarUrl} />
                  <div>
                    <div className="cell-main">{row.name}</div>
                    <div className="cell-sub truncate">{row.email}</div>
                  </div>
                </div>
              </td>
              <td className="right">{number(row.leads)}</td>
              <td className="right hide-sm">{number(row.activities)}</td>
              <td className="right">{number(row.converted)}</td>
              <td className="right hide-sm">{percent(row.conversionRate)}</td>
              <td className="right strong">{money(row.revenue, { compact: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
