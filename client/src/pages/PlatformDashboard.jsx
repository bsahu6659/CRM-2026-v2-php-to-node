/**
 * Super Admin dashboard: the whole platform at a glance.
 * Port of the PHP edition's `views/platformDashboard.js`.
 *
 * The setup-status table is the one that earns its place - it answers "which
 * client signed up and never finished configuring their messaging", which is
 * the difference between a client who sees value in week one and one who
 * churns.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import { number, titleCase } from '../lib/format.js';
import { switchToClient } from '../lib/tenant.js';
import { useAuth } from '../context/AuthContext.jsx';
import Icon from '../components/Icon.jsx';
import { BarList } from '../components/charts.jsx';
import { NoAccess, PageHead, Panel } from '../components/shared.jsx';
import { KpiCard, PageLoader, openOverlay } from '../components/ui/index.js';
import { ChannelDot, ClientWizard } from './Clients.jsx';

export default function PlatformDashboard() {
  const { isPlatformAdmin } = useAuth();
  if (!isPlatformAdmin()) return <NoAccess what="the platform administration area" />;
  return <PlatformDashboardPage />;
}

function PlatformDashboardPage() {
  const navigate = useNavigate();
  const [state, setState] = useState({ status: 'loading', overview: null, automation: null, error: null });

  const load = useCallback(async (signal) => {
    try {
      const [overview, automation] = await Promise.all([
        api.data('/api/platform/overview', undefined, { signal }),
        api.data('/api/platform/automation', undefined, { signal }),
      ]);
      setState({ status: 'ready', overview, automation, error: null });
    } catch (err) {
      if (err.name === 'AbortError') return;
      setState({ status: 'error', overview: null, automation: null, error: err });
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  if (state.status === 'loading') {
    return (
      <div>
        <PageLoader label="Loading platform overview" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div>
        <div className="card">
          <div className="alert danger">{state.error.message}</div>
        </div>
      </div>
    );
  }

  const { overview, automation } = state;

  const typeRows = Object.entries(overview.clients.byType)
    .map(([key, value]) => ({ label: titleCase(key), value }))
    .filter((r) => r.value > 0);

  // Setup status. Sorted so the clients who need attention float to the top.
  const rank = { ORANGE: 0, RED: 1, GREEN: 2 };
  const sorted = [...automation].sort((a, b) => {
    const aWorst = Math.min(rank[a.whatsapp.status] ?? 3, rank[a.email.status] ?? 3);
    const bWorst = Math.min(rank[b.whatsapp.status] ?? 3, rank[b.email.status] ?? 3);
    return aWorst - bWorst;
  });
  const needsAttention = automation.filter((c) => c.whatsapp.status === 'ORANGE' || c.email.status === 'ORANGE').length;

  return (
    <div>
      <PageHead
        title="Platform overview"
        subtitle="Every client company, project and lead across Growvanta."
        actions={[
          <button
            key="create"
            type="button"
            className="btn btn-primary"
            onClick={() => openOverlay((close) => <ClientWizard onClose={close} onSaved={() => load()} />)}
          >
            <Icon name="plus" size={15} />
            Create new client
          </button>,
        ]}
      />

      <div className="kpi-grid">
        <KpiCard
          label="Client companies"
          value={number(overview.clients.total)}
          foot={`${number(overview.clients.active)} active · ${number(overview.clients.suspended)} suspended`}
          iconName="building"
          onClick={() => navigate('/clients')}
        />
        {/* A lead always belongs to one company, so there is no platform-wide
            lead list to open. The client table is where this total is actually
            broken down - it carries a Leads column per company - so that is
            the target. */}
        <KpiCard
          label="Total leads"
          value={number(overview.leads.total)}
          foot={`${number(overview.leads.today)} today · ${number(overview.leads.thisMonth)} this month`}
          iconName="leads"
          onClick={() => navigate('/clients')}
        />
        <KpiCard
          label="Projects"
          value={number(overview.projects.total)}
          foot={`${number(overview.projects.global)} global · ${number(overview.projects.shared)} shared`}
          iconName="briefcase"
          onClick={() => navigate('/projects')}
        />
        {/* Same reason: the sidebar's Users screen lists this company's own
            people, not everybody's. The per-company count lives in the client
            table. */}
        <KpiCard
          label="Users"
          value={number(overview.users)}
          foot="Active across every company"
          iconName="users"
          onClick={() => navigate('/clients')}
        />
      </div>

      <div className="chart-grid">
        <Panel title="Clients by type">
          {typeRows.length ? <BarList rows={typeRows} /> : <div className="muted small">No clients yet.</div>}
        </Panel>
        <Panel title="Leads by client">
          {overview.leadsByClient?.length ? (
            <BarList rows={overview.leadsByClient.map((r) => ({ label: r.name, value: Number(r.total) }))} />
          ) : (
            <div className="muted small">No leads yet.</div>
          )}
        </Panel>
      </div>

      <div className="chart-grid">
        <Panel title="Leads by source">
          {overview.leadsBySource?.length ? (
            <BarList rows={overview.leadsBySource.map((r) => ({ label: r.name, value: Number(r.total) }))} />
          ) : (
            <div className="muted small">No leads yet.</div>
          )}
        </Panel>
        <Panel title="Leads by project">
          {overview.leadsByProject?.length ? (
            <BarList rows={overview.leadsByProject.map((r) => ({ label: r.name, value: Number(r.total) }))} />
          ) : (
            <div className="muted small">No leads attributed to a project yet.</div>
          )}
        </Panel>
      </div>

      <Panel
        title="Client setup status"
        subtitle={
          needsAttention
            ? `${needsAttention} client${needsAttention === 1 ? '' : 's'} switched a channel on but have not finished setting it up.`
            : 'Nobody is stuck mid-setup.'
        }
        flush
      >
        {/* `data` is not decoration: the stacked-card layout that narrow
            screens use is keyed on table.data, and the per-cell data-label is
            what it prints as each row's heading once the thead is hidden. */}
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Company</th>
                <th>Type</th>
                <th>WhatsApp</th>
                <th>Email</th>
                <th>Outstanding</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => {
                const outstanding = [...(c.whatsapp.missing || []), ...(c.email.missing || [])];
                return (
                  <tr key={c.id}>
                    <td data-label="Company">
                      <Link to={`/clients/${c.id}`}>{c.name}</Link>
                    </td>
                    <td data-label="Type">
                      <span className="badge">{titleCase(c.companyType)}</span>
                    </td>
                    <td data-label="WhatsApp">
                      <ChannelDot status={c.whatsapp.status} label={titleCase(c.whatsapp.status)} />
                    </td>
                    <td data-label="Email">
                      <ChannelDot status={c.email.status} label={titleCase(c.email.status)} />
                    </td>
                    <td data-label="Outstanding">
                      <span className="tiny muted">
                        {/* Only a channel that is switched on but unfinished is a
                            problem worth chasing; one that is deliberately off
                            is a choice. */}
                        {outstanding.length && (c.whatsapp.status === 'ORANGE' || c.email.status === 'ORANGE')
                          ? `${outstanding.length} item${outstanding.length === 1 ? '' : 's'} left`
                          : '—'}
                      </span>
                    </td>
                    <td data-label="">
                      <button type="button" className="btn btn-sm" onClick={() => switchToClient(c.id, c.name)}>
                        Open CRM
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
