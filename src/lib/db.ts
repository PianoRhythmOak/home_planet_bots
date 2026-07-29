/**
 * SQLite via better-sqlite3. Synchronous on purpose: these queries are
 * sub-millisecond, and synchronous statements give us atomic claims without
 * any await gap for a second interaction to slip through.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ROOT_DIR } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('db');

export type DB = Database.Database;

export function openDatabase(path: string): DB {
  const full = isAbsolute(path) ? path : resolve(ROOT_DIR, path);
  mkdirSync(dirname(full), { recursive: true });

  const db = new Database(full);
  db.pragma('journal_mode = WAL'); // survives an unclean shutdown
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  log.info(`Database ready at ${full}`);
  return db;
}

/**
 * Dirt-simple forward-only migrations, tracked PER FEATURE.
 *
 * Versions live in a schema_versions table rather than SQLite's `user_version`
 * pragma, which is database-global: with one shared db file, a second feature
 * would inherit the first feature's version number and silently skip its own
 * table creation.
 *
 * Add to the array; never edit or reorder a migration that has already shipped.
 */
export function migrate(db: DB, namespace: string, migrations: string[]): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_versions (
       namespace TEXT PRIMARY KEY,
       version   INTEGER NOT NULL
     )`,
  );

  const row = db.prepare('SELECT version FROM schema_versions WHERE namespace = ?').get(namespace) as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;
  if (current >= migrations.length) return;

  const pending = migrations.slice(current);
  log.info(`Running ${pending.length} migration(s) for "${namespace}" (at version ${current})`);
  db.transaction(() => {
    for (const sql of pending) db.exec(sql);
    db.prepare(
      `INSERT INTO schema_versions (namespace, version) VALUES (?, ?)
       ON CONFLICT(namespace) DO UPDATE SET version = excluded.version`,
    ).run(namespace, migrations.length);
  })();
  log.info(`"${namespace}" schema now at version ${migrations.length}`);
}
