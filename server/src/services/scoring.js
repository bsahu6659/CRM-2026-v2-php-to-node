/** Configurable lead scoring — port of services/Scoring.php. */

import { dbAll, dbExec, dbOne } from '../lib/db.js';
import { gvId, safeJson, toCamelCase, toJson } from '../lib/util.js';

export const GV_SCORING_KINDS = [
  { key: 'FIELD_PRESENT', label: 'Field has a value', needs: ['field'] },
  { key: 'FIELD_EQUALS', label: 'Field matches a value', needs: ['field', 'value'] },
  { key: 'FIELD_GT', label: 'Numeric field greater than', needs: ['field', 'value'] },
  { key: 'SOURCE_IS', label: 'Lead source is', needs: ['value'] },
  { key: 'CAMPAIGN_IS', label: 'Campaign code is', needs: ['value'] },
  { key: 'ACTIVITY_COUNT', label: 'Has at least N activities of a type', needs: ['field', 'value'] },
  { key: 'NO_ACTIVITY_DAYS', label: 'No activity for N days (use negative points)', needs: ['value'] },
  { key: 'STATUS_IS', label: 'Lead status is', needs: ['value'] },
];

export const GV_SCORE_BANDS = [
  { key: 'VERY_HOT', min: 75, label: 'Very Hot', color: '#dc2626' },
  { key: 'HOT', min: 50, label: 'Hot', color: '#ea580c' },
  { key: 'WARM', min: 25, label: 'Warm', color: '#d97706' },
  { key: 'COLD', min: 0, label: 'Cold', color: '#0284c7' },
];

// PHP cast semantics, so a rule scores identically on either backend.
function isRecord(value) {
  return value !== null && typeof value === 'object';
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

function phpInt(value) {
  return Math.trunc(phpFloat(value));
}

/** PHP `?:` — '', '0', 0, null and false all fall through. */
function phpFalsy(value) {
  return value === null || value === undefined || value === false || value === 0 || value === '' || value === '0';
}

/** strtotime() of a DATETIME string, in seconds; null when unparseable. */
function sqlTime(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T'));
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * PHP's camelize() over a DB row: top-level keys only. A JSON column was a
 * string to PHP, so its own keys were never touched — mysql2 hands it back
 * decoded, and a deep camelize would rename custom-field keys.
 */
function camelizeRow(row) {
  if (!isRecord(row)) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[toCamelCase(k)] = v;
  return out;
}

export function scoreBandFor(score) {
  for (const b of GV_SCORE_BANDS) {
    if (score >= b.min) {
      return b.key;
    }
  }
  return 'COLD';
}

export function scoringGetField(lead, field) {
  if (!field) {
    return null;
  }
  if (field.startsWith('customFields.')) {
    const cf = safeJson(lead?.customFields ?? '{}', []);
    if (!isRecord(cf)) return null;
    return cf[field.slice(13)] ?? null;
  }
  let value = lead;
  for (const seg of field.split('.')) {
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, seg)) {
      return null;
    }
    value = value[seg];
  }
  return value === undefined ? null : value;
}

export function scoringIsPresent(value) {
  return !(value === null || value === undefined || phpStr(value).trim() === '');
}

/**
 * `lead` is a camelCase lead row, plus optional `source`/`status` sub-objects.
 * Returns { score, band, breakdown }.
 */
export async function computeScore(orgId, lead) {
  const rules = await dbAll(
    'SELECT * FROM scoring_rules WHERE organization_id = ? AND is_active = 1 ORDER BY sort_order ASC, created_at ASC',
    [orgId]
  );
  if (!rules.length) {
    const score = phpInt(lead.score ?? 0);
    return { score, band: scoreBandFor(score), breakdown: [] };
  }

  const needsActivity = rules.some((r) => ['ACTIVITY_COUNT', 'NO_ACTIVITY_DAYS'].includes(r.kind));
  const activityCounts = {};
  let lastActivityAt = null;
  if (needsActivity && !phpFalsy(lead.id)) {
    const rows = await dbAll(
      'SELECT type, COUNT(*) AS cnt, MAX(occurred_at) AS last_at FROM activities WHERE organization_id = ? AND lead_id = ? GROUP BY type',
      [orgId, lead.id]
    );
    for (const r of rows) {
      activityCounts[r.type] = phpInt(r.cnt);
      const at = sqlTime(r.last_at);
      if (r.last_at && (!lastActivityAt || (at !== null && at > lastActivityAt))) {
        lastActivityAt = at;
      }
    }
  }

  const breakdown = [];
  let total = 0;
  for (const rule of rules) {
    let hit = false;
    switch (rule.kind) {
      case 'FIELD_PRESENT':
        hit = scoringIsPresent(scoringGetField(lead, rule.field));
        break;
      case 'FIELD_EQUALS':
        hit = phpStr(scoringGetField(lead, rule.field)).toLowerCase() === phpStr(rule.value).toLowerCase();
        break;
      case 'FIELD_GT':
        hit = phpFloat(scoringGetField(lead, rule.field)) > phpFloat(rule.value);
        break;
      case 'SOURCE_IS':
        hit = phpStr(lead.source?.key ?? '').toLowerCase() === phpStr(rule.value).toLowerCase();
        break;
      case 'CAMPAIGN_IS':
        hit = phpStr(lead.utmCampaign ?? '').toLowerCase() === phpStr(rule.value).toLowerCase();
        break;
      case 'STATUS_IS':
        hit = phpStr(lead.status?.key ?? '').toLowerCase() === phpStr(rule.value).toLowerCase();
        break;
      case 'ACTIVITY_COUNT':
        hit = (activityCounts[phpStr(rule.field).toUpperCase()] ?? 0) >= phpInt(phpFalsy(rule.value) ? 1 : rule.value);
        break;
      case 'NO_ACTIVITY_DAYS': {
        const days = phpInt(phpFalsy(rule.value) ? 30 : rule.value);
        const nowSec = Math.floor(Date.now() / 1000);
        const reference = lastActivityAt
          || (lead.createdAt !== undefined && lead.createdAt !== null ? sqlTime(lead.createdAt) ?? 0 : nowSec);
        hit = (nowSec - reference) / 86400 >= days;
        break;
      }
      default:
        break;
    }
    if (hit) {
      total += phpInt(rule.points);
      breakdown.push({ rule: rule.name, points: phpInt(rule.points) });
    }
  }

  const score = Math.max(0, Math.min(100, total));
  return { score, band: scoreBandFor(score), breakdown };
}

/** Recomputes and persists; returns null when nothing changed. */
export async function rescoreLead(orgId, leadId, actorId = null) {
  const lead = await dbOne('SELECT * FROM leads WHERE id = ? AND organization_id = ?', [leadId, orgId]);
  if (!lead) {
    return null;
  }
  const enriched = camelizeRow(lead);
  if (lead.source_id) {
    enriched.source = camelizeRow(await dbOne('SELECT `key` FROM lead_sources WHERE id = ?', [lead.source_id]));
  }
  if (lead.status_id) {
    enriched.status = camelizeRow(await dbOne('SELECT `key` FROM lead_statuses WHERE id = ?', [lead.status_id]));
  }

  const { score, band } = await computeScore(orgId, enriched);
  if (score === phpInt(lead.score) && band === lead.score_band) {
    return null;
  }
  await dbExec('UPDATE leads SET score = ?, score_band = ? WHERE id = ?', [score, band, leadId]);

  await dbExec(
    `INSERT INTO activities (id, organization_id, type, subject, lead_id, user_id, meta, occurred_at, created_at)
     VALUES (?,?,?,?,?,?,?,NOW(),NOW())`,
    [
      gvId(), orgId, 'SCORE_CHANGE',
      `Lead score ${phpStr(lead.score)} to ${score} (${band.replaceAll('_', ' ')})`,
      leadId, actorId, toJson({ from: phpInt(lead.score), to: score, band }),
    ]
  );

  return dbOne('SELECT * FROM leads WHERE id = ?', [leadId]);
}
