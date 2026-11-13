/**
 * Small display building blocks - ports of the "small building blocks"
 * section of the PHP edition's ui.js. Markup and class names are unchanged so
 * app.css styles them as before.
 */
import Icon from '../Icon.jsx';
import { avatarColor, initials } from '../../lib/format.js';

const cx = (...parts) => parts.filter(Boolean).join(' ');

/** Initials disc in a stable per-name colour, or the photo when `url` is set. `size`: '' | 'sm' | 'lg' | 'xl'. */
export function Avatar({ name, size = '', url = null }) {
  if (url) return <img className={cx('avatar', size)} src={url} alt={name || ''} />;
  return (
    <div className={cx('avatar', size)} style={{ background: avatarColor(name || '?') }} title={name || ''}>
      {initials(name)}
    </div>
  );
}

/** Coloured pill. `color` is a hex such as '#16a34a'; the background is the same colour at 12% alpha. */
export function StatusBadge({ name, color, dot = true }) {
  if (!name) return <span className="badge">—</span>;
  return (
    <span className={cx('badge', dot && 'dot')} style={color ? { background: `${color}1f`, color } : undefined}>
      {name}
    </span>
  );
}

export function EmptyState({ iconName = 'search', title, message, action }) {
  return (
    <div className="empty">
      <div className="e-icon">
        <Icon name={iconName} size={24} />
      </div>
      <h3>{title}</h3>
      {message ? <p>{message}</p> : null}
      {action || null}
    </div>
  );
}

export function SkeletonBlock({ lines = 4 }) {
  return (
    <div className="card-body">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton skeleton-line" style={{ width: `${100 - i * 9}%` }} />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 6, cols = 5 }) {
  return (
    <div className="card-body">
      <table className="data" style={{ width: '100%' }}>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (__, c) => (
                <td key={c}>
                  <div className="skeleton skeleton-line" style={{ margin: 0 }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PageLoader({ label = 'Loading' }) {
  return (
    <div className="page-loader">
      <span className="spinner lg" />
      <span className="muted">{label}</span>
    </div>
  );
}

/**
 * KPI tile. With `onClick` it becomes a keyboard-reachable button (Enter or
 * Space), as in the original.
 */
export function KpiCard({ label, value, foot, accent = 'var(--brand-500)', iconName, onClick }) {
  const interactive = typeof onClick === 'function';
  return (
    <div
      className={cx('kpi', interactive && 'clickable')}
      style={{ '--accent': accent }}
      onClick={interactive ? () => onClick() : undefined}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? 'button' : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className="k-label">
        {iconName ? <Icon name={iconName} size={14} /> : null}
        {label}
      </div>
      <div className="k-value">{value}</div>
      {foot ? <div className="k-foot">{foot}</div> : null}
    </div>
  );
}

/** `tone`: '' | 'success' | 'warning' | 'danger'. Width is value/max, capped at 100%. */
export function ProgressBar({ value, max, tone = '' }) {
  const pctValue = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="progress">
      <div className={cx('p-fill', tone)} style={{ width: `${pctValue}%` }} />
    </div>
  );
}
