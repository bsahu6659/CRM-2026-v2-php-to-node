/**
 * Due-date sweep — port of cron/sweep.php. Raises FOLLOWUP_DUE /
 * FOLLOWUP_OVERDUE notifications for leads whose next follow-up has come due,
 * warns owners ahead of upcoming follow-ups, sends the morning digest, and
 * clears stale Facebook authorisations.
 *
 * It is safe to run more often than needed — runDueSweep() will not notify
 * the same person about the same lead twice. Three ways in:
 *
 *   - runSweep()             in-process, from whatever schedules it
 *   - scripts/sweep.js       one-shot CLI, for a system cron:
 *                              node server/scripts/sweep.js
 *   - sweepHttpHandler       an Express handler for hosts whose cron can only
 *                            fetch a URL; it refuses unless CRON_TOKEN is set
 *                            and passed as ?token=
 */

import { safeEqual } from '../lib/security.js';
import { metaConnectSweep } from '../services/metaConnect.js';
import { runDueSweep } from '../services/notifications.js';

/**
 * Runs every step and returns the summary object — what the PHP edition
 * printed as `{"data": …}` when triggered over HTTP. Throws if a step fails;
 * the callers decide how to report that.
 */
export async function runSweep() {
  const result = { ...(await runDueSweep()) };
  // Abandoned Facebook authorisations hold an encrypted user token that can
  // list every page the admin runs. Spent or expired ones are rubbish, and
  // rubbish holding a token is worth clearing on the same schedule.
  //
  // PHP's `$result += …` is a union: a key the due sweep already reported is
  // never overwritten.
  for (const [key, value] of Object.entries(await metaConnectSweep())) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = value;
  }
  return result;
}

/** The one-line summary the CLI prints, identical to the PHP edition's. */
export function sweepSummaryLine(result) {
  return `tasks due: ${Math.trunc(Number(result.tasksDue ?? 0))}, `
    + `follow-ups due: ${Math.trunc(Number(result.followUpsDue ?? 0))}, `
    + `follow-ups warned ahead: ${Math.trunc(Number(result.followUpsUpcoming ?? 0))}, `
    + `daily summaries: ${Math.trunc(Number(result.dailySummaries ?? 0))}`
    + `, stale facebook authorisations cleared: ${Math.trunc(Number(result.metaOauthStatesCleared ?? 0))}`;
}

/**
 * The HTTP trigger (GET /cron/sweep.php?token=…). Not mounted by default, just
 * as the PHP edition's cron/ directory was deny-all until someone removed its
 * .htaccess: mount it only on a host that needs it, and it still refuses every
 * call until CRON_TOKEN is set in .env.
 */
export async function sweepHttpHandler(req, res) {
  const expected = String(process.env.CRON_TOKEN ?? '');
  const supplied = typeof req.query?.token === 'string' ? req.query.token : '';
  if (expected === '' || !safeEqual(expected, supplied)) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Set CRON_TOKEN in .env and pass it as ?token=' },
    });
  }

  try {
    const result = await runSweep();
    return res.status(200).json({ data: result });
  } catch (err) {
    console.error('[cron/sweep] ' + (err?.message ?? err));
    return res.status(500).json({
      error: { code: 'SWEEP_FAILED', message: 'The sweep did not complete. Check the server error log.' },
    });
  }
}

export default runSweep;
