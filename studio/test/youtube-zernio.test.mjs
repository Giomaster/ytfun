import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { YouTubeZernio, safeZernioYouTubePermalink } from '../src/youtube-zernio.mjs';

const PROVIDER = '66b2e19d8c3f5a7e9d0b1c2d';
const POST = '65f1c0a9e2b5af0012ab34cd';
const CHANNEL = 'UCjwAEFZPOQ6FIfweosLmCTg';
const VIDEO = 'dQw4w9WgXcQ';
const PUBLICATION = '06c46949-709d-4c62-93a0-5d2a4fb36ba1';
const TOKEN = `sk_${'a'.repeat(64)}`;
const SIGNATURE = 'e'.repeat(64);
const MEDIA = Buffer.from('synthetic-video-fixture');
const SHA = createHash('sha256').update(MEDIA).digest('hex');
const env = { YTFUN_YOUTUBE_ZERNIO_PUBLISH_ENABLED: 'true', ZERNIO_API_KEY: TOKEN,
  ZERNIO_YOUTUBE_ACCOUNT_ID: PROVIDER, YOUTUBE_CHANNEL_ID: CHANNEL, YOUTUBE_CHANNEL_HANDLE: '@aimeow-ofc' };
const binding = { providerAccountId: PROVIDER, nativeAccountId: CHANNEL, handle: '@aimeow-ofc',
  evidenceSha256: 'b'.repeat(64), verifiedAt: '2026-10-02T00:00:00Z', source: 'owner_confirmed' };
const render = { sha256: SHA, durationSeconds: 52.521, width: 1080, height: 1920, format: 'mp4' };
const native = { confirmed: true, videoId: VIDEO, channelId: CHANNEL, privacyStatus: 'public', uploadStatus: 'processed' };
const post = {
  _id: POST, status: 'published', metadata: { ytfunPublicationId: PUBLICATION, ytfunRenderSha256: SHA },
  platforms: [{ platform: 'youtube', accountId: PROVIDER, status: 'published',
    platformSpecificData: { visibility: 'public', containsSyntheticMedia: true, madeForKids: false },
    platformPostId: VIDEO, platformPostUrl: `https://www.youtube.com/watch?v=${VIDEO}`, publishedAt: '2026-10-01T00:00:00Z' }],
};
const account = { _id: PROVIDER, platform: 'youtube', isActive: true, profileUrl: 'https://www.youtube.com/@aimeow-ofc' };
const health = { accountId: PROVIDER, platform: 'youtube', status: 'healthy', tokenStatus: { valid: true },
  permissions: { canPost: true, missingRequired: [] } };
const key = 'temp/123_abc_ai-meow.mp4';
const presign = { key, expiresIn: 3600, publicUrl: `https://media.zernio.com/${key}`,
  uploadUrl: `https://${'1'.repeat(32)}.r2.cloudflarestorage.com/media/${key}?X-Amz-Signature=${SIGNATURE}` };

function fixture(overrides = {}) {
  const calls = [];
  const nativeCalls = [];
  const response = value => value instanceof Response ? value : Response.json(value);
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/accounts')) return response({ accounts: overrides.accounts ?? [account] });
    if (parsed.pathname.endsWith('/health')) return response(overrides.health ?? health);
    if (parsed.pathname.endsWith('/presign')) return response(overrides.presign ?? presign);
    if (options.method === 'PUT') {
      if (overrides.transferError) throw new Error(`unsafe ${TOKEN} ${presign.uploadUrl}`);
      return overrides.transfer ?? new Response(null, { status: 200 });
    }
    if (parsed.pathname.endsWith('/posts') && options.method === 'POST') {
      if (overrides.createError) throw new Error(`unsafe ${TOKEN} ${presign.uploadUrl}`);
      return response(overrides.create ?? { post });
    }
    if (parsed.pathname.endsWith(`/posts/${POST}`)) {
      if (overrides.statusError) throw new Error(`unsafe ${TOKEN}`);
      return response(overrides.status ?? { post });
    }
    throw new Error('Unexpected fixture route');
  };
  const verifyPublishedVideo = overrides.noVerifier ? undefined : async input => {
    nativeCalls.push(input);
    if (overrides.nativeError) throw new Error(`unsafe ${TOKEN}`);
    return overrides.native ?? native;
  };
  const adapter = new YouTubeZernio({ env: overrides.env ?? env, binding: overrides.binding ?? binding,
    fetchImpl, verifyPublishedVideo });
  return { adapter, calls, nativeCalls };
}
const upload = (adapter, extra = {}) => adapter.upload({ media: MEDIA, caption: 'An original AI Meow world.',
  title: 'Impossible worlds inside lava', madeForKids: false, render, publicationId: PUBLICATION, ...extra });
const status = adapter => adapter.status({ providerPostId: POST, publicationId: PUBLICATION, renderSha256: SHA });

test('Zernio route is default off, identity-bound and does not imply owned app audit approval', () => {
  const f = fixture();
  assert.equal(f.adapter.readiness().ready, true);
  assert.equal(f.adapter.readiness().remoteAuthorizationVerified, false);
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(f.adapter), '{}');
  assert.ok(!JSON.stringify(f.adapter.readiness()).includes(TOKEN));
  for (const extra of [{ YTFUN_YOUTUBE_ZERNIO_PUBLISH_ENABLED: 'false' }, { ZERNIO_API_KEY: '' },
    { ZERNIO_YOUTUBE_ACCOUNT_ID: 'bad' }, { YOUTUBE_CHANNEL_HANDLE: '@other' }, { YTFUN_MAX_UPLOAD_BYTES: '9999999999' }]) {
    assert.equal(fixture({ env: { ...env, ...extra } }).adapter.readiness().ready, false);
  }
  assert.equal(fixture({ noVerifier: true }).adapter.readiness().ready, false);
  assert.equal(fixture({ binding: { ...binding, source: 'invented' } }).adapter.readiness().ready, false);
});

test('channel mismatch, inactive connection and missing posting scope stop before mutations', async () => {
  const scenarios = [{ accounts: [{ ...account, profileUrl: 'https://www.youtube.com/@other' }] },
    { accounts: [{ ...account, isActive: false }] }, { accounts: [{ ...account, needsReconnection: true }] },
    { accounts: [account, account] }, { health: { ...health, permissions: { canPost: false, missingRequired: ['upload'] } } }];
  for (const scenario of scenarios) {
    const f = fixture(scenario);
    await assert.rejects(upload(f.adapter));
    assert.ok(f.calls.every(call => call.options.method === 'GET'));
  }
});

test('exact bytes and explicit public/COPPA decisions are checked before remote work', async () => {
  for (const extra of [{ media: Buffer.from('changed') }, { publicationId: '../x' }, { privacy: 'private' },
    { synthetic: false }, { madeForKids: undefined }, { render: { ...render, durationSeconds: 901 } },
    { title: 'unsafe<title>' }, { caption: 'unsafe<description>' }, { tags: ['x'.repeat(101)] }]) {
    const f = fixture();
    await assert.rejects(upload(f.adapter, extra));
    assert.equal(f.calls.length, 0);
  }
});

test('upload sends one public synthetic YouTube target and never shares bearer on signed PUT', async () => {
  const f = fixture();
  const saved = [];
  const result = await upload(f.adapter, { onReceipt: value => { saved.push({ ...value }); } });
  assert.equal(result.status, 'processing');
  assert.equal(result.confirmed, false);
  assert.equal(result.providerPostId, POST);
  const sent = f.calls.find(call => call.options.method === 'POST' && call.url.endsWith('/posts'));
  const body = JSON.parse(sent.options.body);
  assert.equal(sent.options.headers['Idempotency-Key'], PUBLICATION);
  assert.equal(body.publishNow, true);
  assert.equal(body.scheduledFor, undefined);
  assert.equal(body.platforms.length, 1);
  assert.equal(body.platforms[0].accountId, PROVIDER);
  assert.equal(body.platforms[0].platformSpecificData.visibility, 'public');
  assert.equal(body.platforms[0].platformSpecificData.containsSyntheticMedia, true);
  assert.equal(body.platforms[0].platformSpecificData.madeForKids, false);
  assert.equal(body.metadata.ytfunRenderSha256, SHA);
  const put = f.calls.find(call => call.options.method === 'PUT');
  assert.equal(put.options.headers.Authorization, undefined);
  assert.equal(put.options.redirect, 'error');
  assert.ok(saved.some(value => value.providerPostId === POST));
  assert.ok(!JSON.stringify(saved).includes(SIGNATURE));
  assert.ok(!JSON.stringify(saved).includes(TOKEN));
  assert.equal(f.nativeCalls.length, 0);
});

test('unsafe presign hosts and mismatched keys never receive a file or post', async () => {
  for (const extra of [{ uploadUrl: 'https://evil.example/file' }, { publicUrl: 'https://evil.example/file' },
    { key: '../private.mp4' }, { uploadUrl: presign.uploadUrl.replace('/media/temp/', '/other/temp/') + '#x' },
    { publicUrl: presign.publicUrl + '?secret=x' }]) {
    const f = fixture({ presign: { ...presign, ...extra } });
    const result = await upload(f.adapter);
    assert.equal(result.status, 'unknown');
    assert.ok(!f.calls.some(call => call.options.method === 'PUT'));
    assert.ok(!f.calls.some(call => call.url.endsWith('/posts')));
  }
});

test('ambiguous transfer and create failures are sanitized and never retried', async () => {
  for (const overrides of [{ transferError: true }, { createError: true },
    { create: new Response(`echo ${TOKEN}`, { status: 500 }) }]) {
    const f = fixture(overrides);
    const result = await upload(f.adapter);
    assert.equal(result.status, 'unknown');
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.ok(!JSON.stringify(result).includes(SIGNATURE));
    assert.ok(f.calls.filter(call => call.options.method === 'POST' && call.url.endsWith('/posts')).length <= 1);
  }
});

test('207 platform failure retains the provider post without declaring success or leaking body', async () => {
  const failed = structuredClone(post);
  failed.status = 'failed';
  failed.platforms[0].status = 'failed';
  failed.platforms[0].errorMessage = `provider echoes ${TOKEN}`;
  const f = fixture({ create: Response.json({ post: failed }, { status: 207 }) });
  const result = await upload(f.adapter);
  assert.equal(result.status, 'failed');
  assert.equal(result.providerPostId, POST);
  assert.equal(result.confirmed, false);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('post ID is retained when provider returned malformed correlation or receipt persistence fails', async () => {
  const changed = structuredClone(post);
  changed.metadata.ytfunRenderSha256 = 'c'.repeat(64);
  const f = fixture({ create: { post: changed } });
  const result = await upload(f.adapter);
  assert.equal(result.status, 'unknown');
  assert.equal(result.providerPostId, POST);
  const persistence = fixture();
  const partial = await upload(persistence.adapter, { onReceipt: value => { if (value.providerPostId) throw new Error(TOKEN); } });
  assert.equal(partial.status, 'unknown');
  assert.equal(partial.providerPostId, POST);
  assert.ok(!JSON.stringify(partial).includes(TOKEN));
});

test('GET-only reconciliation requires exact target/hash plus observed native public ownership', async () => {
  const f = fixture();
  const result = await status(f.adapter);
  assert.equal(result.status, 'published');
  assert.equal(result.confirmed, true);
  assert.equal(result.privacy, 'public');
  assert.equal(result.accountId, CHANNEL);
  assert.equal(result.nativeVisibilityVerified, true);
  assert.equal(result.videoId, VIDEO);
  assert.equal(result.url, `https://www.youtube.com/watch?v=${VIDEO}`);
  assert.deepEqual(f.nativeCalls, [{ videoId: VIDEO, channelId: CHANNEL }]);
  assert.ok(f.calls.every(call => call.options.method === 'GET'));
});

test('publishNow normalized dispatch timestamps reconcile through GET and native public verification', async () => {
  const createdMs = Date.now() - 60_000;
  const createdAt = new Date(createdMs).toISOString();
  const dispatchedAt = new Date(createdMs - 609).toISOString();
  const offset = value => new Date(value + 3_600_000).toISOString().replace('Z', '+01:00');
  for (const [label, schedules] of [
    ['root and target normalized before creation', { root: dispatchedAt, target: dispatchedAt }],
    ['root and target exactly at creation', { root: createdAt, target: createdAt }],
    ['root only', { root: dispatchedAt }],
    ['target only', { target: dispatchedAt }],
    ['root and target equivalent offset instants', { root: offset(createdMs - 609), target: offset(createdMs) }],
  ]) {
    const normalized = structuredClone(post);
    normalized.createdAt = createdAt;
    normalized.platforms[0].publishedAt = new Date(createdMs + 1_000).toISOString();
    if (schedules.root !== undefined) normalized.scheduledFor = schedules.root;
    if (schedules.target !== undefined) normalized.platforms[0].scheduledFor = schedules.target;
    const f = fixture({ create: Response.json({ post: normalized }, { status: 201 }), status: { post: normalized } });
    const accepted = await upload(f.adapter);
    assert.equal(accepted.status, 'processing', label);
    assert.equal(accepted.confirmed, false, label);
    assert.equal(accepted.providerPostId, POST, label);
    assert.equal(f.nativeCalls.length, 0, label);
    const createCall = f.calls.find(call => call.options.method === 'POST' && call.url.endsWith('/posts'));
    const request = JSON.parse(createCall.options.body);
    assert.equal(request.publishNow, true, label);
    assert.equal(request.scheduledFor, undefined, label);
    assert.equal(request.platforms[0].scheduledFor, undefined, label);
    const callsBeforeReconciliation = f.calls.length;
    const observed = await status(f.adapter);
    assert.equal(observed.status, 'published', label);
    assert.equal(observed.confirmed, true, label);
    assert.equal(observed.privacy, 'public', label);
    assert.equal(observed.accountId, CHANNEL, label);
    assert.equal(observed.nativeVisibilityVerified, true, label);
    assert.deepEqual(f.nativeCalls, [{ videoId: VIDEO, channelId: CHANNEL }], label);
    assert.ok(f.calls.slice(callsBeforeReconciliation).every(call => call.options.method === 'GET'), label);
    assert.equal(f.calls.filter(call => call.options.method === 'PUT').length, 1, label);
    assert.equal(f.calls.filter(call => call.options.method === 'POST' && call.url.endsWith('/posts')).length, 1, label);
  }
});

test('normalized dispatch dates reject future, invalid or unanchored schedules before native verification', async () => {
  const createdMs = Date.now() - 60_000;
  const createdAt = new Date(createdMs).toISOString();
  const dispatchedAt = new Date(createdMs - 609).toISOString();
  const afterCreation = new Date(createdMs + 1_000).toISOString();
  const legacyCreatedAt = new Date(createdMs).toUTCString().replace('GMT', 'GMT+00:00');
  const legacyDispatchedAt = new Date(createdMs - 5_000).toUTCString().replace('GMT', 'GMT+00:00');
  const previousYear = new Date(createdMs).getUTCFullYear() - 1;
  const mutations = [
    ['root schedule after creation', value => { value.scheduledFor = afterCreation; }],
    ['target schedule after creation', value => { value.platforms[0].scheduledFor = afterCreation; }],
    ['root schedule in the future', value => { value.scheduledFor = new Date(Date.now() + 120_000).toISOString(); }],
    ['target schedule in the future', value => { value.platforms[0].scheduledFor = new Date(Date.now() + 120_000).toISOString(); }],
    ['root malformed schedule', value => { value.scheduledFor = 'not-a-timestampZ'; }],
    ['target malformed schedule', value => { value.platforms[0].scheduledFor = 'not-a-timestampZ'; }],
    ['empty schedule', value => { value.scheduledFor = ''; }],
    ['numeric schedule', value => { value.platforms[0].scheduledFor = createdMs; }],
    ['schedule without timezone', value => { value.scheduledFor = dispatchedAt.slice(0, -1); }],
    ['schedule with invalid offset', value => { value.platforms[0].scheduledFor = dispatchedAt.replace('Z', '+25:00'); }],
    ['schedule with impossible calendar day', value => { value.scheduledFor = `${previousYear}-02-30T23:50:02.093Z`; }],
    ['schedule in parseable legacy format', value => { value.scheduledFor = legacyDispatchedAt; }],
    ['missing creation anchor', value => { delete value.createdAt; }],
    ['null creation anchor', value => { value.createdAt = null; }],
    ['malformed creation anchor', value => { value.createdAt = 'not-a-timestampZ'; }],
    ['numeric creation anchor', value => { value.createdAt = createdMs; }],
    ['creation anchor without timezone', value => { value.createdAt = createdAt.slice(0, -1); }],
    ['creation anchor with impossible calendar day', value => {
      value.createdAt = `${previousYear}-02-30T23:50:02.702Z`;
      value.scheduledFor = `${previousYear}-02-01T23:50:02.093Z`;
      value.platforms[0].scheduledFor = value.scheduledFor;
    }],
    ['creation anchor in parseable legacy format', value => {
      value.createdAt = legacyCreatedAt;
      value.scheduledFor = new Date(createdMs - 5_000).toISOString();
      value.platforms[0].scheduledFor = value.scheduledFor;
    }],
    ['future creation anchor beyond clock allowance', value => {
      value.createdAt = new Date(Date.now() + 120_000).toISOString();
      value.scheduledFor = value.createdAt;
      value.platforms[0].scheduledFor = value.createdAt;
    }],
    ['draft with normalized dates', value => { value.status = 'draft'; }],
    ['cancelled with normalized dates', value => { value.status = 'cancelled'; }],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(post);
    changed.createdAt = createdAt;
    changed.scheduledFor = dispatchedAt;
    changed.platforms[0].scheduledFor = dispatchedAt;
    mutate(changed);
    const f = fixture({ status: { post: changed } });
    const observed = await status(f.adapter);
    assert.equal(observed.status, 'unknown', label);
    assert.equal(observed.confirmed, false, label);
    assert.equal(f.nativeCalls.length, 0, label);
    assert.ok(f.calls.every(call => call.options.method === 'GET'), label);
  }
});

test('generic published, unlisted/private, wrong owner, missing link and drafts do not confirm public', async () => {
  const mutations = [value => { value.platforms[0].accountId = 'a'.repeat(24); },
    value => { value.metadata.ytfunPublicationId = 'wrong'; },
    value => { value.platforms[0].platformSpecificData.visibility = 'unlisted'; },
    value => { value.platforms[0].platformPostUrl = null; },
    value => { value.platforms[0].removedFromPlatformAt = '2026-10-01T01:00:00Z'; },
    value => { value.status = 'draft'; }, value => { value.scheduledFor = '2027-01-01T00:00:00Z'; },
    value => { value.platforms.push(value.platforms[0]); }];
  for (const mutate of mutations) {
    const changed = structuredClone(post);
    mutate(changed);
    const f = fixture({ status: { post: changed } });
    assert.equal((await status(f.adapter)).confirmed, false);
    assert.ok(f.calls.every(call => call.options.method === 'GET'));
  }
  for (const changed of [{ ...native, privacyStatus: 'unlisted' }, { ...native, privacyStatus: 'private' },
    { ...native, channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' }, { ...native, uploadStatus: 'processing' },
    { ...native, confirmed: false }]) {
    const result = await status(fixture({ native: changed }).adapter);
    assert.equal(result.status, 'processing');
    assert.equal(result.confirmed, false);
  }
  assert.equal((await status(fixture({ nativeError: true }).adapter)).confirmed, false);
});

test('published link validators reject lookalikes, credentials, extra query, unrelated video and http', () => {
  assert.equal(safeZernioYouTubePermalink(`https://www.youtube.com/shorts/${VIDEO}`, VIDEO), `https://www.youtube.com/shorts/${VIDEO}`);
  for (const value of [`https://youtube.com.evil.example/watch?v=${VIDEO}`, `https://evil@youtube.com/watch?v=${VIDEO}`,
    `https://youtube.com/watch?v=${VIDEO}&secret=x`, `https://youtube.com/watch?v=aaaaaaaaaaa`, `http://youtube.com/watch?v=${VIDEO}`]) {
    assert.equal(safeZernioYouTubePermalink(value, VIDEO), null);
  }
});

test('documented direct storage key and path-style bucket both accept the exact paired public object', async () => {
  for (const uploadUrl of [
    `https://fixture-bucket.r2.cloudflarestorage.com/${key}?X-Amz-Signature=${SIGNATURE}`,
    `https://fixture-bucket.r2.cloudflarestorage.com/media/${key}?X-Amz-Signature=${SIGNATURE}`,
    presign.uploadUrl,
  ]) {
    const f = fixture({ presign: { ...presign, uploadUrl } });
    assert.equal((await upload(f.adapter)).status, 'processing');
    const put = f.calls.find(call => call.options.method === 'PUT');
    assert.equal(put.url, uploadUrl);
    assert.equal(put.options.headers.Authorization, undefined);
  }
});

test('virtual-hosted R2 bucket and account upload the exact direct object without sharing the API bearer', async () => {
  const uploadUrl = `https://fixture-bucket.${'2'.repeat(32)}.r2.cloudflarestorage.com/${key}?X-Amz-Signature=${SIGNATURE}`;
  const f = fixture({ presign: { ...presign, uploadUrl } });
  const saved = [];
  const result = await upload(f.adapter, { onReceipt: value => saved.push({ ...value }) });
  assert.equal(result.status, 'processing');
  assert.equal(result.providerPostId, POST);
  assert.equal(result.publicationId, PUBLICATION);
  assert.equal(result.renderSha256, SHA);
  assert.equal(result.confirmed, false);
  const put = f.calls.find(call => call.options.method === 'PUT');
  assert.equal(put.url, uploadUrl);
  assert.deepEqual(put.options.body, MEDIA);
  assert.equal(put.options.headers['Content-Type'], 'video/mp4');
  assert.equal(put.options.headers.Authorization, undefined);
  assert.equal(put.options.redirect, 'error');
  const mutations = f.calls.filter(call => call.options.method === 'POST' && call.url.endsWith('/posts'));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].options.headers['Idempotency-Key'], PUBLICATION);
  const body = JSON.parse(mutations[0].options.body);
  assert.deepEqual(body.mediaItems, [{ type: 'video', url: presign.publicUrl }]);
  assert.equal(body.metadata.ytfunPublicationId, PUBLICATION);
  assert.equal(body.metadata.ytfunRenderSha256, SHA);
  assert.equal(body.platforms[0].accountId, PROVIDER);
  assert.equal(body.platforms[0].platformSpecificData.visibility, 'public');
  assert.equal(body.platforms[0].platformSpecificData.containsSyntheticMedia, true);
  assert.equal(body.platforms[0].platformSpecificData.madeForKids, false);
  assert.equal(body.scheduledFor, undefined);
  assert.ok(!JSON.stringify({ result, saved }).includes(SIGNATURE));
  assert.ok(!JSON.stringify({ result, saved }).includes(TOKEN));
  assert.ok(!JSON.stringify({ result, saved }).includes(uploadUrl));
});

test('virtual-hosted R2 compatibility rejects extra labels, invalid accounts, credentials and object substitutions before PUT', async () => {
  const origin = `https://fixture-bucket.${'2'.repeat(32)}.r2.cloudflarestorage.com`;
  const uploadUrl = `${origin}/${key}?X-Amz-Signature=${SIGNATURE}`;
  for (const unsafe of [
    uploadUrl.replace('https://', 'https://extra.'),
    uploadUrl.replace('2'.repeat(32), 'g'.repeat(32)),
    uploadUrl.replace('2'.repeat(32), '2'.repeat(31)),
    uploadUrl.replace('fixture-bucket', 'a'.repeat(64)),
    uploadUrl.replace('fixture-bucket', '-fixture-bucket'),
    uploadUrl.replace('fixture-bucket', 'fixture-bucket-'),
    uploadUrl.replace('fixture-bucket', 'fixture_bucket'),
    uploadUrl.replace('.r2.cloudflarestorage.com', '.r2.cloudflarestorage.com.evil.example'),
    uploadUrl.replace('https://', 'https://user:pass@'),
    uploadUrl.replace('https:', 'http:'),
    uploadUrl.replace('.com/', '.com:444/'),
    uploadUrl.replace(`/${key}`, `/fixture-bucket/${key}`),
    uploadUrl.replace(`/${key}`, `/extra/${key}`),
    uploadUrl.replace('ai-meow.mp4', 'different.mp4'),
    uploadUrl.replace('/temp/', '/%74emp/'),
    `${uploadUrl}&X-Amz-Signature=${SIGNATURE}`,
    `${uploadUrl}&%58-Amz-Signature=${SIGNATURE}`,
    `${uploadUrl}#ignored-fragment`,
  ]) {
    const f = fixture({ presign: { ...presign, uploadUrl: unsafe } });
    const result = await upload(f.adapter);
    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'ZERNIO_STORAGE_TARGET_REJECTED');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.phase, 'presign');
    assert.ok(!f.calls.some(call => call.options.method === 'PUT' || call.url.endsWith('/posts')));
    assert.ok(!JSON.stringify(result).includes(SIGNATURE));
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
  const wrongPair = fixture({ presign: { ...presign, uploadUrl,
    publicUrl: presign.publicUrl.replace('ai-meow.mp4', 'different.mp4') } });
  assert.equal((await upload(wrongPair.adapter)).code, 'ZERNIO_STORAGE_TARGET_REJECTED');
  assert.ok(!wrongPair.calls.some(call => call.options.method === 'PUT' || call.url.endsWith('/posts')));
});

test('bucket compatibility still rejects arbitrary paths, lookalike origins and missing or duplicate signatures', async () => {
  for (const uploadUrl of [
    presign.uploadUrl.replace('/media/temp/', '/media/extra/temp/'),
    presign.uploadUrl.replace('/temp/123_abc_', '/temp/different_'),
    presign.uploadUrl.replace('.r2.cloudflarestorage.com', '.r2.cloudflarestorage.com.evil.example'),
    presign.uploadUrl.replace('https://', 'https://secret@'),
    presign.uploadUrl.replace(SIGNATURE, 'not-a-signature'),
    `${presign.uploadUrl}&X-Amz-Signature=${SIGNATURE}`,
  ]) {
    const f = fixture({ presign: { ...presign, uploadUrl } });
    const result = await upload(f.adapter);
    assert.equal(result.code, 'ZERNIO_STORAGE_TARGET_REJECTED');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.phase, 'presign');
    assert.ok(!f.calls.some(call => call.options.method === 'PUT' || call.url.endsWith('/posts')));
  }
});

test('phase diagnostics distinguish HTTP rejection, invalid JSON and local target validation without raw response data', async () => {
  for (const [presignResponse, code, httpStatus] of [
    [new Response(`echo ${TOKEN}`, { status: 403 }), 'ZERNIO_HTTP_REJECTED', 403],
    [new Response(`echo ${TOKEN}`, { status: 200 }), 'ZERNIO_RESPONSE_INVALID', 200],
    [{ ...presign, publicUrl: 'https://evil.example/file' }, 'ZERNIO_STORAGE_TARGET_REJECTED', 200],
  ]) {
    const f = fixture({ presign: presignResponse });
    const saved = [];
    const result = await upload(f.adapter, { onReceipt: value => { saved.push({ ...value }); } });
    assert.equal(result.status, 'unknown');
    assert.equal(result.phase, 'presign');
    assert.equal(result.code, code);
    assert.equal(result.httpStatus, httpStatus);
    assert.equal(saved.at(-1).code, code);
    assert.ok(!JSON.stringify(saved).includes(TOKEN));
    assert.ok(!JSON.stringify(saved).includes(SIGNATURE));
    assert.ok(!f.calls.some(call => call.options.method === 'PUT' || call.url.endsWith('/posts')));
  }
});

test('pending and observed phase receipts must be persisted before any subsequent upload mutation', async () => {
  for (const [phase, code, expectedPuts] of [
    ['presign', 'ZERNIO_HTTP_ACCEPTED', 0],
    ['transfer', 'ZERNIO_TRANSFER_REQUEST_PENDING', 0],
    ['transfer', 'ZERNIO_HTTP_ACCEPTED', 1],
    ['create-post', 'ZERNIO_POST_REQUEST_PENDING', 1],
  ]) {
    const f = fixture();
    const result = await upload(f.adapter, { onReceipt: value => { if (value.phase === phase && value.code === code) throw new Error(TOKEN); } });
    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'ZERNIO_RECEIPT_PERSISTENCE_UNCONFIRMED');
    assert.equal(result.phase, phase);
    assert.equal(f.calls.filter(call => call.options.method === 'PUT').length, expectedPuts);
    assert.ok(!f.calls.some(call => call.url.endsWith('/posts')));
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
});

test('transfer HTTP failure retains its own status and blocks create-post', async () => {
  const f = fixture({ transfer: new Response(TOKEN, { status: 503 }) });
  const saved = [];
  const result = await upload(f.adapter, { onReceipt: value => { saved.push({ ...value }); } });
  assert.equal(result.phase, 'transfer');
  assert.equal(result.code, 'ZERNIO_HTTP_REJECTED');
  assert.equal(result.httpStatus, 503);
  assert.ok(saved.some(value => value.phase === 'transfer' && value.httpStatus === null));
  assert.ok(!f.calls.some(call => call.url.endsWith('/posts')));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});
