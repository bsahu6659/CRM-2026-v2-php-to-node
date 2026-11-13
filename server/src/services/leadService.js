/**
 * The lead funnel — port of services/LeadService.php.
 *
 * Every lead creation path (UI, web form, public API, import, Meta Lead Ads)
 * goes through createLead(); scoring, assignment, duplicate detection, custom
 * fields, sequence codes and domain events all hang off it.
 *
 * Transactions: the PHP edition ran these writes without one, so a failure
 * half-way (a bad custom field caught late, a dropped connection) could leave
 * a lead row with no creation activity, or an owner change with no timeline
 * entry. Here the writes of createLead, updateLead and assignLeads each run in
 * a single dbTransaction, and the domain events are emitted only AFTER it has
 * committed. That ordering matters beyond tidiness: outside a request (cron,
 * scripts) an event dispatches immediately, and a handler started inside the
 * transaction's async context would run its queries on the transaction's
 * connection — after it had been committed and released back to the pool.
 */

import { auditRecord } from '../lib/audit.js';
import { currentRequest } from '../lib/context.js';
import { dbAll, dbExec, dbInClause, dbOne, dbScalar, dbTransaction } from '../lib/db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import {
  gvBool,
  gvDiff,
  gvId,
  normalizeEmail,
  normalizePhone,
  nowSql,
  parseDate,
  slugify,
  toCamelCase,
  toJson,
} from '../lib/util.js';
import { fallbackRoundRobin, resolveAssignment } from './assignment.js';
import { validateCustomFieldValues } from './customFields.js';
import { findDuplicates } from './duplicates.js';
import { emitDomainEvent } from './events.js';
import { notifyUser } from './notifications.js';
import { projectVisibleWhere } from './projects.js';
import { computeScore } from './scoring.js';
import { nextCode } from './sequenceCodes.js';

export const GV_LEAD_WRITABLE_FIELDS = {
  firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone',
  altPhone: 'alt_phone', company: 'company', jobTitle: 'job_title', website: 'website',
  country: 'country', state: 'state', city: 'city', address: 'address', pincode: 'pincode',
  medium: 'medium', landingPage: 'landing_page', referrerUrl: 'referrer_url',
  utmSource: 'utm_source', utmMedium: 'utm_medium', utmCampaign: 'utm_campaign',
  utmTerm: 'utm_term', utmContent: 'utm_content', gclid: 'gclid', fbclid: 'fbclid',
  priority: 'priority', expectedValue: 'expected_value', notes: 'notes',
  rating: 'rating', lostReason: 'lost_reason',
  // Real-estate qualification. These are the fields a site visit is booked
  // on, so they travel with the lead from the very first capture.
  projectId: 'project_id', budgetMin: 'budget_min', budgetMax: 'budget_max',
  configuration: 'configuration', possessionTimeline: 'possession_timeline',
  purpose: 'purpose', funding: 'funding',
};

/** Closed vocabularies for the real-estate qualification fields. */
export const GV_LEAD_PURPOSES = ['END_USE', 'INVESTMENT'];
export const GV_LEAD_FUNDING = ['SELF', 'HOME_LOAN', 'MIXED'];
export const GV_LEAD_POSSESSION = ['IMMEDIATE', 'WITHIN_6_MONTHS', 'WITHIN_1_YEAR', 'WITHIN_2_YEARS', 'FLEXIBLE'];

// ---------------------------------------------------------------------------
// PHP semantics the funnel was written against. Input arrives straight from
// request bodies, webhooks and CSV rows, so "is this set" has to mean what it
// meant in PHP: '' and '0' are empty, a key present with null is present.
// ---------------------------------------------------------------------------
function hasKey(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

function phpEmpty(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '' || value === '0') {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function phpStr(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return '1';
  if (typeof value === 'object') return 'Array';
  return String(value);
}

function phpFloat(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return Object.keys(value).length ? 1 : 0;
  const n = Number.parseFloat(String(value).trim());
  return Number.isNaN(n) ? 0 : n;
}

/**
 * A request value as PDO would have bound it. mysql2 expands an array into a
 * value list and an object into `key = value` pairs, so neither may reach a
 * placeholder raw; PHP bound both as the string "Array".
 */
function scalarParam(value) {
  if (value === undefined) return null;
  if (value !== null && typeof value === 'object') return 'Array';
  if (typeof value === 'boolean') return value ? '1' : '';
  return value;
}

function ucfirst(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * PHP's camelize() over a DB row: top-level keys only. JSON columns were
 * strings to PHP, so their own keys were never renamed; mysql2 returns them
 * decoded, and a deep camelize would turn a custom field `budget_range` into
 * `budgetRange` and break every `customFields.budget_range` rule.
 */
function camelizeRow(row) {
  if (row === null || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[toCamelCase(k)] = v;
  return out;
}

/**
 * parse_date() with strtotime() semantics. A bare YYYY-MM-DD is local midnight
 * in PHP but UTC midnight to `new Date()` — a follow-up set for a day would
 * otherwise be stored at 05:30 in India, or on the previous day further west.
 */
function parseDateLocal(value) {
  if (phpEmpty(value)) return null;
  const s = phpStr(value).trim();
  return parseDate(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s} 00:00:00` : s);
}

/** A PHP `array $tagNames` parameter: a list, or the values of an object. */
function tagList(tagNames) {
  if (Array.isArray(tagNames)) return tagNames;
  if (tagNames !== null && typeof tagNames === 'object') return Object.values(tagNames);
  throw new TypeError('lead tags must be an array');
}

/**
 * Resolves a status by id or key, falling back to the organisation's default
 * and then to whatever sorts first. A lead always has a status, so this never
 * returns null.
 */
export async function leadResolveStatus(orgId, statusIdOrKey) {
  if (!phpEmpty(statusIdOrKey)) {
    const ref = scalarParam(statusIdOrKey);
    const found = await dbOne(
      'SELECT * FROM lead_statuses WHERE organization_id = ? AND (id = ? OR `key` = ?) LIMIT 1',
      [orgId, ref, ref]
    );
    if (found) {
      return found;
    }
  }
  const fallback = (await dbOne('SELECT * FROM lead_statuses WHERE organization_id = ? AND is_default = 1 LIMIT 1', [orgId]))
    || (await dbOne('SELECT * FROM lead_statuses WHERE organization_id = ? ORDER BY sort_order ASC LIMIT 1', [orgId]));
  if (!fallback) {
    throw badRequest('No lead statuses configured for this organisation.');
  }
  return fallback;
}

/** Resolves a source by id or key. Unlike status, a lead may have none. */
export async function leadResolveSource(orgId, sourceIdOrKey) {
  if (phpEmpty(sourceIdOrKey)) {
    return null;
  }
  const ref = scalarParam(sourceIdOrKey);
  return dbOne(
    'SELECT * FROM lead_sources WHERE organization_id = ? AND (id = ? OR `key` = ?) LIMIT 1',
    [orgId, ref, phpStr(ref).toLowerCase()]
  );
}

export function leadScalarPatch(input) {
  for (const [field, allowed] of [
    ['purpose', GV_LEAD_PURPOSES],
    ['funding', GV_LEAD_FUNDING],
    ['possessionTimeline', GV_LEAD_POSSESSION],
  ]) {
    if (!phpEmpty(input[field]) && !allowed.includes(input[field])) {
      throw badRequest(`${ucfirst(field)} must be one of: ${allowed.join(', ')}.`);
    }
  }
  const data = {};
  for (const [camel, column] of Object.entries(GV_LEAD_WRITABLE_FIELDS)) {
    if (!hasKey(input, camel)) {
      continue;
    }
    const v = input[camel];
    if (camel === 'expectedValue') {
      data[column] = v === null || v === undefined || v === '' ? null : phpFloat(v);
    } else if (typeof v === 'string') {
      const trimmed = v.trim();
      data[column] = trimmed === '' ? null : trimmed;
    } else {
      data[column] = scalarParam(v);
    }
  }
  if (hasKey(data, 'first_name') && data.first_name === null) {
    delete data.first_name;
  }
  return data;
}

export async function leadApplyTags(leadId, orgId, tagNames) {
  // array_filter() drops '' and '0' alike; kept so tag sets match.
  const names = [...new Set(
    tagList(tagNames).map((t) => phpStr(t).trim()).filter((t) => t !== '' && t !== '0')
  )].slice(0, 25);
  const tagIds = [];
  for (const name of names) {
    const tag = await dbOne('SELECT * FROM tags WHERE organization_id = ? AND name = ?', [orgId, name]);
    let tagId;
    if (!tag) {
      tagId = gvId();
      await dbExec('INSERT INTO tags (id, organization_id, name, created_at) VALUES (?,?,?,NOW())', [tagId, orgId, name]);
    } else {
      tagId = tag.id;
    }
    tagIds.push(tagId);
  }
  if (tagIds.length) {
    const [inSql, p] = dbInClause(tagIds);
    await dbExec(`DELETE FROM lead_tags WHERE lead_id = ? AND tag_id NOT IN ${inSql}`, [leadId, ...p]);
  } else {
    await dbExec('DELETE FROM lead_tags WHERE lead_id = ?', [leadId]);
  }
  for (const tagId of tagIds) {
    const existing = await dbOne('SELECT id FROM lead_tags WHERE lead_id = ? AND tag_id = ?', [leadId, tagId]);
    if (!existing) {
      await dbExec('INSERT INTO lead_tags (id, lead_id, tag_id) VALUES (?,?,?)', [gvId(), leadId, tagId]);
    }
  }
}

/**
 * Builds the camelCase context Conditions/Scoring/Assignment expect, from a
 * freshly loaded snake_case lead row.
 */
export async function leadBuildContext(leadRow) {
  const ctx = camelizeRow(leadRow);
  ctx.organizationId = leadRow.organization_id;
  if (leadRow.source_id) {
    ctx.source = camelizeRow(await dbOne('SELECT * FROM lead_sources WHERE id = ?', [leadRow.source_id]));
  }
  if (leadRow.status_id) {
    ctx.status = camelizeRow(await dbOne('SELECT * FROM lead_statuses WHERE id = ?', [leadRow.status_id]));
  }
  if (leadRow.project_id) {
    // Assignment and automation rules route on the project, so it has to be
    // in the context the condition engine sees.
    ctx.project = camelizeRow(await dbOne('SELECT * FROM projects WHERE id = ?', [leadRow.project_id]));
  }
  return ctx;
}

/**
 * Resolves a project reference to an id this tenant may actually use.
 *
 * This is the last line of defence on the section 24 rule: every ingestion
 * path (UI, webhook, API key, import, Meta) lands here, so a project id
 * belonging to another company's private stock can never be written onto a
 * lead even if the route-level check were bypassed.
 */
export async function leadResolveProject(orgId, reference) {
  if (reference === null || reference === undefined || reference === '') {
    return null;
  }
  const ref = scalarParam(reference);
  const vis = await projectVisibleWhere(orgId);
  const byId = await dbScalar(
    `SELECT projects.id FROM projects WHERE projects.id = ? AND ${vis.sql}`,
    [ref, ...vis.params]
  );
  if (byId) {
    return String(byId);
  }
  const byName = await dbScalar(
    `SELECT projects.id FROM projects
      WHERE (projects.name = ? OR projects.slug = ? OR projects.code = ?)
        AND projects.is_active = 1 AND ${vis.sql}
      LIMIT 1`,
    [ref, slugify(phpStr(ref)), ref, ...vis.params]
  );
  return byName ? String(byName) : null;
}

/**
 * `input` is raw, untrusted lead fields (camelCase).
 * `ctx`: organizationId, actor?, origin ('MANUAL'|'FORM'|'API'|'IMPORT'|'META'),
 *   duplicatePolicy ('FLAG'|'REJECT'|'ALLOW'), skipAssignment?, skipAutomation?,
 *   ownerId?, teamId?
 * Returns { lead, duplicates, assignment }.
 */
export async function createLead(input, ctx) {
  const orgId = ctx.organizationId;
  const actor = ctx.actor ?? null;
  const origin = ctx.origin ?? 'MANUAL';
  const duplicatePolicy = ctx.duplicatePolicy ?? 'FLAG';
  // PHP received the array by value; the project resolution below rewrites a
  // key, which must not leak back into the caller's object.
  input = { ...(input ?? {}) };

  if (phpEmpty(input.firstName) || phpStr(input.firstName).trim() === '') {
    throw badRequest('First name is required');
  }
  if (phpEmpty(input.email) && phpEmpty(input.phone)) {
    throw badRequest('A lead needs at least an email address or a phone number');
  }

  const status = await leadResolveStatus(orgId, input.statusId ?? input.status ?? null);
  const source = await leadResolveSource(orgId, input.sourceId ?? input.source ?? null);
  // Resolve the project by id OR name, because webhooks and portal feeds send
  // a project name, not our id. An unresolvable name leaves project_id null
  // rather than rejecting the lead - losing an enquiry is worse than losing
  // an attribution, and an unassigned project is visible in the UI.
  input.projectId = await leadResolveProject(orgId, input.projectId ?? input.project ?? null);

  const duplicates = await findDuplicates(orgId, input);
  if (duplicates.length && duplicatePolicy === 'REJECT') {
    throw conflict('A lead with the same phone or email already exists', {
      duplicates: duplicates.map((d) => ({
        id: d.id,
        code: d.code,
        name: `${phpStr(d.firstName)} ${phpStr(d.lastName ?? '')}`.trim(),
        matchedOn: d.matchedOn,
      })),
    });
  }

  const customFields = await validateCustomFieldValues(orgId, 'LEAD', input.customFields ?? [], '{}');
  // Taken before the main transaction, as in the PHP edition, and committed
  // on its own: the organisation row it locks is the parent of every
  // org-scoped table, so holding that lock for the whole funnel would stall
  // every other write in the tenant behind this one lead.
  const code = await nextCode(orgId, 'LD');
  const now = nowSql();
  const base = leadScalarPatch(input);
  const sourceLabel = source?.name ?? (input.utmSource ?? origin);
  const leadId = gvId();

  const columns = {
    ...base,
    id: leadId, organization_id: orgId, code,
    first_name: phpStr(input.firstName).trim(),
    status_id: status.id, source_id: source?.id ?? null,
    email_norm: normalizeEmail(input.email ?? null), phone_norm: normalizePhone(input.phone ?? null),
    created_by_id: actor?.id ?? null,
    owner_id: scalarParam(ctx.ownerId ?? input.ownerId ?? null),
    team_id: scalarParam(ctx.teamId ?? input.teamId ?? null),
    next_follow_up_at: parseDateLocal(input.nextFollowUpAt ?? null),
    site_visit_at: parseDateLocal(input.siteVisitAt ?? null),
    custom_fields: customFields,
    first_touch_source: sourceLabel, first_touch_campaign: scalarParam(input.utmCampaign ?? null), first_touch_at: now,
    last_touch_source: sourceLabel, last_touch_campaign: scalarParam(input.utmCampaign ?? null), last_touch_at: now,
    is_duplicate: duplicatePolicy === 'FLAG' && duplicates.length && !phpEmpty(input.markDuplicate) ? 1 : 0,
    // Meta Lead Ads linkage, when present.
    meta_lead_id: scalarParam(input.metaLeadId ?? null), meta_form_id: scalarParam(input.metaFormId ?? null),
    meta_page_id: scalarParam(input.metaPageId ?? null), meta_ad_id: scalarParam(input.metaAdId ?? null),
    meta_adset_id: scalarParam(input.metaAdsetId ?? null), meta_campaign_id: scalarParam(input.metaCampaignId ?? null),
    created_at: now, updated_at: now,
  };

  const { lead, assignment } = await dbTransaction(async () => {
    const keys = Object.keys(columns);
    const cols = keys.map((k) => `\`${k}\``).join(', ');
    const placeholders = keys.map(() => '?').join(',');
    await dbExec(`INSERT INTO leads (${cols}) VALUES (${placeholders})`, keys.map((k) => columns[k]));

    if (!phpEmpty(input.tags)) {
      await leadApplyTags(leadId, orgId, input.tags);
    }

    let activityType = 'SYSTEM';
    if (origin === 'FORM') activityType = 'FORM';
    else if (origin === 'IMPORT') activityType = 'IMPORT';
    else if (origin === 'META') activityType = 'FORM';
    await dbExec(
      `INSERT INTO activities (id, organization_id, type, subject, body, lead_id, user_id, meta, occurred_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [
        gvId(), orgId, activityType,
        `Lead created via ${phpStr(origin).toLowerCase()}`, !phpEmpty(sourceLabel) ? `Source: ${phpStr(sourceLabel)}` : null,
        leadId, actor?.id ?? null, toJson({ origin, duplicateCount: duplicates.length }),
      ]
    );

    let row = await dbOne('SELECT * FROM leads WHERE id = ?', [leadId]);

    // ---- assignment ---------------------------------------------------------
    let routed = null;
    if (phpEmpty(ctx.skipAssignment) && !row.owner_id && !row.team_id) {
      routed = (await resolveAssignment(await leadBuildContext(row))) ?? (await fallbackRoundRobin(orgId));
      if (routed && (routed.ownerId || routed.teamId)) {
        await dbExec(
          'UPDATE leads SET owner_id = ?, team_id = ?, assigned_at = NOW() WHERE id = ?',
          [routed.ownerId ?? null, routed.teamId ?? null, leadId]
        );
        row = await dbOne('SELECT * FROM leads WHERE id = ?', [leadId]);
        const ownerName = routed.ownerId
          ? await dbOne('SELECT first_name, last_name FROM users WHERE id = ?', [routed.ownerId])
          : null;
        const teamName = routed.teamId ? await dbScalar('SELECT name FROM teams WHERE id = ?', [routed.teamId]) : null;
        await dbExec(
          'INSERT INTO activities (id, organization_id, type, subject, body, lead_id, occurred_at, created_at) VALUES (?,?,?,?,?,?,NOW(),NOW())',
          [
            gvId(), orgId, 'ASSIGNMENT',
            ownerName
              ? `Assigned to ${`${phpStr(ownerName.first_name)} ${phpStr(ownerName.last_name)}`.trim()}`
              : `Routed to team ${phpStr(teamName)}`,
            !phpEmpty(routed.ruleName) ? `Rule: ${routed.ruleName}` : null, leadId,
          ]
        );
        if (routed.ownerId) {
          await notifyUser(orgId, routed.ownerId, 'LEAD_ASSIGNED',
            `New lead assigned: ${`${phpStr(row.first_name)} ${phpStr(row.last_name ?? '')}`.trim()}`,
            `${row.code} from ${!phpEmpty(sourceLabel) ? sourceLabel : 'unknown source'}`, 'LEAD', leadId, `#/leads/${leadId}`);
        }
      }
    } else if (row.owner_id) {
      await dbExec('UPDATE leads SET assigned_at = NOW() WHERE id = ?', [leadId]);
      await notifyUser(orgId, row.owner_id, 'LEAD_ASSIGNED',
        `New lead assigned: ${`${phpStr(row.first_name)} ${phpStr(row.last_name ?? '')}`.trim()}`,
        `${row.code} from ${!phpEmpty(sourceLabel) ? sourceLabel : 'unknown source'}`, 'LEAD', leadId, `#/leads/${leadId}`);
    }

    // ---- scoring --------------------------------------------------------------
    const scored = await computeScore(orgId, await leadBuildContext(row));
    if (scored.score !== Math.trunc(phpFloat(row.score))) {
      await dbExec('UPDATE leads SET score = ?, score_band = ? WHERE id = ?', [scored.score, scored.band, leadId]);
      row = await dbOne('SELECT * FROM leads WHERE id = ?', [leadId]);
    }

    await auditRecord(orgId, actor, 'lead.created', {
      entityType: 'LEAD', entityId: leadId, entityLabel: `${row.code} ${row.first_name}`,
      changes: { origin, source: sourceLabel },
    }, currentRequest());

    return { lead: row, assignment: routed };
  });

  if (phpEmpty(ctx.skipAutomation)) {
    emitDomainEvent('lead.created', { organizationId: orgId, entityType: 'LEAD', data: await leadBuildContext(lead) });
    if (lead.owner_id) {
      emitDomainEvent('lead.assigned', { organizationId: orgId, entityType: 'LEAD', data: await leadBuildContext(lead) });
    }
  }

  return { lead: await leadBuildContext(lead), duplicates, assignment };
}

/** Partial update. Emits status/assignment events only when they really change. */
export async function updateLead(leadId, input, ctx) {
  const orgId = ctx.organizationId;
  const actor = ctx.actor ?? null;
  input = input ?? {};

  const { lead, changes, statusChanged, ownerChanged } = await dbTransaction(async () => {
    const before = await dbOne('SELECT * FROM leads WHERE id = ? AND organization_id = ?', [leadId, orgId]);
    if (!before) {
      throw notFound('Lead not found');
    }

    const data = leadScalarPatch(input);
    if (hasKey(input, 'email')) {
      data.email_norm = normalizeEmail(typeof input.email === 'string' ? input.email : phpStr(input.email));
    }
    if (hasKey(input, 'phone')) {
      data.phone_norm = normalizePhone(typeof input.phone === 'string' ? input.phone : phpStr(input.phone));
    }
    if (hasKey(input, 'nextFollowUpAt')) {
      data.next_follow_up_at = parseDateLocal(input.nextFollowUpAt);
    }
    if (hasKey(input, 'lastContactedAt')) {
      data.last_contacted_at = parseDateLocal(input.lastContactedAt);
    }
    if (hasKey(input, 'siteVisitAt')) {
      data.site_visit_at = parseDateLocal(input.siteVisitAt);
    }
    if (hasKey(input, 'projectId') || hasKey(input, 'project')) {
      // Re-resolved rather than trusted, for the same reason as on create.
      data.project_id = await leadResolveProject(orgId, input.projectId ?? input.project);
    }
    if (hasKey(input, 'customFields')) {
      data.custom_fields = await validateCustomFieldValues(orgId, 'LEAD', input.customFields, before.custom_fields);
    }

    let isStatusChange = false;
    let newStatus = null;
    if (hasKey(input, 'statusId') || hasKey(input, 'status')) {
      newStatus = await leadResolveStatus(orgId, input.statusId ?? input.status);
      if (newStatus.id !== before.status_id) {
        isStatusChange = true;
        data.status_id = newStatus.id;
        if (gvBool(newStatus.is_qualified) && !before.qualified_at) {
          data.qualified_at = nowSql();
        }
        if (gvBool(newStatus.is_lost)) {
          data.lost_at = nowSql();
        } else if (before.lost_at) {
          data.lost_at = null;
          data.lost_reason = null;
        }
      }
    }

    if (hasKey(input, 'sourceId')) {
      const source = await leadResolveSource(orgId, input.sourceId);
      data.source_id = source?.id ?? null;
    }

    let isOwnerChange = false;
    const requestedOwner = input.ownerId === undefined ? null : input.ownerId;
    if (hasKey(input, 'ownerId') && requestedOwner !== before.owner_id) {
      if (!phpEmpty(requestedOwner)) {
        const owner = await dbOne(
          'SELECT id FROM users WHERE id = ? AND organization_id = ? AND is_active = 1',
          [scalarParam(requestedOwner), orgId]
        );
        if (!owner) {
          throw badRequest('That user cannot own leads in this organisation');
        }
      }
      data.owner_id = !phpEmpty(requestedOwner) ? scalarParam(requestedOwner) : null;
      data.assigned_at = nowSql();
      isOwnerChange = true;
    }
    const requestedTeam = input.teamId === undefined ? null : input.teamId;
    if (hasKey(input, 'teamId') && requestedTeam !== before.team_id) {
      if (!phpEmpty(requestedTeam)) {
        const team = await dbOne('SELECT id FROM teams WHERE id = ? AND organization_id = ?', [scalarParam(requestedTeam), orgId]);
        if (!team) {
          throw badRequest('Unknown team');
        }
      }
      data.team_id = !phpEmpty(requestedTeam) ? scalarParam(requestedTeam) : null;
    }

    const dataKeys = Object.keys(data);
    if (dataKeys.length) {
      const sets = dataKeys.map((k) => `\`${k}\` = ?`).join(', ');
      await dbExec(`UPDATE leads SET ${sets}, updated_at = NOW() WHERE id = ?`, [...dataKeys.map((k) => data[k]), leadId]);
    }

    if (hasKey(input, 'tags')) {
      await leadApplyTags(leadId, orgId, input.tags);
    }
    let row = await dbOne('SELECT * FROM leads WHERE id = ?', [leadId]);

    const diff = gvDiff(before, row, [
      ...Object.values(GV_LEAD_WRITABLE_FIELDS),
      'status_id', 'owner_id', 'team_id', 'source_id', 'project_id', 'next_follow_up_at', 'site_visit_at',
    ]);

    if (isStatusChange) {
      // The subject is read by people in the timeline, so it names the status
      // they knew it by. Without this it prints the previous status's id.
      let fromName = before.status_id
        ? phpStr(await dbScalar('SELECT name FROM lead_statuses WHERE id = ?', [before.status_id]))
        : '';
      fromName = fromName !== '' ? fromName : 'No status';
      await dbExec(
        'INSERT INTO activities (id, organization_id, type, subject, lead_id, user_id, meta, occurred_at, created_at) VALUES (?,?,?,?,?,?,?,NOW(),NOW())',
        [
          gvId(), orgId, 'STATUS_CHANGE', `Status: ${fromName} to ${newStatus.name}`, leadId, actor?.id ?? null,
          toJson({ from: before.status_id, to: newStatus.key }),
        ]
      );
    }
    if (isOwnerChange) {
      const ownerName = row.owner_id
        ? await dbOne('SELECT first_name, last_name FROM users WHERE id = ?', [row.owner_id])
        : null;
      await dbExec(
        'INSERT INTO activities (id, organization_id, type, subject, lead_id, user_id, meta, occurred_at, created_at) VALUES (?,?,?,?,?,?,?,NOW(),NOW())',
        [
          gvId(), orgId, 'ASSIGNMENT',
          ownerName ? `Reassigned to ${`${phpStr(ownerName.first_name)} ${phpStr(ownerName.last_name)}`.trim()}` : 'Owner cleared',
          leadId, actor?.id ?? null, toJson({ from: before.owner_id, to: row.owner_id }),
        ]
      );
      if (row.owner_id) {
        const statusName = await dbScalar('SELECT name FROM lead_statuses WHERE id = ?', [row.status_id]);
        await notifyUser(orgId, row.owner_id, 'LEAD_REASSIGNED',
          `Lead assigned to you: ${`${phpStr(row.first_name)} ${phpStr(row.last_name ?? '')}`.trim()}`,
          `${row.code} - ${phpStr(statusName)}`, 'LEAD', leadId, `#/leads/${leadId}`);
      }
    }

    if (Object.keys(diff).length) {
      await auditRecord(orgId, actor, 'lead.updated', {
        entityType: 'LEAD', entityId: leadId, entityLabel: `${row.code} ${row.first_name}`, changes: diff,
      }, currentRequest());
    }

    const scored = await computeScore(orgId, await leadBuildContext(row));
    if (scored.score !== Math.trunc(phpFloat(row.score)) || scored.band !== row.score_band) {
      await dbExec('UPDATE leads SET score = ?, score_band = ? WHERE id = ?', [scored.score, scored.band, leadId]);
      row = await dbOne('SELECT * FROM leads WHERE id = ?', [leadId]);
    }

    return { lead: row, changes: diff, statusChanged: isStatusChange, ownerChanged: isOwnerChange };
  });

  if (phpEmpty(ctx.skipAutomation)) {
    const context = await leadBuildContext(lead);
    emitDomainEvent('lead.updated', { organizationId: orgId, entityType: 'LEAD', data: context, changes });
    if (statusChanged) {
      emitDomainEvent('lead.status_changed', { organizationId: orgId, entityType: 'LEAD', data: context, changes });
    }
    if (ownerChanged && lead.owner_id) {
      emitDomainEvent('lead.assigned', { organizationId: orgId, entityType: 'LEAD', data: context, changes });
    }
  }

  return leadBuildContext(lead);
}

/** Bulk assignment. Returns the number actually moved. */
export async function assignLeads(orgId, leadIds, ownerId, teamId, actor) {
  if (!phpEmpty(ownerId)) {
    const owner = await dbOne('SELECT id FROM users WHERE id = ? AND organization_id = ? AND is_active = 1', [ownerId, orgId]);
    if (!owner) {
      throw badRequest('That user cannot receive leads');
    }
  }
  if (!phpEmpty(teamId)) {
    const team = await dbOne('SELECT id FROM teams WHERE id = ? AND organization_id = ?', [teamId, orgId]);
    if (!team) {
      throw badRequest('Unknown team');
    }
  }
  if (!leadIds || !leadIds.length) {
    return 0;
  }

  const { leads, events } = await dbTransaction(async () => {
    const [inSql, p] = dbInClause(leadIds);
    const rows = await dbAll(
      `SELECT id, code, first_name, last_name, owner_id FROM leads WHERE id IN ${inSql} AND organization_id = ?`,
      [...p, orgId]
    );
    if (!rows.length) {
      return { leads: [], events: [] };
    }
    const ids = rows.map((l) => l.id);
    const [in2, p2] = dbInClause(ids);

    const sets = [];
    const params = [];
    if (ownerId !== null && ownerId !== undefined) {
      sets.push('owner_id = ?');
      params.push(!phpEmpty(ownerId) ? ownerId : null);
    }
    if (teamId !== null && teamId !== undefined) {
      sets.push('team_id = ?');
      params.push(!phpEmpty(teamId) ? teamId : null);
    }
    sets.push('assigned_at = NOW()');
    await dbExec(`UPDATE leads SET ${sets.join(', ')} WHERE id IN ${in2}`, [...params, ...p2]);

    const queued = [];
    for (const l of rows) {
      await dbExec(
        'INSERT INTO activities (id, organization_id, type, subject, lead_id, user_id, occurred_at, created_at) VALUES (?,?,?,?,?,?,NOW(),NOW())',
        [gvId(), orgId, 'ASSIGNMENT', !phpEmpty(ownerId) ? 'Bulk assigned' : 'Bulk routed to team', l.id, actor?.id ?? null]
      );
      queued.push({
        organizationId: orgId,
        entityType: 'LEAD',
        data: { ...l, ownerId: !phpEmpty(ownerId) ? ownerId : null, teamId: !phpEmpty(teamId) ? teamId : null },
      });
    }
    if (!phpEmpty(ownerId)) {
      await notifyUser(orgId, ownerId, 'LEAD_ASSIGNED', `${rows.length} lead(s) assigned to you`,
        rows.slice(0, 5).map((l) => l.code).join(', '), 'LEAD', rows[0]?.id ?? null, '#/leads');
    }

    await auditRecord(orgId, actor, 'lead.bulk_assigned', {
      entityType: 'LEAD', entityLabel: `${rows.length} leads`,
      changes: { ownerId: ownerId ?? null, teamId: teamId ?? null, leadIds: ids },
    }, currentRequest());

    return { leads: rows, events: queued };
  });

  for (const payload of events) {
    emitDomainEvent('lead.assigned', payload);
  }

  return leads.length;
}
