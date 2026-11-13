/**
 * Email aimed at the sales team, not the buyer — port of services/StaffNotify.php.
 *
 * Two moments matter to the person who owns a lead: it arrived, and its
 * follow-up is about to come due. The in-app notification centre already
 * records both - but nobody keeps a CRM tab open all day, which is the whole
 * reason a lead goes cold.
 *
 * Three rules this file keeps:
 *
 *   1. It sends from the platform's own mailbox, configured once in .env, for
 *      every company. A staff alert is not a customer-facing message, so it
 *      must not wait on a tenant setting up SMTP - and most never will. The
 *      tenant's own channel is untouched; that one still speaks to buyers.
 *   2. It refuses to pretend. If the platform mailer is not configured, or the
 *      company has the alert switched off, nothing is "sent" - the reason is
 *      written to the message log exactly like a skipped welcome message.
 *   3. It is a copy, never the record. A failure here is logged and swallowed;
 *      it must not roll back the lead that has just been created.
 */

import config from '../config/index.js';
import { dbAll, dbOne, dbScalar } from '../lib/db.js';
import { gvBool } from '../lib/util.js';
import { commsLog, emailSettings } from './comms.js';
import { onDomainEvent } from './events.js';
import { sendSystemMail } from './mailer.js';
import { notifyUser } from './notifications.js';

// ---------------------------------------------------------------------------
// Local stand-ins for PHP built-ins this file leans on.
// ---------------------------------------------------------------------------

/** htmlspecialchars($s, ENT_QUOTES, 'UTF-8'). */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** PHP empty(): null, '', '0', 0, false and empty arrays are all "nothing". */
function isEmpty(value) {
  if (value === null || value === undefined || value === false) return true;
  if (value === '' || value === '0' || value === 0) return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** PHP (int) cast. */
function toInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** PHP trim() with an explicit character list. */
function trimChars(value, chars) {
  const set = new Set(chars.split(''));
  const s = String(value ?? '');
  let start = 0;
  let end = s.length;
  while (start < end && set.has(s[start])) start++;
  while (end > start && set.has(s[end - 1])) end--;
  return s.slice(start, end);
}

/** trim(first . ' ' . last) — the name as every alert prints it. */
function personName(row) {
  return `${row?.first_name ?? ''} ${row?.last_name ?? ''}`.trim();
}

/**
 * strtotime() for the values this file sees: MySQL DATETIME strings, which
 * the pool returns as local-time 'YYYY-MM-DD HH:MM:SS'. Parsed by hand so the
 * result never depends on how a JS engine reads a space-separated date.
 */
function phpTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(value ?? ''));
  const d = m
    ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
    : new Date(value);
  if (Number.isNaN(d.getTime())) {
    // PHP's date() refuses a false timestamp under strict_types; failing here
    // keeps that behaviour rather than printing "NaN:NaN".
    throw new TypeError(`Could not read a date from "${value}"`);
  }
  return d;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** date('g:i a') */
function formatClock(d) {
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'am' : 'pm'}`;
}

/** date('d M Y, g:i a') */
function formatDueAt(d) {
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${formatClock(d)}`;
}

/** date('D j M') */
function formatDayLabel(d) {
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/**
 * Where a staff email's button lands. The PHP edition served the SPA itself
 * and linked to APP_URL/index.html#/leads/…; here the React app is a separate
 * origin with BrowserRouter paths, so the link points at CLIENT_URL/leads/….
 */
function appLink(path) {
  return `${String(config.clientUrl ?? '').replace(/\/+$/, '')}${path}`;
}

// ---------------------------------------------------------------------------
// The platform mailer
// ---------------------------------------------------------------------------

/**
 * The platform's own mailer, used for every staff alert in every company.
 *
 * These messages go to the salesperson, not the buyer - so they must not wait
 * on a customer configuring SMTP. A company that has never opened the WhatsApp
 * & Email screen still gets told when a lead lands. One mailbox, set once in
 * .env, sends for everybody.
 *
 * A tenant's own channel stays exactly where it was: it is what speaks to
 * buyers, and nothing here touches it.
 */
export function staffMailerSettings() {
  const from = String(config.mail.from ?? '');
  // SMTP_FROM may be either "Name <addr>" or a bare address.
  let fromEmail = from;
  let fromName = 'Growvanta CRM';
  const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(from);
  if (m) {
    fromName = trimChars(m[1], ' "\'') || fromName;
    fromEmail = m[2].trim();
  }

  return {
    smtp_host: String(config.mail.host ?? ''),
    smtp_port: toInt(config.mail.port),
    smtp_encryption: String(config.mail.encryption ?? '').toUpperCase(),
    smtp_username: String(config.mail.user ?? ''),
    smtp_password_plain: String(config.mail.pass ?? ''),
    from_email: fromEmail,
    from_name: fromName,
  };
}

/**
 * Can the platform mailer send right now?
 *
 * Nothing here asks about the tenant. The only question is whether the one
 * shared mailbox is configured, so the answer is the same for every company.
 */
export function staffEmailReady(settings) {
  if (isEmpty(settings.smtp_host)) {
    return {
      ready: false,
      reason: 'The platform mailer is not configured - set SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM in .env.',
    };
  }
  if (isEmpty(settings.from_email)) {
    return { ready: false, reason: 'SMTP_FROM is missing from .env.' };
  }
  return { ready: true, reason: null };
}

/** Shared chrome so both alerts look like they came from the same system. */
export function staffEmailShell(heading, introLine, rows, ctaLabel, ctaUrl) {
  let cells = '';
  for (const [label, value] of Object.entries(rows)) {
    if (value === null || value === undefined || value === '') {
      continue;
    }
    cells += '<tr>'
      + '<td style="padding:7px 16px 7px 0;color:#5A6B62;font-size:13px;white-space:nowrap;vertical-align:top">'
      + escapeHtml(String(label)) + '</td>'
      + '<td style="padding:7px 0;color:#101A14;font-size:14px;font-weight:600">'
      + escapeHtml(String(value)) + '</td>'
      + '</tr>';
  }

  const h = escapeHtml(heading);
  const intro = escapeHtml(introLine);
  const cta = escapeHtml(ctaLabel);
  const url = escapeHtml(ctaUrl);

  return `<div style="background:#F7F8F6;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #DCE2DB;border-radius:10px;overflow:hidden">
    <div style="padding:20px 24px;border-bottom:1px solid #E9EDE7">
      <div style="font-size:17px;font-weight:700;color:#101A14">${h}</div>
      <div style="font-size:14px;color:#5A6B62;margin-top:4px">${intro}</div>
    </div>
    <div style="padding:16px 24px">
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${cells}</table>
    </div>
    <div style="padding:4px 24px 24px">
      <a href="${url}" style="display:inline-block;background:#0E7C4A;color:#fff;text-decoration:none;padding:11px 20px;border-radius:7px;font-size:14px;font-weight:600">${cta}</a>
    </div>
  </div>
  <div style="max-width:560px;margin:14px auto 0;font-size:12px;color:#8A9990;text-align:center">
    Sent by your CRM because you own this lead.
  </div>
</div>`;
}

/** One place that actually pushes a staff message out and records the attempt. */
export async function staffEmailDispatch(orgId, toEmail, toName, subject, html, trigger, leadId) {
  const settings = staffMailerSettings();
  const gate = staffEmailReady(settings);
  if (!gate.ready) {
    await commsLog(orgId, 'EMAIL', {
      leadId, triggeredBy: trigger, status: 'SKIPPED',
      recipient: toEmail, reason: gate.reason,
    });
    return 'SKIPPED';
  }
  if (isEmpty(toEmail)) {
    await commsLog(orgId, 'EMAIL', {
      leadId, triggeredBy: trigger, status: 'SKIPPED',
      reason: 'The recipient has no email address on their profile.',
    });
    return 'SKIPPED';
  }

  // The PHP edition spoke SMTP over a raw socket with these same platform
  // credentials; the platform mailbox in services/mailer.js is that transport
  // here. The recipient's name rides along as a nodemailer address object,
  // which is what the PHP "To: Name <addr>" header carried.
  const result = await sendSystemMail({
    to: toName !== '' ? { name: toName, address: toEmail } : toEmail,
    subject,
    html,
  });
  await commsLog(orgId, 'EMAIL', {
    leadId, triggeredBy: trigger,
    recipient: toEmail, subject,
    status: result?.ok ? 'SENT' : 'FAILED',
    reason: result?.ok ? null : (result?.message ?? result?.reason ?? 'Unknown SMTP error'),
  });
  return result?.ok ? 'SENT' : 'FAILED';
}

/** Owner + the optional standing copy, de-duplicated. */
export function staffNotifyRecipients(settings, owner) {
  const out = {};
  if (owner && !isEmpty(owner.email)) {
    out[String(owner.email).toLowerCase()] = `${owner.first_name ?? ''} ${owner.last_name ?? ''}`.trim();
  }
  const cc = String(settings?.notify_cc_email ?? '').trim();
  if (cc !== '' && !Object.prototype.hasOwnProperty.call(out, cc.toLowerCase())) {
    out[cc.toLowerCase()] = '';
  }
  return out;
}

export function staffLeadRows(lead, project) {
  const name = personName(lead);
  return {
    Lead: name !== '' ? name : (lead.code ?? ''),
    Reference: lead.code ?? null,
    Phone: lead.phone ?? null,
    Email: lead.email ?? null,
    Project: project?.name ?? null,
    City: lead.city ?? null,
    // mb_substr: cut on characters, not bytes, so a Hindi note is not split
    // through the middle of a glyph.
    Notes: !isEmpty(lead.notes) ? Array.from(String(lead.notes)).slice(0, 180).join('') : null,
  };
}

/**
 * "A new lead is yours."
 *
 * Fired on creation and on reassignment, because being handed somebody else's
 * lead is the same news to the person receiving it.
 */
export async function staffNotifyNewLead(orgId, leadId, trigger = 'STAFF_NEW_LEAD') {
  try {
    const settings = await emailSettings(orgId);
    if (!gvBool(settings?.notify_new_lead ?? 0)) {
      return 'DISABLED';
    }
    const lead = await dbOne('SELECT * FROM leads WHERE id = ? AND organization_id = ?', [leadId, orgId]);
    if (!lead || !lead.owner_id) {
      return 'SKIPPED';
    }
    const owner = await dbOne('SELECT id, first_name, last_name, email FROM users WHERE id = ?', [lead.owner_id]);
    const project = lead.project_id
      ? await dbOne('SELECT name FROM projects WHERE id = ?', [lead.project_id])
      : null;
    const source = lead.source_id
      ? await dbScalar('SELECT name FROM lead_sources WHERE id = ?', [lead.source_id])
      : null;

    const leadName = personName(lead);
    const rows = staffLeadRows(lead, project);
    rows.Source = source;
    const html = staffEmailShell(
      'New lead assigned to you',
      !isEmpty(source) ? `Came in through ${source}.` : 'A new enquiry has landed.',
      rows,
      'Open the lead',
      appLink(`/leads/${lead.id}`)
    );

    let last = 'SKIPPED';
    for (const [email, name] of Object.entries(staffNotifyRecipients(settings, owner))) {
      last = await staffEmailDispatch(
        orgId, email, name,
        'New lead: ' + (leadName !== '' ? leadName : lead.code),
        html, trigger, lead.id
      );
    }
    return last;
  } catch (err) {
    // Never let an alert take the lead down with it.
    console.error('[staff-notify] new lead: ' + (err?.message ?? err));
    return 'FAILED';
  }
}

/** "Your follow-up is coming up." Sent ahead of time, not after it slipped. */
export async function staffNotifyFollowup(orgId, lead, settings) {
  try {
    const owner = await dbOne('SELECT id, first_name, last_name, email FROM users WHERE id = ?', [lead.owner_id]);
    const project = !isEmpty(lead.project_id)
      ? await dbOne('SELECT name FROM projects WHERE id = ?', [lead.project_id])
      : null;

    const due = phpTime(String(lead.next_follow_up_at ?? ''));
    const leadName = personName(lead);

    const rows = staffLeadRows(lead, project);
    rows['Due at'] = formatDueAt(due);

    const html = staffEmailShell(
      'Follow-up coming up',
      'Scheduled for ' + formatClock(due) + ' today.',
      rows,
      'Open the lead',
      appLink(`/leads/${lead.id}`)
    );

    let last = 'SKIPPED';
    for (const [email, name] of Object.entries(staffNotifyRecipients(settings, owner))) {
      last = await staffEmailDispatch(
        orgId, email, name,
        'Follow-up due: ' + (leadName !== '' ? leadName : lead.code),
        html, 'STAFF_FOLLOWUP', lead.id
      );
    }
    return last;
  } catch (err) {
    console.error('[staff-notify] follow-up: ' + (err?.message ?? err));
    return 'FAILED';
  }
}

/**
 * Walks each organisation that wants follow-up warnings and emails the ones
 * falling inside its lead time.
 *
 * Called from the sweep. Deduplicated through the notifications table, so a
 * sweep running every fifteen minutes cannot send the same warning four times.
 */
export async function staffFollowupSweep() {
  let sent = 0;
  const orgs = await dbAll(
    // No is_enabled / credentials_valid here: those describe the tenant's
    // own buyer-facing channel. Staff alerts ride the platform mailer, so a
    // company that has never configured email still gets them.
    `SELECT organization_id, followup_lead_minutes FROM email_settings
      WHERE notify_followup = 1`
  );

  for (const row of orgs) {
    const orgId = row.organization_id;
    const minutes = Math.max(15, toInt(!isEmpty(row.followup_lead_minutes) ? row.followup_lead_minutes : 60));
    const settings = await emailSettings(orgId);

    // One organisation at a time so idx_lead_org_followup does the work.
    const leads = await dbAll(
      `SELECT * FROM leads
        WHERE organization_id = ?
          AND next_follow_up_at IS NOT NULL
          AND next_follow_up_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? MINUTE)
          AND owner_id IS NOT NULL
          AND is_converted = 0 AND is_duplicate = 0
        LIMIT 200`,
      [orgId, minutes]
    );

    for (const lead of leads) {
      const already = await dbOne(
        `SELECT id FROM notifications
          WHERE user_id = ? AND entity_type = 'LEAD' AND entity_id = ?
            AND type = 'FOLLOWUP_UPCOMING' AND created_at >= DATE_SUB(NOW(), INTERVAL 12 HOUR)`,
        [lead.owner_id, lead.id]
      );
      if (already) {
        continue;
      }

      const name = personName(lead);
      // The in-app note is written first and is what stops a repeat, so a
      // bounced email cannot turn into a message every fifteen minutes.
      // The link keeps the stored '#/leads/…' form every other notification
      // row uses, so old and new rows are routed by the client the same way.
      await notifyUser(
        orgId, lead.owner_id, 'FOLLOWUP_UPCOMING',
        'Follow-up soon: ' + (name !== '' ? name : lead.code),
        lead.code + ' - due at ' + formatClock(phpTime(String(lead.next_follow_up_at ?? ''))),
        'LEAD', lead.id, '#/leads/' + lead.id
      );
      await staffNotifyFollowup(orgId, lead, settings);
      sent++;
    }
  }

  return { followUpsUpcoming: sent };
}

/**
 * Renders one section of the morning digest - a heading and a list of leads.
 *
 * Deliberately not the single-lead shell above: this email answers "what is on
 * me today", so the time comes first on every line and the name second, which
 * is the order somebody reads a day's plan in.
 *
 * `appUrl` is the base the lead links hang off — the React app's origin here,
 * where the PHP edition passed APP_URL and appended /index.html#.
 */
export function staffDigestSection(heading, rows, timeField, appUrl) {
  if (!rows || rows.length === 0) {
    return '';
  }
  let items = '';
  for (const r of rows) {
    let name = personName(r);
    name = name !== '' ? name : String(r.code ?? '');
    const when = !isEmpty(r[timeField]) ? formatClock(phpTime(String(r[timeField]))) : '';
    // array_filter(): drops null, '' and '0' alike.
    const meta = [r.project_name ?? null, r.phone ?? null, r.status_name ?? null].filter((v) => !isEmpty(v));
    items += '<tr>'
      + '<td style="padding:9px 14px 9px 0;white-space:nowrap;color:#0E7C4A;font-size:13px;font-weight:700;vertical-align:top">'
      + escapeHtml(when) + '</td>'
      + '<td style="padding:9px 0;border-bottom:1px solid #EEF1EC">'
      + '<a href="' + escapeHtml(appUrl + '/leads/' + r.id)
      + '" style="color:#101A14;font-size:14px;font-weight:600;text-decoration:none">'
      + escapeHtml(name) + '</a>'
      + (meta.length
        ? '<div style="color:#5A6B62;font-size:12.5px;margin-top:2px">'
          + escapeHtml(meta.join(' · ')) + '</div>'
        : '')
      + '</td></tr>';
  }

  return '<div style="padding:4px 24px 8px">'
    + '<div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;'
    + 'color:#5A6B62;margin:14px 0 4px">'
    + escapeHtml(heading) + ' (' + rows.length + ')</div>'
    + '<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">'
    + items + '</table></div>';
}

/**
 * The morning digest: today's follow-ups and site visits, one email per person.
 *
 * Sent once a day, per user, and only to people who actually have something on.
 * An empty digest every morning teaches the reader to ignore the one that
 * matters, so nobody is emailed a blank list.
 */
export async function staffDailySummarySweep() {
  let sent = 0;
  const orgs = await dbAll(
    `SELECT organization_id, daily_summary_hour FROM email_settings
      WHERE notify_daily_summary = 1`
  );

  for (const row of orgs) {
    const orgId = row.organization_id;
    const hour = Math.max(0, Math.min(23, toInt(row.daily_summary_hour)));

    // Nothing goes out before the hour the company chose. The sweep runs
    // every fifteen minutes, so the digest leaves within that of the hour.
    if (new Date().getHours() < hour) {
      continue;
    }

    // Loaded for parity with the PHP edition, which made sure the settings
    // row exists for every company it walks.
    await emailSettings(orgId);
    const appUrl = String(config.clientUrl ?? '').replace(/\/+$/, '');

    const select = `SELECT l.id, l.code, l.first_name, l.last_name, l.phone, l.owner_id,
                          l.next_follow_up_at, l.site_visit_at,
                          p.name AS project_name, s.name AS status_name
                     FROM leads l
                     LEFT JOIN projects p ON p.id = l.project_id
                     LEFT JOIN lead_statuses s ON s.id = l.status_id
                    WHERE l.organization_id = ? AND l.owner_id IS NOT NULL
                      AND l.is_converted = 0 AND l.is_duplicate = 0`;

    const followUps = await dbAll(`${select} AND DATE(l.next_follow_up_at) = CURDATE() ORDER BY l.next_follow_up_at ASC`, [orgId]);
    const visits = await dbAll(`${select} AND DATE(l.site_visit_at) = CURDATE() ORDER BY l.site_visit_at ASC`, [orgId]);

    // Group by owner: one email each, not one per lead. A Map keeps the
    // first-seen order PHP's keyed array had.
    const byUser = new Map();
    const bucket = (userId) => {
      if (!byUser.has(userId)) byUser.set(userId, {});
      return byUser.get(userId);
    };
    for (const r of followUps) {
      const b = bucket(r.owner_id);
      (b.followUps ??= []).push(r);
    }
    for (const r of visits) {
      const b = bucket(r.owner_id);
      (b.visits ??= []).push(r);
    }

    for (const [userId, buckets] of byUser) {
      const already = await dbOne(
        `SELECT id FROM notifications
          WHERE user_id = ? AND type = 'DAILY_SUMMARY' AND DATE(created_at) = CURDATE()`,
        [userId]
      );
      if (already) {
        continue;
      }

      const owner = await dbOne('SELECT id, first_name, last_name, email FROM users WHERE id = ? AND is_active = 1', [userId]);
      if (!owner) {
        continue;
      }

      const nFollow = (buckets.followUps ?? []).length;
      const nVisit = (buckets.visits ?? []).length;
      const parts = [
        nFollow ? `${nFollow} follow-up` + (nFollow === 1 ? '' : 's') : null,
        nVisit ? `${nVisit} site visit` + (nVisit === 1 ? '' : 's') : null,
      ].filter((v) => !isEmpty(v));

      const today = formatDayLabel(new Date());

      const body = '<div style="background:#F7F8F6;padding:24px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">'
        + '<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #DCE2DB;border-radius:10px;overflow:hidden">'
        + '<div style="padding:20px 24px;border-bottom:1px solid #E9EDE7">'
        + '<div style="font-size:17px;font-weight:700;color:#101A14">Your day — '
        + escapeHtml(today) + '</div>'
        + '<div style="font-size:14px;color:#5A6B62;margin-top:4px">'
        + escapeHtml(parts.join(' and ')) + '.</div></div>'
        + staffDigestSection('Follow-ups due today', buckets.followUps ?? [], 'next_follow_up_at', appUrl)
        + staffDigestSection('Site visits today', buckets.visits ?? [], 'site_visit_at', appUrl)
        + '<div style="padding:16px 24px 24px">'
        + '<a href="' + escapeHtml(appUrl + '/leads')
        + '" style="display:inline-block;background:#0E7C4A;color:#fff;text-decoration:none;'
        + 'padding:11px 20px;border-radius:7px;font-size:14px;font-weight:600">Open your leads</a>'
        + '</div></div>'
        + '<div style="max-width:560px;margin:14px auto 0;font-size:12px;color:#8A9990;text-align:center">'
        + 'Sent once each morning, only when you have something on.</div></div>';

      // The in-app note is written first and is what prevents a repeat, so
      // a bounced email cannot become a digest every fifteen minutes.
      await notifyUser(
        orgId, userId, 'DAILY_SUMMARY',
        'Your day: ' + parts.join(' and '),
        today, null, null, '#/leads'
      );

      await staffEmailDispatch(
        orgId, String(owner.email ?? ''),
        personName(owner),
        'Your day: ' + parts.join(' and '),
        body, 'STAFF_DAILY_SUMMARY', null
      );
      sent++;
    }
  }

  return { dailySummaries: sent };
}

export function registerStaffNotifyListeners() {
  // A lead that arrives already owned - web form, import, assignment rule.
  onDomainEvent('lead.created', async (payload) => {
    const orgId = payload?.organizationId ?? null;
    const leadId = payload?.data?.id ?? null;
    if (orgId && leadId) {
      await staffNotifyNewLead(orgId, leadId);
    }
  });

  // Being handed someone else's lead is the same news to the receiver.
  onDomainEvent('lead.assigned', async (payload) => {
    const orgId = payload?.organizationId ?? null;
    const leadId = payload?.data?.id ?? null;
    if (orgId && leadId) {
      await staffNotifyNewLead(orgId, leadId, 'STAFF_LEAD_ASSIGNED');
    }
  });
}
