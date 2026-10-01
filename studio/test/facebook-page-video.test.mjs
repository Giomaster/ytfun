import assert from 'node:assert/strict';
import test from 'node:test';
import { FacebookPageVideo, safeFacebookVideoPermalink, validateFacebookPageVideo, validateFacebookReel } from '../src/facebook.mjs';

const PAGE = '1234567890';
const VIDEO = '9876543210';
const SESSION = '1122334455';
const TOKEN = 'fixture-secret-page-token';
const VERSION = 'v26.0';
const MEDIA = Buffer.from('0123456789');
const URL = `https://www.facebook.com/${PAGE}/videos/${VIDEO}/`;
const env = { FACEBOOK_PAGE_ID: PAGE, FACEBOOK_PAGE_ACCESS_TOKEN: TOKEN, FACEBOOK_GRAPH_API_VERSION: VERSION,
  YTFUN_FACEBOOK_PUBLISH_ENABLED: 'true', YTFUN_FACEBOOK_APP_REVIEW_CONFIRMED: 'true' };
const published = { id: VIDEO, from: { id: PAGE }, published: true, permalink_url: URL, status: { video_status: 'ready' } };

function fixture(overrides = {}) {
  const calls = [];
  const saved = [];
  const bytes = overrides.media ?? MEDIA;
  const fetchImpl = async (url, options) => {
    const call = { url: String(url), options };
    calls.push(call);
    if (options.method === 'GET') {
      if (String(url).includes('/me?')) return Response.json(overrides.identity ?? { id: PAGE });
      if (overrides.statusError) throw new Error(TOKEN);
      return Response.json(overrides.status ?? published);
    }
    const phase = options.body.get ? options.body.get('upload_phase') : new URLSearchParams(options.body).get('upload_phase');
    if (phase === overrides.networkError) throw new Error(TOKEN);
    if (phase === 'start') return overrides.start instanceof Response ? overrides.start : Response.json(overrides.start ?? {
      video_id: VIDEO, upload_session_id: SESSION, start_offset: '0', end_offset: String(Math.min(5, bytes.length)),
    });
    if (phase === 'transfer') {
      assert.equal(saved[0]?.videoId, VIDEO, 'receipt must be saved before any bytes');
      const start = Number(options.body.get('start_offset'));
      const blob = options.body.get('video_file_chunk');
      call.bytes = Buffer.from(await blob.arrayBuffer());
      const next = start + blob.size;
      return overrides.transfer instanceof Response ? overrides.transfer : Response.json(overrides.transfer ?? {
        start_offset: String(next), end_offset: String(Math.min(next + 5, bytes.length)),
      });
    }
    return overrides.finish instanceof Response ? overrides.finish : Response.json(overrides.finish ?? { success: true });
  };
  const adapter = new FacebookPageVideo({ env: { ...env, ...overrides.env }, fetchImpl });
  const upload = (extra = {}) => adapter.upload({ media: bytes, caption: 'Original AI-made world. #AIMeow', title: 'An original reveal', synthetic: true,
    onReceipt: async (value) => { saved.push(value); await overrides.onReceipt?.(value); }, ...extra });
  return { calls, saved, adapter, upload };
}

test('long Page Video profile is separate from Reels and exposes its operational limit honestly', () => {
  const render = { durationSeconds: 720, width: 1080, height: 1920, framesPerSecond: 30, format: 'mp4' };
  assert.equal(validateFacebookPageVideo(render).ready, true);
  assert.equal(validateFacebookReel(render).ready, false);
  for (const changed of [{ durationSeconds: 901 }, { durationSeconds: 3 }, { width: 1920, height: 1080 }, { format: 'mov' }, { framesPerSecond: 22 }]) {
    assert.equal(validateFacebookPageVideo({ ...render, ...changed }).ready, false);
  }
  const readiness = fixture().adapter.readiness();
  assert.equal(readiness.videoKind, 'page_video');
  assert.equal(readiness.providerDurationLimitVerified, false);
  assert.equal(readiness.studioMaxDurationSeconds, 900);
  assert.equal(readiness.maxChunkBytes, 8 * 1024 * 1024);
  assert.equal(readiness.remoteAuthorizationVerified, false);
  assert.ok(!JSON.stringify(readiness).includes(TOKEN));
});

test('Page Video persists start receipt before contiguous chunks, sets AI disclosure and uses the returned owned permalink', async () => {
  const f = fixture();
  const result = await f.upload();
  assert.equal(result.status, 'published');
  assert.equal(result.confirmed, true);
  assert.equal(result.url, URL);
  assert.equal(result.syntheticDisclosureRequested, true);
  assert.deepEqual(f.saved.map(value => [value.phase, value.status]), [['start', 'unknown'], ['transfer', 'uploaded'], ['finish', 'processing']]);
  const posts = f.calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 4);
  assert.ok(posts.every(call => call.url === `https://graph-video.facebook.com/${VERSION}/${PAGE}/videos`));
  assert.deepEqual([...new URLSearchParams(posts[0].options.body)], [['upload_phase', 'start'], ['file_size', '10']]);
  assert.deepEqual(Buffer.concat(posts.filter(call => call.bytes).map(call => call.bytes)), MEDIA);
  assert.deepEqual(posts.filter(call => call.bytes).map(call => call.options.body.get('start_offset')), ['0', '5']);
  for (const chunk of posts.filter(call => call.bytes)) {
    assert.equal(chunk.options.body.get('upload_session_id'), SESSION);
    assert.ok(chunk.bytes.length <= 8 * 1024 * 1024);
    assert.equal(chunk.options.headers['Content-Type'], undefined, 'fetch supplies the multipart boundary');
  }
  const finish = new URLSearchParams(posts.at(-1).options.body);
  assert.equal(finish.get('upload_phase'), 'finish');
  assert.equal(finish.get('upload_session_id'), SESSION);
  assert.equal(finish.get('published'), 'true');
  assert.equal(finish.get('is_ai_generated'), 'true');
  assert.equal(finish.get('title'), 'An original reveal');
  assert.equal(finish.get('description'), 'Original AI-made world. #AIMeow');
  for (const call of f.calls) {
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.ok(!call.url.includes(TOKEN));
    assert.equal(call.options.headers.Authorization, `Bearer ${TOKEN}`);
  }
  assert.ok(!JSON.stringify(result).includes(SESSION));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('storage failure after start or accepted transfer prevents the next remote mutation', async () => {
  for (const failedPhase of ['start', 'transfer']) {
    const f = fixture({ onReceipt: value => { if (value.phase === failedPhase) throw new Error(TOKEN); } });
    const result = await f.upload();
    assert.equal(result.status, 'unknown');
    assert.equal(result.videoId, VIDEO);
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, failedPhase === 'start' ? 1 : 3);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
});

test('network uncertainty never repeats start, transfer or finish', async () => {
  for (const phase of ['start', 'transfer', 'finish']) {
    const f = fixture({ networkError: phase });
    const result = await f.upload();
    assert.equal(result.status, 'unknown');
    assert.equal(result.phase, phase);
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, { start: 1, transfer: 2, finish: 4 }[phase]);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
});

test('invalid session/range, oversized chunk and noncontiguous progress stop before finish', async () => {
  for (const changed of [{ upload_session_id: `https://attacker.invalid/${TOKEN}` }, { start_offset: '1' }, { end_offset: '11' }, { end_offset: '0' }, { end_offset: '5.5' }]) {
    const f = fixture({ start: { video_id: VIDEO, upload_session_id: SESSION, start_offset: '0', end_offset: '5', ...changed } });
    assert.equal((await f.upload()).status, 'unknown');
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  }
  const huge = fixture({ media: Buffer.alloc(8 * 1024 * 1024 + 1), start: { video_id: VIDEO, upload_session_id: SESSION, start_offset: '0', end_offset: String(8 * 1024 * 1024 + 1) } });
  assert.equal((await huge.upload()).status, 'unknown');
  assert.equal(huge.calls.filter(call => call.options.method === 'POST').length, 1);
  for (const transfer of [{ start_offset: '0', end_offset: '5' }, { start_offset: '6', end_offset: '10' }, { start_offset: '5', end_offset: '11' }]) {
    const f = fixture({ transfer });
    assert.equal((await f.upload()).status, 'unknown');
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 2);
  }
});

test('owned public visibility, ready processing and a safe permalink are required', async () => {
  for (const changed of [{ from: { id: '99999' } }, { id: '99999' }, { from: undefined }, { permalink_url: undefined }, { permalink_url: 'https://attacker.invalid/' }, { permalink_url: `${URL}?access_token=${TOKEN}` }, { status: { video_status: TOKEN } }, { status: { video_status: 'ready', processing_phase: { status: TOKEN } } }]) {
    const f = fixture({ status: { ...published, ...changed } });
    const result = await f.adapter.status({ videoId: VIDEO });
    assert.equal(result.status, 'unknown');
    assert.equal(result.url, undefined);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.ok(f.calls.every(call => call.options.method === 'GET'));
  }
  assert.equal((await fixture({ status: { ...published, published: false } }).adapter.status({ videoId: VIDEO })).status, 'uploaded');
  assert.equal((await fixture({ status: { ...published, status: { video_status: 'processing' } } }).adapter.status({ videoId: VIDEO })).status, 'processing');
  assert.equal((await fixture({ status: { ...published, status: { video_status: 'ready', processing_phase: { status: 'in_progress' } } } }).adapter.status({ videoId: VIDEO })).status, 'processing');
  assert.equal((await fixture({ status: { ...published, status: { video_status: 'error', errors: [TOKEN] } } }).adapter.status({ videoId: VIDEO })).status, 'failed');
  assert.equal((await fixture({ statusError: true }).upload()).status, 'unknown');
});

test('permalinks must use an exact official host and the current video ID, with no signed or extra query', () => {
  assert.equal(safeFacebookVideoPermalink(`https://www.facebook.com/watch/?v=${VIDEO}`, VIDEO), `https://www.facebook.com/watch/?v=${VIDEO}`);
  assert.equal(safeFacebookVideoPermalink(`https://www.facebook.com/ai.meow/videos/${VIDEO}/`, VIDEO), `https://www.facebook.com/ai.meow/videos/${VIDEO}/`);
  for (const value of [`https://facebook.com.attacker.invalid/reel/${VIDEO}`, `https://user:password@facebook.com/reel/${VIDEO}`, `http://facebook.com/reel/${VIDEO}`, `https://facebook.com:444/reel/${VIDEO}`, `${URL}#private`, `https://facebook.com/reel/123`, `https://facebook.com/watch/?v=${VIDEO}&token=${TOKEN}`]) {
    assert.equal(safeFacebookVideoPermalink(value, VIDEO), null);
  }
});

test('flags, wrong Page, missing receipt callback and excessive media stop before any upload', async () => {
  for (const changed of [{ YTFUN_FACEBOOK_PUBLISH_ENABLED: 'false' }, { YTFUN_FACEBOOK_APP_REVIEW_CONFIRMED: 'false' }, { YTFUN_MAX_UPLOAD_BYTES: '2' }]) {
    const f = fixture({ env: changed });
    await assert.rejects(f.upload());
    assert.equal(f.calls.length, 0);
  }
  const callback = fixture();
  await assert.rejects(callback.upload({ onReceipt: undefined }));
  assert.equal(callback.calls.length, 0);
  const wrong = fixture({ identity: { id: '99999' } });
  await assert.rejects(wrong.upload(), /Page verification failed/);
  assert.ok(wrong.calls.every(call => call.options.method === 'GET'));
});

test('provider rejection bodies and oversized initialization responses never leak or trigger another POST', async () => {
  for (const [start, expected] of [[Response.json({ error: { message: TOKEN, session: SESSION } }, { status: 403 }), 'failed'],
    [Response.json({ error: { message: TOKEN } }, { status: 429 }), 'unknown'],
    [Response.json({ video_id: VIDEO, upload_session_id: SESSION, start_offset: '0', end_offset: '5', padding: 'x'.repeat(70_000) }), 'unknown']]) {
    const f = fixture({ start });
    const result = await f.upload();
    assert.equal(result.status, expected);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.ok(!JSON.stringify(result).includes(SESSION));
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  }
});
