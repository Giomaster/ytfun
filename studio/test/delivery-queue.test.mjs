import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeliveryQueue } from '../src/delivery-queue.mjs';
import { StudioStore } from '../src/store.mjs';
import { episodeReviewHash } from '../src/domain.mjs';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const RENDER = 'b'.repeat(64);
const EPISODE = { id: 'episode', render: { sha256: RENDER } };
const HASH = episodeReviewHash(EPISODE);

async function fixture(t, { outcome = 'uploaded', throws = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ytfun-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StudioStore(directory);
  await store.transaction(state => { state.episodes.push({ ...EPISODE, approval: { reviewHash: HASH } }); });
  let calls = 0;
  let accountId = 'channel';
  const publisher = {
    preflight: async ({ platform }) => ({ platform, accountId, reviewHash: HASH, render: { sha256: RENDER }, ready: ['youtube', 'facebook'].includes(platform), readyToExport: ['tiktok', 'kwai'].includes(platform), reasons: [] }),
    publishYouTube: async () => { calls++; if (throws) throw new Error('private-secret'); return { publication: { id: 'receipt', status: outcome } }; },
    exportPackage: async () => { calls++; return { publication: { id: 'export', status: 'exported' } }; },
  };
  const queue = new DeliveryQueue(store, publisher, { now: () => NOW });
  return { store, queue, calls: () => calls, changeAccount: () => { accountId = 'different'; } };
}

function args(extra = {}) { return { episodeId: 'episode', platform: 'youtube', privacy: 'private', madeForKids: false, expectedReviewHash: HASH, dueAt: new Date(NOW).toISOString(), ...extra }; }

test('queued delivery survives worker recreation; preview never uploads and completed task does not replay', async t => {
  const f = await fixture(t);
  const first = await f.queue.enqueue(args());
  assert.equal((await f.queue.enqueue(args())).duplicate, true);
  assert.equal((await f.queue.runDue()).execute, false);
  assert.equal(f.calls(), 0);
  const completed = await f.queue.runDue({ execute: true });
  assert.equal(completed.delivery.status, 'completed');
  assert.equal(completed.delivery.outcome, 'uploaded');
  assert.equal(completed.delivery.id, first.delivery.id);
  assert.equal((await f.queue.runDue({ execute: true })).idle, true);
  assert.equal(f.calls(), 1);
});

test('unknown provider outcome and thrown diagnostics stop replay without persisting sensitive error text', async t => {
  for (const options of [{ outcome: 'unknown' }, { throws: true }]) {
    const f = await fixture(t, options);
    await f.queue.enqueue(args());
    assert.equal((await f.queue.runDue({ execute: true })).delivery.status, 'attention');
    assert.equal((await f.queue.enqueue(args())).duplicate, true);
    await f.queue.runDue({ execute: true });
    assert.equal(f.calls(), 1);
    assert.equal(JSON.stringify(await f.store.read()).includes('private-secret'), false);
  }
});

test('a changed destination blocks before invoking the publisher', async t => {
  const f = await fixture(t);
  await f.queue.enqueue(args());
  f.changeAccount();
  const result = await f.queue.runDue({ execute: true });
  assert.equal(result.delivery.status, 'attention');
  assert.equal(f.calls(), 0);
});

test('interrupted running claims survive restart and block automatic replay', async t => {
  const f = await fixture(t);
  await f.queue.enqueue(args());
  await f.store.transaction(state => { state.deliveries[0].status = 'running'; });
  assert.equal((await f.queue.runDue({ execute: true })).blocked, true);
  assert.equal(f.calls(), 0);
});

test('exports complete as exported rather than published; future tasks and cancelled tasks never execute', async t => {
  const f = await fixture(t);
  await f.queue.enqueue(args({ platform: 'kwai' }));
  const exported = await f.queue.runDue({ execute: true });
  assert.equal(exported.delivery.outcome, 'exported');
  const future = await f.queue.enqueue(args({ dueAt: new Date(NOW + 3600_000).toISOString() }));
  assert.equal((await f.queue.runDue({ execute: true })).idle, true);
  await f.queue.cancel({ deliveryId: future.delivery.id });
  assert.equal((await f.queue.runDue({ execute: true })).idle, true);
  assert.equal(f.calls(), 1);
});

test('concurrent workers can claim only one due task', async t => {
  const f = await fixture(t);
  await f.queue.enqueue(args());
  await Promise.all([f.queue.runDue({ execute: true }), f.queue.runDue({ execute: true })]);
  assert.equal(f.calls(), 1);
});

test('reconciliation cannot mistake an older failed receipt for the current unknown attempt', async t => {
  const f = await fixture(t);
  const queued = await f.queue.enqueue(args());
  const delivery = queued.delivery;
  await f.store.transaction(state => {
    Object.assign(state.deliveries[0], { status: 'attention', publicationId: 'current' });
    const base = { episodeId: delivery.episodeId, platform: delivery.platform, accountId: delivery.accountId, reviewHash: delivery.reviewHash, renderSha256: delivery.renderSha256 };
    state.publications.push({ ...base, id: 'older', status: 'failed' }, { ...base, id: 'current', status: 'unknown', deliveryId: delivery.id });
  });
  const reconcile = { deliveryId: delivery.id, workerStopped: true, confirmedBy: 'Operator', evidence: 'Inspected provider and stopped original worker.' };
  await assert.rejects(f.queue.reconcile(reconcile), /exact provider publication/);
  assert.equal((await f.queue.list())[0].status, 'attention');
  await f.store.transaction(state => { state.publications.find(item => item.id === 'current').status = 'published'; });
  const closed = await f.queue.reconcile(reconcile);
  assert.equal(closed.delivery.publicationId, 'current');
  assert.equal(closed.delivery.outcome, 'published');
  assert.equal(f.calls(), 0);
});

test('a stopped crash before publisher reservation can close safely without any replay', async t => {
  const f = await fixture(t);
  const queued = await f.queue.enqueue(args());
  await f.store.transaction(state => { state.deliveries[0].status = 'running'; });
  const result = await f.queue.reconcile({ deliveryId: queued.delivery.id, workerStopped: true, confirmedBy: 'Operator', evidence: 'Original worker stopped before any publisher reservation.' });
  assert.equal(result.delivery.status, 'cancelled');
  assert.equal(f.calls(), 0);
  assert.equal((await f.queue.runDue({ execute: true })).idle, true);
});
