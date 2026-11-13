/**
 * One-shot due-date sweep for a system cron — the CLI half of cron/sweep.php.
 *
 * Every 15 minutes, e.g. in crontab:
 *
 *   0,15,30,45 * * * *  cd /path/to/server && node scripts/sweep.js
 *
 * It is safe to run more often than needed: the sweep never notifies the same
 * person about the same lead twice. Exits non-zero when the sweep fails, so
 * cron's own mail-on-failure (or a monitor wrapping it) can tell.
 */

import { closePool } from '../src/lib/db.js';
import { toSqlDateTime } from '../src/lib/util.js';
import { runSweep, sweepSummaryLine } from '../src/jobs/sweep.js';
import { drainDomainEvents } from '../src/services/events.js';
import { registerDomainListeners } from '../src/services/listeners.js';
import { closeMailer } from '../src/services/mailer.js';

let exitCode = 0;

try {
  // The PHP bootstrap wired every listener before any entry point ran; a
  // one-shot script has to do the same or anything it emits goes nowhere.
  registerDomainListeners();

  const result = await runSweep();
  console.log(`[${toSqlDateTime(new Date())}] sweep complete - ${sweepSummaryLine(result)}`);
} catch (err) {
  const message = err?.message ?? String(err);
  console.error('[cron/sweep] ' + message);
  process.stderr.write('sweep failed: ' + message + '\n');
  exitCode = 1;
}

// Everything the sweep set in motion (domain event handlers, mail on the
// pooled SMTP transport) is allowed to finish before the pool closes,
// otherwise a notification could be cut off mid-send.
try {
  await drainDomainEvents();
} catch (err) {
  console.error('[cron/sweep] waiting for event handlers failed:', err?.message ?? err);
}
try {
  await closeMailer();
  await closePool();
} catch (err) {
  console.error('[cron/sweep] shutdown failed:', err?.message ?? err);
}

process.exit(exitCode);
