import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { TicketStore } from '../src/features/verification/store.js';
import type { DB } from '../src/lib/db.js';

describe('TicketStore', () => {
  let db: DB;
  let store: TicketStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new TicketStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates and retrieves an open ticket', () => {
    store.create('thread-1', 'guild-1', 'channel-1', 'user-1');

    const row = store.get('thread-1');
    assert.equal(row?.status, 'open');
    assert.equal(row?.user_id, 'user-1');
    assert.equal(store.openForUser('guild-1', 'user-1')?.thread_id, 'thread-1');
    assert.match(row?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });

  it('allows exactly one atomic claim', () => {
    store.create('thread-1', 'guild-1', 'channel-1', 'user-1');

    assert.equal(store.claim('thread-1'), true);
    assert.equal(store.claim('thread-1'), false);
    assert.equal(store.get('thread-1')?.status, 'closing');

    const deleteAt = Date.parse(store.get('thread-1')?.delete_at ?? '');
    assert.ok(deleteAt > Date.now() + 9 * 60 * 1000);
  });

  it('finishes a ticket and returns it when deletion is due', () => {
    store.create('thread-1', 'guild-1', 'channel-1', 'user-1');
    assert.equal(store.claim('thread-1'), true);
    store.finish('thread-1', 'denied', 'staff-1', 'under age', new Date(0));

    const row = store.get('thread-1');
    assert.equal(row?.decision, 'denied');
    assert.equal(row?.staff_id, 'staff-1');
    assert.equal(row?.reason, 'under age');
    assert.deepEqual(store.due().map((ticket) => ticket.thread_id), ['thread-1']);
  });

  it('parks failed tickets and excludes them from retry queries', () => {
    store.create('thread-1', 'guild-1', 'channel-1', 'user-1');
    store.claim('thread-1');
    store.finish('thread-1', 'closed', null, null, new Date(0));
    store.fail('thread-1', 'no permission');

    assert.equal(store.get('thread-1')?.status, 'failed');
    assert.match(store.get('thread-1')?.reason ?? '', /no permission/);
    assert.deepEqual(store.due(), []);
  });

  it('increments deletion attempts and removes tickets', () => {
    store.create('thread-1', 'guild-1', 'channel-1', 'user-1');

    assert.equal(store.bumpAttempts('thread-1'), 1);
    assert.equal(store.bumpAttempts('thread-1'), 2);
    store.remove('thread-1');
    assert.equal(store.get('thread-1'), undefined);
  });

  it('filters and orders open tickets by guild', () => {
    store.create('thread-b', 'guild-1', 'channel-1', 'user-2');
    store.create('thread-a', 'guild-2', 'channel-1', 'user-1');

    assert.deepEqual(store.open('guild-1').map((row) => row.thread_id), ['thread-b']);
    assert.equal(store.open().length, 2);
  });
});
