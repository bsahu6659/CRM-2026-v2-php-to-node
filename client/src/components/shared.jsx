/**
 * Pieces shared across pages: page headers, breadcrumbs, the standard
 * date-range filter, owner/status pickers and a few small renderers used by
 * more than one screen. Port of the PHP edition's `js/views/shared.js`.
 */
import { Link } from 'react-router-dom';
import Icon from './Icon.jsx';
import { Avatar, StatusBadge } from './ui/Blocks.jsx';
import { Select } from './ui/FormControls.jsx';
import { useReference } from '../lib/reference.js';
import { PRIORITY_TONE, SCORE_TONE, titleCase } from '../lib/format.js';

export { StatusBadge };

/**
 * Page title block.
 * @param breadcrumbs [{ label, path? }] - a crumb with `path` is a link
 * @param actions     a node or an array of nodes, laid out in a wrapping row on the right
 */
export function PageHead({ title, subtitle, breadcrumbs, actions }) {
  return (
    <div className="page-head">
      <div>
        {breadcrumbs?.length ? (
          <div className="breadcrumb">
            {breadcrumbs.map((crumb, i) => [
              i > 0 ? (
                <span key={`sep${i}`} className="sep">
                  /
                </span>
              ) : null,
              crumb.path ? (
                <Link key={`c${i}`} to={crumb.path}>
                  {crumb.label}
                </Link>
              ) : (
                <span key={`c${i}`}>{crumb.label}</span>
              ),
            ])}
          </div>
        ) : null}
        <h1>{title}</h1>
        {subtitle ? <div className="sub">{subtitle}</div> : null}
      </div>
      {actions ? (
        <div className="row wrap" style={{ gap: '8px' }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export const DATE_RANGES = [
  { value: '', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_90_days', label: 'Last 90 days' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'this_year', label: 'This year' },
];

/** The standard date-range <select>. `onChange(value)` receives the range key ('' = all time). */
export function RangeSelect({ value, onChange }) {
  return (
    <Select
      options={DATE_RANGES}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Date range"
    />
  );
}

const SCORE_BANDS = [
  { value: 'COLD', label: 'Cold' },
  { value: 'WARM', label: 'Warm' },
  { value: 'HOT', label: 'Hot' },
  { value: 'VERY_HOT', label: 'Very hot' },
];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => ({ value: p, label: titleCase(p) }));
const CONTROL_KEYS = ['page', 'limit', 'sort', 'dir', 'view'];

/**
 * The standard filter row, rendered as a fragment of controls to drop into a
 * `.toolbar` next to a SearchBox. Each requested filter is rendered only when
 * the reference data for it exists, so a user without project access simply
 * does not see a project picker.
 *
 * @param filters  any of 'range' | 'status' | 'source' | 'project' | 'owner' | 'team' | 'priority' | 'scoreBand', in display order
 * @param current  the current filter values, keyed range / statusId / sourceId / projectId / ownerId / teamId / priority / scoreBand
 * @param onChange called with a patch, e.g. `{ statusId: '3' }`; "Clear" sends every key of `current` as ''
 */
export function FilterBar({ filters, current = {}, onChange }) {
  const ref = useReference();
  const controls = [];

  const add = (key, options, placeholder) => {
    if (!options?.length) return;
    controls.push(
      <Select
        key={key}
        options={options}
        value={current[key] || ''}
        placeholder={placeholder}
        onChange={(e) => onChange({ [key]: e.target.value })}
        aria-label={placeholder}
      />
    );
  };

  for (const filter of filters) {
    if (filter === 'range') {
      controls.push(
        <RangeSelect key="range" value={current.range || ''} onChange={(value) => onChange({ range: value })} />
      );
    } else if (!ref) {
      // Reference lists are still loading; their pickers appear when they land.
    } else if (filter === 'status') {
      add('statusId', ref.statuses.map((s) => ({ value: s.id, label: s.name })), 'All statuses');
    } else if (filter === 'source') {
      add('sourceId', ref.sources.map((s) => ({ value: s.id, label: s.name })), 'All sources');
    } else if (filter === 'project') {
      add('projectId', ref.projects.map((p) => ({ value: p.id, label: p.name })), 'All projects');
    } else if (filter === 'owner') {
      add('ownerId', ref.users.map((u) => ({ value: u.id, label: u.name || u.fullName })), 'All owners');
    } else if (filter === 'team') {
      add('teamId', ref.teams.map((t) => ({ value: t.id, label: t.name })), 'All teams');
    } else if (filter === 'priority') {
      add('priority', PRIORITIES, 'Any priority');
    } else if (filter === 'scoreBand') {
      add('scoreBand', SCORE_BANDS, 'Any score');
    }
  }

  const hasFilters = Object.entries(current).some(([k, v]) => v && !CONTROL_KEYS.includes(k));
  if (hasFilters) {
    controls.push(
      <button
        key="clear"
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => onChange(Object.fromEntries(Object.keys(current).map((k) => [k, ''])))}
      >
        <Icon name="close" size={14} />
        Clear
      </button>
    );
  }

  return <>{controls}</>;
}

/** Owner avatar + name, or an "Unassigned" badge. `owner`: `{ firstName, lastName, avatarUrl }`. */
export function OwnerCell({ owner }) {
  if (!owner) return <span className="badge">Unassigned</span>;
  const name = `${owner.firstName} ${owner.lastName || ''}`.trim();
  return (
    <div className="row" style={{ gap: '7px' }}>
      <Avatar name={name} size="sm" url={owner.avatarUrl} />
      <span className="truncate">{name}</span>
    </div>
  );
}

/** Lead score number plus its band badge (COLD / WARM / HOT / VERY_HOT). */
export function ScoreCell({ score, band }) {
  const color = SCORE_TONE[band] || 'var(--ink-3)';
  return (
    <div className="row" style={{ gap: '7px' }}>
      <span style={{ fontWeight: 700, color, minWidth: '24px', display: 'inline-block' }}>{String(score ?? 0)}</span>
      <span className="badge" style={{ background: `${color}1a`, color, fontSize: '10.5px' }}>
        {titleCase(band || 'cold')}
      </span>
    </div>
  );
}

/** LOW / MEDIUM / HIGH / URGENT badge (defaults to Medium). */
export function PriorityBadge({ priority }) {
  return <span className={PRIORITY_TONE[priority] || 'badge'}>{titleCase(priority || 'medium')}</span>;
}

/** Lead name with "company · code" underneath, for the first column of a lead table. */
export function LeadNameCell({ lead }) {
  return (
    <div>
      <div className="cell-main truncate">{lead.fullName || `${lead.firstName} ${lead.lastName || ''}`.trim()}</div>
      <div className="cell-sub truncate">{[lead.company, lead.code].filter(Boolean).join(' · ')}</div>
    </div>
  );
}

/** Up to three coloured tag badges plus "+N". `tags`: `[{ name, color }]`. */
export function TagList({ tags }) {
  if (!tags?.length) return <span className="muted">—</span>;
  return (
    <div className="row wrap" style={{ gap: '4px' }}>
      {tags.slice(0, 3).map((tag, i) => (
        <span key={tag.id ?? `${tag.name}-${i}`} className="badge" style={{ background: `${tag.color}1f`, color: tag.color }}>
          {tag.name}
        </span>
      ))}
      {tags.length > 3 ? <span className="badge">{`+${tags.length - 3}`}</span> : null}
    </div>
  );
}

/** In-app link (`linkTo(path, label)` in the original). */
export function LinkTo({ to, className = '', children }) {
  return (
    <Link to={to} className={className || undefined}>
      {children}
    </Link>
  );
}

/** Consistent "you do not have access" panel. Render it in place of the page. */
export function NoAccess({ what = 'this section' }) {
  return (
    <div className="card">
      <div className="empty">
        <div className="e-icon">
          <Icon name="shield" size={24} />
        </div>
        <h3>No access</h3>
        <p>{`Your role does not include permission to view ${what}. Ask an administrator if you need it.`}</p>
      </div>
    </div>
  );
}

/** Card wrapper for a chart or table with an optional header action. `flush` drops the body padding. */
export function Panel({ title, subtitle, action, flush = false, children }) {
  return (
    <section className="card">
      {title ? (
        <div className="card-head">
          <div>
            <h3>{title}</h3>
            {subtitle ? <div className="sub">{subtitle}</div> : null}
          </div>
          {action || null}
        </div>
      ) : null}
      <div className={flush ? 'card-body flush' : 'card-body'}>{children}</div>
    </section>
  );
}
