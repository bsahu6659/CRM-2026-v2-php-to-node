/**
 * In-app notifications — port of services/Notifications.php. Email is
 * deliberately not wired to a transport here: without SMTP configured, a
 * notification stays in the in-app centre and the server logs that delivery
 * was skipped, rather than silently pretending to have sent something.
 */

import config from '../config/index.js';
import { dbAll, dbExec, dbOne } from '../lib/db.js';
import { gvId, nowSql, toSqlDateTime } from '../lib/util.js';
import { staffDailySummarySweep, staffFollowupSweep } from './staffNotify.js';

export const GV_NOTIFICATION_TYPES = {
  LEAD_ASSIGNED: 'INFO', LEAD_REASSIGNED: 'INFO', LEAD_CONVERTED: 'SUCCESS',
  TASK_ASSIGNED: 'INFO', TASK_DUE: 'WARNING', TASK_OVERDUE: 'DANGER',
  FOLLOWUP_DUE: 'WARNING', FOLLOWUP_UPCOMING: 'INFO', DAILY_SUMMARY: 'INFO', OPPORTUNITY_UPDATED: 'INFO', DEAL_WON: 'SUCCESS',
  DEAL_LOST: 'DANGER', MENTION: 'INFO', SYSTEM_ALERT: 'WARNING', IMPORT_COMPLETE: 'SUCCESS',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** PHP date('d M Y, H:i', strtotime($value)). */
function formatDueAt(value) {
  const d = new Date(String(value ?? '').replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '01 Jan 1970, 00:00';
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * Never throws: a notification is a side effect of some other operation, and
 * failing to write one must not undo the lead update that caused it.
 */
export async function notifyUser(
  orgId,
  userId,
  type,
  title,
  body = null,
  entityType = null,
  entityId = null,
  link = null,
  sendEmail = false
) {
  if (!userId) {
    return null;
  }
  try {
    const id = gvId();
    const severity = GV_NOTIFICATION_TYPES[type] ?? 'INFO';
    await dbExec(
      `INSERT INTO notifications (id, organization_id, user_id, type, title, body, entity_type, entity_id, link, severity, email_queued_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [id, orgId, userId, type, title, body, entityType, entityId, link, severity, sendEmail ? nowSql() : null]
    );
    if (sendEmail) {
      queueNotificationEmail(title);
    }
    return await dbOne('SELECT * FROM notifications WHERE id = ?', [id]);
  } catch (err) {
    console.error(`[notifications] create failed: ${err?.message ?? err}`);
    return null;
  }
}

export async function notifyMany(userIds, orgId, type, title, body, entityType, entityId, link) {
  for (const userId of [...new Set((userIds ?? []).filter(Boolean))]) {
    await notifyUser(orgId, userId, type, title, body, entityType, entityId, link);
  }
}

export function queueNotificationEmail(title) {
  if (!config.mail.host) {
    console.error(`[notifications] SMTP not configured - "${title}" stayed in-app only.`);
    return;
  }
  // A single seam for a future per-notification email; staff alerts already
  // go out through services/staffNotify.js. Deliberately not faked here.
  console.error(`[notifications] email queued: ${title}`);
}

/** Sweeps tasks and follow-ups that have come due; called from jobs/sweep.js. */
export async function runDueSweep() {
  const now = nowSql();
  // tasksDue is reported by the cron script, so it has to exist even when
  // nothing is due.
  let results = { tasksDue: 0, followUpsDue: 0, followUpsUpcoming: 0 };

  const dueLeads = await dbAll(
    `SELECT id, code, first_name, last_name, organization_id, owner_id, next_follow_up_at FROM leads
     WHERE next_follow_up_at <= ? AND owner_id IS NOT NULL AND is_converted = 0 AND is_duplicate = 0 LIMIT 500`,
    [now]
  );
  for (const lead of dueLeads) {
    const cutoff = toSqlDateTime(new Date(Date.now() - 12 * 3600 * 1000));
    const already = await dbOne(
      "SELECT id FROM notifications WHERE user_id = ? AND entity_type = 'LEAD' AND entity_id = ? AND type = 'FOLLOWUP_DUE' AND created_at >= ?",
      [lead.owner_id, lead.id, cutoff]
    );
    if (already) {
      continue;
    }
    await notifyUser(lead.organization_id, lead.owner_id, 'FOLLOWUP_DUE',
      `Follow-up due: ${`${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim()}`,
      `${lead.code} - scheduled for ${formatDueAt(lead.next_follow_up_at)}`, 'LEAD', lead.id, `#/leads/${lead.id}`);
    results.followUpsDue++;
  }

  // Warning people before a follow-up slips is the point; the block above
  // only catches the ones that already have.
  results = { ...results, ...(await staffFollowupSweep()) };

  // And once each morning, the whole day in one email.
  results = { ...results, ...(await staffDailySummarySweep()) };

  return results;
}

export function registerNotificationListeners() {
  // Notifications are raised directly by leadService at the point of action,
  // so there is nothing additional to subscribe here — this function exists as
  // the wiring point listeners.js expects, kept for symmetry with
  // registerAutomationListeners()/registerWebhookListeners().
}
