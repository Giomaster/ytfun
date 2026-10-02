import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TikTokSession } from '../src/tiktok-session.mjs';
import { TikTokWeb, tiktokStorageTarget, tiktokPostBody, tiktokCrc32 } from '../src/tiktok-web.mjs';

const ACCOUNT = '7474000000000000000';
const COOKIE = 'fixture-private-session-do-not-return';
async function setup(t, fetchImpl) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tiktok-session-ci-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'session.json');
  const data = { expectedAccount: { accountId: ACCOUNT, handle: '@fixture.meow' }, cookies: [
    { name: 'sessionid', value: COOKIE, domain: '.tiktok.com', path: '/', expires: new Date(Date.now() + 86400000).toISOString() },
  ] };
  await writeFile(filename, JSON.stringify(data), { mode: 0o600 });
  const env = { TIKTOK_ACCOUNT_ID: ACCOUNT, TIKTOK_ACCOUNT_HANDLE: 'fixture.meow', TIKTOK_SESSION_FILE: filename, YTFUN_TIKTOK_SESSION_PUBLISH_ENABLED: 'true' };
  return { filename, data, env, session: new TikTokSession({ env, fetchImpl }) };
}
const profile = { status_code: 0, user: { uid: ACCOUNT, unique_id: 'fixture.meow', private_account: false, max_video_duration_in_sec: 3600 } };

test('session expiry and unsafe private file permissions stop requests before transmitting credentials', async t => {
  let calls = 0;
  const f = await setup(t, async () => { calls++; return Response.json(profile); });
  await chmod(f.filename, 0o644);
  await assert.rejects(f.session.verifyAccount(), /TIKTOK_PRIVATE_FILE_UNSAFE/);
  assert.equal(calls, 0);
  await chmod(f.filename, 0o600);
  f.data.cookies[0].expires = '2020-01-01T00:00:00Z';
  await writeFile(f.filename, JSON.stringify(f.data));
  await assert.rejects(f.session.verifyAccount(), /TIKTOK_SESSION_REIMPORT_REQUIRED/);
  assert.equal(calls, 0);
});

test('authorized Set-Cookie rotation is saved privately and a later manual import is read afresh', async t => {
  const received = [];
  const f = await setup(t, async (url, options) => {
    received.push(options.headers.cookie);
    return Response.json(profile, { headers: { 'set-cookie': 'sessionid=fixture-rotated; Domain=.tiktok.com; Path=/; Max-Age=3600; Secure; HttpOnly' } });
  });
  const result = await f.session.verifyAccount();
  assert.equal(result.accountId, ACCOUNT);
  assert.ok(!JSON.stringify(result).includes(COOKIE));
  const rotated = JSON.parse(await readFile(f.filename));
  assert.equal(rotated.cookies[0].value, 'fixture-rotated');
  rotated.cookies[0].value = 'fixture-manual-reimport';
  await writeFile(f.filename, JSON.stringify(rotated));
  await f.session.verifyAccount();
  assert.match(received[1], /fixture-manual-reimport/);
});

test('account mismatch, unknown routes and challenge pages are never accepted as an authenticated account', async t => {
  const f = await setup(t, async () => Response.json({ ...profile, user: { ...profile.user, uid: '999' } }));
  await assert.rejects(f.session.verifyAccount(), /TIKTOK_PUBLIC_ACCOUNT_NOT_CONFIRMED/);
  await assert.rejects(f.session.request('/passport/login/'), /TIKTOK_ROUTE_NOT_CAPTURED/);
  const challenge = await setup(t, async () => new Response('<html>challenge</html>'));
  await assert.rejects(challenge.session.verifyAccount(), /TIKTOK_SESSION_REIMPORT_OR_CHALLENGE_REQUIRED/);
});

test('storage target restrictions prevent account cookies or upload credentials from reaching another host', () => {
  const node = { UploadHost: 'tos-my16-up.tiktokcdn.com', StoreInfos: [{ StoreUri: 'tos-alisg/test', Auth: 'fixture-scoped-storage-auth' }], Vid: 'vfixture123456', SessionKey: 'fixture-key' };
  assert.equal(tiktokStorageTarget(node).url, 'https://tos-my16-up.tiktokcdn.com/upload/v1/tos-alisg/test');
  for (const UploadHost of ['example.com', 'tos-my16-up.tiktokcdn.com.example.com', 'localhost']) assert.throws(() => tiktokStorageTarget({ ...node, UploadHost }));
  assert.throws(() => tiktokStorageTarget({ ...node, StoreInfos: [{ StoreUri: '../private', Auth: 'fixture' }] }));
  assert.equal(tiktokCrc32(Buffer.from('123456789')), 'cbf43926'); // Standard independent CRC-32 vector.
});

test('posting payload requires public visibility, synthetic disclosure and original audio with UTF-16 hashtag offsets', () => {
  const body = tiktokPostBody({ creationId: 'fixture-creation-12345', videoId: 'vfixture123456', caption: '✨ Hidden #AIAnimation', durationSeconds: 7.5, width: 1080, height: 1920 });
  const feature = body.feature_common_info_list[0];
  assert.equal(feature.privacy_setting_info.visibility_type, 0);
  assert.equal(feature.aigc_info.aigc_label_type, 1);
  const text = body.single_post_req_list[0].single_post_feature_info;
  assert.equal(text.text.slice(text.text_extra[0].start, text.text_extra[0].end), '#AIAnimation');
  assert.equal(text.has_original_audio, 1);
});

test('a completed transfer and successful project POST remain processing until public item evidence exists', async () => {
  const routes = [];
  const session = { readiness: () => ({ ready: true }), verifyAccount: async () => ({ accountId: ACCOUNT }),
    uploadAuthorization: async () => ({ access_key_id: 'fixture-access', secret_acess_key: 'fixture-secret', session_token: 'fixture-temp' }),
    refreshCsrf: async () => {}, request: async (route, options) => {
      routes.push({ route, options });
      return { ok: true, httpStatus: 200, data: route.includes('create') ? { status_code: 0, project: { project_id: '123' } } : { status_code: 0 } };
    } };
  const storageCalls = [];
  const web = new TikTokWeb({ session, fetchImpl: async (raw, options) => {
    const url = new URL(raw);
    if (url.hostname.endsWith('tiktokcdn.com')) { storageCalls.push(options); return Response.json({ code: 2000 }); }
    if (url.searchParams.get('Action') === 'ApplyUploadInner') return Response.json({ Result: { InnerUploadAddress: { UploadNodes: [{ UploadHost: 'tos-my16-up.tiktokcdn.com', StoreInfos: [{ StoreUri: 'tos-alisg/test', Auth: 'fixture-storage-auth' }], Vid: 'vfixture123456', SessionKey: 'fixture-key' }] } } });
    return Response.json({ Result: { Results: [{ Vid: 'vfixture123456' }] } });
  } });
  const phases = [];
  const result = await web.upload({ media: Buffer.from('reviewed-bytes'), caption: 'Original #AIAnimation', render: { width: 1080, height: 1920, durationSeconds: 7.5 }, onReceipt: async r => phases.push(r.phase) });
  assert.equal(result.status, 'processing'); assert.equal(result.confirmed, false);
  assert.deepEqual(phases, ['project-create', 'allocation', 'transfer', 'commit', 'post']);
  assert.equal(storageCalls[0].headers.cookie, undefined);
  assert.equal(routes.filter(r => r.route.includes('/post/')).length, 1);
});

test('an interrupted post is unknown and the adapter never retries the mutation', async () => {
  let postCalls = 0;
  const session = { readiness: () => ({ ready: true }), uploadAuthorization: async () => ({}), refreshCsrf: async () => {},
    request: async () => { postCalls++; throw new Error('private provider diagnostic'); } };
  const web = new TikTokWeb({ session });
  const result = await web.upload({ media: Buffer.from('reviewed'), caption: 'Original', render: {}, onReceipt: async () => {} });
  assert.equal(result.status, 'unknown'); assert.equal(postCalls, 1);
  assert.ok(!JSON.stringify(result).includes('private provider diagnostic'));
});

test('recovery of an observed untransferred allocation reuses the original project and allocation', async () => {
  const routes = [];
  const session = { readiness: () => ({ ready: true }), uploadAuthorization: async () => ({ access_key_id: 'fixture-access', secret_acess_key: 'fixture-secret', session_token: 'fixture-temp' }),
    refreshCsrf: async () => {}, request: async (route) => { routes.push(route); return { ok: true, httpStatus: 200, data: { status_code: 0 } }; } };
  const gatewayActions = [];
  const web = new TikTokWeb({ session, fetchImpl: async (raw) => {
    const url = new URL(raw);
    if (url.hostname === 'tos-quic-awsfr.tiktokcdn.com') return Response.json({ code: 2000 });
    gatewayActions.push(url.searchParams.get('Action'));
    return Response.json({ Result: { Results: [{ Vid: 'vfixture123456' }] } });
  } });
  const result = await web.upload({ media: Buffer.from('reviewed-original'), caption: 'Original', render: { width: 1080, height: 1920, durationSeconds: 7.5 }, onReceipt: async () => {},
    prepared: { creationId: 'original-creation-12345', allocation: { Result: { InnerUploadAddress: { UploadNodes: [{ UploadHost: 'tos-quic-awsfr.tiktokcdn.com', StoreInfos: [{ StoreUri: 'tos-awsfr/test', Auth: 'fixture-storage-auth' }], Vid: 'vfixture123456', SessionKey: 'fixture-key' }] } } } } });
  assert.equal(result.creationId, 'original-creation-12345'); assert.equal(result.status, 'processing');
  assert.deepEqual(gatewayActions, ['CommitUploadInner']);
  assert.deepEqual(routes, ['/tiktok/web/project/post/v1/']);
});
