import assert from 'node:assert/strict';
import test from 'node:test';
import { FacebookReels, validateFacebookReel } from '../src/facebook.mjs';

const PAGE = '1234567890';
const VIDEO = '9876543210';
const VERSION = 'v26.0';
const TOKEN = 'fixture-secret-page-oauth';
const MEDIA = Buffer.from('reviewed-render-fixture');
const env = {
  FACEBOOK_PAGE_ID: PAGE, FACEBOOK_PAGE_ACCESS_TOKEN: TOKEN, FACEBOOK_GRAPH_API_VERSION: VERSION,
  YTFUN_FACEBOOK_PUBLISH_ENABLED: 'true', YTFUN_FACEBOOK_APP_REVIEW_CONFIRMED: 'true',
};
const uploadedStatus = {
  id: VIDEO, from: { id: PAGE }, published: false,
  status: { video_status: 'processing', uploading_phase: { status: 'complete' }, processing_phase: { status: 'in_progress' }, publishing_phase: { status: 'not_started' } },
};
const publishedStatus = {
  id: VIDEO, from: { id: PAGE }, published: true,
  status: { video_status: 'ready', uploading_phase: { status: 'complete' }, processing_phase: { status: 'complete' }, publishing_phase: { status: 'complete' } },
};

function fixture(overrides = {}) {
  const calls = [];
  const response = (value) => value instanceof Response ? value : Response.json(value);
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/me')) return response(overrides.identity ?? { id: PAGE });
    if (parsed.hostname === 'rupload.facebook.com') {
      if (overrides.transferError) throw new Error(`Provider may echo ${TOKEN}`);
      return response(overrides.transfer ?? { success: true });
    }
    if (options.method === 'POST') {
      const phase = new URLSearchParams(options.body).get('upload_phase');
      if (phase === 'start') {
        if (overrides.startError) throw new Error(`Provider may echo ${TOKEN}`);
        return response(overrides.start ?? { video_id: VIDEO, upload_url: `https://rupload.facebook.com/video-upload/${VERSION}/${VIDEO}` });
      }
      if (overrides.finishError) throw new Error(`Provider may echo ${TOKEN}`);
      return response(overrides.finish ?? { success: true });
    }
    if (overrides.statusError) throw new Error(`Provider may echo ${TOKEN}`);
    return response(overrides.status ?? uploadedStatus);
  };
  return { calls, adapter: new FacebookReels({ env: overrides.env ?? env, fetchImpl }) };
}

const upload = (adapter, extra = {}) => adapter.upload({ media: MEDIA, caption: 'An original AI-made story. #AIMeow', synthetic: true, ...extra });

test('configuration readiness is local and does not expose credentials or imply authorization', () => {
  let called = false;
  const adapter = new FacebookReels({ env, fetchImpl: async () => { called = true; throw new Error('Unexpected call'); } });
  const result = adapter.readiness();
  assert.equal(result.ready, true);
  assert.equal(result.remoteAuthorizationVerified, false);
  assert.equal(called, false);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.equal(JSON.stringify(adapter), '{}');
  const missing = new FacebookReels({ env: {}, fetchImpl: fetch }).readiness();
  assert.equal(missing.ready, false);
  assert.equal(missing.accountId, null);
  assert.ok(missing.reasons.some((reason) => reason.includes('FACEBOOK_PAGE_ACCESS_TOKEN')));
  assert.ok(missing.reasons.some((reason) => reason.includes('FACEBOOK_GRAPH_API_VERSION')));
});

test('publishing gates and malformed IDs or version stop before any remote request', async () => {
  for (const changed of [
    { YTFUN_FACEBOOK_PUBLISH_ENABLED: 'false' }, { YTFUN_FACEBOOK_APP_REVIEW_CONFIRMED: 'false' },
    { FACEBOOK_PAGE_ID: '../another-page' }, { FACEBOOK_GRAPH_API_VERSION: 'v26.0/path' },
    { FACEBOOK_PAGE_ACCESS_TOKEN: `bad\n${TOKEN}` }, { YTFUN_MAX_UPLOAD_BYTES: '999999999999' },
  ]) {
    const f = fixture({ env: { ...env, ...changed } });
    await assert.rejects(upload(f.adapter));
    assert.equal(f.calls.length, 0);
  }
});

test('a personal or another Page token cannot start an upload', async () => {
  const f = fixture({ identity: { id: '1111111111', access_token: TOKEN } });
  await assert.rejects(upload(f.adapter), (error) => !error.message.includes(TOKEN) && /Page verification failed/.test(error.message));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.method, 'GET');
});

test('upload persists the video ID before transfer, submits AI disclosure, and confirms the published state', async () => {
  const f = fixture({ status: publishedStatus });
  const saved = [];
  const result = await upload(f.adapter, { onReceipt: async (value) => {
    saved.push({ value, requestCount: f.calls.length });
    assert.ok(!JSON.stringify(value).includes(TOKEN));
    assert.ok(!JSON.stringify(value).includes('rupload'));
  } });
  assert.equal(result.status, 'published');
  assert.equal(result.confirmed, true);
  assert.equal(result.videoId, VIDEO);
  assert.equal(result.syntheticDisclosureRequested, true);
  assert.equal(result.publishingRequested, true);
  assert.deepEqual(saved.map(({ value, requestCount }) => [value.phase, value.status, requestCount]), [
    ['start', 'unknown', 2], ['transfer', 'uploaded', 3], ['finish', 'processing', 4],
  ]);
  const posts = f.calls.filter((call) => call.options.method === 'POST');
  assert.equal(posts.length, 3);
  assert.equal(posts[0].url, `https://graph.facebook.com/${VERSION}/${PAGE}/video_reels`);
  assert.deepEqual([...new URLSearchParams(posts[0].options.body)], [['upload_phase', 'start']]);
  assert.equal(posts[1].options.body, MEDIA);
  assert.equal(posts[1].options.headers.Authorization, `OAuth ${TOKEN}`);
  assert.equal(posts[1].options.headers.file_size, String(MEDIA.length));
  assert.equal(posts[1].options.headers.offset, '0');
  const finish = new URLSearchParams(posts[2].options.body);
  assert.equal(finish.get('video_id'), VIDEO);
  assert.equal(finish.get('video_state'), 'PUBLISHED');
  assert.equal(finish.get('is_ai_generated'), 'true');
  assert.equal(finish.get('description'), 'An original AI-made story. #AIMeow');
  for (const call of f.calls) {
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.ok(!call.url.includes(TOKEN));
  }
});

test('finish acceptance and processing readiness do not become a published receipt', async () => {
  const f = fixture();
  const result = await upload(f.adapter);
  assert.equal(result.status, 'processing');
  assert.equal(result.publishingRequested, true);
  const readyOnly = fixture({ status: { id: VIDEO, from: { id: PAGE }, published: true, status: { video_status: 'ready' } } });
  assert.equal((await upload(readyOnly.adapter)).status, 'unknown');
  const draft = fixture({ status: { ...publishedStatus, published: false } });
  assert.equal((await upload(draft.adapter)).status, 'unknown');
});

test('unsafe or mismatched returned URLs never receive the Page token or bytes', async () => {
  for (const upload_url of [
    `https://attacker.invalid/video-upload/${VERSION}/${VIDEO}`,
    `https://rupload.facebook.com.attacker.invalid/video-upload/${VERSION}/${VIDEO}`,
    `http://rupload.facebook.com/video-upload/${VERSION}/${VIDEO}`,
    `https://user:password@rupload.facebook.com/video-upload/${VERSION}/${VIDEO}`,
    `https://rupload.facebook.com:444/video-upload/${VERSION}/${VIDEO}`,
    `https://rupload.facebook.com/video-upload/${VERSION}/${VIDEO}?access_token=${TOKEN}`,
    `https://rupload.facebook.com/video-upload/v25.0/${VIDEO}`,
    `https://rupload.facebook.com/video-upload/${VERSION}/1111111111`,
    `https://rupload.facebook.com/video-upload/${VERSION}/${VIDEO}#fragment`,
  ]) {
    const f = fixture({ start: { video_id: VIDEO, upload_url } });
    const result = await upload(f.adapter);
    assert.equal(result.status, 'unknown');
    assert.equal(result.videoId, VIDEO);
    assert.equal(f.calls.filter((call) => call.options.method === 'POST').length, 1);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.ok(!JSON.stringify(result).includes('attacker.invalid'));
  }
});

test('a failed durable receipt stops before further remote mutations', async () => {
  const f = fixture();
  const result = await upload(f.adapter, { onReceipt: async () => { throw new Error(`Could not save ${TOKEN}`); } });
  assert.equal(result.status, 'unknown');
  assert.equal(result.videoId, VIDEO);
  assert.equal(f.calls.length, 2);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('network uncertainty is sanitized and never retried at start, transfer or finish', async () => {
  for (const phase of ['start', 'transfer', 'finish']) {
    const f = fixture({ [`${phase}Error`]: true });
    const result = await upload(f.adapter);
    assert.equal(result.status, 'unknown');
    assert.equal(result.phase, phase);
    assert.equal(f.calls.filter((call) => call.options.method === 'POST').length, { start: 1, transfer: 2, finish: 3 }[phase]);
    if (phase !== 'start') assert.equal(result.videoId, VIDEO);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
});

test('a definitive initialization rejection is failed; throttling or malformed success remains unknown', async () => {
  for (const [response, expected] of [
    [Response.json({ error: { message: TOKEN } }, { status: 403 }), 'failed'],
    [Response.json({ error: { message: TOKEN } }, { status: 429 }), 'unknown'],
    [Response.json({ video_id: TOKEN, upload_url: 'https://attacker.invalid/' }), 'unknown'],
    [new Response(`<html>${TOKEN}</html>`), 'unknown'],
    [Response.json({ video_id: VIDEO, padding: 'x'.repeat(70_000) }), 'unknown'],
  ]) {
    const f = fixture({ start: response });
    const result = await upload(f.adapter);
    assert.equal(result.status, expected);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.equal(f.calls.length, 2);
  }
});

test('status requires the original Page and matching owned video, with sanitized phase enums', async () => {
  for (const changed of [{ id: '1111111111' }, { from: { id: '1111111111' } }, { from: undefined }]) {
    const f = fixture({ status: { ...publishedStatus, ...changed } });
    const result = await f.adapter.status({ videoId: VIDEO });
    assert.equal(result.status, 'unknown');
    assert.equal(result.confirmed, false);
  }
  const f = fixture({ status: { ...publishedStatus, status: { video_status: TOKEN, uploading_phase: { status: TOKEN }, processing_phase: { status: 'error', errors: [TOKEN] }, publishing_phase: { status: 'not_started' } } } });
  const result = await f.adapter.status({ videoId: VIDEO });
  assert.equal(result.status, 'failed');
  assert.equal(result.confirmed, true);
  assert.equal(result.providerVideoStatus, null);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.equal(f.calls.filter((call) => call.options.method === 'POST').length, 0);
  await assert.rejects(f.adapter.status({ videoId: '../other' }));
});

test('lost status response retains video ID and reports uncertainty after accepted finish', async () => {
  const f = fixture({ statusError: true });
  const result = await upload(f.adapter);
  assert.equal(result.status, 'unknown');
  assert.equal(result.videoId, VIDEO);
  assert.equal(result.publishingRequested, true);
  assert.equal(f.calls.filter((call) => call.options.method === 'POST').length, 3);
});

test('invalid media size, captions or synthetic declaration never initiate delivery', async () => {
  for (const extra of [{ media: Buffer.alloc(0) }, { media: new Uint8Array(10) }, { caption: '' }, { caption: 'x'.repeat(5001) }, { synthetic: false }]) {
    const f = fixture();
    await assert.rejects(upload(f.adapter, extra));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ env: { ...env, YTFUN_MAX_UPLOAD_BYTES: '2' } });
  await assert.rejects(upload(f.adapter));
  assert.equal(f.calls.length, 0);
});

test('the conservative Reel profile rejects unverified or oversized metadata', () => {
  const metadata = { durationSeconds: 60, width: 1080, height: 1920, framesPerSecond: 30, format: 'mp4' };
  assert.equal(validateFacebookReel(metadata).ready, true);
  for (const changed of [{ durationSeconds: 3.9 }, { durationSeconds: 60.1 }, { width: 1920, height: 1080 }, { framesPerSecond: 22 }, { format: 'mov' }, { height: 1080 }]) {
    assert.equal(validateFacebookReel({ ...metadata, ...changed }).ready, false);
  }
  assert.equal(validateFacebookReel().ready, false);
});
