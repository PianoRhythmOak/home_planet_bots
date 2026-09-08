/**
 * Ticket persistence. Every open verification thread has a row here so a restart
 * doesn't lose track of it.
 */

import type { DB } from '../../lib/db.js';
import { migrate } from '../../lib/db.js';

export type TicketStatus = 'open' | 'closing' | 'failed';
export type TicketDecision = 'approved' | 'denied' | 'closed' | 'expired' | 'left';

export interface TicketRow {
  thread_id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  created_at: string;
  status: TicketStatus;
  decision: TicketDecision | null;
  staff_id: string | null;
  reason: string | null;
  delete_at: string | null;
  attempts: number;
  /** 1 when opened by /verifytest. Suppresses the irreversible parts of a decision. */
  is_test: number;
}

/**
 * How long a claimed-but-unfinished ticket survives before the janitor cleans it
 * up anyway. Only reached if the process dies between claiming and finishing, so
 * it's set well above how long the decision path could legitimately take.
 */
const CLAIM_FALLBACK_MS = 10 * 60 * 1000;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS tickets (
     thread_id  TEXT PRIMARY KEY,
     guild_id   TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     user_id    TEXT NOT NULL,
     created_at TEXT NOT NULL,
     status     TEXT NOT NULL DEFAULT 'open',
     decision   TEXT,
     staff_id   TEXT,
     reason     TEXT,
     delete_at  TEXT,
     attempts   INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets (guild_id, user_id, status);
   CREATE INDEX IF NOT EXISTS idx_tickets_due  ON tickets (status, delete_at);`,

  // Tickets opened by /verifytest. Kept on the row rather than inferred from the
  // thread's name, because the decision path has to still know it's a drill after
  // a restart — and a renamed thread would then quietly re-arm kickOnDeny.
  `ALTER TABLE tickets ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;`,
];

export class TicketStore {
  constructor(private readonly db: DB) {
    migrate(db, 'verification', MIGRATIONS);
  }

  create(
    threadId: string,
    guildId: string,
    channelId: string,
    userId: string,
    isTest = false,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tickets (thread_id, guild_id, channel_id, user_id, created_at, status, is_test)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(threadId, guildId, channelId, userId, new Date().toISOString(), isTest ? 1 : 0);
  }

  get(threadId: string): TicketRow | undefined {
    return this.db.prepare('SELECT * FROM tickets WHERE thread_id = ?').get(threadId) as
      | TicketRow
      | undefined;
  }

  openForUser(guildId: string, userId: string): TicketRow | undefined {
    return this.db
      .prepare("SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'")
      .get(guildId, userId) as TicketRow | undefined;
  }

  /**
   * Atomically take ownership of a ticket. Returns false if someone already has it.
   *
   * This is the whole reason the close path is safe: better-sqlite3 is synchronous,
   * so between the read and the write there is no await for a second Approve click
   * to slip through.
   *
   * `delete_at` is set to a deliberately GENEROUS fallback, not the real delete time.
   * The real one is written by finish(). If we wrote the real (possibly 0s) delay
   * here, the janitor could delete the thread while we were still building its
   * transcript. The fallback only ever fires if this process dies mid-decision.
   */
  claim(threadId: string): boolean {
    const fallback = new Date(Date.now() + CLAIM_FALLBACK_MS);
    const result = this.db
      .prepare("UPDATE tickets SET status = 'closing', delete_at = ? WHERE thread_id = ? AND status = 'open'")
      .run(fallback.toISOString(), threadId);
    return result.changes === 1;
  }

  finish(
    threadId: string,
    decision: TicketDecision,
    staffId: string | null,
    reason: string | null,
    deleteAt: Date,
  ): void {
    this.db
      .prepare('UPDATE tickets SET decision = ?, staff_id = ?, reason = ?, delete_at = ? WHERE thread_id = ?')
      .run(decision, staffId, reason, deleteAt.toISOString(), threadId);
  }

  /** Park a ticket we can't delete, so the janitor stops retrying it forever. */
  fail(threadId: string, note: string): void {
    this.db
      .prepare(
        "UPDATE tickets SET status = 'failed', reason = COALESCE(reason, '') || ? WHERE thread_id = ?",
      )
      .run(` [${note}]`, threadId);
  }

  bumpAttempts(threadId: string): number {
    this.db.prepare('UPDATE tickets SET attempts = attempts + 1 WHERE thread_id = ?').run(threadId);
    const row = this.db.prepare('SELECT attempts FROM tickets WHERE thread_id = ?').get(threadId) as
      | { attempts: number }
      | undefined;
    return row?.attempts ?? 0;
  }

  remove(threadId: string): void {
    this.db.prepare('DELETE FROM tickets WHERE thread_id = ?').run(threadId);
  }

  /**
   * Threads whose delete time has passed. ISO-8601 UTC strings compare correctly
   * lexicographically, which is why every timestamp goes in via toISOString().
   */
  due(): TicketRow[] {
    return this.db
      .prepare("SELECT * FROM tickets WHERE status = 'closing' AND delete_at IS NOT NULL AND delete_at <= ?")
      .all(new Date().toISOString()) as TicketRow[];
  }

  open(guildId?: string): TicketRow[] {
    if (guildId) {
      return this.db
        .prepare("SELECT * FROM tickets WHERE status = 'open' AND guild_id = ? ORDER BY created_at")
        .all(guildId) as TicketRow[];
    }
    return this.db
      .prepare("SELECT * FROM tickets WHERE status = 'open' ORDER BY created_at")
      .all() as TicketRow[];
  }
}
