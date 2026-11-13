/**
 * URL query state for pages.
 *
 * The PHP edition handed each view a `query` object parsed from the hash and,
 * when only the query changed, called the view's `onQuery(query)` instead of
 * rebuilding it. In React the page is not remounted when only the query
 * changes (see App.jsx), so a page derives its state from the query and lets
 * effects re-run - that *is* `onQuery`.
 *
 * `useQueryParams()` is a thin layer over react-router's `useSearchParams()`
 * that speaks in plain objects, the shape the vanilla views were written
 * against.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

const isEmpty = (v) => v === undefined || v === null || v === '' || v === false;

/**
 * Returns `[query, setQuery]`.
 *
 * - `query`: `{ [key]: string }` for the current URL; a new object only when the URL's query changes.
 * - `setQuery(patch, { replace = true, merge = true })`: merges `patch` into the
 *   current query (or replaces it when `merge` is false), drops keys whose value
 *   is `''`, `null`, `undefined` or `false`, and writes the URL. `replace`
 *   defaults to true because filter changes were `history.replaceState` in the
 *   original - the back button leaves the page instead of undoing a filter.
 */
export function useQueryParams() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useMemo(() => Object.fromEntries(searchParams), [searchParams]);

  const setQuery = useCallback(
    (patch, { replace = true, merge = true } = {}) => {
      setSearchParams(
        (prev) => {
          const next = merge ? Object.fromEntries(prev) : {};
          Object.assign(next, patch);
          const out = new URLSearchParams();
          for (const [key, value] of Object.entries(next)) {
            if (!isEmpty(value)) out.set(key, String(value));
          }
          return out;
        },
        { replace }
      );
    },
    [setSearchParams]
  );

  return [query, setQuery];
}
