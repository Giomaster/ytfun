import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { episodeAssetHash, episodeReviewHash } from '../src/domain.mjs';
import { Publisher } from '../src/publishing.mjs';
import { StudioStore } from '../src/store.mjs';

const CHANNEL = 'UCjwAEFZPOQ6FIfweosLmCTg';
const PROVIDER = '66b2e19d8c3f5a7e9d0b1c2d';
const PROVIDER_POST = '65f1c0a9e2b5af0012ab34cd';
const VIDEO = 'dQw4w9WgXcQ';
const BINDING_SHA = 'b'.repeat(64);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const binding = { providerAccountId: PROVIDER, nativeAccountId: CHANNEL, handle: '@aimeow-ofc',
  evidenceSha256: BINDING_SHA, verifiedAt: '2026-10-02T00:00:00Z', source: 'owner_confirmed' };

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ytfun-zernio-publishing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'assets'));
  const media = Buffer.from('exact-reviewed-zernio-render');
  const images = Buffer.from('original-generated-fixture-image');
  const audio = Buffer.from('original-generated-fixture-audio');
  for (const [name, bytes] of [['render.mp4', media], ['visual.png', images], ['audio.wav', audio]]) {
    await writeFile(path.join(directory, 'assets', name), bytes);
  }
  const store = new StudioStore(directory);
  const project = { id: 'project-zernio', title: 'Hidden Worlds fixture', mode: 'fiction', status: 'active',
    cadence: { minHoursBetweenPosts: 18, maxPostsPerRollingDay: 2 } };
  const assets = [
    { id: 'visual-zernio', kind: 'image', path: 'assets/visual.png', sha256: sha(images) },
    { id: 'audio-zernio', kind: 'audio', path: 'assets/audio.wav', sha256: sha(audio) },
  ].map(asset => ({ ...asset, episodeId: 'episode-zernio', sceneId: 'scene-zernio', synthetic: true,
    provenance: { provider: 'CI fixture', model: 'original-fixture-model', prompt: 'Original impossible scene',
      commercialLicense: { url: 'https://example.com/fixture-license', notes: 'CI fixture commercial-rights evidence.' } } }));
  const episode = { id: 'episode-zernio', projectId: project.id, title: 'Impossible worlds inside lava',
    hook: 'One cut opens an impossible world.', synopsis: 'Original synthetic fictional reveal.',
    originalAngle: 'An original material reveal.', continuityNote: 'Standalone fixture.',
    metadata: { description: 'An original AI-made scene.', hashtags: ['AIMeow'], tags: ['AI animation'] },
    scenes: [{ id: 'scene-zernio', durationSeconds: 52.521, narration: 'Fixture narration.', visualPrompt: 'A fictional sphere opens.' }],
    render: { path: 'assets/render.mp4', sha256: sha(media), durationSeconds: 52.521, width: 1080, height: 1920,
      synthetic: true, sceneAssets: [{ sceneId: 'scene-zernio', visualAssetId: 'visual-zernio', audioAssetId: 'audio-zernio' }] },
    status: 'approved' };
  episode.approval = { reviewHash: episodeReviewHash(episode), assetReviewHash: episodeAssetHash(episode, assets),
    approvedAt: new Date().toISOString(), review: { originalityChecked: true, factsChecked: true, renderWatched: true,
      reviewedBy: 'CI fixture reviewer', notes: 'Only generated fixture evidence; not a real owner attestation.' } };
  await store.transaction(state => { state.projects.push(project); state.episodes.push(episode); state.assets.push(...assets); });
  const env = { YOUTUBE_CHANNEL_ID: CHANNEL, YOUTUBE_CHANNEL_HANDLE: '@aimeow-ofc',
    YTFUN_YOUTUBE_ZERNIO_PUBLISH_ENABLED: 'true', ZERNIO_YOUTUBE_ACCOUNT_ID: PROVIDER,
    ZERNIO_YOUTUBE_BINDING_JSON: JSON.stringify(binding),
    YTFUN_YOUTUBE_PUBLIC_ENABLED: 'false', YTFUN_YOUTUBE_AUDIT_CONFIRMED: 'false', ...overrides.env };
  const calls = [];
  let lastContext;
  const youtubeZernio = {
    readiness: () => ({ ready: true, reasons: [], accountId: CHANNEL, providerAccountId: PROVIDER,
      maxBytes: 250 * 1024 * 1024, maxDurationSeconds: 900 }),
    verifyAccount: async () => { calls.push('verify-account'); return { accountId: CHANNEL, providerAccountId: PROVIDER, maxDurationSeconds: 900 }; },
    upload: async input => {
      calls.push('upload');
      assert.deepEqual(input.media, media);
      assert.equal(input.madeForKids, false);
      assert.equal(input.title, episode.title);
      assert.equal(input.render.sha256, episode.render.sha256);
      const reserved = (await store.read()).publications.find(item => item.id === input.publicationId);
      assert.equal(reserved.accountId, CHANNEL);
      assert.equal(reserved.providerAccountId, PROVIDER);
      assert.equal(reserved.privacy, 'public');
      assert.equal(reserved.route, 'zernio');
      assert.equal(reserved.renderSha256, episode.render.sha256);
      lastContext = { route: 'zernio', publicationId: input.publicationId, accountId: CHANNEL,
        providerAccountId: PROVIDER, renderSha256: episode.render.sha256, providerPostId: PROVIDER_POST };
      await input.onReceipt({ ...lastContext, status: 'processing', phase: 'create-post', confirmed: false });
      if (overrides.uploadThrows) throw new Error('Provider raw diagnostics must never survive.');
      return { ...lastContext, status: overrides.uploadStatus ?? 'processing', phase: 'create-post', confirmed: false };
    },
    status: async input => {
      calls.push('status');
      assert.equal(input.providerPostId, PROVIDER_POST);
      assert.equal(input.renderSha256, episode.render.sha256);
      assert.equal(input.publicationId, lastContext.publicationId);
      return { ...lastContext, status: 'published', phase: 'status', confirmed: true, privacy: 'public',
        videoId: VIDEO, url: `https://www.youtube.com/watch?v=${VIDEO}`, publishedAt: new Date().toISOString(), nativeVisibilityVerified: true };
    },
  };
  const ownedAuth = { readiness: () => ({ ready: false, reasons: ['owned OAuth deliberately disabled in fixture'] }),
    getAccessToken: async () => { throw new Error('Own upload authorization must not be used for this injected provider route.'); } };
  const publisher = new Publisher(store, { env, youtubeZernio, youtubeAuth: ownedAuth,
    fetchImpl: async () => { throw new Error('No owned upload request is allowed in this integration fixture.'); } });
  return { store, publisher, episode, project, env, calls, youtubeZernio };
}

const input = (f, extra = {}) => ({ episodeId: f.episode.id, platform: 'youtube', privacy: 'public',
  expectedReviewHash: f.episode.approval.reviewHash, madeForKids: false, execute: true, ...extra });

test('selected YouTube provider bypasses only own-app audit and still requires public immediate delivery', async t => {
  const f = await fixture(t);
  const publicPlan = await f.publisher.preflight(input(f));
  assert.equal(publicPlan.ready, true);
  assert.equal(publicPlan.deliveryMode, 'zernio');
  assert.equal(publicPlan.providerAccountId, PROVIDER);
  assert.ok(!publicPlan.reasons.some(reason => /audit|youtube\.upload/.test(reason)));
  for (const privacy of ['private', 'unlisted']) {
    assert.equal((await f.publisher.preflight(input(f, { privacy }))).ready, false);
    await assert.rejects(f.publisher.publishYouTube(input(f, { privacy })));
  }
  await assert.rejects(f.publisher.publishYouTube(input(f, { publishAt: new Date(Date.now() + 3_600_000).toISOString() })));
  assert.deepEqual(f.calls, []);
  const sent = await f.publisher.publishYouTube(input(f));
  assert.equal(sent.publication.status, 'processing');
  assert.equal(sent.publication.providerPostId, PROVIDER_POST);
  assert.equal(sent.publication.privacy, 'public');
  const synced = await f.publisher.syncPublication({ publicationId: sent.publication.id });
  assert.equal(synced.status, 'published');
  assert.equal(synced.videoId, VIDEO);
  assert.equal(synced.providerPrivacyStatus, 'public');
});

test('unknown provider outcome retains exact post ID and reservation without another upload', async t => {
  const f = await fixture(t, { uploadThrows: true });
  const first = await f.publisher.publishYouTube(input(f));
  assert.equal(first.publication.status, 'unknown');
  assert.equal(first.publication.providerPostId, PROVIDER_POST);
  assert.equal(first.publication.renderSha256, f.episode.render.sha256);
  assert.ok(!first.publication.error.includes('raw diagnostics'));
  const second = await f.publisher.publishYouTube(input(f));
  assert.equal(second.duplicate, true);
  assert.equal(second.publication.id, first.publication.id);
  assert.equal(f.calls.filter(call => call === 'upload').length, 1);
  assert.equal((await f.store.read()).publications.length, 1);
});

test('existing own-route unknown publication blocks a new provider mutation for the same episode', async t => {
  const f = await fixture(t);
  await f.store.transaction(state => state.publications.push({ id: 'original-owned-publication', episodeId: f.episode.id,
    projectId: f.project.id, platform: 'youtube', accountId: CHANNEL, privacy: 'public', status: 'unknown',
    renderSha256: f.episode.render.sha256, reviewHash: f.episode.approval.reviewHash, effectiveAt: new Date().toISOString(),
    createdAt: new Date().toISOString(), videoId: VIDEO }));
  const result = await f.publisher.publishYouTube(input(f));
  assert.equal(result.duplicate, true);
  assert.equal(result.publication.id, 'original-owned-publication');
  assert.deepEqual(f.calls, []);
});

test('shared native channel cadence counts reservations from the owned provider across projects', async t => {
  const f = await fixture(t);
  await f.store.transaction(state => state.publications.push({ id: 'another-route-reservation', episodeId: 'another-episode',
    projectId: f.project.id, platform: 'youtube', accountId: CHANNEL, status: 'unknown', privacy: 'public',
    effectiveAt: new Date().toISOString(), createdAt: new Date().toISOString() }));
  const plan = await f.publisher.preflight(input(f));
  assert.equal(plan.ready, false);
  assert.ok(plan.reasons.some(reason => /Channel cadence/.test(reason)));
  await assert.rejects(f.publisher.publishYouTube(input(f)), /Channel cadence/);
  assert.deepEqual(f.calls, []);
});

test('running claim from the previous route or another provider binding cannot be used', async t => {
  for (const mismatch of [{ mode: 'official_api' }, { providerAccountId: 'a'.repeat(24) }, { bindingSha256: 'c'.repeat(64) }]) {
    const f = await fixture(t);
    await f.store.transaction(state => {
      state.deliveries = [{ id: 'claim-zernio', status: 'running', episodeId: f.episode.id, platform: 'youtube',
        accountId: CHANNEL, privacy: 'public', madeForKids: false, mode: 'zernio', providerAccountId: PROVIDER,
        bindingSha256: BINDING_SHA, reviewHash: f.episode.approval.reviewHash, renderSha256: f.episode.render.sha256, ...mismatch }];
    });
    await assert.rejects(f.publisher.publishYouTube(input(f, { deliveryId: 'claim-zernio' })), /provider or account binding changed/);
    assert.ok(!f.calls.includes('upload'));
    assert.deepEqual((await f.store.read()).publications, []);
  }
});

test('sync requires the original provider binding and never mutates another route on binding drift', async t => {
  const f = await fixture(t);
  const first = await f.publisher.publishYouTube(input(f));
  f.env.ZERNIO_YOUTUBE_BINDING_JSON = JSON.stringify({ ...binding, evidenceSha256: 'c'.repeat(64) });
  await assert.rejects(f.publisher.syncZernio({ publicationId: first.publication.id }), /original provider account binding/);
  assert.equal(f.calls.filter(call => call === 'status').length, 0);
  assert.equal((await f.store.read()).publications[0].status, 'processing');
});
