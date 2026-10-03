import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { episodeAssetHash, episodeReviewHash } from '../src/domain.mjs';
import { DeliveryQueue } from '../src/delivery-queue.mjs';
import { normalizeYouTubeMetadata, Publisher, youtubeMetadataHash } from '../src/publishing.mjs';
import { StudioStore } from '../src/store.mjs';
import { purgeYouTubeData } from '../src/youtube-data-policy.mjs';
import { YouTubeZernio } from '../src/youtube-zernio.mjs';

const CHANNEL = 'UCjwAEFZPOQ6FIfweosLmCTg';
const PROVIDER = '66b2e19d8c3f5a7e9d0b1c2d';
const POST = '65f1c0a9e2b5af0012ab34cd';
const VIDEO = 'dQw4w9WgXcQ';
const TOKEN = `sk_${'a'.repeat(64)}`;
const SIGNATURE = 'e'.repeat(64);
const MEDIA = Buffer.from('exact-reviewed-original-youtube-presentation-fixture');
const sha = value => createHash('sha256').update(value).digest('hex');
const PRESENTATION = { title: 'A tiny city inside a crystal',
  description: 'One opening reveals a miniature world. Original AI-made animation.',
  tags: ['AI Meow', 'crystal city'] };
const presentationInput = (snapshot = PRESENTATION) => ({ youtubeMetadata: structuredClone(snapshot),
  youtubeMetadataSha256: youtubeMetadataHash(snapshot) });

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ytfun-youtube-presentation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'assets'));
  const visual = Buffer.from('synthetic-original-visual-fixture');
  const audio = Buffer.from('synthetic-original-audio-fixture');
  for (const [name, bytes] of [['render.mp4', MEDIA], ['visual.mp4', visual], ['audio.wav', audio]]) {
    await writeFile(path.join(directory, 'assets', name), bytes);
  }
  const store = new StudioStore(directory);
  const project = { id: randomUUID(), title: 'Shared original AI Meow fixture', mode: 'fiction', status: 'active',
    cadence: { minHoursBetweenPosts: 0, maxPostsPerRollingDay: null } };
  const episodeId = randomUUID(); const sceneId = randomUUID();
  const assets = [['video', 'visual.mp4', visual], ['audio', 'audio.wav', audio]].map(([kind, filename, bytes]) => ({
    id: randomUUID(), episodeId, sceneId, kind, path: `assets/${filename}`, sha256: sha(bytes), synthetic: true,
    provenance: { provider: 'CI fixture', model: 'original-fixture-model', prompt: 'An original fictional crystal world.',
      commercialLicense: { url: 'https://example.com/fixture-license', notes: 'Synthetic CI fixture rights evidence.' } },
  }));
  const episode = { id: episodeId, projectId: project.id, title: 'Shared production fixture title',
    hook: 'A crystal opens onto a small world.', synopsis: 'Original fictional miniature city.',
    originalAngle: 'An original material opens to reveal an impossible city.', continuityNote: 'Standalone fixture.',
    audioMode: 'nonverbal', format: 'short', trendIds: [], metrics: [], metadata: {
      description: 'Two preserved generated plans, exact source hashes and a technical assembly receipt.',
      hashtags: ['#AIMeow'], tags: ['shared production tag'] },
    scenes: [{ id: sceneId, durationSeconds: 15, narration: '', visualPrompt: 'An invented city inside a crystal.' }],
    render: { path: 'assets/render.mp4', sha256: sha(MEDIA), durationSeconds: 15, width: 1080, height: 1920,
      framesPerSecond: 30, format: 'mp4', synthetic: true, audioMode: 'nonverbal', hasAudio: true,
      sceneAssets: [{ sceneId, visualAssetId: assets[0].id, audioAssetId: assets[1].id }] }, status: 'approved' };
  episode.approval = { reviewHash: episodeReviewHash(episode), assetReviewHash: episodeAssetHash(episode, assets),
    approvedAt: new Date().toISOString(), review: { originalityChecked: true, factsChecked: true, renderWatched: true,
      reviewedBy: 'CI fixture reviewer', notes: 'Simulated fixture review only; no actual human observation is asserted.' } };
  const now = Date.now();
  const otherPublications = [
    { id: randomUUID(), episodeId, projectId: project.id, platform: 'facebook', accountId: 'fixture-facebook-page',
      privacy: 'public', status: 'unknown', renderSha256: episode.render.sha256, reviewHash: episode.approval.reviewHash,
      effectiveAt: new Date(now - 1_000).toISOString(), providerPhase: 'processing', videoId: 'fixture-facebook-video' },
    { id: randomUUID(), episodeId, projectId: project.id, platform: 'tiktok', accountId: 'fixture-tiktok-account',
      privacy: 'public', status: 'published', renderSha256: episode.render.sha256, reviewHash: episode.approval.reviewHash,
      effectiveAt: new Date(now - 2_000).toISOString(), postId: 'fixture-tiktok-post' },
  ];
  const otherDeliveries = otherPublications.map(publication => ({ id: randomUUID(), episodeId,
    platform: publication.platform, accountId: publication.accountId, reviewHash: publication.reviewHash,
    renderSha256: publication.renderSha256, privacy: 'public', dueAt: publication.effectiveAt,
    status: publication.status === 'unknown' ? 'attention' : 'completed', publicationId: publication.id,
    mode: publication.platform === 'facebook' ? 'official_api' : 'zernio', outcome: publication.status }));
  await store.transaction(state => {
    state.projects.push(project); state.episodes.push(episode); state.assets.push(...assets);
    state.publications.push(...otherPublications); state.deliveries = otherDeliveries;
  });
  const binding = { providerAccountId: PROVIDER, nativeAccountId: CHANNEL, handle: '@aimeow-ofc',
    evidenceSha256: 'b'.repeat(64), verifiedAt: new Date(now).toISOString(), source: 'owner_confirmed' };
  const env = { YOUTUBE_CHANNEL_ID: CHANNEL, YOUTUBE_CHANNEL_HANDLE: '@aimeow-ofc',
    YTFUN_YOUTUBE_ZERNIO_PUBLISH_ENABLED: 'true', ZERNIO_YOUTUBE_ACCOUNT_ID: PROVIDER,
    ZERNIO_YOUTUBE_BINDING_JSON: JSON.stringify(binding), ZERNIO_API_KEY: TOKEN,
    YTFUN_YOUTUBE_PUBLIC_ENABLED: 'false', YTFUN_YOUTUBE_AUDIT_CONFIRMED: 'false' };
  const calls = []; const nativeCalls = []; const reserved = [];
  const hooks = { verifyAccount: null, createPost: null, getPost: null };
  let providerPost; let statusUnavailable = false;
  const key = 'temp/fixture_youtube_presentation.mp4';
  const fetchImpl = async (url, request = {}) => {
    const method = request.method ?? 'GET'; const parsed = new URL(url);
    calls.push({ url: String(url), method, request });
    if (parsed.pathname.endsWith('/accounts')) {
      await hooks.verifyAccount?.();
      return Response.json({ accounts: [{ _id: PROVIDER, platform: 'youtube', isActive: true,
        profileUrl: 'https://www.youtube.com/@aimeow-ofc' }] });
    }
    if (parsed.pathname.endsWith('/health')) return Response.json({ accountId: PROVIDER, platform: 'youtube',
      status: 'healthy', tokenStatus: { valid: true }, permissions: { canPost: true, missingRequired: [] } });
    if (parsed.pathname.endsWith('/presign')) return Response.json({ key, expiresIn: 3600,
      publicUrl: `https://media.zernio.com/${key}`,
      uploadUrl: `https://${'1'.repeat(32)}.r2.cloudflarestorage.com/media/${key}?X-Amz-Signature=${SIGNATURE}` });
    if (method === 'PUT') {
      assert.deepEqual(request.body, MEDIA); assert.equal(request.headers.Authorization, undefined);
      assert.equal(request.redirect, 'error'); return new Response(null, { status: 200 });
    }
    if (method === 'POST' && parsed.pathname.endsWith('/posts')) {
      const body = JSON.parse(request.body);
      const publication = (await store.read()).publications.find(item => item.id === body.metadata.ytfunPublicationId);
      reserved.push(structuredClone(publication));
      await hooks.createPost?.({ body, publication });
      providerPost = { _id: POST, status: 'published', metadata: body.metadata,
        platforms: [{ ...body.platforms[0], status: 'published', platformPostId: VIDEO,
          platformPostUrl: `https://www.youtube.com/watch?v=${VIDEO}`, publishedAt: new Date(now - 1_000).toISOString() }] };
      return Response.json({ post: providerPost }, { status: 201 });
    }
    if (method === 'GET' && parsed.pathname.endsWith(`/posts/${POST}`)) {
      await hooks.getPost?.();
      if (statusUnavailable) throw new Error(`Unsafe fixture provider diagnostics ${TOKEN}`);
      return Response.json({ post: providerPost });
    }
    assert.fail(`Unexpected fixture route: ${method} ${parsed.pathname}`);
  };
  const youtubeZernio = new YouTubeZernio({ env, binding, fetchImpl, verifyPublishedVideo: async input => {
    nativeCalls.push(input);
    return { ...input, confirmed: true, privacyStatus: 'public', uploadStatus: 'processed' };
  } });
  const youtubeAuth = { readiness: () => ({ ready: false, reasons: ['Own OAuth disabled in fixture'] }),
    getAccessToken: async () => assert.fail('The owned upload route must not be used by the provider fixture') };
  const publisher = new Publisher(store, { env, youtubeZernio, youtubeAuth,
    fetchImpl: async () => assert.fail('No owned provider network call is allowed in this fixture') });
  const queue = new DeliveryQueue(store, publisher, { now: () => now });
  return { directory, store, episode, assets, otherPublications, otherDeliveries, env, publisher, queue, calls, nativeCalls,
    reserved, hooks, dueAt: new Date(now).toISOString(), setStatusUnavailable(value) { statusUnavailable = value; } };
}

const input = (f, extra = {}) => ({ episodeId: f.episode.id, platform: 'youtube', privacy: 'public',
  expectedReviewHash: f.episode.approval.reviewHash, madeForKids: false, execute: true, ...extra });
const enqueue = (f, extra = {}) => f.queue.enqueue({ ...input(f), dueAt: f.dueAt, ...extra });
const mutationCalls = f => f.calls.filter(call => call.method === 'POST' || call.method === 'PUT');
const createBody = f => JSON.parse(f.calls.find(call => call.method === 'POST' && call.url.endsWith('/posts')).request.body);
const assertPresentation = (record, expected = PRESENTATION) => {
  assert.deepEqual(record.youtubeMetadata, expected);
  assert.equal(record.youtubeMetadataSha256, youtubeMetadataHash(expected));
};
async function assertSharedState(f) {
  const state = await f.store.read(); const current = state.episodes.find(episode => episode.id === f.episode.id);
  assert.deepEqual({ ...current, status: f.episode.status }, f.episode, 'Only the existing publication status lifecycle may change');
  assert.equal(episodeReviewHash(current), f.episode.approval.reviewHash);
  assert.deepEqual(current.render, f.episode.render); assert.deepEqual(current.approval, f.episode.approval);
  assert.deepEqual(state.assets, f.assets);
  assert.deepEqual(state.publications.filter(publication => publication.platform !== 'youtube'), f.otherPublications);
  assert.deepEqual(state.deliveries.filter(delivery => delivery.platform !== 'youtube'), f.otherDeliveries);
  assert.deepEqual(await readFile(path.join(f.directory, f.episode.render.path)), MEDIA);
}

test('YouTube presentation hashing normalizes the exact three fields and preserves tag order', () => {
  const raw = { tags: [' AI Meow ', 'crystal city '], description: ` ${PRESENTATION.description} `,
    title: ` ${PRESENTATION.title} ` };
  assert.deepEqual(normalizeYouTubeMetadata(raw), PRESENTATION);
  const canonical = JSON.stringify({ description: PRESENTATION.description, tags: PRESENTATION.tags, title: PRESENTATION.title });
  assert.equal(youtubeMetadataHash(raw), sha(canonical));
  assert.equal(youtubeMetadataHash(raw), youtubeMetadataHash(PRESENTATION));
  assert.notEqual(youtubeMetadataHash({ ...PRESENTATION, tags: [...PRESENTATION.tags].reverse() }), youtubeMetadataHash(PRESENTATION));
});

test('queued presentation survives restart and is reserved before the exact public provider POST without changing shared metadata', async t => {
  const f = await fixture(t);
  const raw = { ...PRESENTATION, title: ` ${PRESENTATION.title} `, tags: PRESENTATION.tags.map(tag => ` ${tag} `) };
  const requested = presentationInput(raw);
  const plan = await f.publisher.preflight(input(f, requested));
  assert.equal(plan.ready, true); assert.equal(plan.reviewHash, f.episode.approval.reviewHash);
  assert.equal(plan.render.sha256, f.episode.render.sha256);
  const queued = (await enqueue(f, requested)).delivery;
  assertPresentation(queued); assert.equal(mutationCalls(f).length, 0);
  const recreated = new DeliveryQueue(f.store, f.publisher, { now: () => Date.parse(f.dueAt) });
  const preview = await recreated.runDue({ execute: false, platform: 'youtube', expectedDeliveryId: queued.id });
  assert.equal(preview.plan.metadata.title, PRESENTATION.title);
  assert.equal(preview.plan.metadata.description, PRESENTATION.description);
  assert.equal(mutationCalls(f).length, 0);
  const result = await recreated.runDue({ execute: true, platform: 'youtube', expectedDeliveryId: queued.id });
  assert.equal(result.delivery.status, 'completed'); assert.equal(result.delivery.outcome, 'processing');
  assertPresentation(result.delivery);
  assert.equal(f.reserved.length, 1); assertPresentation(f.reserved[0]);
  assert.equal(f.reserved[0].deliveryId, queued.id); assert.equal(f.reserved[0].reviewHash, queued.reviewHash);
  assert.equal(f.reserved[0].renderSha256, queued.renderSha256);
  const body = createBody(f);
  assert.equal(body.content, PRESENTATION.description); assert.deepEqual(body.tags, PRESENTATION.tags);
  assert.equal(body.platforms[0].platformSpecificData.title, PRESENTATION.title);
  assert.equal(body.platforms[0].platformSpecificData.visibility, 'public');
  assert.equal(body.platforms[0].platformSpecificData.containsSyntheticMedia, true);
  assert.equal(body.metadata.ytfunRenderSha256, f.episode.render.sha256);
  assert.equal(body.publishNow, true);
  const publication = (await f.store.read()).publications.find(item => item.id === result.delivery.publicationId);
  assertPresentation(publication);
  assert.equal(mutationCalls(f).length, 3, 'One presign, one byte transfer and one publish POST');
  assert.equal((await recreated.runDue({ execute: true, platform: 'youtube' })).idle, true);
  await assertSharedState(f);
});

test('incomplete, unbound or malformed presentation inputs fail before queuing or provider work', async t => {
  const f = await fixture(t);
  const valid = presentationInput();
  const invalid = [
    { youtubeMetadata: PRESENTATION }, { youtubeMetadataSha256: valid.youtubeMetadataSha256 },
    { ...valid, youtubeMetadataSha256: '0'.repeat(64) }, { ...valid, youtubeMetadataSha256: valid.youtubeMetadataSha256.toUpperCase() },
    { ...valid, youtubeMetadataSha256: '' }, { ...valid, youtubeMetadataSha256: null },
    { ...valid, youtubeMetadata: { ...PRESENTATION, unreviewedExtra: 'hidden field' } },
    { ...valid, youtubeMetadata: { title: PRESENTATION.title, description: PRESENTATION.description } },
    { ...valid, youtubeMetadata: { title: PRESENTATION.title, tags: [] } },
    { ...valid, youtubeMetadata: { description: PRESENTATION.description, tags: [] } },
    { ...valid, youtubeMetadata: { ...PRESENTATION, title: '' } },
    { ...valid, youtubeMetadata: { ...PRESENTATION, title: 'x'.repeat(101) } },
    { ...valid, youtubeMetadata: { ...PRESENTATION, title: 'Unsafe\nsecond title' } },
    { ...valid, youtubeMetadata: { ...PRESENTATION, title: '<unsafe>' } },
    { ...valid, youtubeMetadata: { ...PRESENTATION, description: ' ' } },
    { ...valid, youtubeMetadata: { ...PRESENTATION, description: 'x'.repeat(5001) } },
    { ...valid, youtubeMetadata: { ...PRESENTATION, description: 'é'.repeat(2501) } },
    { ...valid, youtubeMetadata: { ...PRESENTATION, description: '<unsafe>' } },
    { ...valid, youtubeMetadata: { ...PRESENTATION, tags: 'not-an-array' } },
    { ...valid, youtubeMetadata: { ...PRESENTATION, tags: [' '] } },
    { ...valid, youtubeMetadata: { ...PRESENTATION, tags: ['x'.repeat(101)] } },
    { ...valid, youtubeMetadata: { ...PRESENTATION, tags: Array.from({ length: 5 }, () => 'x'.repeat(100)) } },
  ];
  const before = await f.store.read();
  for (const malformed of invalid) {
    await assert.rejects(enqueue(f, malformed));
    await assert.rejects(f.publisher.publishYouTube(input(f, malformed)));
  }
  assert.deepEqual(await f.store.read(), before);
  assert.deepEqual(f.calls, []);
});

test('presentation is limited to immediate public YouTube on the selected provider', async t => {
  const f = await fixture(t);
  const extra = presentationInput();
  for (const platform of ['facebook', 'tiktok', 'kwai']) {
    await assert.rejects(enqueue(f, { ...extra, platform, privacy: platform === 'kwai' ? 'private' : 'public' }));
    await assert.rejects(f.publisher.preflight(input(f, { ...extra, platform })));
  }
  for (const privacy of ['private', 'unlisted']) await assert.rejects(f.publisher.publishYouTube(input(f, { ...extra, privacy })));
  await assert.rejects(f.publisher.publishYouTube(input(f, { ...extra, publishAt: new Date(Date.now() + 3_600_000).toISOString() })));
  f.env.YTFUN_YOUTUBE_ZERNIO_PUBLISH_ENABLED = 'false';
  await assert.rejects(f.publisher.publishYouTube(input(f, extra)));
  assert.deepEqual(f.calls, []);
  await assertSharedState(f);
});

test('queued duplicates retain the original presentation rather than authorizing a different description', async t => {
  const f = await fixture(t);
  const original = (await enqueue(f, presentationInput())).delivery;
  const alternative = { ...PRESENTATION, description: 'Another valid description for the same reviewed binary.' };
  const duplicate = await enqueue(f, presentationInput(alternative));
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.delivery.id, original.id);
  assertPresentation(duplicate.delivery);
  assert.equal((await f.queue.list()).filter(delivery => delivery.platform === 'youtube').length, 1);
  assert.deepEqual(f.calls, []);
});

test('a running delivery rejects a different valid presentation before reserving or transferring media', async t => {
  const f = await fixture(t);
  const original = (await enqueue(f, presentationInput())).delivery;
  await f.store.transaction(state => { state.deliveries.find(item => item.id === original.id).status = 'running'; });
  const alternative = { ...PRESENTATION, title: 'Another title for the same binary' };
  await assert.rejects(f.publisher.publishYouTube(input(f, { ...presentationInput(alternative), deliveryId: original.id })));
  assert.equal(mutationCalls(f).length, 0);
  assert.equal((await f.store.read()).publications.filter(item => item.platform === 'youtube').length, 0);
  assertPresentation((await f.queue.list()).find(item => item.id === original.id));
  await assertSharedState(f);
});

test('presentation changed after claim is rejected atomically at reservation, even with a newly valid digest', async t => {
  for (const whitespaceOnly of [false, true]) {
    const f = await fixture(t);
    const original = (await enqueue(f, presentationInput())).delivery;
    let changed = false;
    f.hooks.verifyAccount = async () => {
      if (changed) return; changed = true;
      await f.store.transaction(state => {
        const delivery = state.deliveries.find(item => item.id === original.id);
        delivery.youtubeMetadata.title = whitespaceOnly ? ` ${PRESENTATION.title} ` : 'Changed while the claimed delivery was awaiting account verification';
        delivery.youtubeMetadataSha256 = youtubeMetadataHash(delivery.youtubeMetadata);
      });
    };
    const result = await f.queue.runDue({ execute: true, platform: 'youtube', expectedDeliveryId: original.id });
    assert.equal(changed, true); assert.equal(result.delivery.status, 'attention');
    assert.equal(mutationCalls(f).length, 0);
    assert.equal((await f.store.read()).publications.filter(item => item.platform === 'youtube').length, 0);
    assert.equal((await f.queue.runDue({ execute: true, platform: 'youtube' })).idle, true);
    await assertSharedState(f);
  }
});

test('malformed persisted snapshots are rejected before claiming a queued delivery', async t => {
  for (const mutate of [
    delivery => { delete delivery.youtubeMetadataSha256; },
    delivery => { delete delivery.youtubeMetadata; },
    delivery => { delivery.youtubeMetadataSha256 = '0'.repeat(64); },
    delivery => { delivery.youtubeMetadata.title = ` ${PRESENTATION.title} `; },
    delivery => { delivery.youtubeMetadata.extra = 'unbound persisted field'; },
  ]) {
    const f = await fixture(t); const queued = (await enqueue(f, presentationInput())).delivery;
    await f.store.transaction(state => { mutate(state.deliveries.find(item => item.id === queued.id)); });
    await assert.rejects(f.queue.runDue({ execute: true, platform: 'youtube', expectedDeliveryId: queued.id }));
    assert.equal((await f.queue.list()).find(item => item.id === queued.id).status, 'queued');
    assert.deepEqual(f.calls, []);
    assert.equal((await f.store.read()).publications.filter(item => item.platform === 'youtube').length, 0);
    await assertSharedState(f);
  }
});

test('expected metadata digest is bound to the exact YouTube delivery before execution', async t => {
  const f = await fixture(t); const queued = (await enqueue(f, presentationInput())).delivery;
  const dispatch = { execute: true, platform: 'youtube', expectedDeliveryId: queued.id };
  const wrong = await f.queue.runDue({ ...dispatch, youtubeMetadataSha256: '0'.repeat(64) });
  assert.equal(wrong.blocked, true);
  assert.equal((await f.queue.list()).find(item => item.id === queued.id).status, 'queued');
  for (const incomplete of [
    { execute: true, youtubeMetadataSha256: queued.youtubeMetadataSha256 },
    { ...dispatch, platform: 'facebook', youtubeMetadataSha256: queued.youtubeMetadataSha256 },
    { ...dispatch, youtubeMetadataSha256: 'invalid' },
  ]) await assert.rejects(f.queue.runDue(incomplete));
  assert.deepEqual(f.calls, []);
  const completed = await f.queue.runDue({ ...dispatch, youtubeMetadataSha256: queued.youtubeMetadataSha256 });
  assert.equal(completed.delivery.status, 'completed'); assertPresentation(f.reserved[0]);
});

test('a valid presentation swapped between candidate read and atomic claim cannot be dispatched as the old snapshot', async t => {
  const f = await fixture(t); const queued = (await enqueue(f, presentationInput())).delivery;
  const replacement = { ...PRESENTATION, description: 'A different valid presentation won the metadata race.' };
  const originalTransaction = f.store.transaction.bind(f.store); let swapped = false;
  f.store.transaction = async operation => {
    if (!swapped) {
      swapped = true;
      await originalTransaction(state => {
        Object.assign(state.deliveries.find(item => item.id === queued.id), presentationInput(replacement));
      });
    }
    return originalTransaction(operation);
  };
  const result = await f.queue.runDue({ execute: true, platform: 'youtube', expectedDeliveryId: queued.id,
    youtubeMetadataSha256: queued.youtubeMetadataSha256 });
  assert.equal(result.contended, true); assert.equal(swapped, true);
  const current = (await f.queue.list()).find(item => item.id === queued.id);
  assert.equal(current.status, 'queued'); assertPresentation(current, replacement);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.store.read()).publications.filter(item => item.platform === 'youtube').length, 0);
  await assertSharedState(f);
});

test('unknown receipt preserves the presentation and public GET reconciliation cannot replay the provider mutation', async t => {
  const f = await fixture(t);
  const delivery = (await enqueue(f, presentationInput())).delivery;
  const dispatched = await f.queue.runDue({ execute: true, platform: 'youtube', expectedDeliveryId: delivery.id });
  const publicationId = dispatched.delivery.publicationId;
  f.setStatusUnavailable(true);
  const unknown = await f.publisher.syncPublication({ publicationId });
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.providerPostId, POST); assertPresentation(unknown);
  const beforeDuplicate = f.calls.length;
  const alternative = { ...PRESENTATION, title: 'A replacement presentation must not trigger another upload' };
  const duplicate = await f.publisher.publishYouTube(input(f, presentationInput(alternative)));
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.publication.id, publicationId); assertPresentation(duplicate.publication);
  assert.equal(f.calls.length, beforeDuplicate);
  f.setStatusUnavailable(false);
  const reconciliationStart = f.calls.length;
  const published = await f.publisher.syncPublication({ publicationId });
  assert.equal(published.status, 'published'); assert.equal(published.providerPrivacyStatus, 'public'); assertPresentation(published);
  assert.equal(published.videoId, VIDEO);
  assert.deepEqual(f.nativeCalls, [{ videoId: VIDEO, channelId: CHANNEL }]);
  assert.ok(f.calls.slice(reconciliationStart).every(call => call.method === 'GET'));
  assert.equal(mutationCalls(f).length, 3);
  assert.equal((await f.queue.runDue({ execute: true, platform: 'youtube' })).idle, true);
  assert.ok(!JSON.stringify(await f.store.read()).includes(TOKEN));
  await assertSharedState(f);
});

test('queue reconciliation rejects another valid presentation on an otherwise exact provider receipt', async t => {
  const f = await fixture(t); const queued = (await enqueue(f, presentationInput())).delivery;
  const result = await f.queue.runDue({ execute: true, platform: 'youtube', expectedDeliveryId: queued.id });
  const changed = { ...PRESENTATION, tags: ['a different valid presentation'] };
  await f.store.transaction(state => {
    state.deliveries.find(item => item.id === queued.id).status = 'attention';
    Object.assign(state.publications.find(item => item.id === result.delivery.publicationId), presentationInput(changed));
  });
  const callsBefore = f.calls.length;
  await assert.rejects(f.queue.reconcile({ deliveryId: queued.id, workerStopped: true,
    confirmedBy: 'CI fixture operator', evidence: 'Simulated stopped worker with exact provider ID but changed presentation.' }), /metadata snapshot/);
  assert.equal((await f.queue.list()).find(item => item.id === queued.id).status, 'attention');
  assert.equal(f.calls.length, callsBefore);
  assertPresentation((await f.store.read()).publications.find(item => item.id === result.delivery.publicationId), changed);
  await assertSharedState(f);
});

test('a coherent presentation replacement during public GET cannot confirm a different persisted snapshot', async t => {
  const f = await fixture(t);
  const original = (await f.publisher.publishYouTube(input(f, presentationInput()))).publication;
  const replacement = { ...PRESENTATION, description: 'A different valid snapshot replaced the reserved metadata during GET.' };
  let replaced;
  f.hooks.getPost = async () => {
    await f.store.transaction(state => {
      const publication = state.publications.find(item => item.id === original.id);
      Object.assign(publication, presentationInput(replacement));
      replaced = structuredClone(publication);
    });
  };
  const beforeGET = f.calls.length;
  await assert.rejects(f.publisher.syncPublication({ publicationId: original.id }), /metadata snapshot changed/);
  const current = (await f.store.read()).publications.find(item => item.id === original.id);
  assert.deepEqual(current, replaced, 'GET evidence for the old snapshot cannot overwrite or confirm the replacement');
  assert.equal(current.status, 'processing'); assert.equal(current.providerPostId, original.providerPostId);
  assert.equal(current.reviewHash, original.reviewHash); assert.equal(current.renderSha256, original.renderSha256);
  assertPresentation(current, replacement);
  assert.ok(f.calls.slice(beforeGET).every(call => call.method === 'GET'));
  assert.equal(mutationCalls(f).length, 3);
  await assertSharedState(f);
});

test('purging YouTube API data preserves the local presentation evidence and the original no-replay reservation', async t => {
  const f = await fixture(t);
  const queued = (await enqueue(f, presentationInput())).delivery;
  const dispatched = await f.queue.runDue({ execute: true, platform: 'youtube', expectedDeliveryId: queued.id });
  const sent = (await f.store.read()).publications.find(item => item.id === dispatched.delivery.publicationId);
  const confirmed = await f.publisher.syncPublication({ publicationId: sent.id });
  assert.equal(confirmed.status, 'published'); assert.equal(confirmed.providerPostId, POST);
  const counts = await f.store.transaction(state => purgeYouTubeData(state, { now: Date.now(), all: true }));
  assert.equal(counts.publications, 1); assert.equal(counts.deliveries, 1);
  const retained = (await f.store.read()).publications.find(item => item.id === sent.id);
  assert.equal(retained.status, 'unknown'); assert.equal(retained.localOnly, true);
  assert.equal(retained.blockReason, 'youtube_api_data_removed'); assertPresentation(retained);
  assert.equal(retained.episodeId, sent.episodeId); assert.equal(retained.reviewHash, sent.reviewHash);
  assert.equal(retained.renderSha256, sent.renderSha256);
  for (const field of ['accountId', 'providerAccountId', 'providerPostId', 'videoId', 'url', 'apiData', 'route']) {
    assert.equal(Object.hasOwn(retained, field), false, `Provider field ${field} must be removed`);
  }
  const retainedDelivery = (await f.queue.list()).find(item => item.id === queued.id);
  assert.equal(retainedDelivery.status, 'attention'); assert.equal(retainedDelivery.localOnly, true);
  assert.equal(retainedDelivery.blockReason, 'youtube_api_data_removed'); assertPresentation(retainedDelivery);
  assert.equal(retainedDelivery.publicationId, sent.id);
  assert.equal(retainedDelivery.reviewHash, queued.reviewHash); assert.equal(retainedDelivery.renderSha256, queued.renderSha256);
  const beforeDuplicate = f.calls.length;
  const duplicate = await f.publisher.publishYouTube(input(f, presentationInput()));
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.publication, retained);
  assert.equal(f.calls.length, beforeDuplicate);
  assert.equal(mutationCalls(f).length, 3);
  assert.equal((await f.queue.runDue({ execute: true, platform: 'youtube' })).idle, true);
  await assertSharedState(f);
});

test('a legacy unknown YouTube reservation blocks a new presentation without modifying or replaying its receipt', async t => {
  const f = await fixture(t);
  const unknown = { id: randomUUID(), episodeId: f.episode.id, projectId: f.episode.projectId,
    platform: 'youtube', accountId: CHANNEL, status: 'unknown', privacy: 'public',
    reviewHash: f.episode.approval.reviewHash, renderSha256: f.episode.render.sha256,
    effectiveAt: f.dueAt, createdAt: f.dueAt, videoId: VIDEO };
  await f.store.transaction(state => { state.publications.push(unknown); });
  const duplicate = await f.publisher.publishYouTube(input(f, presentationInput()));
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.publication, unknown);
  assert.deepEqual((await f.store.read()).publications.find(item => item.id === unknown.id), unknown);
  assert.deepEqual(f.calls, []);
  await assertSharedState(f);
});

test('legacy delivery without a presentation keeps episode metadata and does not inject snapshot fields', async t => {
  const f = await fixture(t);
  const queued = (await enqueue(f)).delivery;
  assert.equal(Object.hasOwn(queued, 'youtubeMetadata'), false);
  assert.equal(Object.hasOwn(queued, 'youtubeMetadataSha256'), false);
  const result = await f.queue.runDue({ execute: true, platform: 'youtube', expectedDeliveryId: queued.id });
  assert.equal(result.delivery.status, 'completed');
  const body = createBody(f);
  assert.equal(body.platforms[0].platformSpecificData.title, f.episode.title);
  assert.equal(body.content, `${f.episode.metadata.description}\n\n#AIMeow`);
  assert.deepEqual(body.tags, f.episode.metadata.tags);
  const publication = (await f.store.read()).publications.find(item => item.id === result.delivery.publicationId);
  assert.equal(Object.hasOwn(publication, 'youtubeMetadata'), false);
  assert.equal(Object.hasOwn(publication, 'youtubeMetadataSha256'), false);
  await assertSharedState(f);
});
