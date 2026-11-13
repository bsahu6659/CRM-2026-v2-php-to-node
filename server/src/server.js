/**
 * HTTP entry point. Kept separate from app.js so the test suite can import the
 * application without binding a port.
 */

import config from './config/index.js';
import { createApp } from './app.js';
import { closePool, dbScalar } from './lib/db.js';
import { runSweep } from './jobs/sweep.js';

const app = createApp();

// The PHP edition needed a cron entry for the follow-up/daily-summary sweep
// because PHP has no long-lived process. Node does, so it runs in-process by
// default. Set SWEEP_INTERVAL_MIN=0 when several API processes share one
// database and an external `npm run sweep` cron owns the job instead —
// running it in every worker would only repeat work the sweep already dedupes.
const sweepMinutes = Number.parseInt(process.env.SWEEP_INTERVAL_MIN ?? '15', 10);
let sweepTimer = null;
let sweepRunning = false;

async function sweepTick() {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    await runSweep();
  } catch (err) {
    console.error('[sweep] failed:', err?.message ?? err);
  } finally {
    sweepRunning = false;
  }
}

if (Number.isFinite(sweepMinutes) && sweepMinutes > 0) {
  sweepTimer = setInterval(sweepTick, sweepMinutes * 60_000);
  sweepTimer.unref();
}

const server = app.listen(config.port, async () => {
  console.log(`[server] Growvanta CRM API listening on http://localhost:${config.port} (${config.env})`);
  try {
    await dbScalar('SELECT 1');
    console.log(`[server] database ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database} reachable`);
  } catch (err) {
    // Not fatal: the process stays up so /api/health can report "degraded"
    // and a container orchestrator sees a live port with a failing check,
    // which is far easier to diagnose than a crash loop.
    console.error('[server] database unreachable at boot:', err.message);
  }
});

async function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  if (sweepTimer) clearInterval(sweepTimer);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  // Don't let a hung connection hold the process open forever.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default server;
