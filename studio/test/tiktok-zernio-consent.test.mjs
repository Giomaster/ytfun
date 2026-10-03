import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { episodeAssetHash, episodeReviewHash } from '../src/domain.mjs';
import { Publisher } from '../src/publishing.mjs';
import { StudioStore } from '../src/store.mjs';
import { validateTikTokZernioAttestation, validateTikTokZernioAttestationShape } from '../src/tiktok-zernio-attestation.mjs';
import { ownerAcceptedTechnicalReview, technicalReviewEnv } from './technical-review-fixture.mjs';

const NATIVE = '7474661840611197969';
const PROVIDER = '6ac02d2440f29aa9fab0d6af';
const PROVIDER_POST = '65f1c0a9e2b5af0012ab34cd';
const BINDING = 'b'.repeat(64);
const AUTHORITY = 'a'.repeat(64);
const EVIDENCE = 'c'.repeat(64);
const ACTOR = 'codex:01a0fb03-ce6a-7820-a7d4-cee666e81c7c';
const KEY = `sk_${'e'.repeat(64)}`;
const sha = value => createHash('sha256').update(value).digest('hex');
const interactionSettings = { allow_comment: true, allow_duet: false, allow_stitch: false };

async function fixture(t, { enabled = true, technical = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ytfun-tiktok-preview-ci-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'assets'));
  const media = Buffer.from('original-ci-render; this is not an observed real owner video');
  const visual = Buffer.from('original-ci-visual');
  await writeFile(path.join(directory, 'assets/render.mp4'), media);
  await writeFile(path.join(directory, 'assets/visual.png'), visual);
  const store = new StudioStore(directory);
  const asset = { id: 'visual', episodeId: 'episode-preview', sceneId: 'scene', kind: 'image', path: 'assets/visual.png', sha256: sha(visual), synthetic: true,
    provenance: { provider: 'CI fixture', model: 'fixture', prompt: 'A new original reveal.', commercialLicense: { url: 'https://example.com/fixture-license', notes: 'Fixture rights evidence.' } } };
  const episode = { id: 'episode-preview', projectId: 'project', audioMode: 'silent', title: 'An impossible world unfolds',
    hook: 'An impossible miniature world opens.', synopsis: 'A single original complete reveal.', originalAngle: 'A surprising miniature living interior.',
    scenes: [{ id: 'scene', durationSeconds: 7.5, narration: '', visualPrompt: 'Original material reveal.' }], metadata: { description: 'Original synthetic fiction.', hashtags: ['#AIMeow'] },
    render: { path: 'assets/render.mp4', sha256: sha(media), durationSeconds: 7.5, width: 1080, height: 1920, format: 'mp4', synthetic: true,
      audioMode: 'silent', hasAudio: false, sceneAssets: [{ sceneId: 'scene', visualAssetId: 'visual' }] }, status: 'approved' };
  episode.approval = { reviewHash: episodeReviewHash(episode), assetReviewHash: episodeAssetHash(episode, [asset]), approvedAt: new Date().toISOString(),
    review: technical ? ownerAcceptedTechnicalReview(episode) : { originalityChecked: true, factsChecked: true, renderWatched: true, reviewedBy: 'CI fixture reviewer', notes: 'Only fixture observations; not a production preview claim.' } };
  await store.transaction(state => {
    state.projects.push({ id: 'project', status: 'active', mode: 'fiction', cadence: { minHoursBetweenPosts: 0, maxPostsPerRollingDay: null } });
    state.episodes.push(episode); state.assets.push(asset);
  });
  const binding = { providerAccountId: PROVIDER, nativeAccountId: NATIVE, handle: 'ai._.meow', evidenceSha256: BINDING,
    verifiedAt: new Date().toISOString(), source: 'owner_confirmed' };
  const env = { TIKTOK_ACCOUNT_ID: NATIVE, TIKTOK_ACCOUNT_HANDLE: binding.handle, ZERNIO_TIKTOK_ACCOUNT_ID: PROVIDER,
    ZERNIO_TIKTOK_BINDING_JSON: JSON.stringify(binding), ZERNIO_API_KEY: KEY, YTFUN_TIKTOK_ZERNIO_PUBLISH_ENABLED: 'true',
    ...(technical ? technicalReviewEnv : {}),
    ...(enabled ? { YTFUN_TIKTOK_STANDING_AUTHORITY_SHA256: AUTHORITY } : {}) };
  const adapterEnv = { ...env }, calls = [];
  const readiness = { ready: true, reasons: [], accountId: NATIVE, providerAccountId: PROVIDER, bindingSha256: BINDING,
    standingAuthoritySha256: enabled ? AUTHORITY : null, maxDurationSeconds: 600 };
  const adapter = {
    readiness: () => ({ ...readiness }),
    verifyAccount: async () => { calls.push('verify'); return { ...readiness }; },
    upload: async input => {
      calls.push('upload');
      assert.deepEqual(input.media, media);
      assert.equal(validateTikTokZernioAttestation(input.attestation, sha(media), { env: adapterEnv }), true);
      const publication = (await store.read()).publications.find(item => item.id === input.publicationId);
      assert.deepEqual(publication.consentEvidence, input.attestation);
      const receipt = { route: 'zernio', publicationId: input.publicationId, accountId: NATIVE, providerAccountId: PROVIDER, renderSha256: sha(media),
        providerPostId: PROVIDER_POST, phase: 'post', status: 'processing', confirmed: false };
      await input.onReceipt(receipt);
      return receipt;
    },
  };
  const publisher = new Publisher(store, { env, tiktokZernio: adapter, fetchImpl: async () => { throw new Error('No real provider calls in fixtures.'); } });
  const owner = { renderSha256: sha(media), contentPreviewConfirmed: true, expressConsentGiven: true, previewWitness: 'owner', consentSource: 'owner_explicit',
    evidenceSha256: EVIDENCE, recordedAt: new Date().toISOString() };
  const delegated = { ...owner, previewWitness: 'authorized_agent', consentSource: 'owner_standing_authority', previewActorId: ACTOR,
    previewMethod: 'visual_playback', authorityEvidenceSha256: AUTHORITY };
  return { directory, store, episode, env, publisher, adapter, readiness, calls, owner, delegated };
}

const record = (f, extra = {}) => f.publisher.recordTikTokZernioConsent({ episodeId: f.episode.id, expectedReviewHash: f.episode.approval.reviewHash,
  attestation: f.delegated, interactionSettings, ...extra });
const request = f => ({ episodeId: f.episode.id, platform: 'tiktok', privacy: 'public', expectedReviewHash: f.episode.approval.reviewHash, execute: true });

test('real delegated preview records its actor and authority; public publication retains the evidence without implying owner playback', async t => {
  const f = await fixture(t, { technical: true });
  const consent = await record(f);
  assert.equal(consent.accountId, NATIVE);
  assert.equal(consent.providerAccountId, PROVIDER);
  assert.equal(consent.bindingSha256, BINDING);
  assert.deepEqual(consent.attestation, f.delegated);
  assert.deepEqual(await record(f), consent);
  assert.equal((await f.publisher.preflight(request(f))).ready, true);
  const result = await f.publisher.publishTikTok(request(f));
  assert.equal(result.publication.status, 'processing');
  assert.equal(result.publication.privacy, 'public');
  assert.equal(result.publication.consentEvidence.previewWitness, 'authorized_agent');
  assert.equal(result.publication.consentEvidence.previewActorId, ACTOR);
  assert.equal(result.publication.consentEvidence.authorityEvidenceSha256, AUTHORITY);
  assert.equal(result.publication.consentEvidence.evidenceSha256, EVIDENCE);
  assert.equal(result.publication.consentEvidence.consentSource, 'owner_standing_authority');
  assert.equal(JSON.stringify(await f.store.read()).includes(KEY), false);
  assert.equal((await f.store.read()).episodes[0].approval.review.mode, 'owner_accepted_technical');
  assert.equal((await f.store.read()).episodes[0].approval.review.renderWatched, false, 'Independent delegated playback must not rewrite the earlier technical acceptance as a watched owner render');
  assert.equal(f.calls.filter(call => call === 'upload').length, 1);
  const repeated = await f.publisher.publishTikTok(request(f));
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.publication.id, result.publication.id);
  assert.equal(f.calls.filter(call => call === 'upload').length, 1);
});

test('disabled or mismatched standing authority rejects recording without modifying evidence or contacting the provider', async t => {
  for (const configured of [undefined, 'invalid', 'd'.repeat(64)]) {
    const f = await fixture(t, { enabled: false });
    if (configured !== undefined) f.env.YTFUN_TIKTOK_STANDING_AUTHORITY_SHA256 = configured;
    const before = await f.store.read();
    await assert.rejects(record(f), /authorized preview/);
    assert.deepEqual(await f.store.read(), before);
    assert.equal((await f.publisher.preflight(request(f))).ready, false);
    assert.deepEqual(f.calls, []);
  }
});

test('standing permission and technical acceptance never substitute for a real exact-render playback observation', async t => {
  const f = await fixture(t);
  const before = await f.store.read();
  for (const delta of [{ contentPreviewConfirmed: false }, { expressConsentGiven: false }, { previewMethod: 'inferred' },
    { previewActorId: 'owner' }, { previewActorId: 'codex:invalid' }, { evidenceSha256: '' }, { authorityEvidenceSha256: 'd'.repeat(64) },
    { renderSha256: 'd'.repeat(64) }, { recordedAt: new Date(Date.now() + 3_600_000).toISOString() }, { renderWatched: false }, { rawEvidence: KEY }]) {
    await assert.rejects(record(f, { attestation: { ...f.delegated, ...delta } }));
    assert.deepEqual(await f.store.read(), before);
  }
  await assert.rejects(record(f, { attestation: { renderSha256: f.episode.render.sha256, ownerAcceptedTechnical: true, renderWatched: false } }));
  assert.deepEqual(f.calls, []);
});

test('historical delegated evidence stays readable after revocation while new publication is blocked', async t => {
  const f = await fixture(t);
  await record(f);
  delete f.env.YTFUN_TIKTOK_STANDING_AUTHORITY_SHA256;
  const saved = await f.store.read();
  assert.equal(saved.zernioConsents[0].attestation.previewActorId, ACTOR);
  assert.equal(validateTikTokZernioAttestationShape(saved.zernioConsents[0].attestation, f.episode.render.sha256), true);
  assert.equal(validateTikTokZernioAttestation(saved.zernioConsents[0].attestation, f.episode.render.sha256, { env: f.env }), false);
  assert.equal((await f.publisher.preflight(request(f))).ready, false);
  await assert.rejects(f.publisher.publishTikTok(request(f)), /preview/);
  assert.deepEqual(await f.store.read(), saved);
  assert.deepEqual(f.calls, []);
});

test('explicit owner previews remain available without delegated authority, including earlier records without provider bindings', async t => {
  const f = await fixture(t, { enabled: false });
  const consent = await record(f, { attestation: f.owner });
  assert.equal(consent.attestation.previewWitness, 'owner');
  assert.equal(consent.attestation.previewActorId, undefined);
  await f.store.transaction(state => { delete state.zernioConsents[0].providerAccountId; delete state.zernioConsents[0].bindingSha256; });
  assert.equal((await f.publisher.preflight(request(f))).ready, true);
  const sent = await f.publisher.publishTikTok(request(f));
  assert.deepEqual(sent.publication.consentEvidence, f.owner);
  assert.equal(f.calls.filter(call => call === 'upload').length, 1);
});

test('changed review, actual media, native identity or provider binding prevents consent or publication', async t => {
  const changedReview = await fixture(t);
  await changedReview.store.transaction(state => { state.episodes[0].title = 'Changed after the observed preview'; });
  await assert.rejects(record(changedReview));
  assert.equal((await changedReview.store.read()).zernioConsents, undefined);
  const changedBytes = await fixture(t);
  await writeFile(path.join(changedBytes.directory, 'assets/render.mp4'), 'different-media');
  await assert.rejects(record(changedBytes), /fingerprint/);
  assert.equal((await changedBytes.store.read()).zernioConsents, undefined);
  for (const change of [f => { f.env.TIKTOK_ACCOUNT_ID = '7474000000000000000'; },
    f => { f.env.ZERNIO_TIKTOK_ACCOUNT_ID = '6ac02d2440f29aa9fab0d6ab'; },
    f => { f.env.ZERNIO_TIKTOK_BINDING_JSON = JSON.stringify({ ...JSON.parse(f.env.ZERNIO_TIKTOK_BINDING_JSON), evidenceSha256: 'f'.repeat(64) }); },
    f => { f.readiness.standingAuthoritySha256 = 'd'.repeat(64); }]) {
    const f = await fixture(t);
    await record(f);
    change(f);
    const before = await f.store.read();
    assert.equal((await f.publisher.preflight(request(f))).ready, false);
    await assert.rejects(record(f));
    await assert.rejects(f.publisher.publishTikTok(request(f)));
    assert.deepEqual(await f.store.read(), before);
    assert.deepEqual(f.calls, []);
  }
});

test('a binding change during account verification fails before any provider mutation or new reservation', async t => {
  const f = await fixture(t);
  await record(f);
  f.adapter.verifyAccount = async () => {
    f.calls.push('verify');
    f.env.ZERNIO_TIKTOK_BINDING_JSON = JSON.stringify({ ...JSON.parse(f.env.ZERNIO_TIKTOK_BINDING_JSON), evidenceSha256: 'd'.repeat(64) });
    return { ...f.readiness };
  };
  const before = await f.store.read();
  await assert.rejects(f.publisher.publishTikTok(request(f)), /changed/);
  assert.deepEqual(await f.store.read(), before);
  assert.deepEqual(f.calls, ['verify']);
});

test('original004 unknown reservation cannot be replaced, reset or re-sent by recording delegated consent', async t => {
  const f = await fixture(t);
  await f.store.transaction(state => state.publications.push({ id: 'cdb49830-aeb7-4cca-99f2-7a4a73b8e8ed', episodeId: f.episode.id,
    projectId: 'project', platform: 'tiktok', accountId: NATIVE, route: 'experimental_session_rest', privacy: 'public', status: 'unknown',
    reviewHash: f.episode.approval.reviewHash, renderSha256: f.episode.render.sha256, creationId: '6b69fdb1706441ec81fecf5a939b71ae', effectiveAt: new Date().toISOString() }));
  const before = await f.store.read();
  await assert.rejects(record(f), /existing TikTok reservation/);
  const result = await f.publisher.publishTikTok(request(f));
  assert.equal(result.duplicate, true);
  assert.equal(result.publication.id, before.publications[0].id);
  assert.deepEqual(await f.store.read(), before);
  assert.deepEqual(f.calls, []);
});
