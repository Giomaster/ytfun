import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { TikTokZernio, validateTikTokZernioAttestation, zernioTikTokUploadTarget } from '../src/tiktok-zernio.mjs';

const PROVIDER_ACCOUNT = '66b2e19d8c3f5a7e9d0b1c2d';
const PROVIDER_POST = '65f1c0a9e2b5af0012ab34cd';
const NATIVE_ACCOUNT = '7474661840611197969';
const NATIVE_POST = '7691909272912825622';
const PUBLICATION = '478b6085-f871-407d-8b28-8e60d4e835f5';
const HANDLE = 'ai._.meow';
const KEY = `sk_${'a'.repeat(64)}`;
const MEDIA = Buffer.from('original-mp4-fixture');
const HASH = createHash('sha256').update(MEDIA).digest('hex');
const WHEN = new Date(Date.now() - 3_600_000).toISOString();
const env = { ZERNIO_API_KEY: KEY, ZERNIO_TIKTOK_ACCOUNT_ID: PROVIDER_ACCOUNT, TIKTOK_ACCOUNT_ID: NATIVE_ACCOUNT,
  TIKTOK_ACCOUNT_HANDLE: HANDLE, YTFUN_TIKTOK_ZERNIO_PUBLISH_ENABLED: 'true' };
const binding = { providerAccountId: PROVIDER_ACCOUNT, nativeAccountId: NATIVE_ACCOUNT, handle: HANDLE,
  evidenceSha256: 'c'.repeat(64), verifiedAt: WHEN, source: 'owner_confirmed' };
const attestation = { renderSha256: HASH, contentPreviewConfirmed: true, expressConsentGiven: true,
  evidenceSha256: 'b'.repeat(64), recordedAt: WHEN, previewWitness: 'owner', consentSource: 'owner_explicit' };
const interactions = { allow_comment: true, allow_duet: true, allow_stitch: false };
const creatorInfo = {
  creator: { canPostMore: true }, privacyLevels: [{ value: 'PUBLIC_TO_EVERYONE' }],
  postingLimits: { maxVideoDurationSec: 600, interactionSettings: {
    allow_comment: { enabled: true, required: true, default: false },
    allow_duet: { enabled: true, required: true, default: false },
    allow_stitch: { enabled: false, required: true, default: false },
  } },
};
const storage = { key: `temp/123_abc_${PUBLICATION}.mp4`, expiresIn: 3600,
  uploadUrl: `https://fixture-bucket.r2.cloudflarestorage.com/temp/123_abc_${PUBLICATION}.mp4?X-Amz-Signature=${'f'.repeat(64)}`,
  publicUrl: `https://media.zernio.com/temp/123_abc_${PUBLICATION}.mp4` };
const post = {
  _id: PROVIDER_POST, status: 'published', visibility: 'public',
  metadata: { ytfunPublicationId: PUBLICATION, ytfunRenderSha256: HASH, ytfunRoute: 'tiktok_zernio' },
  platforms: [{ platform: 'tiktok', accountId: PROVIDER_ACCOUNT, status: 'published', platformPostId: NATIVE_POST,
    platformPostUrl: `https://www.tiktok.com/@${HANDLE}/video/${NATIVE_POST}`, publishedAt: WHEN }],
};
const item = { id: NATIVE_POST, author: { id: NATIVE_ACCOUNT, uniqueId: HANDLE },
  privateItem: false, secret: false, forFriend: false, isProhibited: false, isReviewing: false,
  ShowAIGC: true, aigcLabelType: '1', createTime: String(Date.parse(WHEN) / 1000) };

function fixture(options = {}) {
  const calls = [];
  const fetchImpl = async (rawUrl, config) => {
    const url = new URL(rawUrl); calls.push({ url: url.href, config });
    if (options.rejectPath === url.pathname) throw new Error(`Provider echoed ${KEY} ${storage.uploadUrl}`);
    if (url.hostname === 'www.tiktok.com') {
      const detail = options.detail ?? { statusCode: 0, itemInfo: { itemStruct: options.item ?? item } };
      return new Response(`<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': detail } })}</script></html>`);
    }
    if (url.hostname.endsWith('.r2.cloudflarestorage.com')) return new Response(null, { status: options.transferStatus ?? 200 });
    if (options.responsePath === url.pathname) return options.response;
    if (url.pathname === '/api/v1/accounts') return Response.json(options.accounts ?? { accounts: [{ _id: PROVIDER_ACCOUNT, platform: 'tiktok', username: HANDLE, isActive: true }] });
    if (url.pathname.endsWith('/creator-info')) return Response.json(options.creatorInfo ?? creatorInfo);
    if (url.pathname === '/api/v1/media/presign') return Response.json(options.storage ?? storage);
    if (url.pathname === '/api/v1/posts' && config.method === 'POST') return Response.json(options.create ?? { post: { _id: PROVIDER_POST } }, { status: 201 });
    if (url.pathname === `/api/v1/posts/${PROVIDER_POST}`) return Response.json({ post: options.post ?? post });
    throw new Error('Unexpected fixture URL');
  };
  return { calls, adapter: new TikTokZernio({ env: options.env ?? env, binding: options.binding ?? binding, fetchImpl }) };
}

const upload = (f, extra = {}) => f.adapter.upload({ media: MEDIA, caption: 'Impossible worlds. #AIMeow', publicationId: PUBLICATION,
  render: { durationSeconds: 7.5, width: 1080, height: 1920, format: 'mp4' }, attestation,
  interactionSettings: interactions, onReceipt: async () => {}, ...extra });
const status = f => f.adapter.status({ providerPostId: PROVIDER_POST, publicationId: PUBLICATION, renderSha256: HASH });

test('default-off readiness is local, separates IDs and does not expose credentials', async () => {
  const f = fixture({ env: { ...env, YTFUN_TIKTOK_ZERNIO_PUBLISH_ENABLED: undefined } });
  assert.equal(f.adapter.readiness().ready, false);
  assert.equal(f.adapter.readiness().accountId, NATIVE_ACCOUNT);
  assert.equal(f.adapter.readiness().providerAccountId, PROVIDER_ACCOUNT);
  assert.equal(f.adapter.readiness().bindingSha256, binding.evidenceSha256);
  assert.equal(f.adapter.readiness().remoteAuthorizationVerified, false);
  assert.equal(f.calls.length, 0);
  await assert.rejects(upload(f), /PUBLISH_DISABLED/);
  assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(f.adapter.readiness()).includes(KEY));
  assert.equal(JSON.stringify(f.adapter), '{}');
});

test('explicit binding must match both identities, evidence and source before remote calls', async () => {
  for (const delta of [{ providerAccountId: '66b2e19d8c3f5a7e9d0b1c2e' }, { nativeAccountId: '7474661840611197970' },
    { handle: 'personal' }, { evidenceSha256: '' }, { source: 'assumed' }, { verifiedAt: 'invalid' }]) {
    const f = fixture({ binding: { ...binding, ...delta } });
    assert.equal(f.adapter.readiness().ready, false);
    await assert.rejects(f.adapter.verifyAccount(), /CONFIGURATION_REQUIRED/);
    assert.equal(f.calls.length, 0);
  }
});

test('account and creator information require the exact active handle, public option and capability', async () => {
  for (const delta of [{ isActive: false }, { username: 'personal' }, { platform: 'youtube' }, { needsReconnection: true }, { enabled: false }]) {
    const f = fixture({ accounts: { accounts: [{ _id: PROVIDER_ACCOUNT, platform: 'tiktok', username: HANDLE, isActive: true, ...delta }] } });
    await assert.rejects(f.adapter.verifyAccount(), /ACCOUNT_NOT_CONFIRMED/);
    assert.equal(f.calls.length, 1);
  }
  for (const value of [{ ...creatorInfo, creator: { canPostMore: false } }, { ...creatorInfo, privacyLevels: [{ value: 'SELF_ONLY' }] },
    { ...creatorInfo, postingLimits: { maxVideoDurationSec: 600, interactionSettings: {} } }]) {
    const f = fixture({ creatorInfo: value });
    await assert.rejects(upload(f), /PUBLIC_POST_NOT_AVAILABLE/);
    assert.ok(f.calls.every(c => c.config.method === 'GET'));
  }
  assert.equal((await fixture().adapter.verifyAccount()).maxDurationSeconds, 600);
});

test('provider preview is exact-hash owner evidence, not an inferred technical review', async () => {
  for (const delta of [{ renderSha256: 'd'.repeat(64) }, { contentPreviewConfirmed: false }, { expressConsentGiven: false },
    { previewWitness: 'agent' }, { evidenceSha256: '' }, { recordedAt: 'bad' }, { consentSource: 'inferred' }]) {
    const f = fixture();
    assert.equal(validateTikTokZernioAttestation({ ...attestation, ...delta }, HASH), false);
    await assert.rejects(upload(f, { attestation: { ...attestation, ...delta } }), /PREVIEW_AND_CONSENT_REQUIRED/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(upload(f, { attestation: { renderSha256: HASH, ownerAcceptedTechnical: true, renderWatched: false } }), /PREVIEW_AND_CONSENT_REQUIRED/);
  assert.equal(f.calls.length, 0);
});

test('explicit interaction choices respect disabled toggles and actual duration ceiling', async () => {
  const missing = fixture();
  await assert.rejects(upload(missing, { interactionSettings: {} }), /EXPLICIT_INTERACTIONS_REQUIRED/);
  assert.equal(missing.calls.length, 0);
  const disabled = fixture();
  await assert.rejects(upload(disabled, { interactionSettings: { ...interactions, allow_stitch: true } }), /CREATOR_LIMIT_EXCEEDED/);
  assert.ok(disabled.calls.every(c => c.config.method === 'GET'));
  const tooLong = fixture({ creatorInfo: { ...creatorInfo, postingLimits: { ...creatorInfo.postingLimits, maxVideoDurationSec: 7 } } });
  await assert.rejects(upload(tooLong), /CREATOR_LIMIT_EXCEEDED/);
  assert.ok(tooLong.calls.every(c => c.config.method === 'GET'));
});

test('signed upload origins and exact public/storage key pairing reject exfiltration paths', async () => {
  assert.ok(zernioTikTokUploadTarget(storage));
  for (const delta of [{ uploadUrl: storage.uploadUrl.replace('fixture-bucket.r2.cloudflarestorage.com', 'evil.example') },
    { uploadUrl: storage.uploadUrl.replace('https:', 'http:') }, { uploadUrl: `${storage.uploadUrl}&X-Amz-Signature=${'a'.repeat(64)}` },
    { publicUrl: storage.publicUrl.replace('media.zernio.com', 'media.zernio.com.evil.example') },
    { publicUrl: `${storage.publicUrl}?token=secret` }, { publicUrl: storage.publicUrl.replace('123_abc_', '456_abc_') },
    { expiresIn: 999999 }, { key: 'temp/../secret.mp4' }]) {
    const f = fixture({ storage: { ...storage, ...delta } });
    const receipt = await upload(f);
    assert.equal(receipt.status, 'unknown');
    assert.equal(receipt.code, 'TIKTOK_ZERNIO_STORAGE_TARGET_NOT_CONFIRMED');
    assert.equal(f.calls.filter(c => c.config.method === 'PUT').length, 0);
    assert.equal(f.calls.filter(c => c.url.endsWith('/posts') && c.config.method === 'POST').length, 0);
  }
});

test('direct public AI post uses stable idempotency, saves ID before status GET and verifies native visibility', async () => {
  const f = fixture(), receipts = [];
  const result = await upload(f, { onReceipt: async value => receipts.push({ ...value, at: f.calls.length }) });
  assert.equal(result.status, 'published');
  assert.equal(result.confirmed, true);
  assert.equal(result.accountId, NATIVE_ACCOUNT);
  assert.equal(result.providerAccountId, PROVIDER_ACCOUNT);
  assert.equal(result.postId, NATIVE_POST);
  assert.equal(result.privacy, 'public');
  assert.equal(result.syntheticDisclosureConfirmed, true);
  const created = f.calls.find(c => c.config.method === 'POST' && c.url.endsWith('/posts'));
  const body = JSON.parse(created.config.body);
  assert.equal(created.config.headers['Idempotency-Key'], PUBLICATION);
  assert.equal(body.publishNow, true);
  assert.equal(body.visibility, 'public');
  assert.deepEqual(body.platforms, [{ platform: 'tiktok', accountId: PROVIDER_ACCOUNT }]);
  assert.deepEqual(body.metadata, { ytfunPublicationId: PUBLICATION, ytfunRenderSha256: HASH, ytfunRoute: 'tiktok_zernio' });
  assert.deepEqual(body.tiktokSettings, { privacy_level: 'PUBLIC_TO_EVERYONE', ...interactions,
    content_preview_confirmed: true, express_consent_given: true, video_made_with_ai: true, draft: false, isAdsOnly: false });
  const transferred = f.calls.find(c => c.config.method === 'PUT');
  assert.deepEqual(transferred.config.headers, { 'Content-Type': 'video/mp4' });
  assert.equal(transferred.config.body, MEDIA);
  const saved = receipts.find(r => r.providerPostId);
  assert.equal(saved.providerPostId, PROVIDER_POST);
  assert.equal(saved.at, f.calls.findIndex(c => c.url.endsWith('/posts') && c.config.method === 'POST') + 1);
  assert.ok(saved.at <= f.calls.findIndex(c => c.url.endsWith(`/posts/${PROVIDER_POST}`)));
  for (const call of f.calls) {
    assert.equal(call.config.redirect, 'error');
    assert.ok(call.config.signal instanceof AbortSignal);
    if (call.url.startsWith('https://zernio.com/api/v1')) assert.equal(call.config.headers.Authorization, `Bearer ${KEY}`);
    else assert.equal(call.config.headers?.Authorization, undefined);
  }
  assert.ok(!JSON.stringify(receipts).includes(KEY));
  assert.ok(!JSON.stringify(receipts).includes('X-Amz-Signature'));
  assert.ok(!JSON.stringify(result).includes('media.zernio.com'));
});

test('unknown POST outcome and receipt callback failure never trigger an automatic retry', async () => {
  const f = fixture({ rejectPath: '/api/v1/posts' });
  const result = await upload(f);
  assert.equal(result.status, 'unknown');
  assert.equal(result.phase, 'post');
  assert.equal(f.calls.filter(c => c.url.endsWith('/posts') && c.config.method === 'POST').length, 1);
  assert.ok(!JSON.stringify(result).includes(KEY));
  const persistence = fixture();
  const failed = await upload(persistence, { onReceipt: async value => { if (value.providerPostId) throw new Error('Store failure'); } });
  assert.equal(failed.status, 'unknown');
  assert.equal(failed.providerPostId, PROVIDER_POST);
  assert.equal(persistence.calls.filter(c => c.url.includes(`/posts/${PROVIDER_POST}`)).length, 0);
  const before = fixture();
  await upload(before, { onReceipt: async () => { throw new Error('Store failure'); } });
  assert.ok(before.calls.every(c => c.config.method === 'GET'));
});

test('generic published without URL, Inbox draft or unbound target is not a confirmed publication', async () => {
  for (const value of [{ ...post, platforms: [{ ...post.platforms[0], platformPostUrl: null }] }, { ...post, status: 'draft' },
    { ...post, metadata: { ...post.metadata, ytfunPublicationId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' } },
    { ...post, platforms: [{ ...post.platforms[0], accountId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }] },
    { ...post, visibility: 'private' }, { ...post, platforms: [{ ...post.platforms[0], removedFromPlatformAt: WHEN }] },
    { ...post, platforms: [...post.platforms, { platform: 'youtube' }] }]) {
    const f = fixture({ post: value }), result = await status(f);
    assert.equal(result.confirmed, false);
    assert.notEqual(result.status, 'published');
    assert.ok(f.calls.every(c => c.config.method === 'GET'));
    assert.equal(f.calls.filter(c => c.url.startsWith('https://www.tiktok.com')).length, 0);
  }
});

test('public native UID, privacy and synthetic label are required even if Zernio says published', async () => {
  for (const delta of [{ author: { id: '111111111', uniqueId: HANDLE } }, { author: { id: NATIVE_ACCOUNT, uniqueId: 'personal' } },
    { privateItem: true }, { secret: true }, { forFriend: true }, { isProhibited: true }, { isReviewing: true },
    { ShowAIGC: false }, { aigcLabelType: '0' }, { id: '111111111' }]) {
    const f = fixture({ item: { ...item, ...delta } }), result = await status(f);
    assert.equal(result.status, 'processing');
    assert.equal(result.confirmed, false);
    assert.ok(f.calls.every(c => c.config.method === 'GET'));
  }
});

test('status reconciliation does not depend on the remaining creator quota or publishing feature flag', async () => {
  const f = fixture({ env: { ...env, YTFUN_TIKTOK_ZERNIO_PUBLISH_ENABLED: 'false' }, creatorInfo: { ...creatorInfo, creator: { canPostMore: false } } });
  assert.equal((await status(f)).confirmed, true);
  assert.ok(!f.calls.some(c => c.url.includes('creator-info')));
});

test('provider errors and oversized JSON produce sanitized unresolved receipts', async () => {
  const rejected = fixture({ responsePath: '/api/v1/posts', response: new Response(`${KEY} ${storage.uploadUrl}`, { status: 500 }) });
  const result = await upload(rejected);
  assert.equal(result.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes(KEY));
  const oversize = fixture({ responsePath: `/api/v1/posts/${PROVIDER_POST}`, response: new Response('x', { headers: { 'content-length': '2000000' } }) });
  assert.equal((await status(oversize)).confirmed, false);
  assert.ok(oversize.calls.every(c => c.config.method === 'GET'));
});
