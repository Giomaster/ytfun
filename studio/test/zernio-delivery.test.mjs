import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeliveryQueue } from '../src/delivery-queue.mjs';
import { StudioStore } from '../src/store.mjs';

const NOW = Date.parse('2026-10-02T22:00:00.000Z');
const HASH = 'a'.repeat(64);
const RENDER = 'b'.repeat(64);
const BINDING = 'c'.repeat(64);
const PROVIDER = '66b2e19d8c3f5a7e9d0b1c2d';
const ACCOUNT = '7474661840611197969';
const EPISODE = '24f720b9-1e69-4173-afc1-fb1a68c331c8';
const DELIVERY = '8f9794fc-395b-4a39-bd4f-e17f78d3dfde';
const PUBLICATION = 'cdb49830-aeb7-4cca-99f2-7a4a73b8e8ed';

async function fixture(t, { delivery = {}, publications = [], otherDeliveries = [], selected = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ytfun-zernio-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StudioStore(directory);
  const original = {
    id: DELIVERY, episodeId: EPISODE, platform: 'tiktok', accountId: ACCOUNT,
    reviewHash: HASH, renderSha256: RENDER, privacy: 'public', mode: 'experimental_session_rest',
    dueAt: new Date(NOW - 60_000).toISOString(), createdAt: new Date(NOW - 3_600_000).toISOString(),
    status: 'queued', ...delivery,
  };
  await store.transaction(state => {
    state.projects.push({ id: 'project-delivery-fixture' });
    state.episodes.push({ id: EPISODE });
    state.deliveries = [original, ...otherDeliveries];
    state.publications.push(...publications);
  });
  const calls = [];
  const config = { selected, accountId: original.accountId, providerAccountId: PROVIDER, bindingSha256: BINDING,
    reviewHash: HASH, renderSha256: RENDER, ready: true };
  const makePlan = () => ({ episodeId: EPISODE, platform: original.platform, accountId: config.accountId,
    deliveryMode: config.selected ? 'zernio' : original.platform === 'youtube' ? 'official_api' : 'experimental_session_rest',
    providerAccountId: config.providerAccountId, bindingSha256: config.bindingSha256,
    reviewHash: config.reviewHash, render: { sha256: config.renderSha256 }, ready: config.ready, readyToExport: false,
    reasons: config.ready ? [] : ['Fixture preflight blocked.'] });
  const publisher = {
    zernioSelected: () => config.selected,
    zernioAdapter: () => ({ verifyAccount: async () => {
      calls.push('identity-get');
      return { accountId: config.accountId, providerAccountId: config.providerAccountId };
    } }),
    plan: async () => { calls.push('plan'); return makePlan(); },
    preflight: async () => { calls.push('preflight'); return makePlan(); },
    publishTikTok: async input => {
      calls.push('upload');
      assert.equal(input.execute, true);
      assert.equal(input.privacy, 'public');
      assert.equal(input.deliveryId, DELIVERY);
      const claimed = (await store.read()).deliveries.find(item => item.id === input.deliveryId);
      assert.equal(claimed.status, 'running');
      assert.equal(claimed.mode, 'zernio');
      const publication = { id: 'fixture-provider-publication', episodeId: EPISODE, platform: 'tiktok', accountId: ACCOUNT,
        providerAccountId: PROVIDER, bindingSha256: BINDING, route: 'zernio', status: 'processing',
        deliveryId: DELIVERY, reviewHash: HASH, renderSha256: RENDER, privacy: 'public' };
      await store.transaction(state => state.publications.push(publication));
      return { publication };
    },
  };
  const queue = new DeliveryQueue(store, publisher, { now: () => NOW });
  return { store, queue, publisher, calls, config, original };
}

const migrate = (f, extra = {}) => f.queue.migrateUnstartedToZernio({ deliveryId: DELIVERY,
  expectedMode: f.original.mode, expectedReviewHash: HASH, reason: 'Owner authorized the supported Zernio integration.', ...extra });

test('unstarted public migration preserves exact identity, media, due time and prior route history', async t => {
  const originalApiData = { grantId: 'old-provider-authorization', authorized: true };
  const history = [{ at: '2026-10-01T00:00:00Z', mode: 'legacy', reason: 'Earlier recorded transition.' }];
  const f = await fixture(t, { delivery: { apiData: originalApiData, providerHistory: history } });
  const result = await migrate(f);
  const migrated = result.delivery;
  assert.equal(migrated.id, DELIVERY);
  assert.equal(migrated.mode, 'zernio');
  assert.equal(migrated.status, 'queued');
  assert.equal(migrated.accountId, ACCOUNT);
  assert.equal(migrated.providerAccountId, PROVIDER);
  assert.equal(migrated.bindingSha256, BINDING);
  assert.equal(migrated.reviewHash, HASH);
  assert.equal(migrated.renderSha256, RENDER);
  assert.equal(migrated.dueAt, f.original.dueAt);
  assert.equal(migrated.createdAt, f.original.createdAt);
  assert.equal(migrated.apiData, undefined);
  assert.equal(migrated.providerHistory.length, 2);
  assert.deepEqual(migrated.providerHistory[0], history[0]);
  assert.deepEqual(migrated.providerHistory[1].apiData, originalApiData);
  assert.equal(migrated.providerHistory[1].mode, 'experimental_session_rest');
  assert.equal(migrated.providerHistory[1].previousStatus, 'queued');
  assert.equal((await f.store.read()).publications.length, 0);
  assert.ok(!f.calls.includes('upload'));
});

test('original 004 unknown allocation reservation cannot migrate, reset or dispatch through Zernio', async t => {
  const unknown = { id: PUBLICATION, episodeId: EPISODE, deliveryId: DELIVERY, platform: 'tiktok', accountId: ACCOUNT,
    route: 'experimental_session_rest', status: 'unknown', privacy: 'public', reviewHash: HASH, renderSha256: RENDER,
    creationId: '6b69fdb1706441ec81fecf5a939b71ae', providerPhase: 'allocation' };
  const f = await fixture(t, { delivery: { status: 'attention', phase: 'delivery', publicationId: PUBLICATION }, publications: [unknown] });
  const before = await f.store.read();
  await assert.rejects(migrate(f), /proved unstarted/);
  assert.deepEqual(await f.store.read(), before);
  assert.equal((await f.queue.runDue({ execute: true, platform: 'tiktok' })).idle, true);
  assert.ok(!f.calls.includes('upload'));
});

test('even a queued or preflight-labelled delivery is blocked when a publication exists for its episode', async t => {
  for (const delivery of [{}, { status: 'attention', phase: 'preflight' }]) {
    const f = await fixture(t, { delivery, publications: [{ id: PUBLICATION, episodeId: EPISODE, platform: 'tiktok',
      accountId: ACCOUNT, status: 'unknown', route: 'experimental_session_rest' }] });
    const before = await f.store.read();
    await assert.rejects(migrate(f), /proved unstarted/);
    assert.deepEqual(await f.store.read(), before);
    assert.ok(!f.calls.includes('upload'));
  }
});

test('proved unstarted attention/preflight may migrate while attention/delivery and running cannot', async t => {
  const safe = await fixture(t, { delivery: { status: 'attention', phase: 'preflight', error: 'Previous route preflight blocked.' } });
  const migrated = (await migrate(safe)).delivery;
  assert.equal(migrated.status, 'queued');
  assert.equal(migrated.mode, 'zernio');
  assert.equal(migrated.phase, undefined);
  assert.equal(migrated.error, undefined);
  assert.equal(migrated.providerHistory.at(-1).previousStatus, 'attention');
  for (const delivery of [{ status: 'attention', phase: 'delivery' }, { status: 'running', phase: 'preflight' },
    { status: 'completed' }, { status: 'cancelled' }]) {
    const f = await fixture(t, { delivery });
    const before = await f.store.read();
    await assert.rejects(migrate(f), /proved unstarted/);
    assert.deepEqual(await f.store.read(), before);
    assert.ok(!f.calls.includes('upload'));
  }
});

test('migration blocks any concurrent running claim regardless of its network', async t => {
  const f = await fixture(t, { otherDeliveries: [{ id: 'facebook-running', episodeId: 'another-episode',
    platform: 'facebook', status: 'running', mode: 'official_api' }] });
  const before = await f.store.read();
  await assert.rejects(migrate(f), /proved unstarted/);
  assert.deepEqual(await f.store.read(), before);
  const dispatch = await f.queue.runDue({ execute: true, platform: 'tiktok' });
  assert.equal(dispatch.blocked, true);
  assert.ok(!f.calls.includes('upload'));
});

test('migration refuses stale hashes, native identity drift, exports and an unselected provider', async t => {
  for (const change of [f => { f.config.renderSha256 = 'd'.repeat(64); },
    f => { f.config.reviewHash = 'e'.repeat(64); }, f => { f.config.accountId = '7474000000000000000'; },
    f => { f.config.bindingSha256 = 'invalid'; }, f => { f.config.selected = false; }]) {
    const f = await fixture(t);
    change(f);
    const before = await f.store.read();
    await assert.rejects(migrate(f));
    assert.deepEqual(await f.store.read(), before);
    assert.ok(!f.calls.includes('upload'));
  }
  const privateExport = await fixture(t, { delivery: { privacy: 'private' } });
  await assert.rejects(migrate(privateExport), /proved unstarted/);
  const wrongExpected = await fixture(t);
  await assert.rejects(migrate(wrongExpected, { expectedMode: 'official_api' }), /proved unstarted/);
});

test('due dispatch remains blocked until the unstarted old route is explicitly migrated', async t => {
  const f = await fixture(t);
  const before = await f.store.read();
  const blocked = await f.queue.runDue({ execute: true, platform: 'tiktok' });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /Selected provider changed/);
  assert.deepEqual(await f.store.read(), before);
  assert.deepEqual(f.calls, []);
  await migrate(f);
  const dispatched = await f.queue.runDue({ execute: true, platform: 'tiktok' });
  assert.equal(dispatched.delivery.status, 'completed');
  assert.equal(dispatched.delivery.outcome, 'processing');
  assert.equal(dispatched.delivery.publicationId, 'fixture-provider-publication');
  assert.equal(f.calls.filter(call => call === 'upload').length, 1);
  // Completion is delivery execution, not a claim of public publication.
  assert.equal((await f.store.read()).publications[0].status, 'processing');
});

test('selected route drift leaves queued delivery untouched and binding drift becomes attention before upload', async t => {
  const changedRoute = await fixture(t);
  await migrate(changedRoute);
  changedRoute.config.selected = false;
  const before = await changedRoute.store.read();
  assert.equal((await changedRoute.queue.runDue({ execute: true, platform: 'tiktok' })).blocked, true);
  assert.deepEqual(await changedRoute.store.read(), before);
  assert.ok(!changedRoute.calls.includes('upload'));
  for (const change of [f => { f.config.bindingSha256 = 'd'.repeat(64); },
    f => { f.config.providerAccountId = 'a'.repeat(24); }, f => { f.config.reviewHash = 'e'.repeat(64); },
    f => { f.config.accountId = '7474000000000000000'; }, f => { f.config.ready = false; }]) {
    const f = await fixture(t);
    await migrate(f);
    change(f);
    const result = await f.queue.runDue({ execute: true, platform: 'tiktok' });
    assert.equal(result.delivery.status, 'attention');
    assert.equal(result.delivery.phase, 'preflight');
    assert.ok(!f.calls.includes('upload'));
    assert.deepEqual((await f.store.read()).publications, []);
  }
});

test('YouTube migration preserves the old consent generation as history rather than using it for Zernio', async t => {
  const oldGrant = { grantId: 'owned-youtube-grant', authorized: true };
  const f = await fixture(t, { delivery: { platform: 'youtube', mode: 'official_api',
    accountId: 'UCjwAEFZPOQ6FIfweosLmCTg', madeForKids: false, apiData: oldGrant } });
  const result = await migrate(f);
  assert.equal(result.delivery.mode, 'zernio');
  assert.equal(result.delivery.accountId, 'UCjwAEFZPOQ6FIfweosLmCTg');
  assert.equal(result.delivery.apiData, undefined);
  assert.deepEqual(result.delivery.providerHistory.at(-1).apiData, oldGrant);
  assert.equal(result.delivery.madeForKids, false);
  assert.equal(result.delivery.dueAt, f.original.dueAt);
  assert.ok(!f.calls.includes('upload'));
});
