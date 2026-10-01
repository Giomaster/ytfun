import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StudioStore } from '../src/store.mjs';
import { Studio } from '../src/domain.mjs';
import { Production } from '../src/production.mjs';

// Small signatures are intentional: these tests exercise contracts with a fake
// inference client/process runner. They never perform inference or media encoding.
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const WAV = Buffer.from('RIFF0000WAVEfmt mock narration');
const MP4 = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom000000000000')]);
const license = { url: 'https://provider.example/model-license', notes: 'Commercial generation permitted for this model; all inputs are synthetic or licensed.' };
const provenance = { provider: 'studio-example', model: 'licensed-model', prompt: 'An original fictional clock city.', synthetic: true, commercialLicense: license };
const env = { HF_TOKEN: 'fake-token', FFMPEG_PATH: 'fake-ffmpeg', FFPROBE_PATH: 'fake-ffprobe' };

async function setup(t, { budgetMonthlyUsd = null, sceneCount = 1 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-production-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StudioStore(directory);
  const studio = new Studio(store);
  const project = await studio.createProject({ title: 'Clock city', premise: 'A fictional miniature city', audience: 'Fantasy fans', language: 'pt-BR', budgetMonthlyUsd });
  const episode = await studio.planEpisode({ projectId: project.id, title: 'The last clock wakes', hook: 'Time returns to a sleeping city.', synopsis: 'The clock wakes its inhabitants.', originalAngle: 'An original miniature clock-city mythology.', scenes: Array.from({ length: sceneCount }, (_, index) => ({ durationSeconds: 3, narration: `O relógio ${index + 1} acordou a cidade.`, visualPrompt: `An original tiny clock city, scene ${index + 1}` })), metadata: { description: 'An original AI-generated fictional episode.', hashtags: ['#FicçãoIA'] } });
  return { directory, store, studio, project, episode };
}

function generation(episode, overrides = {}) {
  return { episodeId: episode.id, sceneId: episode.scenes[0].id, kind: 'image', model: 'example/licensed-model', provider: 'hf-inference', estimatedCostUsd: 0, pricingSourceUrl: 'https://provider.example/pricing', commercialLicense: license, ...overrides };
}

async function addSourceAssets(context, production, { alsoVideo = false } = {}) {
  const sourceImage = join(context.directory, 'source.png');
  const sourceAudio = join(context.directory, 'source.wav');
  const sourceVideo = join(context.directory, 'source.mp4');
  await writeFile(sourceImage, PNG);
  await writeFile(sourceAudio, WAV);
  await writeFile(sourceVideo, MP4);
  const registered = [];
  for (const scene of context.episode.scenes) {
    const base = { episodeId: context.episode.id, sceneId: scene.id, provenance };
    const image = await production.registerAsset({ ...base, kind: 'image', localPath: sourceImage });
    const audio = await production.registerAsset({ ...base, kind: 'audio', localPath: sourceAudio });
    const video = alsoVideo ? await production.registerAsset({ ...base, kind: 'video', localPath: sourceVideo }) : null;
    registered.push({ image, audio, video });
  }
  return registered;
}

function fakeRenderer(durationSeconds, { audioDuration = 2, onEncode } = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    const path = args.at(-1);
    if (command === env.FFPROBE_PATH) {
      const final = /render-[^/]+\.mp4$/.test(path);
      const audio = /\.wav$/.test(path);
      return { exitCode: 0, stdout: JSON.stringify({ format: { duration: String(final ? durationSeconds : audio ? audioDuration : 3) }, streams: audio ? [{ codec_type: 'audio', duration: String(audioDuration) }] : final ? [{ codec_type: 'video', width: 1080, height: 1920, avg_frame_rate: '30/1' }, { codec_type: 'audio', duration: String(durationSeconds) }] : [{ codec_type: 'video', width: 720, height: 1280 }] }) };
    }
    assert.equal(command, env.FFMPEG_PATH);
    if (onEncode) await onEncode({ args, options, path });
    await writeFile(path, MP4);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

test('free-first generation reserves before cloud inference and stores licensing evidence', async (t) => {
  const context = await setup(t);
  let received;
  const production = new Production(context.store, { env, inferenceClient: { textToImage: async (args, options) => {
    received = { args, options };
    const state = await context.store.read();
    assert.equal(state.spending.length, 1);
    assert.equal(state.spending[0].status, 'reserved');
    return new Blob([PNG], { type: 'image/png' });
  } } });
  const asset = await production.generateAsset(generation(context.episode));
  assert.deepEqual(received, { args: { model: 'example/licensed-model', provider: 'hf-inference', inputs: context.episode.scenes[0].visualPrompt }, options: { outputType: 'blob' } });
  assert.equal(asset.synthetic, true);
  assert.deepEqual(asset.provenance.commercialLicense, license);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assert.match(asset.path, /^assets\/[^/]+\.png$/);
  assert.deepEqual(await readFile(resolve(context.directory, asset.path)), PNG);
  const state = await context.store.read();
  assert.equal(state.projects[0].budgetMonthlyUsd, null);
  assert.equal(state.spending[0].status, 'completed');
  assert.equal(state.spending[0].assetId, asset.id);
  assert.match(state.spending[0].priceNote, /zero does not prove/);
  assert.equal(state.episodes[0].approval, null);
});

test('positive costs need both a per-call acknowledgment and the operator switch', async (t) => {
  const context = await setup(t);
  let requests = 0;
  const client = { textToImage: async () => { requests += 1; return new Blob([PNG], { type: 'image/png' }); } };
  const disabled = new Production(context.store, { env, inferenceClient: client });
  await assert.rejects(disabled.generateAsset(generation(context.episode, { estimatedCostUsd: 0.2 })), /Paid generation/);
  await assert.rejects(disabled.generateAsset(generation(context.episode, { estimatedCostUsd: 0.2, acknowledgePaidCost: true })), /Paid generation/);
  const enabled = new Production(context.store, { env: { ...env, YTFUN_PAID_GENERATION_ENABLED: 'true' }, inferenceClient: client });
  await assert.rejects(enabled.generateAsset(generation(context.episode, { estimatedCostUsd: 0.2 })), /Paid generation/);
  assert.equal(requests, 0);
  assert.equal((await context.store.read()).spending.length, 0);
  await enabled.generateAsset(generation(context.episode, { estimatedCostUsd: 0.2, acknowledgePaidCost: true }));
  assert.equal(requests, 1);
});

test('a caller may set an optional ceiling; pending and completed estimates count toward it', async (t) => {
  const context = await setup(t, { budgetMonthlyUsd: 0.3, sceneCount: 2 });
  let requests = 0;
  const production = new Production(context.store, { env: { ...env, YTFUN_PAID_GENERATION_ENABLED: 'true' }, inferenceClient: { textToImage: async () => { requests += 1; return new Blob([PNG], { type: 'image/png' }); } } });
  await production.generateAsset(generation(context.episode, { estimatedCostUsd: 0.2, acknowledgePaidCost: true }));
  await assert.rejects(production.generateAsset(generation(context.episode, { sceneId: context.episode.scenes[1].id, estimatedCostUsd: 0.2, acknowledgePaidCost: true })), /monthly project budget/);
  assert.equal(requests, 1);
  assert.equal((await context.store.read()).spending.length, 1);
});

test('failed cloud calls keep an unknown billing outcome and block blind retry or rendering', async (t) => {
  const context = await setup(t);
  let requests = 0;
  const production = new Production(context.store, { env, inferenceClient: { textToImage: async () => { requests += 1; throw new Error('Provider transport failed: Authorization Bearer secret-provider-token'); } } });
  await assert.rejects(production.generateAsset(generation(context.episode)), (error) => {
    assert.match(error.message, /Generation failed after reservation/);
    assert.doesNotMatch(error.message, /secret-provider-token|Authorization|transport failed/);
    return true;
  });
  const state = await context.store.read();
  assert.equal(state.spending[0].status, 'unknown');
  assert.doesNotMatch(JSON.stringify(state), /secret-provider-token/);
  assert.equal(state.assets.length, 0);
  await assert.rejects(production.generateAsset(generation(context.episode)), /unknown charge outcome/);
  await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), /outstanding generation/);
  assert.equal(requests, 1);
});

test('models, explicit providers, token, estimate and commercial license are required before requests', async (t) => {
  const context = await setup(t);
  const production = new Production(context.store, { env, inferenceClient: { textToImage: async () => { assert.fail('No inference request is permitted'); } } });
  for (const overrides of [{ model: '' }, { provider: 'auto' }, { provider: '' }, { estimatedCostUsd: undefined }, { estimatedCostUsd: NaN }, { estimatedCostUsd: -1 }, { pricingSourceUrl: 'file:///tmp/prices' }, { commercialLicense: { url: license.url, notes: '' } }, { commercialLicense: { url: 'https://user:secret@example.com', notes: license.notes } }, { kind: 'photo' }]) {
    await assert.rejects(production.generateAsset(generation(context.episode, overrides)));
  }
  await assert.rejects(new Production(context.store, { env: {}, inferenceClient: {} }).generateAsset(generation(context.episode)), /HF_TOKEN/);
  assert.equal((await context.store.read()).spending.length, 0);
});

test('text-to-speech uses scene narration and text-to-video accepts only a media Blob', async (t) => {
  const context = await setup(t);
  const received = [];
  const production = new Production(context.store, { env, inferenceClient: {
    textToSpeech: async (args) => { received.push(args); return new Blob([WAV], { type: 'audio/wav' }); },
    textToVideo: async (args) => { received.push(args); return new Blob([MP4], { type: 'video/mp4' }); },
  } });
  const audio = await production.generateAsset(generation(context.episode, { kind: 'audio' }));
  const video = await production.generateAsset(generation(context.episode, { kind: 'video', prompt: 'Explicit video motion prompt' }));
  assert.equal(received[0].inputs, context.episode.scenes[0].narration);
  assert.equal(received[1].inputs, 'Explicit video motion prompt');
  assert.match(audio.path, /\.wav$/);
  assert.match(video.path, /\.mp4$/);
});

test('remote URL strings, oversized Blobs and mismatched media headers fail closed', async (t) => {
  class OversizedBlob extends Blob { get size() { return 100 * 1024 * 1024 + 1; } }
  for (const output of ['https://provider.example/video.mp4', new Blob([PNG], { type: 'text/html' }), new Blob([WAV], { type: 'image/png' }), new Blob([]), new OversizedBlob([PNG], { type: 'image/png' })]) {
    const context = await setup(t);
    const production = new Production(context.store, { env, inferenceClient: { textToImage: async () => output } });
    await assert.rejects(production.generateAsset(generation(context.episode)));
    assert.equal((await context.store.read()).spending[0].status, 'unknown');
    assert.equal((await context.store.read()).assets.length, 0);
  }
});

test('a reserved generation excludes overlapping attempts for the same scene and kind', async (t) => {
  const context = await setup(t);
  let finish;
  let entered;
  const enteredPromise = new Promise((accept) => { entered = accept; });
  const response = new Promise((accept) => { finish = accept; });
  const production = new Production(context.store, { env, inferenceClient: { textToImage: async () => { entered(); return response; } } });
  const first = production.generateAsset(generation(context.episode));
  await enteredPromise;
  try {
    await assert.rejects(production.generateAsset(generation(context.episode)), /reserved/);
  } finally {
    finish(new Blob([PNG], { type: 'image/png' }));
  }
  await first;
  assert.equal((await context.store.read()).spending.length, 1);
});

test('registration copies a regular local file, retains evidence, and clears any approval/render', async (t) => {
  const context = await setup(t);
  const production = new Production(context.store, { env });
  const path = join(context.directory, 'input.png');
  await writeFile(path, PNG);
  await context.store.transaction((state) => { state.episodes[0].status = 'approved'; state.episodes[0].approval = { reviewHash: 'old' }; state.episodes[0].render = { path: 'old' }; });
  const asset = await production.registerAsset({ episodeId: context.episode.id, sceneId: context.episode.scenes[0].id, kind: 'image', localPath: path, provenance });
  await writeFile(path, Buffer.from('source changed'));
  assert.deepEqual(await readFile(resolve(context.directory, asset.path)), PNG);
  assert.deepEqual(asset.provenance.commercialLicense, license);
  assert.equal(asset.synthetic, true);
  const updated = await context.studio.getEpisode(context.episode.id);
  assert.equal(updated.status, 'planned');
  assert.equal(updated.approval, null);
  assert.equal(updated.render, null);
});

test('registration rejects unattested inputs, URLs, directories, wrong media and published mutation', async (t) => {
  const context = await setup(t);
  const production = new Production(context.store, { env });
  const path = join(context.directory, 'input.png');
  await writeFile(path, PNG);
  const input = { episodeId: context.episode.id, sceneId: context.episode.scenes[0].id, kind: 'image', localPath: path, provenance };
  await assert.rejects(production.registerAsset({ ...input, provenance: { ...provenance, synthetic: false } }), /synthetic=true/);
  await assert.rejects(production.registerAsset({ ...input, localPath: 'https://example.com/input.png' }), /absolute local file/);
  await assert.rejects(production.registerAsset({ ...input, localPath: context.directory }), /regular nonempty file/);
  await assert.rejects(production.registerAsset({ ...input, kind: 'audio' }), /supported audio/);
  await context.store.transaction((state) => { state.episodes[0].status = 'published'; });
  await assert.rejects(production.registerAsset(input), /published/);
  assert.equal((await context.store.read()).assets.length, 0);
});

test('reserved, uncertain and completed publication lifecycles freeze production regardless of episode status', async (t) => {
  const context = await setup(t);
  const production = new Production(context.store, { env, inferenceClient: { textToImage: async () => { assert.fail('No cloud call is permitted'); } }, runner: async () => { assert.fail('No encoder is permitted'); } });
  const path = join(context.directory, 'input.png');
  await writeFile(path, PNG);
  for (const status of ['reserved', 'uploading', 'sending', 'unknown', 'uploaded', 'scheduled', 'published']) {
    await context.store.transaction((state) => { state.episodes[0].status = 'rendered'; state.publications = [{ id: 'publication-fixture', episodeId: context.episode.id, status }]; });
    await assert.rejects(production.generateAsset(generation(context.episode)), /publication/);
    await assert.rejects(production.registerAsset({ episodeId: context.episode.id, sceneId: context.episode.scenes[0].id, kind: 'image', localPath: path, provenance }), /publication/);
    await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), /publication/);
  }
  assert.equal((await context.store.read()).spending.length, 0);
});

test('inactive projects cannot spend or register/render assets', async (t) => {
  const context = await setup(t);
  const production = new Production(context.store, { env, inferenceClient: {} });
  const path = join(context.directory, 'input.png');
  await writeFile(path, PNG);
  await context.store.transaction((state) => { state.projects[0].status = 'archived'; });
  await assert.rejects(production.generateAsset(generation(context.episode)), /project must be active/);
  await assert.rejects(production.registerAsset({ episodeId: context.episode.id, sceneId: context.episode.scenes[0].id, kind: 'image', localPath: path, provenance }), /project must be active/);
  await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), /project must be active/);
  assert.equal((await context.store.read()).spending.length, 0);
});

test('render requires every visual and voice asset before reserving the episode', async (t) => {
  const context = await setup(t);
  const production = new Production(context.store, { env, runner: async () => { assert.fail('Renderer must not start'); } });
  await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), /requires synthetic visual and narration/);
  assert.equal((await context.studio.getEpisode(context.episode.id)).status, 'planned');
});

test('render composes vertical scenes with voice and approximate subtitles, prefers generated video, and requires later review', async (t) => {
  const context = await setup(t, { sceneCount: 2 });
  const fake = fakeRenderer(6);
  const production = new Production(context.store, { env, runner: fake.runner });
  const sources = await addSourceAssets(context, production, { alsoVideo: true });
  const render = await production.renderEpisode({ episodeId: context.episode.id });
  assert.equal(render.durationSeconds, 6);
  assert.equal(render.synthetic, true);
  assert.equal(render.captionsTiming, 'scene-approximate');
  assert.equal(render.visualMethod, 'generated-video');
  assert.deepEqual(render.sceneAssets, context.episode.scenes.map((scene, index) => ({ sceneId: scene.id, visualAssetId: sources[index].video.id, audioAssetId: sources[index].audio.id })));
  const srt = await readFile(resolve(context.directory, render.captionsPath), 'utf8');
  assert.match(srt, /00:00:00,000 --> 00:00:03,000/);
  assert.match(srt, /00:00:03,000 --> 00:00:06,000/);
  const encoding = fake.calls.filter((call) => call.command === env.FFMPEG_PATH && !call.args.includes('concat'));
  assert.equal(encoding.length, 2);
  assert.ok(encoding.every((call) => call.args.includes('-stream_loop') && call.args.includes('1:a:0')));
  assert.ok(encoding.every((call) => call.args[call.args.indexOf('-vf') + 1].includes('subtitles=')));
  const updated = await context.studio.getEpisode(context.episode.id);
  assert.equal(updated.status, 'rendered');
  assert.equal(updated.approval, null);
  assert.equal(updated.renderAttempt.status, 'completed');
});

test('the low-cost image fallback adds deterministic motion without promising monetization', async (t) => {
  const context = await setup(t);
  const fake = fakeRenderer(3);
  const production = new Production(context.store, { env, runner: fake.runner });
  await addSourceAssets(context, production);
  const render = await production.renderEpisode({ episodeId: context.episode.id });
  assert.equal(render.visualMethod, 'includes-animated-images');
  const clipCall = fake.calls.find((call) => call.command === env.FFMPEG_PATH && call.args.includes('-loop'));
  assert.match(clipCall.args[clipCall.args.indexOf('-vf') + 1], /zoompan=/);
});

test('render rejects narration longer than its scene and records failure without an artifact', async (t) => {
  const context = await setup(t);
  const fake = fakeRenderer(3, { audioDuration: 3.2 });
  const production = new Production(context.store, { env, runner: fake.runner });
  await addSourceAssets(context, production);
  await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), /would truncate narration/);
  assert.equal(fake.calls.filter((call) => call.command === env.FFMPEG_PATH).length, 0);
  const updated = await context.studio.getEpisode(context.episode.id);
  assert.equal(updated.status, 'planned');
  assert.equal(updated.render, null);
  assert.equal(updated.renderAttempt.status, 'failed');
});

test('render verifies registered source bytes before invoking an encoder', async (t) => {
  const context = await setup(t);
  const fake = fakeRenderer(3);
  const production = new Production(context.store, { env, runner: fake.runner });
  const [sources] = await addSourceAssets(context, production);
  await writeFile(resolve(context.directory, sources.image.path), Buffer.from('changed'));
  await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), /changed on disk/);
  assert.equal(fake.calls.length, 0);
});

test('editorial changes during encoding prevent a stale render from committing', async (t) => {
  const context = await setup(t);
  let changed = false;
  const fake = fakeRenderer(3, { onEncode: async () => {
    if (changed) return;
    changed = true;
    await context.store.transaction((state) => { state.episodes[0].metadata.description = 'Edited during render'; });
  } });
  const production = new Production(context.store, { env, runner: fake.runner });
  await addSourceAssets(context, production);
  await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), /changed during rendering/);
  const updated = await context.studio.getEpisode(context.episode.id);
  assert.equal(updated.render, null);
  assert.equal(updated.approval, null);
  assert.equal(updated.renderAttempt.status, 'failed');
  assert.equal(updated.metadata.description, 'Edited during render');
});

test('metrics recorded during encoding do not invalidate the editorial snapshot', async (t) => {
  const context = await setup(t);
  let changed = false;
  const fake = fakeRenderer(3, { onEncode: async () => {
    if (changed) return;
    changed = true;
    await context.studio.recordMetrics({ episodeId: context.episode.id, platform: 'youtube', views: 0, observedAt: new Date().toISOString(), sourceUrl: 'https://studio.youtube.com/example' });
  } });
  const production = new Production(context.store, { env, runner: fake.runner });
  await addSourceAssets(context, production);
  await production.renderEpisode({ episodeId: context.episode.id });
  assert.equal((await context.studio.getEpisode(context.episode.id)).metrics.length, 1);
});

test('a mismatched final duration or missing output audio prevents render completion', async (t) => {
  for (const failure of ['duration', 'audio']) {
    const context = await setup(t);
    const fake = fakeRenderer(3);
    const runner = async (command, args, options) => {
      const response = await fake.runner(command, args, options);
      if (command === env.FFPROBE_PATH && /render-[^/]+\.mp4$/.test(args.at(-1))) {
        const probe = JSON.parse(response.stdout);
        if (failure === 'duration') probe.format.duration = '2';
        else probe.streams = probe.streams.filter((stream) => stream.codec_type !== 'audio');
        response.stdout = JSON.stringify(probe);
      }
      return response;
    };
    const production = new Production(context.store, { env, runner });
    await addSourceAssets(context, production);
    await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), /Final render failed/);
    assert.equal((await context.studio.getEpisode(context.episode.id)).render, null);
  }
});
