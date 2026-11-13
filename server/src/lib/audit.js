/**
 * Append-only audit trail. Failures are logged and swallowed — an audit write
 * must never break the business operation that triggered it, but it must also
 * never fail silently server-side.
 */

import { dbExec } from './db.js';
import { clientIp, userAgent } from './auth.js';
import { gvId, toJson } from './util.js';

function actorLabel(actor, apiKey) {
  if (actor) return `${actor.firstName} ${actor.lastName} <${actor.email}>`;
  if (apiKey) return `API key ${apiKey.prefix}`;
  return 'system';
}

/**
 * `req` is optional so background jobs (the cron sweep, webhook processing)
 * can write audit rows too — they simply have no IP or user agent to record.
 */
export async function auditRecord(orgId, actor, action, opts = {}, req = null) {
  try {
    await dbExec(
      `INSERT INTO audit_logs
         (id, organization_id, user_id, actor_label, action, entity_type, entity_id, entity_label, changes, ip, user_agent, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        gvId(),
        orgId,
        actor?.id ?? null,
        actorLabel(actor, req?.apiKey),
        action,
        opts.entityType ?? null,
        opts.entityId ?? null,
        opts.entityLabel ?? null,
        toJson(opts.changes ?? {}),
        req ? clientIp(req) : null,
        req ? userAgent(req) : null,
      ]
    );
  } catch (err) {
    console.error(`[audit] failed to record ${action}:`, err.message);
  }
}

/**
 * Records a data export: who took what out, under which filters, and at what
 * visibility scope. Written before the file is streamed, so an export that
 * dies mid-download still leaves a trace.
 */
export async function exportRecord(orgId, actor, entity, format, rowCount, filters = {}, req = null) {
  try {
    // Paging and sort parameters say nothing about which data left the
    // building, and keeping them makes the audit row harder to read.
    const clean = { ...filters };
    for (const k of ['page', 'limit', 'sort', 'order', 'dir', '_path']) delete clean[k];

    await dbExec(
      `INSERT INTO export_jobs
         (id, organization_id, user_id, actor_label, entity, format, row_count, filters, data_scope, ip, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        gvId(),
        orgId,
        actor?.id ?? null,
        actorLabel(actor, req?.apiKey),
        entity,
        format,
        rowCount,
        toJson(clean),
        actor?.role?.dataScope ?? null,
        req ? clientIp(req) : null,
      ]
    );

    await auditRecord(
      orgId,
      actor,
      'data.exported',
      {
        entityType: 'EXPORT',
        entityLabel: entity,
        changes: { format, rowCount, filters: clean },
      },
      req
    );
  } catch (err) {
    console.error('[audit] export record failed:', err.message);
  }
}
