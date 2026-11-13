/**
 * Performance & targets: activity volume, conversion and revenue per person,
 * compared against the targets a manager has set.
 * Port of the PHP edition's `js/views/performance.js`.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { loadReference } from '../lib/reference.js';
import { money, number, percent, date, titleCase } from '../lib/format.js';
import Icon from '../components/Icon.jsx';
import { BarList, ColumnChart, PALETTE } from '../components/charts.jsx';
import { PageHead, FilterBar, NoAccess, Panel } from '../components/shared.jsx';
import {
  Avatar,
  BusyButton,
  EmptyState,
  Field,
  Input,
  Modal,
  PageLoader,
  ProgressBar,
  Select,
  Tabs,
  reportError,
  toast,
  useConfirm,
} from '../components/ui/index.js';

const METRICS = ['LEADS', 'CALLS', 'MEETINGS', 'QUALIFIED', 'OPPORTUNITIES', 'CONVERSIONS', 'REVENUE'];

const PERIODS = [
  { value: 'MONTH', label: 'This month' },
  { value: 'QUARTER', label: 'This quarter' },
  { value: 'YEAR', label: 'This year' },
];

const TABS = [
  { key: 'people', label: 'By person' },
  { key: 'targets', label: 'Targets' },
];

/** Bar tone for an attainment percentage: met, badly behind, or in between. */
const attainmentTone = (attainment) => (attainment >= 100 ? 'success' : attainment < 50 ? 'danger' : 'warning');

export default function Performance() {
  const { can } = useAuth();
  if (!can('reports', 'read') && !can('targets', 'read')) return <NoAccess what="performance reports" />;
  return <PerformancePage />;
}

/**
 * Tab and filters live in the URL. As on Reports, the default range (this
 * month) applies only when `range` is absent; "All time" is kept as an
 * explicit empty `range=` so the default does not take it back.
 */
function usePerformanceQuery() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'targets' ? 'targets' : 'people';
  const filters = {
    range: searchParams.has('range') ? searchParams.get('range') : 'this_month',
    teamId: searchParams.get('teamId') || '',
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

  return { tab, filters, update };
}

function PerformancePage() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { tab, filters, update } = usePerformanceQuery();

  // Bumped where the original re-ran load() with unchanged state (after a
  // delete, after saving targets, on a click on the active tab).
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // { users } while the "Set targets" dialog is open.
  const [targetForm, setTargetForm] = useState(null);

  const loadKey = JSON.stringify({ tab, filters, tick });
  const [view, setView] = useState({ key: null, status: 'loading', data: null, error: null });

  useEffect(() => {
    const req = JSON.parse(loadKey);
    // Without targets:read the Targets tab is a static "no access" card; nothing to fetch.
    if (req.tab === 'targets' && !can('targets', 'read')) {
      setView({ key: loadKey, status: 'ready', data: null, error: null });
      return undefined;
    }
    const ctrl = new AbortController();
    const { signal } = ctrl;
    setView({ key: loadKey, status: 'loading', data: null, error: null });
    const path = req.tab === 'targets' ? '/api/targets' : '/api/reports/performance';
    api
      .data(path, req.filters, { signal })
      .then((rows) => {
        if (!signal.aborted) setView({ key: loadKey, status: 'ready', data: rows, error: null });
      })
      .catch((err) => {
        if (signal.aborted) return;
        reportError(err);
        setView({ key: loadKey, status: 'error', data: null, error: err });
      });
    return () => ctrl.abort();
    // `can` is stable for the session; loadKey carries everything that changes.
  }, [loadKey]);

  // The original fetched reference data before opening the dialog.
  async function openTargetForm() {
    const ref = await loadReference();
    setTargetForm({ users: ref.users });
  }

  const current = view.key === loadKey ? view : { status: 'loading' };

  let body;
  if (current.status === 'loading') {
    body = <PageLoader />;
  } else if (current.status === 'error') {
    body = (
      <div className="card">
        <EmptyState iconName="alert" title="Unavailable" message={current.error?.message} />
      </div>
    );
  } else if (tab === 'targets') {
    body = (
      <TargetsTab
        rows={current.data}
        can={can}
        confirm={confirm}
        reload={reload}
        onSetTargets={openTargetForm}
      />
    );
  } else {
    body = <PeopleTab rows={current.data} />;
  }

  const actions = [
    <div key="filters" className="row wrap filter-row" style={{ gap: '8px' }}>
      <FilterBar filters={['range', 'team']} current={filters} onChange={(patch) => update(patch)} />
    </div>,
    can('targets', 'create') ? (
      <button key="targets" type="button" className="btn btn-primary" onClick={openTargetForm}>
        <Icon name="target" size={15} />
        Set targets
      </button>
    ) : null,
    can('reports', 'export') ? (
      <button
        key="export"
        type="button"
        className="btn"
        onClick={() =>
          api
            .download('/api/reports/export/performance', filters)
            .then(() => toast.success('Exported'))
            .catch(reportError)
        }
      >
        <Icon name="download" size={15} />
        Export
      </button>
    ) : null,
  ].filter(Boolean);

  return (
    <div>
      <PageHead title="Performance" subtitle="Individual and team output against target." actions={actions} />
      <div className="mb-16">
        <Tabs
          items={TABS}
          active={tab}
          onSelect={(key) => {
            update({ tab: key });
            reload();
          }}
        />
      </div>
      {body}

      {targetForm ? (
        <TargetForm
          users={targetForm.users}
          onClose={() => setTargetForm(null)}
          onSaved={() => {
            update({ tab: 'targets' });
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// By person
// ---------------------------------------------------------------------------

function PeopleTab({ rows }) {
  if (!rows.length) {
    return (
      <div className="card">
        <EmptyState
          iconName="users"
          title="No performance data"
          message="Nobody in your scope has recorded activity in this period."
        />
      </div>
    );
  }

  const chartGroups = rows.slice(0, 10).map((r) => ({
    label: r.name.split(' ')[0],
    calls: r.calls,
    meetings: r.meetings,
    converted: r.converted,
  }));

  return (
    <div>
      <div className="chart-grid two mb-16">
        <Panel title="Activity volume">
          <ColumnChart
            groups={chartGroups}
            seriesDefs={[
              { key: 'calls', label: 'Calls', color: PALETTE[0] },
              { key: 'meetings', label: 'Meetings', color: PALETTE[1] },
              { key: 'converted', label: 'Conversions', color: PALETTE[2] },
            ]}
            formatValue={number}
          />
        </Panel>
        <Panel title="Revenue by person">
          <BarList
            rows={rows
              .filter((r) => r.revenue > 0)
              .slice(0, 10)
              .map((r) => ({ key: r.userId ?? r.id ?? r.name, label: r.name, value: r.revenue }))}
            formatValue={(v) => money(v, { compact: true })}
          />
        </Panel>
      </div>

      <Panel title="Detail" flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Person</th>
                <th className="right">Leads</th>
                <th className="right">Calls</th>
                <th className="right hide-sm">Emails</th>
                <th className="right hide-sm">Meetings</th>
                <th className="right">Converted</th>
                <th className="right hide-sm">Conv. rate</th>
                <th className="right hide-sm">Site visits</th>
                <th className="right">Revenue</th>
                <th style={{ width: '180px' }}>Target attainment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.userId ?? r.id ?? `${r.email}-${i}`}>
                  <td>
                    <div className="row" style={{ gap: '8px' }}>
                      <Avatar name={r.name} size="sm" />
                      <div>
                        <div className="cell-main">{r.name}</div>
                        <div className="cell-sub truncate">{r.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="right">{number(r.leads)}</td>
                  <td className="right">{number(r.calls)}</td>
                  <td className="right hide-sm">{number(r.emails)}</td>
                  <td className="right hide-sm">{number(r.meetings)}</td>
                  <td className="right">{number(r.converted)}</td>
                  <td className="right hide-sm">{percent(r.conversionRate)}</td>
                  <td className="right hide-sm">{number(r.siteVisits)}</td>
                  <td className="right strong">{money(r.revenue, { compact: true })}</td>
                  <td>
                    <Attainment targets={r.targets} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

/** Up to three metrics' attainment bars for one person. */
function Attainment({ targets }) {
  const entries = Object.entries(targets || {});
  if (!entries.length) return <span className="muted tiny">No targets set</span>;
  return (
    <div className="col" style={{ gap: '6px' }}>
      {entries.slice(0, 3).map(([metric, t]) => (
        <div key={metric}>
          <div className="row-between tiny mb-8">
            <span className="muted">{titleCase(metric)}</span>
            <span className={t.attainment >= 100 ? 'text-success strong' : ''}>{percent(t.attainment, 0)}</span>
          </div>
          <ProgressBar value={t.actual} max={t.target || 1} tone={attainmentTone(t.attainment)} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

function TargetsTab({ rows, can, confirm, reload, onSetTargets }) {
  if (!can('targets', 'read')) {
    return (
      <div className="card">
        <EmptyState iconName="shield" title="No access to targets" />
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="card">
        <EmptyState
          iconName="target"
          title="No targets set"
          message="Set monthly or quarterly targets so attainment shows up on the dashboard and performance report."
          action={
            can('targets', 'create') ? (
              <button type="button" className="btn btn-primary" onClick={onSetTargets}>
                Set targets
              </button>
            ) : null
          }
        />
      </div>
    );
  }

  const remove = async (t) => {
    const yes = await confirm({ title: 'Remove this target?', danger: true, confirmLabel: 'Remove' });
    if (!yes) return;
    try {
      await api.del(`/api/targets/${t.id}`);
      toast.success('Target removed');
      reload();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <Panel title="Targets" flush>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Owner</th>
              <th>Metric</th>
              <th>Period</th>
              <th className="right">Target</th>
              <th className="right">Actual</th>
              <th style={{ width: '200px' }}>Attainment</th>
              <th style={{ width: '48px' }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td className="cell-main">{t.ownerLabel}</td>
                <td>
                  <span className="badge">{titleCase(t.metric)}</span>
                </td>
                <td className="small muted">{`${titleCase(t.period)} · ${date(t.periodStart)}`}</td>
                <td className="right">
                  {t.metric === 'REVENUE' ? money(t.targetValue, { compact: true }) : number(t.targetValue)}
                </td>
                <td className="right strong">
                  {t.metric === 'REVENUE' ? money(t.actual, { compact: true }) : number(t.actual)}
                </td>
                <td>
                  <div>
                    <div className="row-between tiny mb-8">
                      <span className={t.attainment >= 100 ? 'text-success strong' : ''}>{percent(t.attainment, 0)}</span>
                      {t.attainment >= 100 ? <span className="badge badge-success">Met</span> : null}
                    </div>
                    <ProgressBar value={t.actual} max={t.targetValue || 1} tone={attainmentTone(t.attainment)} />
                  </div>
                </td>
                <td>
                  {can('targets', 'delete') ? (
                    <button type="button" className="icon-btn" aria-label="Delete target" onClick={() => remove(t)}>
                      <Icon name="trash" size={15} />
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function TargetForm({ users, onClose, onSaved }) {
  const [metric, setMetric] = useState('REVENUE');
  const [period, setPeriod] = useState('MONTH');
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState(() => new Set());

  const toggle = (id, on) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = async () => {
    // In list order, as the original read the checked boxes off the DOM.
    const userIds = users.filter((u) => selected.has(u.id)).map((u) => u.id);
    if (!userIds.length) {
      toast.warn('Select at least one person');
      return;
    }
    if (!value) {
      toast.warn('Enter a target value');
      return;
    }
    try {
      const res = await api.post('/api/targets/bulk', {
        userIds,
        metric,
        period,
        periodStart: new Date().toISOString(),
        targetValue: Number(value),
      });
      toast.success(`Targets set for ${res.data.updated} people`);
      onClose();
      onSaved();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <Modal
      title="Set targets"
      subtitle="Applies to everyone you select. Existing targets for the same metric and period are replaced."
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <BusyButton className="btn btn-primary" onClick={save}>
            Save targets
          </BusyButton>
        </div>
      }
    >
      <div>
        <div className="form-grid">
          <Field label="Metric">
            <Select
              options={METRICS.map((m) => ({ value: m, label: titleCase(m) }))}
              value={metric}
              onChange={(e) => setMetric(e.target.value)}
            />
          </Field>
          <Field label="Period">
            <Select options={PERIODS} value={period} onChange={(e) => setPeriod(e.target.value)} />
          </Field>
          <Field label="Target value" required>
            <Input type="number" min="0" placeholder="500000" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        </div>
        <Field label="People" required>
          <div
            style={{
              maxHeight: '220px',
              overflowY: 'auto',
              border: '1px solid var(--line)',
              borderRadius: '8px',
              padding: '8px',
            }}
          >
            {users.map((u) => (
              <label key={u.id} className="checkbox" style={{ display: 'flex', padding: '4px 0' }}>
                <input type="checkbox" value={u.id} checked={selected.has(u.id)} onChange={(e) => toggle(u.id, e.target.checked)} />
                {u.fullName || u.name}
              </label>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
