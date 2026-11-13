/**
 * Duplicate detection — port of services/Duplicates.php, including the fix
 * applied during hardening: matching is NAME_COMPANY (same person, same
 * company), not "company + email domain", which would wrongly flag every
 * colleague at the same firm as a duplicate of each other.
 */

import { dbAll, dbExec, dbInClause, dbOne, dbTransaction } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { gvId, normalizeEmail, normalizePhone, toJson } from '../lib/util.js';

export const GV_DUP_STRATEGY_WEIGHT = { PHONE: 100, EMAIL: 90, NAME_PHONE: 80, NAME_COMPANY: 45 };

/** PHP empty(): '', '0', 0, null, false and [] are all "empty". */
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

/**
 * A request value as PDO would have bound it. mysql2 expands an array into a
 * value list and an object into `key = value` pairs, so neither may reach a
 * placeholder raw; PHP bound both as the string "Array".
 */
function scalarParam(value) {
  if (value !== null && typeof value === 'object') return 'Array';
  if (typeof value === 'boolean') return value ? '1' : '';
  return value;
}

/** strtotime() of a DATETIME string, in milliseconds. */
function sqlTime(value) {
  const ms = new Date(String(value).replace(' ', 'T')).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

export async function findDuplicates(orgId, input, excludeId = null, limit = 5) {
  const emailNorm = normalizeEmail(input.email ?? null);
  const phoneNorm = normalizePhone(input.phone ?? null);
  const altPhoneNorm = normalizePhone(input.altPhone ?? null);

  const or = [];
  const params = [];
  if (phoneNorm) {
    or.push('phone_norm = ?');
    params.push(phoneNorm);
  }
  if (altPhoneNorm && altPhoneNorm !== phoneNorm) {
    or.push('phone_norm = ?');
    params.push(altPhoneNorm);
  }
  if (emailNorm) {
    or.push('email_norm = ?');
    params.push(emailNorm);
  }
  if (!phpEmpty(input.company) && !phpEmpty(input.firstName)) {
    if (!phpEmpty(input.lastName)) {
      or.push('(company = ? AND first_name = ? AND last_name = ?)');
      params.push(scalarParam(input.company), scalarParam(input.firstName), scalarParam(input.lastName));
    } else {
      or.push('(company = ? AND first_name = ?)');
      params.push(scalarParam(input.company), scalarParam(input.firstName));
    }
  }
  if (!or.length) {
    return [];
  }

  // `limit` is an integer in every caller; forced to one here because it is
  // interpolated into the LIMIT clause rather than bound.
  const lim = Math.max(0, Math.trunc(Number(limit) || 0));
  let sql = `SELECT id, code, first_name, last_name, email, phone, company, email_norm, phone_norm, created_at, owner_id
            FROM leads WHERE organization_id = ? AND is_duplicate = 0`;
  const bind = [orgId];
  if (excludeId) {
    sql += ' AND id != ?';
    bind.push(excludeId);
  }
  sql += ` AND (${or.join(' OR ')}) ORDER BY created_at DESC LIMIT ${lim * 3}`;
  const rows = await dbAll(sql, [...bind, ...params]);

  // Hydrate owner + status labels the frontend expects.
  const ownerIds = [...new Set(rows.map((r) => r.owner_id).filter(Boolean))];
  const owners = {};
  if (ownerIds.length) {
    const [inSql, p] = dbInClause(ownerIds);
    for (const u of await dbAll(`SELECT id, first_name, last_name FROM users WHERE id IN ${inSql}`, p)) {
      owners[u.id] = u;
    }
  }

  const scored = [];
  for (const row of rows) {
    const reasons = [];
    if (phoneNorm && row.phone_norm === phoneNorm) {
      reasons.push('PHONE');
    }
    if (emailNorm && row.email_norm === emailNorm) {
      reasons.push('EMAIL');
    }
    if (reasons.includes('PHONE') && !phpEmpty(input.firstName)
      && phpStr(row.first_name).toLowerCase() === phpStr(input.firstName).toLowerCase()) {
      reasons.push('NAME_PHONE');
    }
    if (!reasons.length) {
      reasons.push('NAME_COMPANY');
    }
    const confidence = Math.max(...reasons.map((r) => GV_DUP_STRATEGY_WEIGHT[r] ?? 0));
    const owner = row.owner_id ? owners[row.owner_id] : undefined;
    scored.push({
      id: row.id, code: row.code,
      firstName: row.first_name, lastName: row.last_name,
      email: row.email, phone: row.phone, company: row.company,
      createdAt: row.created_at,
      owner: owner ? {
        id: row.owner_id,
        firstName: owner.first_name,
        lastName: owner.last_name,
      } : null,
      matchedOn: reasons,
      confidence,
    });
  }
  scored.sort((a, b) => b.confidence - a.confidence);
  return scored.slice(0, lim);
}

/**
 * Merges `sourceIds` into `targetId`: fills the target's blank fields from the
 * newest source, re-parents every child record, and tombstones the sources
 * (isDuplicate = true) rather than deleting them, so old links still resolve.
 */
export async function mergeLeads(orgId, targetId, sourceIds, actorId) {
  const ids = [...new Set((sourceIds ?? []).filter((id) => String(id) !== String(targetId)))];
  if (!ids.length) {
    throw badRequest('Nothing to merge');
  }

  return dbTransaction(async () => {
    const target = await dbOne('SELECT * FROM leads WHERE id = ? AND organization_id = ?', [targetId, orgId]);
    if (!target) {
      throw notFound('Target lead not found');
    }
    const [inSql, p] = dbInClause(ids);
    const sources = await dbAll(
      `SELECT * FROM leads WHERE id IN ${inSql} AND organization_id = ? ORDER BY created_at DESC`,
      [...p, orgId]
    );
    if (!sources.length) {
      throw notFound('No source leads found');
    }

    const fillable = [
      'last_name', 'email', 'phone', 'alt_phone', 'company', 'job_title', 'website',
      'country', 'state', 'city', 'address', 'pincode',
      'source_id', 'project_id', 'medium', 'landing_page', 'referrer_url',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'expected_value', 'notes',
    ];
    const patch = {};
    for (const field of fillable) {
      if (target[field] === null || target[field] === undefined || target[field] === '') {
        for (const s of sources) {
          if (s[field] !== null && s[field] !== undefined && s[field] !== '') {
            patch[field] = s[field];
            break;
          }
        }
      }
    }
    if (patch.email !== undefined && patch.email !== null) {
      patch.email_norm = normalizeEmail(patch.email);
    }
    if (patch.phone !== undefined && patch.phone !== null) {
      patch.phone_norm = normalizePhone(patch.phone);
    }

    // Earliest first-touch across the merged set is the true first touch.
    const all = [...sources, target];
    const withTouch = all.filter((l) => l.first_touch_at);
    if (withTouch.length) {
      withTouch.sort((a, b) => sqlTime(a.first_touch_at) - sqlTime(b.first_touch_at));
      const earliest = withTouch[0];
      if (earliest.id !== target.id) {
        patch.first_touch_source = earliest.first_touch_source;
        patch.first_touch_campaign = earliest.first_touch_campaign;
        patch.first_touch_at = earliest.first_touch_at;
      }
    }
    patch.score = Math.max(Math.trunc(Number(target.score) || 0), ...sources.map((s) => Math.trunc(Number(s.score) || 0)));

    for (const table of ['activities', 'documents']) {
      await dbExec(`UPDATE ${table} SET lead_id = ? WHERE lead_id IN ${inSql}`, [targetId, ...p]);
    }

    // Tags: a join table with a unique constraint — move only tags the target lacks.
    const existingTags = await dbAll('SELECT tag_id FROM lead_tags WHERE lead_id = ?', [targetId]);
    const have = new Set(existingTags.map((t) => t.tag_id));
    const incoming = await dbAll(`SELECT * FROM lead_tags WHERE lead_id IN ${inSql}`, p);
    for (const link of incoming) {
      if (have.has(link.tag_id)) {
        await dbExec('DELETE FROM lead_tags WHERE id = ?', [link.id]);
      } else {
        await dbExec('UPDATE lead_tags SET lead_id = ? WHERE id = ?', [targetId, link.id]);
        have.add(link.tag_id);
      }
    }

    await dbExec(`UPDATE leads SET is_duplicate = 1, merged_into_id = ? WHERE id IN ${inSql}`, [targetId, ...p]);

    const patchKeys = Object.keys(patch);
    if (patchKeys.length) {
      const sets = patchKeys.map((k) => `${k} = ?`).join(', ');
      await dbExec(`UPDATE leads SET ${sets} WHERE id = ?`, [...patchKeys.map((k) => patch[k]), targetId]);
    }
    const merged = await dbOne('SELECT * FROM leads WHERE id = ?', [targetId]);

    await dbExec(
      `INSERT INTO activities (id, organization_id, type, subject, body, lead_id, user_id, meta, occurred_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [
        gvId(), orgId, 'SYSTEM', `Merged ${sources.length} duplicate lead(s)`,
        sources.map((s) => `${phpStr(s.code)} - ${phpStr(s.first_name)} ${phpStr(s.last_name ?? '')}`).join(', '),
        targetId, actorId, toJson({ mergedIds: ids }),
      ]
    );

    return { merged, mergedCount: sources.length };
  });
}
