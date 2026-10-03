import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { StudioStore, emptyStudioState } from '../src/store.mjs';
import { Studio } from '../src/domain.mjs';
import { Publisher } from '../src/publishing.mjs';
import { Research } from '../src/research.mjs';
import { YouTubeAuth, YOUTUBE_READONLY_SCOPE } from '../src/oauth.mjs';
import { YouTubeDataLifecycle } from '../src/youtube-data.mjs';
import { purgeYouTubeData, youtubeApiData, youtubeBlocked, youtubeConnection, YOUTUBE_DATA_TTL_MS } from '../src/youtube-data-policy.mjs';
import { removeYouTubeGrant } from '../src/private-env.mjs';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const CHANNEL = 'UCfixturePersonalAccount';
const TOKEN = 'fixture-private-refresh-token';
const iso = time => new Date(time).toISOString();

function sampleState() {
  const state = emptyStudioState();
  state.projects.push({ id: 'project', premise: 'Original premise' });
  state.episodes.push({ id: 'episode', projectId: 'project', status: 'published', title: 'Original title', trendIds: ['youtube-trend', 'other-trend'], metrics: [
    { id: 'youtube-metric', platform: 'youtube', observedAt: iso(NOW - YOUTUBE_DATA_TTL_MS), views: 12, sourceUrl: 'https://studio.youtube.com/video/abcdefghijk/analytics' },
    { id: 'facebook-metric', platform: 'facebook', observedAt: iso(NOW - YOUTUBE_DATA_TTL_MS), views: 20 },
  ] });
  state.trends.push({ id: 'youtube-trend', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', observedAt: iso(NOW - YOUTUBE_DATA_TTL_MS), topic: 'API title', evidence: 'API statistics' },
    { id: 'other-trend', sourceUrl: 'https://example.com/context', observedAt: iso(NOW - YOUTUBE_DATA_TTL_MS) });
  state.publications.push({ id: 'publication', platform: 'youtube', episodeId: 'episode', projectId: 'project', accountId: CHANNEL, videoId: 'abcdefghijk', status: 'published',
    createdAt: iso(NOW - YOUTUBE_DATA_TTL_MS), updatedAt: iso(NOW), reviewHash: 'a'.repeat(64), renderSha256: 'b'.repeat(64), url: 'https://www.youtube.com/watch?v=abcdefghijk', providerUploadStatus: 'processed' });
  state.assets.push({ id: 'asset', path: 'assets/original.mp4', provenance: { provider: 'original-AI' } });
  state.spending.push({ id: 'cost', estimatedCostUsd: 0 });
  state.deliveries = [{ id: 'queued', episodeId: 'episode', platform: 'youtube', accountId: CHANNEL, status: 'queued', createdAt: iso(NOW - YOUTUBE_DATA_TTL_MS) },
    { id: 'running', episodeId: 'episode', platform: 'youtube', accountId: CHANNEL, publicationId: 'publication', outcome: 'published', status: 'running', createdAt: iso(NOW - YOUTUBE_DATA_TTL_MS) }];
  return state;
}

async function fixture(t, response = () => new Response(null, { status: 200 })) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ytfun-youtube-data-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, 'private.env');
  const env = { YOUTUBE_CHANNEL_ID: CHANNEL, YOUTUBE_REFRESH_TOKEN: TOKEN, YOUTUBE_CLIENT_ID: 'fixture-client', YOUTUBE_CLIENT_SECRET: 'fixture-client-secret', YTFUN_YOUTUBE_GRANT_ID: 'fixture-generation',
    YTFUN_PRIVATE_ENV_FILE: envFile, YTFUN_YOUTUBE_PUBLIC_ENABLED: 'true', YTFUN_YOUTUBE_AUDIT_CONFIRMED: 'true' };
  await writeFile(envFile, `# Preserve this comment\n${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\nFACEBOOK_PAGE_ACCESS_TOKEN=fixture-facebook-token\nYOUTUBE_API_KEY=fixture-public-key\n`, { mode: 0o600 });
  const store = new StudioStore(path.join(directory, 'data'));
  const initial = sampleState();
  initial.trends[0].apiData = youtubeApiData({ grantId: env.YTFUN_YOUTUBE_GRANT_ID, now: Date.parse(initial.trends[0].observedAt) });
  initial.episodes[0].metrics[0].apiData = youtubeApiData({ authorized: true, grantId: env.YTFUN_YOUTUBE_GRANT_ID, now: Date.parse(initial.episodes[0].metrics[0].observedAt) });
  for (const item of [...initial.publications, ...initial.deliveries]) item.apiData = youtubeApiData({ authorized: true, grantId: env.YTFUN_YOUTUBE_GRANT_ID, now: Date.parse(item.createdAt) });
  await store.transaction(state => Object.assign(state, initial));
  const calls = [];
  const lifecycle = new YouTubeDataLifecycle(store, { env, now: () => NOW, fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return response(url, options); } });
  t.after(() => lifecycle.stop());
  return { directory, envFile, env, store, lifecycle, calls };
}

test('30-day API expiry uses fetch time, preserves originals/other networks and blocks unknown replay', () => {
  const state = sampleState();
  const originalAssets = structuredClone(state.assets), originalCosts = structuredClone(state.spending);
  const counts = purgeYouTubeData(state, { now: NOW });
  assert.deepEqual(counts, { trends: 1, metrics: 1, publications: 1, deliveries: 2 });
  assert.deepEqual(state.assets, originalAssets);
  assert.deepEqual(state.spending, originalCosts);
  assert.deepEqual(state.episodes[0].trendIds, ['other-trend']);
  assert.equal(state.episodes[0].metrics[0].platform, 'facebook');
  assert.equal(state.publications[0].id, 'publication');
  assert.equal(state.publications[0].status, 'unknown');
  assert.equal(state.publications[0].localOnly, true);
  assert.equal(state.deliveries[0].status, 'cancelled');
  assert.equal(state.deliveries[1].status, 'attention');
  assert.equal(JSON.stringify(state).includes(CHANNEL), false);
  assert.equal(JSON.stringify(state).includes('abcdefghijk'), false);
  assert.deepEqual(purgeYouTubeData(state, { now: NOW }), { trends: 0, metrics: 0, publications: 0, deliveries: 0 });
});

test('snapshot provenance and last verified API response control expiry; malformed/future metadata cannot extend it', () => {
  const state = emptyStudioState();
  state.trends.push({ id: 'fresh', ...{ apiData: youtubeApiData({ now: NOW - YOUTUBE_DATA_TTL_MS + 1 }) } },
    { id: 'future', apiData: youtubeApiData({ now: NOW + 1000 }) }, { id: 'invalid', apiData: { provider: 'youtube', fetchedAt: 'invalid' } });
  state.publications.push({ id: 'recently-verified', platform: 'youtube', createdAt: iso(NOW - 2 * YOUTUBE_DATA_TTL_MS), verifiedAt: iso(NOW - 1000), videoId: 'abcdefghijk' });
  assert.equal(purgeYouTubeData(state, { now: NOW }).trends, 2);
  assert.equal(state.trends[0].id, 'fresh');
  assert.equal(state.publications[0].videoId, 'abcdefghijk');
  assert.equal(purgeYouTubeData(state, { now: NOW + 1 }).trends, 1);
});

test('preview never reads a private file or calls Google, and expiry maintenance works without delivery worker', async t => {
  const f = await fixture(t);
  f.env.YTFUN_PRIVATE_ENV_FILE = '/nonexistent/private.env';
  const before = await f.store.read();
  const preview = await f.lifecycle.disconnect();
  assert.equal(preview.execute, false);
  assert.equal(preview.removes.publications, 1);
  assert.deepEqual(await f.store.read(), before);
  assert.deepEqual(f.calls, []);
  await f.lifecycle.maintain();
  assert.equal((await f.store.read()).publications[0].localOnly, true);
  assert.deepEqual(f.calls, []);
});

test('disconnect confirms each stage, revokes once without redirects/retries and preserves unrelated environment', async t => {
  const f = await fixture(t);
  const result = await f.lifecycle.disconnect({ execute: true, expectedChannelId: CHANNEL });
  assert.equal(result.complete, true);
  assert.equal(result.revocation.status, 'confirmed');
  assert.equal(result.environmentCleanup.confirmed, true);
  assert.equal(result.storeCleanup.confirmed, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(f.calls[0].options.method, 'POST');
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.equal(new URLSearchParams(f.calls[0].options.body).get('token'), TOKEN);
  const stored = parseEnv(await readFile(f.envFile, 'utf8'));
  assert.equal(stored.YOUTUBE_REFRESH_TOKEN, undefined);
  assert.equal(stored.YOUTUBE_CHANNEL_ID, undefined);
  assert.equal(stored.YTFUN_YOUTUBE_GRANT_ID, undefined);
  assert.equal(stored.YOUTUBE_CLIENT_ID, 'fixture-client');
  assert.equal(stored.FACEBOOK_PAGE_ACCESS_TOKEN, 'fixture-facebook-token');
  assert.equal(stored.YOUTUBE_API_KEY, 'fixture-public-key');
  assert.equal(stored.YTFUN_YOUTUBE_PUBLIC_ENABLED, 'false');
  assert.equal((await stat(f.envFile)).mode & 0o777, 0o600);
  assert.equal(f.lifecycle.auth.readiness().ready, false);
  await assert.rejects(f.lifecycle.fetch('https://www.googleapis.com/youtube/v3/videos'), /disconnected/);
  const repeated = await f.lifecycle.disconnect({ execute: true, expectedChannelId: CHANNEL });
  assert.equal(repeated.revocation.status, 'confirmed');
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(await f.store.read()).includes(TOKEN), false);
  // Restarting with the same grant remains blocked; fresh consent has a distinct generation.
  const state = await f.store.read();
  assert.equal(youtubeBlocked(state, { YTFUN_YOUTUBE_GRANT_ID: 'fixture-generation' }), true);
  assert.equal(youtubeBlocked(state, {}), true);
  assert.equal(youtubeBlocked(state, { YTFUN_YOUTUBE_GRANT_ID: 'fresh-consent-generation' }), false);
});

test('ambiguous revocation is truthful, clears local data and never replays its POST', async t => {
  const f = await fixture(t, () => { throw new Error(TOKEN); });
  const result = await f.lifecycle.disconnect({ execute: true, expectedChannelId: CHANNEL });
  assert.equal(result.complete, false);
  assert.equal(result.revocation.status, 'unknown');
  assert.equal(result.environmentCleanup.confirmed, true);
  assert.match(result.actionRequired, /Google Account/);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  await f.lifecycle.disconnect({ execute: true, expectedChannelId: CHANNEL });
  assert.equal(f.calls.length, 1);
});

test('OAuth setup lock remains held during revocation and concurrent disconnect sends only one POST', async t => {
  let release, entered;
  const began = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async () => {
    entered();
    await new Promise(resolve => { release = resolve; });
    return new Response(null, { status: 200 });
  });
  const first = f.lifecycle.disconnect({ execute: true, expectedChannelId: CHANNEL });
  await began;
  const second = f.lifecycle.disconnect({ execute: true, expectedChannelId: CHANNEL });
  await assert.rejects(removeYouTubeGrant(f.envFile, { expectedChannelId: CHANNEL, expectedToken: TOKEN }), /not confirmed/);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.every(result => result.complete), true);
  assert.equal(f.calls.length, 1);
});

test('wrong account, symlink, concurrent grant or OAuth lock never cause broad environment deletion', async t => {
  const f = await fixture(t);
  await assert.rejects(f.lifecycle.disconnect({ execute: true, expectedChannelId: 'UCother' }), /exact configured/);
  const original = await readFile(f.envFile, 'utf8');
  const link = path.join(f.directory, 'linked.env');
  await symlink(f.envFile, link);
  await assert.rejects(removeYouTubeGrant(link, { expectedChannelId: CHANNEL, expectedToken: TOKEN }), /not confirmed/);
  await assert.rejects(removeYouTubeGrant(f.envFile, { expectedChannelId: CHANNEL, expectedToken: 'other-grant' }), /not confirmed/);
  await writeFile(`${f.envFile}.oauth.lock`, '', { mode: 0o600 });
  await assert.rejects(removeYouTubeGrant(f.envFile, { expectedChannelId: CHANNEL, expectedToken: TOKEN }), /not confirmed/);
  assert.equal(await readFile(f.envFile, 'utf8'), original);
  assert.deepEqual(f.calls, []);
});

test('disconnect aborts Google calls and a late publisher receipt cannot restore deleted API fields', async t => {
  let capturedSignal;
  const f = await fixture(t, (url, options) => {
    if (String(url).endsWith('/revoke')) return new Response(null, { status: 200 });
    capturedSignal = options.signal;
    return new Response(null, { status: 200 });
  });
  await f.lifecycle.fetch('https://www.googleapis.com/youtube/v3/videos', { signal: AbortSignal.timeout(30_000) });
  assert.equal(capturedSignal.aborted, false);
  await f.lifecycle.disconnect({ execute: true, expectedChannelId: CHANNEL });
  assert.equal(capturedSignal.aborted, true);
  const publisher = new Publisher(f.store, { env: f.env, youtubeAuth: f.lifecycle.auth, fetchImpl: f.lifecycle.fetch });
  const late = await publisher.updatePublication('publication', { status: 'published', videoId: 'lateVideo11', accountId: CHANNEL, providerPrivacyStatus: 'public' });
  assert.equal(late.localOnly, true);
  assert.equal(late.status, 'unknown');
  assert.equal(late.videoId, undefined);
});

test('invalid_grant invalidates shared research/publisher access and purges authorized data without claiming revocation', async t => {
  const f = await fixture(t, () => Response.json({ error: 'invalid_grant', error_description: TOKEN }, { status: 400 }));
  await assert.rejects(f.lifecycle.auth.getAccessToken(), /rejected/);
  const state = await f.store.read();
  assert.equal(state.youtubeConnection.reason, 'authorization_invalid');
  assert.equal(state.youtubeConnection.revocation.status, 'not_requested');
  assert.equal(state.episodes[0].metrics.some(item => item.platform === 'youtube'), false);
  assert.equal(state.publications[0].localOnly, true);
  const research = new Research(new Studio(f.store, { env: f.env }), { env: f.env, youtubeLifecycle: f.lifecycle, youtubeAuth: f.lifecycle.auth, fetchImpl: f.lifecycle.fetch });
  await assert.rejects(research.discover({ source: 'youtube' }), /disconnected/);
  await assert.rejects(f.lifecycle.auth.getAccessToken(), /rejected|disconnected/);
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(state).includes(TOKEN), false);
});

test('in-flight OAuth refresh cannot refill its private cache after invalidate', async () => {
  let finish;
  const auth = new YouTubeAuth({ env: { YOUTUBE_REFRESH_TOKEN: TOKEN, YOUTUBE_CLIENT_ID: 'client', YOUTUBE_CLIENT_SECRET: 'secret' }, fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const pending = auth.getAccessToken();
  auth.invalidate();
  finish(Response.json({ access_token: 'late-private-access-token', token_type: 'Bearer', expires_in: 3600, scope: YOUTUBE_READONLY_SCOPE }));
  await assert.rejects(pending, /disconnected/);
  assert.equal(auth.readiness().ready, false);
  await assert.rejects(auth.getAccessToken(), /disconnected/);
  assert.equal(JSON.stringify(auth).includes('late-private-access-token'), false);
});

test('janitor authorization checks are independent of delivery worker, daily and without immediate remote retry', async t => {
  const f = await fixture(t, url => String(url).endsWith('/token')
    ? Response.json({ access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 3600, scope: YOUTUBE_READONLY_SCOPE })
    : new Response(null, { status: 200 }));
  f.env.YTFUN_DELIVERY_WORKER_ENABLED = 'false';
  await f.lifecycle.tick();
  assert.equal(f.calls.length, 2);
  assert.equal((await f.store.read()).publications[0].localOnly, true);
  await f.lifecycle.tick();
  assert.equal(f.calls.length, 2);
});

test('explicit disconnect during invalid_grant cleanup purges its public cache and never claims unrequested revocation', async t => {
  const f = await fixture(t, () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
  let entered, release;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const originalTransaction = f.store.transaction.bind(f.store);
  let first = true;
  f.store.transaction = async operation => {
    const result = await originalTransaction(operation);
    if (first) { first = false; entered(); await gate; }
    return result;
  };
  const rejectedRefresh = f.lifecycle.auth.getAccessToken();
  const rejected = assert.rejects(rejectedRefresh, /rejected/);
  await began;
  const explicit = f.lifecycle.disconnect({ execute: true, expectedChannelId: CHANNEL });
  release();
  const result = await explicit;
  await rejected;
  assert.equal(result.mode, 'explicit');
  assert.equal(result.complete, false);
  assert.equal(result.revocation.status, 'not_requested');
  assert.match(result.actionRequired, /Google Account/);
  assert.equal(result.storeCleanup.confirmed, true);
  assert.equal((await f.store.read()).trends.some(item => item.id === 'youtube-trend'), false);
  assert.equal(f.calls.some(call => call.url.endsWith('/revoke')), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('late rejection of grant A cannot purge or rewrite active grant B; history and unknown blocks survive', async t => {
  const f = await fixture(t, () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
  const newerEnv = { ...f.env, YTFUN_YOUTUBE_GRANT_ID: 'new-consent-B', YOUTUBE_REFRESH_TOKEN: 'fixture-newer-refresh-token' };
  const newerFile = Object.entries(newerEnv).map(([key, value]) => `${key}=${value}`).join('\n');
  await writeFile(f.envFile, newerFile, { mode: 0o600 });
  const marker = youtubeApiData({ authorized: true, grantId: 'new-consent-B', now: NOW });
  const newer = { trend: { id: 'trend-B', sourceUrl: 'https://www.youtube.com/watch?v=bcdefghijkl', observedAt: iso(NOW), apiData: marker, topic: 'Newer API title' },
    episode: { id: 'episode-B', projectId: 'project', status: 'published', trendIds: ['trend-B'], metrics: [{ id: 'metric-B', platform: 'youtube', views: 77, observedAt: iso(NOW), apiData: marker }] },
    publication: { id: 'publication-B', episodeId: 'episode-B', platform: 'youtube', accountId: CHANNEL, videoId: 'bcdefghijkl', status: 'published', createdAt: iso(NOW), apiData: marker },
    delivery: { id: 'delivery-B', episodeId: 'episode-B', platform: 'youtube', accountId: CHANNEL, status: 'completed', createdAt: iso(NOW), apiData: marker } };
  await f.store.transaction(state => { state.trends.push(newer.trend); state.episodes.push(newer.episode); state.publications.push(newer.publication); state.deliveries.push(newer.delivery); });
  await assert.rejects(f.lifecycle.auth.getAccessToken(), /rejected/);
  await f.lifecycle.maintain();
  await f.lifecycle.maintain();
  const current = await f.store.read();
  assert.deepEqual(current.trends.find(item => item.id === 'trend-B'), newer.trend);
  assert.deepEqual(current.episodes.find(item => item.id === 'episode-B'), newer.episode);
  assert.deepEqual(current.publications.find(item => item.id === 'publication-B'), newer.publication);
  assert.deepEqual(current.deliveries.find(item => item.id === 'delivery-B'), newer.delivery);
  assert.equal(await readFile(f.envFile, 'utf8'), newerFile);
  assert.equal(current.publications.find(item => item.id === 'publication').status, 'unknown');
  assert.equal(youtubeBlocked(current, { YTFUN_YOUTUBE_GRANT_ID: 'fixture-generation' }), true);
  assert.equal(youtubeBlocked(current, newerEnv), false);
  const newerLifecycle = new YouTubeDataLifecycle(f.store, { env: newerEnv, now: () => NOW, fetchImpl: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }) });
  await assert.rejects(newerLifecycle.auth.getAccessToken(), /rejected/);
  const history = await f.store.read();
  assert.equal(youtubeConnection(history, { YTFUN_YOUTUBE_GRANT_ID: 'fixture-generation' }).blocked, true);
  assert.equal(youtubeConnection(history, { YTFUN_YOUTUBE_GRANT_ID: 'new-consent-B' }).blocked, true);
});

test('personal MCP fails closed without a unique grant generation instead of mixing manually replaced tokens', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ytfun-generation-required-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const lifecycle = new YouTubeDataLifecycle(new StudioStore(directory), { env: { YOUTUBE_CHANNEL_ID: CHANNEL, YOUTUBE_ACCESS_TOKEN: 'fixture-static-token' }, fetchImpl: async () => { calls++; } });
  assert.equal(lifecycle.auth.readiness().ready, false);
  await assert.rejects(lifecycle.fetch('https://www.googleapis.com/youtube/v3/videos'), /GRANT_ID/);
  assert.equal(calls, 0);
});
