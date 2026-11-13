/**
 * Reference data: statuses, sources, teams, dimensions, assignable users and
 * project options - the lists almost every screen needs for its pickers.
 *
 * Port of `reference()` / `refreshReference()` / `statusById()` from the PHP
 * edition's store. The lists are fetched once and reused; any screen that
 * edits them calls `refreshReference()`, so a newly added status shows up
 * immediately rather than after a reload. Components read the cache through
 * `useReference()`, which re-renders them when a refresh lands.
 */
import { useEffect, useSyncExternalStore } from 'react';
import api from './api.js';
import { can, getSession } from './session.js';

let cache = null;
let pending = null;
// Bumped by every forced load and by clearReference(), so a slow response for
// a superseded request cannot overwrite a newer one (or a signed-out state).
let generation = 0;
const listeners = new Set();

const notify = () => listeners.forEach((fn) => fn());

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The cached reference object, or `null` when it has not loaded yet. */
export const getReference = () => cache;

/**
 * Loads (or returns the cached) reference data. Never rejects: each list
 * falls back to empty, exactly like the original, so one module the user
 * cannot read does not take every picker down with it.
 */
export function loadReference({ force = false } = {}) {
  if (cache && !force) return Promise.resolve(cache);
  if (pending && !force) return pending;

  const gen = ++generation;
  const request = (async () => {
    const [filters, users, projects] = await Promise.all([
      api.data('/api/reports/filters').catch(() => ({})),
      api.data('/api/users/assignable').catch(() => []),
      can('projects', 'read') ? api.data('/api/projects/options').catch(() => []) : Promise.resolve([]),
    ]);
    const value = {
      statuses: filters?.statuses || [],
      sources: filters?.sources || [],
      teams: filters?.teams || [],
      dimensions: filters?.dimensions || [],
      users: users || [],
      projects: projects || [],
    };
    if (gen === generation) {
      cache = value;
      notify();
    }
    return value;
  })();

  pending = request;
  request.finally(() => {
    if (pending === request) pending = null;
  });
  return request;
}

/** Forces a reload - call after creating/editing a status, source, team, user or project. */
export const refreshReference = () => loadReference({ force: true });

/** Looks a pipeline status up by id in the cached lists; `null` if unknown or not loaded. */
export function statusById(id) {
  return cache?.statuses.find((s) => String(s.id) === String(id)) || null;
}

/** Drops the cache. AuthProvider calls this when the session ends. */
export function clearReference() {
  generation += 1;
  cache = null;
  pending = null;
  notify();
}

/**
 * Hook: the reference object (`{ statuses, sources, teams, dimensions, users,
 * projects }`), or `null` while the first load is in flight. Starts the load
 * if nothing has yet.
 */
export function useReference() {
  const value = useSyncExternalStore(subscribe, getReference);
  useEffect(() => {
    // No session means nothing to load - the shell is on its way out.
    if (!value && getSession().user) loadReference();
  }, [value]);
  return value;
}
