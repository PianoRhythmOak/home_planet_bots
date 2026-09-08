import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { migrate } from '../src/lib/db.js';

describe('migrate', () => {
  it('tracks versions independently for each feature', (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());

    migrate(db, 'alpha', ['CREATE TABLE alpha_one (id INTEGER)', 'CREATE TABLE alpha_two (id INTEGER)']);
    migrate(db, 'beta', ['CREATE TABLE beta_one (id INTEGER)']);

    const versions = db
      .prepare('SELECT namespace, version FROM schema_versions ORDER BY namespace')
      .all();
    assert.deepEqual(versions, [
      { namespace: 'alpha', version: 2 },
      { namespace: 'beta', version: 1 },
    ]);
  });

  it('only runs migrations added after the stored version', (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    const first = 'CREATE TABLE first (id INTEGER)';

    migrate(db, 'feature', [first]);
    migrate(db, 'feature', [first, 'CREATE TABLE second (id INTEGER)']);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('first', 'second') ORDER BY name")
      .all();
    assert.deepEqual(tables, [{ name: 'first' }, { name: 'second' }]);
  });

  it('rolls back the entire pending batch when a migration fails', (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());

    assert.throws(() =>
      migrate(db, 'broken', [
        'CREATE TABLE should_rollback (id INTEGER)',
        'THIS IS NOT VALID SQL',
      ]),
    );

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'")
      .get();
    const version = db
      .prepare('SELECT version FROM schema_versions WHERE namespace = ?')
      .get('broken');
    assert.equal(table, undefined);
    assert.equal(version, undefined);
  });
});
