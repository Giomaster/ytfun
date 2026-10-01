import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { episodeAssetHash, episodeReviewHash } from '../src/domain.mjs';
import { Publisher } from '../src/publishing.mjs';
import { StudioStore } from '../src/store.mjs';

const CHANNEL = 'UCoriginalStudio';
const TOKEN = 'fixture-secret-oauth-token';
const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ytfun-publishing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'assets'));
  const fileContents = { 'render.mp4': Buffer.from('reviewed-original-render'), 'visual.png': Buffer.from('generated-visual'), 'audio.wav': Buffer.from('generated-narration') };
  for (const [name, bytes] of Object.entries(fileContents)) await writeFile(path.join(directory, 'assets', name), bytes);
  const store = new StudioStore(directory);
  const project = { id: 'project-1', title: 'Original fictional series', mode: 'fiction', status: 'active', budgetMonthlyUsd: null, cadence: { minHoursBetweenPosts: 24, maxPostsPerRollingDay: 1 } };
  const assets = [
    { id: 'visual-1', episodeId: 'episode-1', sceneId: 'scene-1', kind: 'image', path: 'assets/visual.png', sha256: digest(fileContents['visual.png']) },
    { id: 'audio-1', episodeId: 'episode-1', sceneId: 'scene-1', kind: 'audio', path: 'assets/audio.wav', sha256: digest(fileContents['audio.wav']) },
  ].map((asset) => ({ ...asset, synthetic: true, provenance: { provider: 'fixture', model: 'original-model', prompt: 'An original generated scene', commercialLicense: { url: 'https://example.com/model-license', notes: 'Commercial use permitted by the retained model license.' } } }));
  const episode = {
    id: 'episode-1', projectId: project.id, title: 'An original fictional adventure',
    hook: 'The city remembered tomorrow', synopsis: 'An invented protagonist makes a new choice.',
    originalAngle: 'A fictional timekeeper negotiates with a sentient clock.', continuityNote: 'Standalone first episode.',
    metadata: { description: 'An original synthetic fictional story.', hashtags: ['fiction', 'animation'] },
    factualSources: [], scenes: [{ id: 'scene-1', durationSeconds: 65, narration: 'The timekeeper found tomorrow in a clock.', visualPrompt: 'A fantastical timekeeper and a clock' }],
    render: { path: 'assets/render.mp4', sha256: digest(fileContents['render.mp4']), durationSeconds: 65, synthetic: true, sceneAssets: [{ sceneId: 'scene-1', visualAssetId: 'visual-1', audioAssetId: 'audio-1' }] },
    status: 'approved',
  };
  approve(episode, assets);
  await store.transaction((state) => { state.projects.push(project); state.episodes.push(episode); state.assets.push(...assets); });
  return { directory, store, episode, project, assets, bytes: fileContents['render.mp4'], env: { YOUTUBE_CHANNEL_ID: CHANNEL, YOUTUBE_ACCESS_TOKEN: TOKEN } };
}

function approve(episode, assets) {
  episode.approval = {
    reviewHash: episodeReviewHash(episode), assetReviewHash: episodeAssetHash(episode, assets), approvedAt: new Date().toISOString(),
    review: { originalityChecked: true, factsChecked: true, renderWatched: true, reviewedBy: 'Human creator', notes: 'Reviewed the completed original render.' },
  };
}

function successfulFetch({ privacy = 'private', publishAt, onInit, onUpload, location = SESSION } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).includes('/youtube/v3/channels?')) return Response.json({ items: [{ id: CHANNEL }] });
    if (options.method === 'POST') {
      await onInit?.();
      return new Response(null, { status: 200, headers: { location } });
    }
    await onUpload?.();
    return Response.json({ id: 'original123', status: { uploadStatus: 'uploaded', privacyStatus: privacy, ...(publishAt ? { publishAt } : {}) } });
  };
  return { calls, fetchImpl };
}

function args(f, extra = {}) {
  return { episodeId: f.episode.id, privacy: 'private', expectedReviewHash: f.episode.approval.reviewHash, madeForKids: false, execute: true, ...extra };
}

test('preview verifies reviewed media without invoking a remote endpoint or reserving an upload', async (t) => {
  const f = await fixture(t);
  const publisher = new Publisher(f.store, { env: f.env, fetchImpl: () => { throw new Error('Unexpected remote request'); } });
  const plan = await publisher.publishYouTube(args(f, { execute: false }));
  assert.equal(plan.ready, true);
  assert.equal(plan.execute, false);
  assert.equal(plan.disclosure.synthetic, true);
  assert.deepEqual((await f.store.read()).publications, []);
  assert.equal(JSON.stringify(plan).includes(TOKEN), false);
});

test('private upload does not require a public audit flag and is never reported as published', async (t) => {
  const f = await fixture(t);
  const remote = successfulFetch();
  const publisher = new Publisher(f.store, { env: f.env, fetchImpl: remote.fetchImpl });
  const result = await publisher.publishYouTube(args(f));
  assert.equal(result.publication.status, 'uploaded');
  assert.equal(result.publication.url, undefined);
  assert.equal(remote.calls.length, 3);
  const init = JSON.parse(remote.calls[1].options.body);
  assert.equal(init.status.containsSyntheticMedia, true);
  assert.equal(init.status.selfDeclaredMadeForKids, false);
  assert.equal(init.status.privacyStatus, 'private');
  assert.deepEqual(remote.calls[2].options.body, f.bytes);
  assert.ok(remote.calls.every((call) => call.options.redirect === 'error'));
});

test('public and unlisted uploads need both explicit release enablement and confirmed API audit', async (t) => {
  const f = await fixture(t);
  for (const privacy of ['public', 'unlisted']) {
    for (const flags of [{}, { YTFUN_YOUTUBE_PUBLIC_ENABLED: 'true' }, { YTFUN_YOUTUBE_AUDIT_CONFIRMED: 'true' }]) {
      const publisher = new Publisher(f.store, { env: { ...f.env, ...flags }, fetchImpl: () => { throw new Error('Unexpected request'); } });
      await assert.rejects(publisher.publishYouTube(args(f, { privacy })), /confirmed YouTube API audit/);
    }
  }
  assert.deepEqual((await f.store.read()).publications, []);
});

test('scheduling from private privacy also needs the public gate and confirms a private scheduled resource', async (t) => {
  const f = await fixture(t);
  const publishAt = new Date(Date.now() + 48 * 3_600_000).toISOString();
  const blocked = new Publisher(f.store, { env: f.env, fetchImpl: () => { throw new Error('Unexpected request'); } });
  await assert.rejects(blocked.publishYouTube(args(f, { publishAt })), /confirmed YouTube API audit/);
  const remote = successfulFetch({ privacy: 'private', publishAt });
  const publisher = new Publisher(f.store, { env: { ...f.env, YTFUN_YOUTUBE_PUBLIC_ENABLED: 'true', YTFUN_YOUTUBE_AUDIT_CONFIRMED: 'true' }, fetchImpl: remote.fetchImpl });
  const result = await publisher.publishYouTube(args(f, { publishAt }));
  assert.equal(result.publication.status, 'scheduled');
  assert.equal(result.publication.url, undefined);
  assert.equal(result.publication.effectiveAt, publishAt);
  assert.equal(JSON.parse(remote.calls[1].options.body).status.privacyStatus, 'private');
  assert.equal(JSON.parse(remote.calls[1].options.body).status.publishAt, publishAt);
});

test('public visibility is reported only when the upload response actually confirms public privacy', async (t) => {
  const f = await fixture(t);
  const remote = successfulFetch({ privacy: 'private' });
  const publisher = new Publisher(f.store, { env: { ...f.env, YTFUN_YOUTUBE_PUBLIC_ENABLED: 'true', YTFUN_YOUTUBE_AUDIT_CONFIRMED: 'true' }, fetchImpl: remote.fetchImpl });
  const result = await publisher.publishYouTube(args(f, { privacy: 'public' }));
  assert.equal(result.publication.status, 'uploaded');
  assert.equal(result.publication.providerPrivacyStatus, 'private');
  assert.equal(result.publication.publishedAt, undefined);
});

test('public privacy alone is not a processed published video; sync requires owned processed status', async t => {
  const f = await fixture(t);
  const remote = successfulFetch({ privacy: 'public' });
  const env = { ...f.env, YTFUN_YOUTUBE_PUBLIC_ENABLED: 'true', YTFUN_YOUTUBE_AUDIT_CONFIRMED: 'true' };
  const publisher = new Publisher(f.store, { env, fetchImpl: remote.fetchImpl });
  const uploaded = await publisher.publishYouTube(args(f, { privacy: 'public' }));
  assert.equal(uploaded.publication.status, 'uploaded');
  assert.equal(uploaded.publication.publishedAt, undefined);
  const sync = new Publisher(f.store, { env, fetchImpl: async () => Response.json({ items: [{ id: uploaded.publication.videoId, snippet: { channelId: CHANNEL }, status: { privacyStatus: 'public', uploadStatus: 'processed' } }] }) });
  const published = await sync.syncPublication({ publicationId: uploaded.publication.id });
  assert.equal(published.status, 'published');
  assert.ok(published.publishedAt);
  const wrongChannel = new Publisher(f.store, { env, fetchImpl: async () => Response.json({ items: [{ id: uploaded.publication.videoId, snippet: { channelId: 'another-channel' }, status: { privacyStatus: 'public', uploadStatus: 'processed' } }] }) });
  await assert.rejects(wrongChannel.syncPublication({ publicationId: uploaded.publication.id }), /owned video/);
});

test('exported subtitles are bound to the reviewed caption hash', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'assets', 'captions.srt'), 'original caption');
  await f.store.transaction(state => {
    const episode = state.episodes[0];
    episode.render.captionsPath = 'assets/captions.srt';
    episode.render.captionsSha256 = digest(Buffer.from('original caption'));
    approve(episode, state.assets);
    f.episode = structuredClone(episode);
  });
  await writeFile(path.join(f.directory, 'assets', 'captions.srt'), 'changed caption');
  const publisher = new Publisher(f.store, { env: {} });
  await assert.rejects(publisher.exportTikTok({ episodeId: f.episode.id, expectedReviewHash: f.episode.approval.reviewHash }), /Subtitles changed/);
  assert.equal((await f.store.read()).publications.length, 0);
});

test('a changed script or stale caller fingerprint blocks upload before network requests', async (t) => {
  const f = await fixture(t);
  await f.store.transaction((state) => { state.episodes[0].title = 'An altered story'; });
  const publisher = new Publisher(f.store, { env: f.env, fetchImpl: () => { throw new Error('Unexpected request'); } });
  await assert.rejects(publisher.publishYouTube(args(f)), /Expected review fingerprint/);
  assert.deepEqual((await f.store.read()).publications, []);
});

test('changed asset bytes and changed license evidence invalidate human approval', async (t) => {
  const f = await fixture(t);
  await f.store.transaction((state) => { state.assets[0].provenance.commercialLicense.notes = 'Altered licensing evidence'; });
  const publisher = new Publisher(f.store, { env: f.env, fetchImpl: () => { throw new Error('Unexpected request'); } });
  let plan = await publisher.preflight({ episodeId: f.episode.id, platform: 'youtube', privacy: 'private' });
  assert.equal(plan.ready, false);
  assert.ok(plan.reasons.some((reason) => reason.includes('license evidence changed')));
  await f.store.transaction((state) => { state.assets[0].provenance.commercialLicense.notes = f.assets[0].provenance.commercialLicense.notes; });
  await writeFile(path.join(f.directory, 'assets/visual.png'), 'tampered-visual');
  plan = await publisher.preflight({ episodeId: f.episode.id, platform: 'youtube', privacy: 'private' });
  assert.ok(plan.reasons.some((reason) => reason.includes('scene asset is missing, changed')));
});

test('render path containment rejects a symlink to a file outside studio storage', async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'ytfun-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'outside.mp4'), f.bytes);
  await rm(path.join(f.directory, 'assets/render.mp4'));
  await symlink(path.join(outside, 'outside.mp4'), path.join(f.directory, 'assets/render.mp4'));
  const publisher = new Publisher(f.store, { env: f.env });
  const plan = await publisher.preflight({ episodeId: f.episode.id, platform: 'youtube', privacy: 'private' });
  assert.equal(plan.ready, false);
  assert.ok(plan.reasons.some((reason) => reason.includes('outside studio storage')));
});

test('channel ownership mismatch blocks the attempt before creating a reservation', async (t) => {
  const f = await fixture(t);
  const publisher = new Publisher(f.store, { env: f.env, fetchImpl: async () => Response.json({ items: [{ id: 'UCotherChannel' }] }) });
  await assert.rejects(publisher.publishYouTube(args(f)), /channel verification failed/);
  assert.deepEqual((await f.store.read()).publications, []);
});

test('unexpected resumable hosts never receive a Bearer token and remain reserved as unknown', async (t) => {
  const f = await fixture(t);
  const remote = successfulFetch({ location: 'https://attacker.example/upload/youtube/v3/videos' });
  const publisher = new Publisher(f.store, { env: f.env, fetchImpl: remote.fetchImpl });
  const result = await publisher.publishYouTube(args(f));
  assert.equal(result.publication.status, 'unknown');
  assert.equal(remote.calls.length, 2);
  assert.ok(remote.calls.every((call) => !String(call.url).includes('attacker.example')));
  assert.equal(JSON.stringify(await f.store.read()).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes('attacker.example'), false);
});

test('ambiguous network outcomes keep their reservation and cannot trigger a second upload', async (t) => {
  const f = await fixture(t);
  let remoteRequests = 0;
  const publisher = new Publisher(f.store, { env: f.env, fetchImpl: async (url) => {
    remoteRequests += 1;
    if (String(url).includes('/channels?')) return Response.json({ items: [{ id: CHANNEL }] });
    throw new Error(`Upstream diagnostic accidentally containing ${TOKEN}`);
  } });
  const first = await publisher.publishYouTube(args(f));
  assert.equal(first.publication.status, 'unknown');
  const second = await publisher.publishYouTube(args(f));
  assert.equal(second.duplicate, true);
  assert.equal(second.publication.id, first.publication.id);
  assert.equal(remoteRequests, 2);
  assert.equal(JSON.stringify(await f.store.read()).includes(TOKEN), false);
});

test('review changed during channel verification is checked again inside the reservation transaction', async (t) => {
  const f = await fixture(t);
  const publisher = new Publisher(f.store, { env: f.env, fetchImpl: async () => {
    await f.store.transaction((state) => { state.episodes[0].hook = 'A different hook after the preview'; });
    return Response.json({ items: [{ id: CHANNEL }] });
  } });
  await assert.rejects(publisher.publishYouTube(args(f)), /Episode changed/);
  assert.deepEqual((await f.store.read()).publications, []);
});

test('channel cadence includes other projects and upcoming unknown reservations', async (t) => {
  const f = await fixture(t);
  await f.store.transaction((state) => {
    state.projects.push({ ...f.project, id: 'project-2' });
    state.publications.push({ id: 'other-project-reservation', episodeId: 'other-episode', projectId: 'project-2', platform: 'youtube', accountId: CHANNEL,
      reviewHash: 'other-review', status: 'unknown', createdAt: new Date().toISOString(), effectiveAt: new Date(Date.now() + 2 * 3_600_000).toISOString() });
  });
  const publisher = new Publisher(f.store, { env: f.env });
  const plan = await publisher.preflight({ episodeId: f.episode.id, platform: 'youtube', privacy: 'private' });
  assert.equal(plan.ready, false);
  assert.ok(plan.reasons.some((reason) => reason.includes('24 hours between')));
  assert.ok(plan.reasons.some((reason) => reason.includes('rolling 24 hours')));
});

test('rolling-day cadence checks a window that ends at a later reservation', async (t) => {
  const f = await fixture(t);
  const candidate = Date.now() + 72 * 3_600_000;
  await f.store.transaction((state) => {
    state.projects[0].cadence = { minHoursBetweenPosts: 12, maxPostsPerRollingDay: 2 };
    for (const [id, offset] of [['earlier', -11], ['later', 11]]) {
      state.publications.push({ id, projectId: f.project.id, episodeId: id, platform: 'youtube', accountId: CHANNEL, status: 'scheduled', effectiveAt: new Date(candidate + offset * 3_600_000).toISOString() });
    }
  });
  const publisher = new Publisher(f.store, { env: { ...f.env, YTFUN_YOUTUBE_PUBLIC_ENABLED: 'true', YTFUN_YOUTUBE_AUDIT_CONFIRMED: 'true' } });
  const plan = await publisher.preflight({ episodeId: f.episode.id, platform: 'youtube', privacy: 'public', publishAt: new Date(candidate).toISOString() });
  assert.ok(plan.reasons.some((reason) => reason.includes('at most 2')));
});

test('TikTok export retains disclosure and hashes, deduplicates, and never counts as a published post', async (t) => {
  const f = await fixture(t);
  const publisher = new Publisher(f.store, { env: {}, fetchImpl: () => { throw new Error('Export must not contact TikTok'); } });
  const result = await publisher.exportTikTok({ episodeId: f.episode.id, expectedReviewHash: f.episode.approval.reviewHash });
  assert.equal(result.publication.status, 'exported');
  assert.equal(result.publication.effectiveAt, undefined);
  assert.equal(result.package.disclosure.isAigc, true);
  assert.equal(result.package.video.sha256, f.episode.render.sha256);
  assert.equal(result.package.monetization.eligibilityConfirmed, false);
  const saved = JSON.parse(await readFile(path.join(f.directory, result.publication.exportPath), 'utf8'));
  assert.equal(saved.caption, result.package.caption);
  assert.equal(saved.status, 'exported');
  const repeated = await publisher.exportTikTok({ episodeId: f.episode.id, expectedReviewHash: f.episode.approval.reviewHash });
  assert.equal(repeated.duplicate, true);
  assert.equal((await f.store.read()).publications.length, 1);
  assert.equal((await readdir(path.join(f.directory, 'exports'))).length, 1);
});

test('metadata limits and explicit child-directed selection block invalid requests', async (t) => {
  const f = await fixture(t);
  const publisher = new Publisher(f.store, { env: f.env });
  await assert.rejects(publisher.publishYouTube(args(f, { madeForKids: undefined })), /explicitly selected/);
  await f.store.transaction((state) => {
    state.episodes[0].title = 'x'.repeat(101);
    approve(state.episodes[0], state.assets);
  });
  const plan = await publisher.preflight({ episodeId: f.episode.id, platform: 'youtube', privacy: 'private' });
  assert.ok(plan.reasons.some((reason) => reason.includes('1 to 100')));
});

test('independent processes cannot reserve and upload the same reviewed episode twice', async (t) => {
  const f = await fixture(t);
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  const publisherUrl = pathToFileURL(path.resolve(sourceDirectory, '../src/publishing.mjs')).href;
  const storeUrl = pathToFileURL(path.resolve(sourceDirectory, '../src/store.mjs')).href;
  const script = `
    import { writeFile, readdir } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    import path from 'node:path';
    import { Publisher } from ${JSON.stringify(publisherUrl)};
    import { StudioStore } from ${JSON.stringify(storeUrl)};
    const directory = process.env.FIXTURE_DIRECTORY;
    const store = new StudioStore(directory);
    const state = await store.read();
    const publisher = new Publisher(store, { env: { YOUTUBE_CHANNEL_ID: ${JSON.stringify(CHANNEL)}, YOUTUBE_ACCESS_TOKEN: ${JSON.stringify(TOKEN)} }, fetchImpl: async (url, options = {}) => {
      if (String(url).includes('/channels?')) {
        await writeFile(path.join(directory, process.pid + '.ready'), 'ready');
        const deadline = Date.now() + 5000;
        while ((await readdir(directory)).filter(name => name.endsWith('.ready')).length < 2) {
          if (Date.now() > deadline) throw new Error('Fixture synchronization timed out');
          await delay(10);
        }
        return Response.json({ items: [{ id: ${JSON.stringify(CHANNEL)} }] });
      }
      if (options.method === 'POST') {
        await writeFile(path.join(directory, process.pid + '.upload-init'), 'reserved');
        return new Response(null, { status: 200, headers: { location: ${JSON.stringify(SESSION)} } });
      }
      return Response.json({ id: 'original123', status: { privacyStatus: 'private', uploadStatus: 'uploaded' } });
    } });
    try {
      const result = await publisher.publishYouTube({ episodeId: 'episode-1', privacy: 'private', madeForKids: false, expectedReviewHash: state.episodes[0].approval.reviewHash, execute: true });
      process.stdout.write(JSON.stringify({ status: result.publication.status, duplicate: result.duplicate ?? false }));
    } catch (error) {
      if (error.code !== 'STUDIO_BUSY') throw error;
      process.stdout.write(JSON.stringify({ status: 'busy' }));
    }
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, FIXTURE_DIRECTORY: f.directory }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let diagnostic = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { diagnostic += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Fixture child failed: ${diagnostic}`));
      else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } }
    });
  });
  const results = await Promise.all([run(), run()]);
  assert.ok(results.some((result) => result.status === 'uploaded'));
  assert.equal((await readdir(f.directory)).filter((name) => name.endsWith('.upload-init')).length, 1);
  assert.equal((await f.store.read()).publications.length, 1);
});
