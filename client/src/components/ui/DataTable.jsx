import { forwardRef, isValidElement, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { number } from '../../lib/format.js';
import { EmptyState, SkeletonTable } from './Blocks.jsx';
import { Pagination } from './Navigation.jsx';

/**
 * Server-side data table. Port of ui.js `dataTable()`.
 *
 * Owns paging, sorting, selection and its own fetch loop. Callers give it a
 * `load(params)` returning `{ data, meta }` (an `api.get(...)` response as it
 * stands) and a column definition; nothing about the row shape leaks into
 * this file.
 *
 * Filters reach it either declaratively through `params` (the table reloads
 * from page 1 whenever their content changes) or imperatively through the ref
 * (`ref.current.setParams(patch)`), the latter matching the original's
 * returned handle. Use one style per table.
 */
const clean = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== '' && v !== null && v !== undefined) out[k] = v;
  }
  return out;
};

const isToolbarElement = (node) =>
  isValidElement(node) && String(node.props?.className || '').split(/\s+/).includes('toolbar');

const DataTable = forwardRef(function DataTable(
  {
    columns,
    load,
    rowKey = (r) => r.id,
    onRowClick,
    selectable = false,
    bulkActions = null,
    toolbar = null,
    emptyTitle = 'Nothing here yet',
    emptyMessage = '',
    emptyAction = null,
    defaultSort = null,
    defaultDir = 'desc',
    pageSize = 25,
    initialParams = {},
    params,
  },
  ref
) {
  const [query, setQuery] = useState(() => ({
    page: 1,
    limit: pageSize,
    sort: defaultSort,
    dir: defaultDir,
    params: clean({ ...initialParams, ...(params || {}) }),
  }));
  // Bumped to force a fetch even when the query itself is unchanged.
  const [tick, setTick] = useState(0);
  const [view, setView] = useState({ status: 'loading', rows: [], error: null });
  // The pager keeps showing the last good meta while a new page loads, as the
  // original left its pager in place until the response arrived.
  const [meta, setMeta] = useState(null);
  const [selected, setSelected] = useState(() => new Set());

  const loadRef = useRef(load);
  loadRef.current = load;
  const latest = useRef({ query, selected, meta });
  latest.current = { query, selected, meta };
  const requestToken = useRef(0);

  const queryKey = JSON.stringify(query);

  useEffect(() => {
    const token = ++requestToken.current;
    setView((v) => ({ ...v, status: 'loading' }));
    const { page, limit, sort, dir, params: filters } = JSON.parse(queryKey);
    Promise.resolve()
      .then(() => loadRef.current({ page, limit, sort: sort || undefined, dir, ...filters }))
      .then((res) => {
        if (token !== requestToken.current) return; // a newer request superseded this one
        setView({ status: 'ready', rows: res?.data || [], error: null });
        setMeta(res?.meta || null);
      })
      .catch((err) => {
        if (token !== requestToken.current) return;
        setView({ status: 'error', rows: [], error: err });
      });
  }, [queryKey, tick]);

  // Declarative filters: a change in content (not identity) restarts at page 1.
  const paramsKey = JSON.stringify(params ?? null);
  const firstParams = useRef(true);
  useEffect(() => {
    if (firstParams.current) {
      firstParams.current = false;
      return;
    }
    if (params === undefined) return;
    // initialParams is a seed, not a dependency: only the params content matters.
    setQuery((q) => ({ ...q, page: 1, params: clean({ ...initialParams, ...JSON.parse(paramsKey) }) }));
  }, [paramsKey]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  useImperativeHandle(
    ref,
    () => ({
      refresh,
      setParams(patch, { resetPage = true } = {}) {
        setQuery((q) => {
          const merged = { ...q.params, ...patch };
          return { ...q, page: resetPage ? 1 : q.page, params: clean(merged) };
        });
        refresh();
      },
      getParams: () => ({ ...latest.current.query.params }),
      getSelected: () => [...latest.current.selected],
      clearSelection,
      getMeta: () => latest.current.meta,
    }),
    [refresh, clearSelection]
  );

  const toolbarNode = !toolbar ? null : isToolbarElement(toolbar) ? toolbar : <div className="toolbar">{toolbar}</div>;

  const { rows } = view;
  const colCount = columns.length + (selectable ? 1 : 0);

  const toggleSort = (col) => {
    setQuery((q) =>
      q.sort === col.sortKey
        ? { ...q, page: 1, dir: q.dir === 'asc' ? 'desc' : 'asc' }
        : { ...q, page: 1, sort: col.sortKey, dir: 'desc' }
    );
  };

  const toggleRow = (key, checked) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleAll = (checked) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const row of rows) {
        if (checked) next.add(rowKey(row));
        else next.delete(rowKey(row));
      }
      return next;
    });
  };

  let body;
  let pager = <div />;
  if (view.status === 'loading') {
    body = <SkeletonTable rows={6} cols={colCount} />;
    pager = renderPager(meta);
  } else if (view.status === 'error') {
    body = (
      <EmptyState
        iconName="alert"
        title="Could not load this list"
        message={view.error?.message}
        action={
          <button type="button" className="btn" onClick={refresh}>
            Try again
          </button>
        }
      />
    );
    pager = renderPager(meta);
  } else if (!rows.length) {
    body = <EmptyState title={emptyTitle} message={emptyMessage} action={emptyAction} />;
  } else {
    const allSelected = rows.every((r) => selected.has(rowKey(r)));
    body = (
      <table className="data">
        <thead>
          <tr>
            {selectable ? (
              <th className="checkbox-cell">
                <input
                  type="checkbox"
                  checked={allSelected}
                  aria-label="Select all rows"
                  onChange={(e) => toggleAll(e.target.checked)}
                />
              </th>
            ) : null}
            {columns.map((col, i) => (
              <th
                key={col.key ?? i}
                // The header must carry the same responsive class as its cells, or a
                // column hidden at narrow widths keeps its heading and the table skews.
                className={[col.sortKey ? 'sortable' : '', col.cellClass || ''].filter(Boolean).join(' ') || undefined}
                style={col.width ? { width: col.width } : undefined}
                onClick={col.sortKey ? () => toggleSort(col) : undefined}
              >
                {col.label}
                {col.sortKey && query.sort === col.sortKey ? (
                  <span className="sort-ind">{query.dir === 'asc' ? '▲' : '▼'}</span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const isSelected = selected.has(key);
            return (
              <tr
                key={key}
                className={[onRowClick ? 'clickable' : '', isSelected ? 'selected' : ''].filter(Boolean).join(' ') || undefined}
                onClick={
                  onRowClick
                    ? (e) => {
                        // Portalled content (a row's dropdown menu, a modal opened
                        // from a cell) bubbles here through React without being
                        // inside the row's DOM.
                        if (!e.currentTarget.contains(e.target)) return;
                        if (e.target.closest('input, button, a, .dropdown')) return;
                        onRowClick(row);
                      }
                    : undefined
                }
              >
                {selectable ? (
                  <td className="checkbox-cell" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      aria-label="Select row"
                      onChange={(e) => toggleRow(key, e.target.checked)}
                    />
                  </td>
                ) : null}
                {/* `data-label` is what the stacked card layout prints as each row's
                    heading once the table stops being a table on small screens. */}
                {columns.map((col, i) => (
                  <td key={col.key ?? i} className={col.cellClass || undefined} data-label={col.label || ''}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    );
    pager = renderPager(meta);
  }

  function renderPager(m) {
    if (!m) return <div />;
    if (m.totalPages > 1) {
      return <Pagination meta={m} onPage={(p) => setQuery((q) => ({ ...q, page: p }))} />;
    }
    return (
      <div className="pagination">
        <div className="muted small">{`${number(m.total)} record${m.total === 1 ? '' : 's'}`}</div>
      </div>
    );
  }

  // The bulk bar reflects the selection as of the last completed render, so it
  // stays put while a page loads, as in the original.
  const showBulk = selectable && selected.size > 0;

  return (
    <div className="card">
      {toolbarNode}
      <div>
        {showBulk ? (
          <div className="bulk-bar">
            <span>{`${selected.size} selected`}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={clearSelection}>
              Clear
            </button>
            {bulkActions ? bulkActions([...selected], { refresh, clear: clearSelection }) : null}
          </div>
        ) : null}
      </div>
      <div className="table-wrap">{body}</div>
      <div>{pager}</div>
    </div>
  );
});

export default DataTable;
