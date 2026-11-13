/**
 * Tabs and pagination - ports of ui.js `tabs()` and `pagination()`.
 */
import { number } from '../../lib/format.js';

/**
 * `items`: `[{ key, label, count? }]`. `count` (when not undefined) renders a
 * badge after the label. `onSelect(key)` fires for every click, including on
 * the active tab, as in the original.
 */
export function Tabs({ items, active, onSelect }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={item.key === active ? 'active' : ''}
          role="tab"
          aria-selected={String(item.key === active)}
          onClick={() => onSelect(item.key)}
        >
          {item.label}
          {item.count !== undefined ? (
            <span className="badge" style={{ marginLeft: '6px' }}>
              {number(item.count)}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/**
 * Page buttons for the API's paging `meta` (`{ page, totalPages, total, limit }`).
 * `onPage(page)` fires with the 1-based target page. Renders an empty <div>
 * without meta.
 */
export function Pagination({ meta, onPage }) {
  if (!meta) return <div />;
  const { page, totalPages, total, limit } = meta;
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  const buttons = [];
  const push = (key, label, targetPage, isActive = false, disabled = false) => {
    buttons.push(
      <button
        key={key}
        type="button"
        className={isActive ? 'active' : ''}
        disabled={disabled}
        onClick={disabled || isActive ? undefined : () => onPage(targetPage)}
      >
        {label}
      </button>
    );
  };

  push('prev', '‹', page - 1, false, page <= 1);
  // Window of pages around the current one, with ellipses.
  const windowSet = new Set([1, totalPages, page, page - 1, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((p) => windowSet.add(p));
  if (page >= totalPages - 2) [totalPages - 1, totalPages - 2, totalPages - 3].forEach((p) => windowSet.add(p));
  const pages = [...windowSet].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  let previous = 0;
  for (const p of pages) {
    if (p - previous > 1) {
      buttons.push(
        <button key={`gap${p}`} type="button" disabled>
          …
        </button>
      );
    }
    push(`p${p}`, String(p), p, p === page);
    previous = p;
  }
  push('next', '›', page + 1, false, page >= totalPages);

  return (
    <div className="pagination">
      <div className="muted small">{`${number(from)}–${number(to)} of ${number(total)}`}</div>
      <div className="pages">{buttons}</div>
    </div>
  );
}
