import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { episodeAssetHash, episodeReviewHash } from '../src/domain.mjs';
import { Publisher } from '../src/publishing.mjs';
import { DeliveryQueue } from '../src/delivery-queue.mjs';
import { StudioStore } from '../src/store.mjs';
import { purgeYouTubeData } from '../src/youtube-data-policy.mjs';
import { normalizePublicationMetadata, publicationMetadataHash, publicationMetadataSnapshot,
  publicationMetadataBindingsMatch, youtubeMetadataHash } from '../src/publication-metadata.mjs';
import { ownerAcceptedTechnicalReview, technicalReviewEnv } from './technical-review-fixture.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const ACCOUNT = { youtube: 'UCmetadataFixture', facebook: '123456', tiktok: '7474661840611197969' };
const PROVIDER = '66b2e19d8c3f5a7e9d0b1c2d';
const BINDING = 'b'.repeat(64), AUTHORITY = 'a'.repeat(64);
const settings = { allow_comment: true, allow_duet: false, allow_stitch: false };
const metadata = platform => ({ title: `${platform} presentation`, description: `Original AI-made fiction for ${platform}.`, hashtags: ['#AIMeow'], tags: ['AI animation'] });
const snapshot = (platform, value = metadata(platform)) => ({ publicationMetadata: value, publicationMetadataSha256: publicationMetadataHash(value, platform) });

test('network metadata is complete, canonical, platform-bound and cannot carry unreviewed provider controls', () => {
  const normalized = normalizePublicationMetadata({ title: ' Hello ', description: ' World ', hashtags: [' #AIMeow '], tags: [' AI animation '] }, 'youtube');
  assert.deepEqual(normalized, { title: 'Hello', description: 'World', hashtags: ['#AIMeow'], tags: ['AI animation'] });
  assert.notEqual(publicationMetadataHash(normalized, 'youtube'), publicationMetadataHash(normalized, 'facebook'));
  for (const value of [{ ...normalized, synthetic: false }, { ...normalized, privacy: 'private' }, { ...normalized, hashtags: undefined },
    { ...normalized, title: 'unsafe\nname' }, { ...normalized, hashtags: ['ordinary text'] }, { ...normalized, tags: ['x'.repeat(101)] }]) {
    assert.throws(() => normalizePublicationMetadata(value, 'youtube'));
  }
  assert.throws(() => publicationMetadataSnapshot({ publicationMetadata: normalized }, 'youtube'), /SHA256/);
  assert.throws(() => publicationMetadataSnapshot({ ...snapshot('youtube', normalized), publicationMetadataSha256: '0'.repeat(64) }, 'youtube'), /does not match/);
  assert.throws(() => publicationMetadataSnapshot(snapshot('youtube', normalized), 'facebook'), /does not match/);
  assert.throws(() => publicationMetadataSnapshot(snapshot('youtube', { ...normalized, title: ' Hello ' }), 'youtube', { requireCanonical: true }), /normalized/);
  for (const platform of ['youtube', 'facebook', 'tiktok']) {
    assert.throws(() => normalizePublicationMetadata({ ...normalized, description: 'x'.repeat(5001) }, platform));
  }
  assert.throws(() => normalizePublicationMetadata({ ...normalized, description: 'é'.repeat(2600) }, 'youtube'), /UTF-8/);
  assert.equal(normalizePublicationMetadata({ ...normalized, description: '', hashtags: [] }, 'youtube').description, '');
});

test('legacy YouTube metadata retains its exact prior digest and never becomes another network snapshot', () => {
  const legacy = { title: 'Legacy presentation', description: 'Already selected description. #AIMeow', tags: ['AI animation'] };
  const claim = { youtubeMetadata: legacy, youtubeMetadataSha256: youtubeMetadataHash(legacy) };
  const expected = snapshot('youtube', { ...legacy, hashtags: [] });
  assert.deepEqual(publicationMetadataSnapshot(claim, 'youtube', { requireCanonical: true }), expected);
  assert.equal(publicationMetadataBindingsMatch(claim, expected, 'youtube'), true);
  assert.equal(claim.youtubeMetadataSha256, youtubeMetadataHash(legacy));
  assert.throws(() => publicationMetadataSnapshot(claim, 'tiktok'), /another network/);
  assert.throws(() => publicationMetadataSnapshot({ ...claim, ...expected }, 'youtube'), /cannot be mixed/);
  assert.throws(() => publicationMetadataSnapshot({ ...claim, youtubeMetadataSha256: 'c'.repeat(64) }, 'youtube'), /does not match/);
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ytfun-network-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'assets'));
  const files = { 'render.mp4': Buffer.from('exact original final CI media'), 'visual.png': Buffer.from('original visual'), 'audio.wav': Buffer.from('original sound') };
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(directory, 'assets', name), value);
  const store = new StudioStore(directory);
  const assets = ['visual', 'audio'].map(kind => ({ id: kind, episodeId: 'episode', sceneId: 'scene', kind: kind === 'visual' ? 'image' : 'audio',
    path: `assets/${kind === 'visual' ? 'visual.png' : 'audio.wav'}`, sha256: digest(files[kind === 'visual' ? 'visual.png' : 'audio.wav']), synthetic: true,
    provenance: { provider: 'CI fixture', model: 'original fixture', prompt: 'Original fictional scene.', commercialLicense: { url: 'https://example.com/fixture-license', notes: 'Retained fixture commercial rights.' } } }));
  const episode = { id: 'episode', projectId: 'project', format: 'short', audioMode: 'nonverbal', title: 'Shared editorial title', hook: 'Original reveal.',
    synopsis: 'Original complete visual story.', originalAngle: 'Original unexpected interior.', metadata: { description: 'Shared original description.', hashtags: ['#AIMeow'] },
    scenes: [{ id: 'scene', durationSeconds: 15, narration: '', visualPrompt: 'One complete original transformation.', soundPrompt: 'Original nonverbal effects.' }],
    render: { path: 'assets/render.mp4', sha256: digest(files['render.mp4']), durationSeconds: 15, width: 1080, height: 1920, framesPerSecond: 24,
      format: 'mp4', synthetic: true, audioMode: 'nonverbal', hasAudio: true, sceneAssets: [{ sceneId: 'scene', visualAssetId: 'visual', audioAssetId: 'audio' }] }, status: 'approved' };
  episode.approval = { reviewHash: episodeReviewHash(episode), assetReviewHash: episodeAssetHash(episode, assets), approvedAt: new Date().toISOString(),
    review: { originalityChecked: true, factsChecked: true, renderWatched: true, reviewedBy: 'CI fixture reviewer', notes: 'Only fixture evidence, not production playback.' } };
  await store.transaction(state => { state.projects.push({ id: 'project', status: 'active', mode: 'fiction', cadence: { minHoursBetweenPosts: 0, maxPostsPerRollingDay: null } }); state.episodes.push(episode); state.assets.push(...assets); });
  const env = { YOUTUBE_CHANNEL_ID: ACCOUNT.youtube, FACEBOOK_PAGE_ID: ACCOUNT.facebook, TIKTOK_ACCOUNT_ID: ACCOUNT.tiktok, TIKTOK_ACCOUNT_HANDLE: 'ai._.meow',
    ZERNIO_YOUTUBE_ACCOUNT_ID: PROVIDER, ZERNIO_TIKTOK_ACCOUNT_ID: PROVIDER, YTFUN_YOUTUBE_ZERNIO_PUBLISH_ENABLED: 'true', YTFUN_TIKTOK_ZERNIO_PUBLISH_ENABLED: 'true',
    YTFUN_TIKTOK_STANDING_AUTHORITY_SHA256: AUTHORITY, ZERNIO_YOUTUBE_BINDING_JSON: JSON.stringify({ evidenceSha256: BINDING }), ZERNIO_TIKTOK_BINDING_JSON: JSON.stringify({ evidenceSha256: BINDING }) };
  const sent = [], adapter = platform => ({
    readiness: () => ({ ready: true, reasons: [], accountId: ACCOUNT[platform], providerAccountId: PROVIDER, bindingSha256: BINDING, standingAuthoritySha256: AUTHORITY, maxDurationSeconds: 600 }),
    verifyAccount: async () => ({ accountId: ACCOUNT[platform], providerAccountId: PROVIDER, maxDurationSeconds: 600 }),
    upload: async input => {
      sent.push({ platform, title: input.title, caption: input.caption, tags: input.tags, renderSha256: input.render?.sha256, synthetic: input.synthetic });
      if (platform === 'facebook') return { videoId: '123456789', status: 'processing' };
      const receipt = { route: 'zernio', publicationId: input.publicationId, accountId: ACCOUNT[platform], providerAccountId: PROVIDER,
        renderSha256: episode.render.sha256, providerPostId: '65f1c0a9e2b5af0012ab34cd', status: 'processing', phase: 'post', confirmed: false };
      await input.onReceipt(receipt); return receipt;
    },
  });
  const youtubeZernio = adapter('youtube'), tiktokZernio = adapter('tiktok'), facebook = adapter('facebook');
  const publisher = new Publisher(store, { env, youtubeZernio, tiktokZernio, facebook, fetchImpl: () => { assert.fail('No provider network in CI fixtures.'); } });
  const consent = { renderSha256: episode.render.sha256, contentPreviewConfirmed: true, expressConsentGiven: true, previewWitness: 'authorized_agent',
    consentSource: 'owner_standing_authority', previewActorId: 'codex:01a0fb03-ce6a-7820-a7d4-cee666e81c7c', previewMethod: 'visual_playback',
    authorityEvidenceSha256: AUTHORITY, evidenceSha256: 'd'.repeat(64), recordedAt: new Date().toISOString() };
  return { directory, store, episode, assets, publisher, env, sent, consent, youtubeZernio, tiktokZernio, facebook };
}

const request = (f, platform, extra = {}) => ({ episodeId: f.episode.id, platform, privacy: 'public', expectedReviewHash: f.episode.approval.reviewHash,
  execute: true, ...(platform === 'youtube' ? { madeForKids: false } : {}), ...extra });
const publish = (f, platform, input) => f.publisher[{ youtube: 'publishYouTube', facebook: 'publishFacebook', tiktok: 'publishTikTok' }[platform]](input);

test('one approved final has independent copy and hashtags on all three networks without changing shared evidence', async t => {
  const f = await fixture(t), before = structuredClone(f.episode);
  for (const platform of ['facebook', 'youtube', 'tiktok']) {
    const binding = snapshot(platform), input = request(f, platform, binding);
    if (platform === 'tiktok') await f.publisher.recordTikTokZernioConsent({ episodeId: f.episode.id, expectedReviewHash: before.approval.reviewHash,
      attestation: f.consent, interactionSettings: settings, ...binding });
    assert.equal((await f.publisher.preflight(input)).ready, true);
    const result = await publish(f, platform, input);
    assert.equal(result.publication.status, 'processing');
    assert.equal(result.publication.publicationMetadataSha256, binding.publicationMetadataSha256);
    assert.deepEqual(result.publication.publicationMetadata, binding.publicationMetadata);
    assert.equal(result.publication.reviewHash, before.approval.reviewHash);
    assert.equal(result.publication.renderSha256, before.render.sha256);
    const transmitted = f.sent.find(item => item.platform === platform);
    assert.equal(transmitted.caption, platform === 'youtube' ? `${metadata(platform).description}\n\n#AIMeow` : `${metadata(platform).title}\n\n${metadata(platform).description}\n\n#AIMeow`);
    if (platform === 'facebook') assert.equal(transmitted.synthetic, true);
    const current = (await f.store.read()).episodes[0];
    assert.deepEqual(current.metadata, before.metadata); assert.deepEqual(current.approval, before.approval);
    assert.equal(episodeReviewHash(current), before.approval.reviewHash);
  }
  assert.equal((await f.store.read()).publications.length, 3);
});

test('TikTok exact preview also binds network copy; old default preview cannot authorize an altered caption', async t => {
  const f = await fixture(t);
  const base = { episodeId: f.episode.id, expectedReviewHash: f.episode.approval.reviewHash, attestation: f.consent, interactionSettings: settings };
  await f.publisher.recordTikTokZernioConsent(base);
  assert.equal((await f.publisher.preflight(request(f, 'tiktok'))).ready, true);
  const custom = snapshot('tiktok');
  assert.equal((await f.publisher.preflight(request(f, 'tiktok', custom))).ready, false);
  await f.publisher.recordTikTokZernioConsent({ ...base, ...custom });
  assert.equal((await f.publisher.preflight(request(f, 'tiktok', custom))).ready, true);
  const changed = snapshot('tiktok', { ...metadata('tiktok'), title: 'Another presentation' });
  assert.equal((await f.publisher.preflight(request(f, 'tiktok', changed))).ready, false);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.store.read()).zernioConsents.length, 2);
});

test('queue persists exact network metadata through recreation, rescheduling and delivery', async t => {
  for (const platform of ['facebook', 'youtube', 'tiktok']) {
    const f = await fixture(t), binding = snapshot(platform);
    if (platform === 'tiktok') await f.publisher.recordTikTokZernioConsent({ episodeId: f.episode.id, expectedReviewHash: f.episode.approval.reviewHash, attestation: f.consent, interactionSettings: settings, ...binding });
    const now = Date.now(), queue = new DeliveryQueue(f.store, f.publisher, { now: () => now });
    const args = { ...request(f, platform, binding), dueAt: new Date(now).toISOString() };
    const queued = (await queue.enqueue(args)).delivery;
    assert.equal((await queue.enqueue(args)).duplicate, true);
    await assert.rejects(queue.enqueue({ ...args, ...snapshot(platform, { ...metadata(platform), title: 'Changed queued copy' }) }), /different metadata/);
    const recreated = new DeliveryQueue(f.store, f.publisher, { now: () => now });
    const expectedClaim = Object.fromEntries(['dueAt', 'platform', 'privacy', 'madeForKids', 'reviewHash', 'renderSha256', 'accountId', 'mode', 'providerAccountId', 'bindingSha256']
      .map(key => [key, ['madeForKids', 'providerAccountId', 'bindingSha256'].includes(key) ? queued[key] ?? null : queued[key]]));
    await assert.rejects(recreated.rescheduleUnstarted({ deliveryId: queued.id, expectedClaim, dueAt: queued.dueAt, reason: 'Missing snapshot must not bind another presentation.' }), /metadata changed/);
    await recreated.rescheduleUnstarted({ deliveryId: queued.id, expectedClaim: { ...expectedClaim, ...binding }, dueAt: queued.dueAt, reason: 'Preserve the exact account presentation.' });
    const completed = await recreated.runDue({ execute: true, platform, expectedDeliveryId: queued.id, publicationMetadataSha256: binding.publicationMetadataSha256 });
    assert.equal(completed.delivery.status, 'completed');
    const receipt = (await f.store.read()).publications[0];
    assert.equal(receipt.publicationMetadataSha256, queued.publicationMetadataSha256);
    assert.deepEqual(receipt.publicationMetadata, queued.publicationMetadata);
    assert.equal((await recreated.runDue({ execute: true, platform })).idle, true);
    assert.equal(f.sent.length, 1);
  }
});

test('an already queued legacy YouTube snapshot executes without dropping copy or rewriting its original claim', async t => {
  const f = await fixture(t), now = Date.now(), queue = new DeliveryQueue(f.store, f.publisher, { now: () => now });
  const legacy = { title: 'Legacy chosen title', description: 'Legacy complete caption. #AIMeow', tags: ['AI animation'] };
  const aliases = { youtubeMetadata: legacy, youtubeMetadataSha256: youtubeMetadataHash(legacy) };
  const queued = (await queue.enqueue({ ...request(f, 'youtube', aliases), dueAt: new Date(now).toISOString() })).delivery;
  await f.store.transaction(state => {
    const item = state.deliveries.find(delivery => delivery.id === queued.id);
    delete item.publicationMetadata; delete item.publicationMetadataSha256;
    Object.assign(item, aliases);
  });
  const result = await queue.runDue({ execute: true, platform: 'youtube', expectedDeliveryId: queued.id });
  assert.equal(result.delivery.status, 'completed');
  assert.deepEqual(result.delivery.youtubeMetadata, legacy);
  assert.equal(result.delivery.youtubeMetadataSha256, aliases.youtubeMetadataSha256);
  assert.equal(result.delivery.publicationMetadata, undefined);
  assert.equal(f.sent[0].title, legacy.title); assert.equal(f.sent[0].caption, legacy.description);
});

test('the private TikTok REST experiment carries the same immutable public caption snapshot', async t => {
  const f = await fixture(t); f.env.YTFUN_TIKTOK_ZERNIO_PUBLISH_ENABLED = 'false';
  const inputs = [], tiktok = { readiness: () => ({ ready: true, reasons: [], accountId: ACCOUNT.tiktok }),
    verifyAccount: async () => ({ accountId: ACCOUNT.tiktok, maxDurationSeconds: 180 }),
    upload: async input => { inputs.push(input); return { creationId: 'fixture-creation-12345', status: 'unknown', phase: 'post' }; } };
  const publisher = new Publisher(f.store, { env: f.env, tiktok });
  const result = await publisher.publishTikTok(request(f, 'tiktok', snapshot('tiktok')));
  assert.equal(result.publication.status, 'unknown'); assert.equal(result.publication.route, 'experimental_session_rest');
  assert.equal(result.publication.publicationMetadataSha256, snapshot('tiktok').publicationMetadataSha256);
  assert.equal(inputs[0].caption, 'tiktok presentation\n\nOriginal AI-made fiction for tiktok.\n\n#AIMeow');
  assert.equal((await publisher.publishTikTok(request(f, 'tiktok', snapshot('tiktok')))).duplicate, true);
  assert.equal(inputs.length, 1);
});

test('invalid metadata, unsupported visibility and changed hashes fail before provider activity', async t => {
  for (const platform of ['facebook', 'youtube', 'tiktok']) {
    const f = await fixture(t), binding = snapshot(platform);
    await assert.rejects(publish(f, platform, request(f, platform, { ...binding, publicationMetadataSha256: '0'.repeat(64) })), /does not match/);
    await assert.rejects(publish(f, platform, request(f, platform, { ...binding, privacy: 'private' })), /PUBLIC/);
    await writeFile(path.join(f.directory, 'assets/render.mp4'), 'modified media');
    await assert.rejects(publish(f, platform, request(f, platform, binding)));
    assert.deepEqual(f.sent, []); assert.deepEqual((await f.store.read()).publications, []);
  }
});

test('same bytes or source composition cannot be reposted under another episode on the same account', async t => {
  const f = await fixture(t);
  await f.publisher.publishFacebook(request(f, 'facebook', snapshot('facebook')));
  await f.store.transaction(state => {
    const duplicate = structuredClone(state.episodes[0]);
    duplicate.id = 'another-episode'; duplicate.title = 'Different title does not create content';
    const copied = state.assets.map(asset => ({ ...structuredClone(asset), id: `copy-${asset.id}`, episodeId: duplicate.id }));
    duplicate.render.sceneAssets = [{ sceneId: 'scene', visualAssetId: 'copy-visual', audioAssetId: 'copy-audio' }];
    duplicate.approval.reviewHash = episodeReviewHash(duplicate);
    duplicate.approval.assetReviewHash = episodeAssetHash(duplicate, copied);
    state.assets.push(...copied); state.episodes.push(duplicate);
  });
  const same = await f.publisher.preflight({ episodeId: 'another-episode', platform: 'facebook', privacy: 'public', ...snapshot('facebook') });
  assert.ok(same.reasons.some(reason => reason.includes('exact media already')));
  assert.ok(same.reasons.some(reason => reason.includes('source composition already')));
  const reencoded = Buffer.from('same editorial composition in a different encoding');
  await writeFile(path.join(f.directory, 'assets/reencoded.mp4'), reencoded);
  await f.store.transaction(state => {
    const copy = state.episodes.find(item => item.id === 'another-episode');
    copy.render.path = 'assets/reencoded.mp4'; copy.render.sha256 = digest(reencoded);
    copy.approval.reviewHash = episodeReviewHash(copy);
  });
  const differentBytes = await f.publisher.preflight({ episodeId: 'another-episode', platform: 'facebook', privacy: 'public', ...snapshot('facebook') });
  assert.ok(differentBytes.reasons.every(reason => !reason.includes('exact media already')));
  assert.ok(differentBytes.reasons.some(reason => reason.includes('source composition already')));
  assert.equal((await f.publisher.preflight({ episodeId: 'another-episode', platform: 'youtube', privacy: 'public', ...snapshot('youtube') })).ready, true);
});

test('caller mutation during account verification cannot replace the bound network presentation', async t => {
  const f = await fixture(t), input = request(f, 'facebook', snapshot('facebook'));
  f.facebook.verifyAccount = async () => { input.publicationMetadata.title = 'Changed while awaiting verification'; return { accountId: ACCOUNT.facebook }; };
  const result = await f.publisher.publishFacebook(input);
  assert.equal(result.publication.status, 'processing');
  assert.equal(result.publication.publicationMetadata.title, 'facebook presentation');
  assert.ok(f.sent[0].caption.startsWith('facebook presentation\n\n'));
});

test('a changed reserved snapshot is not accepted as the original provider receipt or retried', async t => {
  const f = await fixture(t), original = f.youtubeZernio.upload;
  f.youtubeZernio.upload = async input => {
    await f.store.transaction(state => Object.assign(state.publications.find(item => item.id === input.publicationId),
      snapshot('youtube', { ...metadata('youtube'), title: 'A different reserved title' })));
    return original(input);
  };
  const input = request(f, 'youtube', snapshot('youtube'));
  const result = await f.publisher.publishYouTube(input);
  assert.equal(result.publication.status, 'unknown');
  assert.equal(result.publication.providerPostId, undefined);
  assert.equal((await f.publisher.publishYouTube(input)).duplicate, true);
  assert.equal(f.sent.length, 1);
});

test('data maintenance preserves locally authored presentation and dedup evidence without keeping API account data', async t => {
  const f = await fixture(t), result = await f.publisher.publishYouTube(request(f, 'youtube', snapshot('youtube')));
  await f.store.transaction(state => purgeYouTubeData(state, { all: true }));
  const local = (await f.store.read()).publications[0];
  assert.equal(local.localOnly, true); assert.equal(local.accountId, undefined); assert.equal(local.providerPostId, undefined);
  assert.deepEqual(local.publicationMetadata, result.publication.publicationMetadata);
  assert.equal(local.publicationMetadataSha256, result.publication.publicationMetadataSha256);
  assert.equal(local.compositionSha256, result.publication.compositionSha256);
});

test('owner-accepted technical operation retains historical aesthetic rejections and costs while checking rights', async t => {
  const f = await fixture(t);
  Object.assign(f.env, technicalReviewEnv);
  await f.store.transaction(state => {
    state.assets[0].qualityReview = { decision: 'rejected', sha256: state.assets[0].sha256, findings: 'Old aesthetic rejection.' };
    state.spending.push({ id: 'retained-cost', assetId: state.assets[0].id, episodeId: f.episode.id, status: 'completed', estimatedCostUsd: 0.605 });
    state.episodes[0].approval.assetReviewHash = episodeAssetHash(state.episodes[0], state.assets);
    state.episodes[0].approval.review = ownerAcceptedTechnicalReview(state.episodes[0]);
  });
  assert.equal((await f.publisher.preflight(request(f, 'facebook', snapshot('facebook')))).ready, true);
  const disabled = new Publisher(f.store, { env: { ...f.env, YTFUN_OWNER_ACCEPTED_TECHNICAL_REVIEW_ENABLED: 'false' }, facebook: f.facebook });
  assert.equal((await disabled.preflight(request(f, 'facebook', snapshot('facebook')))).ready, false);
  await f.store.transaction(state => { state.assets[0].provenance.commercialLicense.notes = ''; state.episodes[0].approval.assetReviewHash = episodeAssetHash(state.episodes[0], state.assets); });
  assert.equal((await f.publisher.preflight(request(f, 'facebook', snapshot('facebook')))).ready, false);
  const state = await f.store.read();
  assert.equal(state.assets[0].qualityReview.decision, 'rejected'); assert.equal(state.spending[0].estimatedCostUsd, 0.605);
  assert.equal(f.sent.length, 0);
});
