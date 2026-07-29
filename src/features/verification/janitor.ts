/**
 * Background sweep: finishes deletions that a restart interrupted, and expires
 * threads staff never answered.
 *
 * Everything is wrapped — one bad row or a locked database must not silently
 * stop all cleanup for the life of the process.
 */

import { createLogger } from '../../lib/logger.js';
import type { BotContext } from '../../lib/types.js';
import { deleteThread, expireTicket, getStore } from './service.js';

const log = createLogger('verification:janitor');
const INTERVAL_MS = 2 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

async function sweep(ctx: BotContext): Promise<void> {
  // A backlog can take longer than the interval; overlapping sweeps would double
  // the REST traffic and inflate the delete-retry counter toward its give-up limit.
  if (running) {
    log.debug('Previous sweep still running — skipping this tick.');
    return;
  }
  running = true;
  try {
    await runSweep(ctx);
  } finally {
    running = false;
  }
}

async function runSweep(ctx: BotContext): Promise<void> {
  const store = getStore();

  try {
    for (const row of store.due()) {
      await deleteThread(ctx, row.thread_id, row.guild_id);
    }
  } catch (err) {
    log.error('Deletion sweep failed:', err);
  }

  const hours = ctx.config.verification.staleThreadHours;
  if (hours <= 0) return;

  try {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    for (const row of store.open()) {
      const created = Date.parse(row.created_at);
      if (Number.isNaN(created)) {
        log.warn(`Unreadable timestamp on ticket ${row.thread_id}`);
        continue;
      }
      if (created > cutoff) continue;
      await expireTicket(ctx, row, hours);
    }
  } catch (err) {
    log.error('Stale sweep failed:', err);
  }
}

export function startJanitor(ctx: BotContext): void {
  if (timer) return;
  timer = setInterval(() => void sweep(ctx), INTERVAL_MS);
  timer.unref();
  void sweep(ctx); // catch up on anything missed while the bot was down
  log.info(`Janitor running every ${INTERVAL_MS / 1000}s`);
}

export function stopJanitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
