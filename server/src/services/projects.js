/**
 * Projects - the central real-estate entity. Port of services/Projects.php.
 *
 * A project row is owned by exactly one organisation. What makes it shareable
 * is `visibility`:
 *
 *   PRIVATE   only the owning tenant
 *   SELECTED  the owner plus every tenant listed in project_access
 *   GLOBAL    the owner plus every tenant on the platform
 *
 * The rule that matters most (spec section 24) is what this file deliberately
 * does NOT do: nothing here ever touches leads. A broker who can see a global
 * project still reads leads through leads.organization_id, so two brokers
 * working the same tower never see each other's buyers.
 */

import { dbAll, dbExec, dbInClause, dbOne, dbScalar, dbTransaction } from '../lib/db.js';
import { forbidden, notFound } from '../lib/errors.js';
import { currentActor, currentContext } from '../lib/context.js';
import { isPlatformAdmin, orgUsesGlobalProjects } from '../lib/tenancy.js';
import { camelize, gvId, safeJson, slugify } from '../lib/util.js';

export const GV_PROJECT_TYPES = ['RESIDENTIAL', 'COMMERCIAL', 'MIXED_USE', 'PLOTTED', 'VILLA'];
export const GV_PROJECT_STATUSES = ['PRE_LAUNCH', 'NEW_LAUNCH', 'ONGOING', 'READY_TO_MOVE', 'COMPLETED', 'SOLD_OUT', 'ON_HOLD'];
export const GV_PROJECT_VISIBILITY = ['PRIVATE', 'SELECTED', 'GLOBAL'];

/** PHP's empty(): the PHP edition leans on it, and "0" counts as empty there. */
function empty(value) {
  return (
    value === undefined || value === null || value === false || value === 0 || value === '' || value === '0' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * The visibility predicate, as a WHERE fragment against an aliased `projects`.
 *
 * Business type - not a generic "industry" - decides what a company can see:
 *
 *   DEVELOPER                    their own stock, plus anything explicitly
 *                                shared with them. A developer builds and sells
 *                                what it owns; it has no business browsing the
 *                                global master of other developers' towers.
 *   BROKER / CHANNEL_PARTNER     their own, anything shared with them, AND the
 *   / AGENCY                     global project master - which is the whole
 *                                reason the global master exists.
 *
 * Table-qualified on purpose: this fragment is interpolated into queries that
 * join organizations and users, and all three carry organization_id.
 *
 * Async because the company type is looked up; returns { sql, params }.
 */
export async function projectVisibleWhere(orgId, alias = 'projects') {
  // The platform owner, working at platform level, sees every project on the
  // platform. They are the one who has to fix a client's half-filled listing,
  // and they cannot fix what they cannot see.
  //
  // The moment they switch INTO a client this stops applying: inside a tenant
  // they see exactly what that tenant sees, which is what keeps "open their
  // CRM" an honest view rather than a privileged one.
  if (platformAdminAtPlatformLevel()) {
    return { sql: '1 = 1', params: [] };
  }

  const clauses = [`${alias}.organization_id = ?`];
  const params = [orgId];

  if (orgUsesGlobalProjects(await orgCompanyType(orgId))) {
    clauses.push(`(${alias}.visibility = 'GLOBAL' AND ${alias}.is_active = 1)`);
  }

  clauses.push(`EXISTS (SELECT 1 FROM project_access pa WHERE pa.project_id = ${alias}.id AND pa.organization_id = ?)`);
  params.push(orgId);

  return { sql: `(${clauses.join(' OR ')})`, params };
}

/**
 * Cached per request: the visibility predicate is built many times per page.
 *
 * PHP held this in a function-static, which lives exactly as long as one
 * request. A module-level Map would outlive the request in Node and keep
 * serving a company type after it changed, so the cache hangs off the
 * request's context instead and is dropped with it. Outside a request (cron,
 * scripts) every call reads the database.
 */
const companyTypeCache = new WeakMap();

export async function orgCompanyType(orgId) {
  const ctx = currentContext();
  let cache = null;
  if (ctx) {
    cache = companyTypeCache.get(ctx);
    if (!cache) {
      cache = new Map();
      companyTypeCache.set(ctx, cache);
    }
    if (cache.has(orgId)) return cache.get(orgId);
  }
  const raw = await dbScalar('SELECT company_type FROM organizations WHERE id = ?', [orgId]);
  const type = String(empty(raw) ? 'DEVELOPER' : raw);
  if (cache) cache.set(orgId, type);
  return type;
}

/**
 * Loads a project the tenant is allowed to see, or throws. Every read route
 * goes through this rather than a bare SELECT by id, so a guessed project id
 * from another tenant returns 404 instead of data.
 */
export async function projectLoadVisible(orgId, projectId) {
  const vis = await projectVisibleWhere(orgId);
  const row = await dbOne(
    `SELECT projects.* FROM projects WHERE projects.id = ? AND ${vis.sql}`,
    [projectId, ...vis.params]
  );
  if (!row) {
    throw notFound('Project not found, or it is not shared with your company.');
  }
  return row;
}

/**
 * Editing is narrower than viewing: a broker may sell a global project but may
 * not rename it. Only the owning tenant (or a platform admin inside the
 * platform tenant) can write.
 */
export function projectAssertWritable(actor, project) {
  if (project.organization_id === actor.organizationId) {
    return;
  }
  // A platform admin may correct any project's details wherever it lives -
  // the global master is theirs to curate, and a client's listing with a
  // missing RERA number or price band is theirs to complete.
  if (isPlatformAdmin(actor)) {
    return;
  }
  throw forbidden('This project belongs to another company. You can use it, but not edit it.');
}

/**
 * True only for a platform admin who is NOT currently inside a client.
 *
 * Returns false with no actor at all, so CLI scripts (seed, cron) keep the
 * ordinary tenant-scoped behaviour rather than silently gaining global reach.
 */
export function platformAdminAtPlatformLevel() {
  const a = currentActor();
  return a !== null && isPlatformAdmin(a) && empty(a.isImpersonating);
}

export async function projectNextCode(orgId) {
  // Same atomic-increment trick the lead sequence uses: bump and read in one
  // statement so two concurrent creates cannot collide on a code.
  //
  // PHP ran both statements on its one request connection. Here they are kept
  // on one pooled connection by a transaction (joining the caller's, if any):
  // the UPDATE's row lock is then held until the read, so a concurrent create
  // waits rather than reading the same number.
  return dbTransaction(async () => {
    await dbExec('UPDATE organizations SET project_seq = project_seq + 1 WHERE id = ?', [orgId]);
    const seq = Math.trunc(Number(await dbScalar('SELECT project_seq FROM organizations WHERE id = ?', [orgId])) || 0);
    return `PRJ-${seq}`;
  });
}

export async function projectUniqueSlug(orgId, name) {
  const slug0 = slugify(name);
  const base = empty(slug0) ? 'project' : slug0;
  let slug = base;
  let n = 1;
  while (await dbScalar('SELECT id FROM projects WHERE organization_id = ? AND slug = ?', [orgId, slug])) {
    n++;
    slug = `${base}-${n}`;
  }
  return slug;
}

/** Shapes a row for the API, adding the flags the UI needs to decide affordances. */
/**
 * Uploaded images are stored as a bare file name in a directory that is not
 * publicly served, so the stored value is not something a browser can load.
 * Anything that already looks like a URL (an external link, an absolute path)
 * is passed through untouched.
 */
function isServableUrl(value) {
  return /^(https?:)?\/\//i.test(value) || value.startsWith('/') || value.startsWith('data:');
}

export function projectPresent(row, viewerOrgId, extra = {}) {
  const isOwner = row.organization_id === viewerOrgId;
  const a = currentActor();
  const cover = row.cover_image_url ? String(row.cover_image_url) : null;
  return camelize({
    ...row,
    cover_image_url: cover && !isServableUrl(cover) ? `/api/projects/${row.id}/cover` : cover,
    configurations: safeJson(row.configurations, []),
    amenities: safeJson(row.amenities, []),
    is_owner: isOwner,
    is_shared: !isOwner,
    can_edit: isOwner || (a !== null && isPlatformAdmin(a)),
    ...extra,
  });
}

/**
 * Replaces the tenant list a SELECTED project is shared with.
 * Platform-admin only - it is the lever behind spec section 23.
 */
export async function projectSetAccess(projectId, orgIds, grantedById) {
  await dbTransaction(async () => {
    await dbExec('DELETE FROM project_access WHERE project_id = ?', [projectId]);
    for (const orgId of [...new Set(orgIds ?? [])]) {
      if (empty(orgId)) {
        continue;
      }
      // A tenant that no longer exists is skipped rather than failing the
      // whole grant - the UI list can lag behind a deleted client.
      if (!(await dbScalar('SELECT id FROM organizations WHERE id = ?', [orgId]))) {
        continue;
      }
      await dbExec(
        'INSERT INTO project_access (id, project_id, organization_id, granted_by_id, created_at) VALUES (?,?,?,?,NOW())',
        [gvId(), projectId, orgId, grantedById ?? null]
      );
    }
  });
}

export async function projectAccessOrgIds(projectId) {
  const rows = await dbAll('SELECT organization_id FROM project_access WHERE project_id = ?', [projectId]);
  return rows.map((r) => r.organization_id);
}

/** Cover image, falling back to the first gallery image if none is flagged. */
export async function projectSyncCover(projectId) {
  const cover = await dbOne(
    'SELECT url FROM project_images WHERE project_id = ? ORDER BY is_cover DESC, sort_order ASC, created_at ASC LIMIT 1',
    [projectId]
  );
  await dbExec('UPDATE projects SET cover_image_url = ? WHERE id = ?', [cover?.url ?? null, projectId]);
}

export async function projectImages(projectId) {
  const rows = await dbAll(
    `SELECT id, url, caption, is_cover, sort_order, mime_type, file_size, created_at
       FROM project_images WHERE project_id = ? ORDER BY is_cover DESC, sort_order ASC, created_at ASC`,
    [projectId]
  );
  return camelize(
    rows.map((r) => ({
      ...r,
      url: r.url && !isServableUrl(String(r.url)) ? `/api/projects/${projectId}/images/${r.id}/file` : r.url,
    }))
  );
}

/**
 * Lead counts per project, scoped to the viewing tenant only. This is the
 * query that proves the global-project rule: the project id may be shared, the
 * COUNT never is.
 *
 * Returns { [projectId]: count }.
 */
export async function projectLeadCounts(orgId, projectIds) {
  if (!projectIds || projectIds.length === 0) {
    return {};
  }
  const [inSql, params] = dbInClause(projectIds);
  const rows = await dbAll(
    `SELECT project_id, COUNT(*) AS total
       FROM leads
      WHERE leads.organization_id = ? AND leads.is_duplicate = 0 AND leads.project_id IN ${inSql}
      GROUP BY project_id`,
    [orgId, ...params]
  );
  const out = {};
  for (const r of rows) {
    out[r.project_id] = Math.trunc(Number(r.total) || 0);
  }
  return out;
}
