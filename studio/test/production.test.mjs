import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StudioStore } from '../src/store.mjs';
import { Studio } from '../src/domain.mjs';
import { Production } from '../src/production.mjs';
import { ProductionJobs } from '../src/jobs.mjs';
import { InferenceClient } from '@huggingface/inference';
import { createHash, randomUUID } from 'node:crypto';

// Small signatures are intentional: these tests exercise contracts with a fake
// inference client/process runner. They never perform inference or media encoding.
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const WAV = Buffer.from('RIFF0000WAVEfmt mock narration');
const MP4 = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom000000000000')]);
const license = { url: 'https://provider.example/model-license', notes: 'Commercial generation permitted for this model; all inputs are synthetic or licensed.' };
const provenance = { provider: 'studio-example', model: 'licensed-model', prompt: 'An original fictional clock city.', synthetic: true, commercialLicense: license };
const env = { HF_TOKEN: 'fake-token', FFMPEG_PATH: 'fake-ffmpeg', FFPROBE_PATH: 'fake-ffprobe' };
const pilotVideoParameters = { resolution: '480p', aspect_ratio: '16:9', num_frames: 81, frames_per_second: 16, num_inference_steps: 27, seed: 20261001, interpolator_model: 'none', num_interpolated_frames: 0, enable_prompt_expansion: false };
const filmVideoParameters = { ...pilotVideoParameters, resolution: '720p', aspect_ratio: '9:16', interpolator_model: 'film', num_interpolated_frames: 1, adjust_fps_for_interpolation: true };
const END_PNG = Buffer.concat([PNG, Buffer.from('original final frame')]);

async function setup(t, { budgetMonthlyUsd = null, sceneCount = 1, sceneDurationSeconds = 3, audioMode, format } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-production-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StudioStore(directory);
  const studio = new Studio(store);
  const project = await studio.createProject({ title: 'Clock city', premise: 'A fictional miniature city', audience: 'Fantasy fans', language: 'pt-BR', budgetMonthlyUsd });
  const episode = await studio.planEpisode({ projectId: project.id, ...(audioMode ? { audioMode } : {}), ...(format ? { format } : {}), title: 'The last clock wakes', hook: 'Time returns to a sleeping city.', synopsis: 'The clock wakes its inhabitants.', originalAngle: 'An original miniature clock-city mythology.', scenes: Array.from({ length: sceneCount }, (_, index) => ({ durationSeconds: sceneDurationSeconds, ...(['silent', 'nonverbal'].includes(audioMode) ? {} : { narration: `O relógio ${index + 1} acordou a cidade.` }), visualPrompt: `An original tiny clock city, scene ${index + 1}` })), metadata: { description: 'An original AI-generated fictional episode.', hashtags: ['#FicçãoIA'] } });
  return { directory, store, studio, project, episode };
}

function generation(episode, overrides = {}) {
  return { episodeId: episode.id, sceneId: episode.scenes[0].id, kind: 'image', model: 'example/licensed-model', provider: 'hf-inference', estimatedCostUsd: 0, pricingSourceUrl: 'https://provider.example/pricing', commercialLicense: license, ...overrides };
}

async function interruptedFalGeneration(t, { withJob = false } = {}) {
  const context = await setup(t, { audioMode: 'silent' });
  const jobId = withJob ? randomUUID() : undefined;
  if (withJob) await context.store.transaction(state => {
    state.productionJobs = [{ id: jobId, action: 'generate', episodeId: context.episode.id, status: 'running' }];
  });
  let posts = 0;
  const input = generation(context.episode, { kind: 'video', provider: 'fal-ai', model: 'Wan-AI/Wan2.2-TI2V-5B',
    videoParameters: { resolution: '720p', aspect_ratio: '9:16', num_frames: 121, frames_per_second: 24, seed: 20261002, interpolator_model: 'none', num_interpolated_frames: 0 },
    estimatedCostUsd: 0.15, acknowledgePaidCost: true, ...(withJob ? { productionJobId: jobId } : {}) });
  const initial = new Production(context.store, { env: { ...env, YTFUN_PAID_GENERATION_ENABLED: 'true' },
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'POST');
      posts += 1;
      return Response.json({ request_id: 'request-123', status: 'IN_QUEUE', response_url: 'https://queue.fal.run/fal-ai/wan/requests/request-123' });
    }, inferenceClient: { textToVideo: async (args, options) => {
      await options.fetch('https://router.huggingface.co/fal-ai/fal-ai/wan/v2.2-5b/text-to-video?_subdomain=queue', { method: 'POST' });
      throw new Error('private-provider-timeout');
    } } });
  await assert.rejects(initial.generateAsset(input), /Generation failed after reservation/);
  const reservation = (await context.store.read()).spending[0];
  assert.equal(reservation.status, 'unknown');
  assert.equal(posts, 1);
  return { ...context, input, reservation, jobId };
}

test('24fps Wan5B recovery reconciles the original unknown reservation without a POST or additional cost', async t => {
  const context = await interruptedFalGeneration(t);
  const replies = [Response.json({ status: 'IN_PROGRESS' }), Response.json({ status: 'COMPLETED' }),
    Response.json({ video: { url: 'https://v3.fal.media/pilot.mp4' } }), new Response(MP4, { headers: { 'content-type': 'video/mp4' } })];
  let gets = 0;
  const recovery = new Production(context.store, { env, inferenceClient: { textToVideo: async () => assert.fail('Recovery must never invoke inference') },
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      gets += 1;
      assert.ok(replies.length);
      return replies.shift();
    } });
  const input = { ...context.input, acknowledgePaidCost: false, resumeReservationId: context.reservation.id };
  assert.deepEqual(await recovery.generateAsset(input), { reservationId: context.reservation.id, status: 'pending', remoteStatus: 'IN_PROGRESS', submitted: false });
  const pending = await context.store.read();
  assert.equal(pending.spending[0].status, 'unknown');
  assert.equal(pending.assets.length, 0);
  const asset = await recovery.generateAsset(input);
  assert.equal(asset.kind, 'video');
  assert.deepEqual(asset.provenance.videoParameters, context.input.videoParameters);
  assert.deepEqual(await readFile(resolve(context.directory, asset.path)), MP4);
  assert.deepEqual(await recovery.generateAsset(input), asset);
  assert.equal(gets, 4);
  const state = await context.store.read();
  assert.equal(state.spending.length, 1);
  assert.equal(state.assets.length, 1);
  assert.equal(state.spending[0].estimatedCostUsd, 0.15);
  assert.equal(state.spending[0].status, 'completed');
  assert.equal(state.spending[0].assetId, asset.id);
  assert.equal(state.spending[0].recoveryClaim, undefined);
  assert.equal(state.spending[0].error, undefined);
  assert.doesNotMatch(JSON.stringify(state), /private-provider-timeout|fake-token/);
});

test('receipt recovery blocks changed provenance, absent receipts and active original jobs before HTTP', async t => {
  const context = await interruptedFalGeneration(t, { withJob: true });
  let gets = 0;
  const production = new Production(context.store, { env, fetchImpl: async () => { gets += 1; assert.fail('Rejected recovery reached the network'); } });
  const input = { ...context.input, resumeReservationId: context.reservation.id };
  await assert.rejects(production.generateAsset(input), /original generation worker is still active/);
  await context.store.transaction(state => { state.productionJobs[0].status = 'failed'; });
  for (const overrides of [{ prompt: 'Changed original intent' }, { model: 'other/model' }, { estimatedCostUsd: 0 },
    { commercialLicense: { ...license, notes: 'Changed license attestation' } }, { videoParameters: { ...context.input.videoParameters, seed: 7 } }]) {
    await assert.rejects(production.generateAsset({ ...input, ...overrides }), /match the original persisted generation request/);
  }
  await context.store.transaction(state => { delete state.spending[0].remoteRequest; });
  await assert.rejects(production.generateAsset(input), /persisted remote queue receipt is required/);
  assert.equal(gets, 0);
  assert.equal((await context.store.read()).spending.length, 1);
});

test('a reserved request can resume only after its original job is truthfully reconciled as stopped', async t => {
  const context = await interruptedFalGeneration(t, { withJob: true });
  const input = { ...context.input, resumeReservationId: context.reservation.id };
  await context.store.transaction(state => {
    state.spending[0].status = 'reserved';
    state.productionJobs[0].status = 'interrupted';
  });
  const production = new Production(context.store, { env, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET');
    return Response.json({ status: 'IN_QUEUE' });
  } });
  assert.equal((await production.generateAsset(input)).status, 'pending');
  await context.store.transaction(state => { delete state.spending[0].productionJobId; });
  await assert.rejects(production.generateAsset(input), /reconciliation of its stopped original worker/);
});

test('concurrent recovery claims share no asset mutation and never repeat a submission', async t => {
  const context = await interruptedFalGeneration(t);
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let gets = 0;
  const production = new Production(context.store, { env, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET');
    gets += 1;
    entered();
    await blocked;
    return Response.json({ status: 'IN_PROGRESS' });
  } });
  const input = { ...context.input, resumeReservationId: context.reservation.id };
  const first = production.generateAsset(input);
  try {
    await ready;
    await assert.rejects(production.generateAsset(input), /already being retrieved/);
  } finally { release(); }
  assert.equal((await first).status, 'pending');
  assert.equal(gets, 1);
  const state = await context.store.read();
  assert.equal(state.spending.length, 1);
  assert.equal(state.assets.length, 0);
  assert.equal(state.spending[0].recoveryClaim, undefined);
});

async function addSourceAssets(context, production, { alsoVideo = false, includeAudio = context.episode.audioMode !== 'silent' } = {}) {
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
    const audio = includeAudio ? await production.registerAsset({ ...base, kind: 'audio', localPath: sourceAudio }) : null;
    const video = alsoVideo ? await production.registerAsset({ ...base, kind: 'video', localPath: sourceVideo }) : null;
    registered.push({ image, audio, video });
  }
  return registered;
}

async function addEndReference(context, production) {
  const localPath = join(context.directory, `end-${randomUUID()}.png`);
  await writeFile(localPath, END_PNG);
  return production.registerAsset({ episodeId: context.episode.id, sceneId: context.episode.scenes[0].id, kind: 'image', localPath, provenance });
}

function fakeRenderer(durationSeconds, { audioDuration = 2, finalHasAudio = true, sourceHasAudio = false, sourceVideoDuration = 3, onEncode } = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    const path = args.at(-1);
    if (command === env.FFPROBE_PATH) {
      const final = /render-[^/]+\.mp4$/.test(path);
      const audio = /\.wav$/.test(path);
      const streams = audio
        ? [{ codec_type: 'audio', duration: String(audioDuration) }]
        : final
          ? [{ codec_type: 'video', width: 1080, height: 1920, avg_frame_rate: '30/1' }, ...(finalHasAudio ? [{ codec_type: 'audio', duration: String(durationSeconds) }] : [])]
          : [{ codec_type: 'video', width: 720, height: 1280, duration: String(sourceVideoDuration) }, ...(sourceHasAudio && /\.mp4$/.test(path) ? [{ codec_type: 'audio', duration: String(sourceVideoDuration) }] : [])];
      return { exitCode: 0, stdout: JSON.stringify({ format: { duration: String(final ? durationSeconds : audio ? audioDuration : sourceVideoDuration) }, streams }) };
    }
    assert.equal(command, env.FFMPEG_PATH);
    if (onEncode) await onEncode({ args, options, path });
    await writeFile(path, MP4);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

test('image dimensions translate to fal image_size and preserve original bounded intent', async t => {
  const context = await setup(t, { audioMode: 'silent' });
  const imageParameters = { width: 720, height: 1280, num_inference_steps: 28, seed: 20261002 };
  const production = new Production(context.store, { env, inferenceClient: { textToImage: async (args, options) => {
    assert.deepEqual(args.parameters, { image_size: { width: 720, height: 1280 }, num_inference_steps: 28, seed: 20261002 });
    assert.equal(options.outputType, 'blob');
    assert.equal(options.retry_on_error, false);
    assert.deepEqual((await context.store.read()).spending[0].imageParameters, imageParameters);
    args.parameters.image_size.width = 256;
    return new Blob([PNG], { type: 'image/png' });
  } } });
  const asset = await production.generateAsset(generation(context.episode, { provider: 'fal-ai', imageParameters }));
  assert.deepEqual(asset.provenance.imageParameters, imageParameters);
  assert.deepEqual((await context.store.read()).spending[0].imageParameters, imageParameters);
  assert.equal(imageParameters.width, 720);
});

test('unsupported image settings and non-video references reject before reservation or inference', async t => {
  const context = await setup(t);
  let requests = 0;
  const request = async () => { requests += 1; assert.fail('Invalid inputs reached inference'); };
  const production = new Production(context.store, { env, inferenceClient: { textToImage: request, textToVideo: request, imageToVideo: request } });
  for (const imageParameters of [null, [], { width: 255, height: 1280 }, { width: 2049, height: 1280 }, { width: 720.5, height: 1280 }, { height: 255, width: 720 }, { height: 2049, width: 720 }, { width: 720 }, { height: 1280 }, { num_inference_steps: 0 }, { num_inference_steps: 51 }, { seed: -1 }, { seed: 4_294_967_296 }, { image_size: 'portrait_16_9' }, { enable_safety_checker: false }]) {
    await assert.rejects(production.generateAsset(generation(context.episode, { imageParameters })), /imageParameters/);
  }
  await assert.rejects(production.generateAsset(generation(context.episode, { kind: 'video', imageParameters: {} })), /only for image/);
  for (const kind of ['image', 'audio']) await assert.rejects(production.generateAsset(generation(context.episode, { kind, referenceImageAssetId: randomUUID() })), /only for video/);
  assert.equal(requests, 0);
  assert.equal((await context.store.read()).spending.length, 0);
});

test('real HF SDK sends Qwen dimensions under fal image_size without leaking image controls', async t => {
  const context = await setup(t, { audioMode: 'silent' });
  let posts = 0;
  const mockFetch = async (url, options) => {
    if (new URL(url).hostname === 'huggingface.co') return Response.json({ inferenceProviderMapping: { 'fal-ai': { providerId: 'fal-ai/qwen-image-2512', status: 'live', task: 'text-to-image' } } });
    assert.equal(url, 'https://router.huggingface.co/fal-ai/fal-ai/qwen-image-2512?_subdomain=queue');
    assert.equal(options.method, 'POST');
    posts += 1;
    if (posts > 1) assert.fail('A second image submission is forbidden');
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.image_size, { width: 720, height: 1280 });
    assert.equal(payload.width, undefined);
    assert.equal(payload.height, undefined);
    assert.equal(payload.num_inference_steps, 28);
    assert.equal(payload.seed, 123);
    assert.equal(payload.prompt, context.episode.scenes[0].visualPrompt);
    return Response.json({ error: 'fake-private-image-error' }, { status: 503 });
  };
  const client = new InferenceClient('hf_fake_ci_only', { fetch: mockFetch, retry_on_error: true });
  const production = new Production(context.store, { env: { ...env, YTFUN_PAID_GENERATION_ENABLED: 'true' }, inferenceClient: client });
  const imageParameters = { width: 720, height: 1280, num_inference_steps: 28, seed: 123 };
  await assert.rejects(production.generateAsset(generation(context.episode, { model: 'ci-only/qwen-image-size-contract', provider: 'fal-ai', imageParameters, estimatedCostUsd: 0.02, acknowledgePaidCost: true })), /Generation failed after reservation/);
  const state = await context.store.read();
  assert.equal(posts, 1);
  assert.deepEqual(state.spending[0].imageParameters, imageParameters);
  assert.equal(state.spending[0].status, 'unknown');
  assert.doesNotMatch(JSON.stringify(state), /hf_fake_ci_only|fake-private-image-error/);
});

test('image-to-video sends typed reference bytes and motion prompt, preserving parent evidence and original image', async t => {
  const context = await setup(t, { audioMode: 'silent' });
  let image;
  const production = new Production(context.store, { env, inferenceClient: { imageToVideo: async (args, options) => {
    assert.equal(args.inputs instanceof Blob, true);
    assert.equal(args.inputs.type, 'image/png');
    assert.deepEqual(Buffer.from(await args.inputs.arrayBuffer()), PNG);
    assert.deepEqual(args.parameters, { ...pilotVideoParameters, prompt: 'The same cat opens its eyes and raises one paw.' });
    assert.equal(options.retry_on_error, false);
    assert.equal(typeof options.fetch, 'function');
    const reserved = (await context.store.read()).spending[0];
    assert.equal(reserved.status, 'reserved');
    assert.deepEqual(reserved.referenceImage, { assetId: image.id, sha256: image.sha256 });
    args.parameters.seed = 7;
    return new Blob([MP4], { type: 'video/mp4' });
  }, textToVideo: async () => assert.fail('A reference must select imageToVideo') } });
  [{ image }] = await addSourceAssets(context, production, { includeAudio: false });
  const jobs = new ProductionJobs(context.store, production);
  const job = await jobs.start({ action: 'generate', input: generation(context.episode, {
    kind: 'video', provider: 'fal-ai', model: 'Wan-AI/Wan2.2-I2V-A14B', referenceImageAssetId: image.id,
    prompt: 'The same cat opens its eyes and raises one paw.', videoParameters: pilotVideoParameters,
  }) });
  await jobs.running.get(job.id);
  const done = await jobs.get(job.id);
  assert.equal(done.status, 'completed');
  const asset = done.result;
  const descriptor = { assetId: image.id, sha256: image.sha256 };
  assert.deepEqual(asset.provenance.referenceImage, descriptor);
  assert.deepEqual(asset.provenance.parents, [descriptor]);
  assert.deepEqual(asset.provenance.videoParameters, pilotVideoParameters);
  const state = await context.store.read();
  assert.equal(state.assets.length, 2);
  assert.deepEqual(state.assets.find(item => item.id === image.id), image);
  assert.equal(state.spending[0].productionJobId, job.id);
  assert.equal(state.spending[0].status, 'completed');
  assert.deepEqual(state.spending[0].referenceImage, descriptor);
  assert.match(state.spending[0].referenceImageSnapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(state.episodes[0].approval, null);
});

test('reference validity and file hash prevent image-to-video charges before reservation', async t => {
  const context = await setup(t, { audioMode: 'silent', sceneCount: 2 });
  let requests = 0;
  const production = new Production(context.store, { env, inferenceClient: { imageToVideo: async () => { requests += 1; assert.fail('Invalid reference reached inference'); } } });
  const images = await addSourceAssets(context, production, { includeAudio: false });
  const image = images[0].image;
  const input = generation(context.episode, { kind: 'video', provider: 'fal-ai', referenceImageAssetId: image.id });
  await assert.rejects(production.generateAsset({ ...input, referenceImageAssetId: randomUUID() }), /same episode and scene/);
  await assert.rejects(production.generateAsset({ ...input, referenceImageAssetId: images[1].image.id }), /same episode and scene/);
  for (const change of [{ synthetic: false }, { provenance: { ...image.provenance, commercialLicense: null } }, { path: 'source.png' }]) {
    await context.store.transaction(state => { Object.assign(state.assets.find(asset => asset.id === image.id), change); });
    await assert.rejects(production.generateAsset(input));
    await context.store.transaction(state => { Object.assign(state.assets.find(asset => asset.id === image.id), image); });
  }
  await writeFile(resolve(context.directory, image.path), Buffer.concat([PNG, Buffer.from('changed')]));
  await assert.rejects(production.generateAsset(input), /hash does not match/);
  assert.equal(requests, 0);
  assert.equal((await context.store.read()).spending.length, 0);
});

test('real HF SDK routes image-to-video as data URI with prompt, preserving one ambiguous charge', async t => {
  const context = await setup(t, { audioMode: 'silent' });
  let posts = 0;
  const mockFetch = async (url, options) => {
    if (new URL(url).hostname === 'huggingface.co') return Response.json({ inferenceProviderMapping: { 'fal-ai': { providerId: 'fal-ai/wan/v2.2-a14b/image-to-video', status: 'live', task: 'image-to-video' } } });
    assert.equal(url, 'https://router.huggingface.co/fal-ai/fal-ai/wan/v2.2-a14b/image-to-video?_subdomain=queue');
    assert.equal(options.method, 'POST');
    posts += 1;
    if (posts > 1) assert.fail('A second paid submission is forbidden');
    const payload = JSON.parse(options.body);
    assert.equal(payload.image_url, `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(payload.prompt, 'A cat raises its paw.');
    assert.equal(payload.num_frames, 81);
    assert.equal(payload.inputs, undefined);
    return Response.json({ error: 'fake-provider-private-value' }, { status: 503 });
  };
  const client = new InferenceClient('hf_fake_ci_only', { fetch: mockFetch, retry_on_error: true });
  const production = new Production(context.store, { env: { ...env, YTFUN_PAID_GENERATION_ENABLED: 'true' }, inferenceClient: client, fetchImpl: mockFetch });
  const [{ image }] = await addSourceAssets(context, production, { includeAudio: false });
  await assert.rejects(production.generateAsset(generation(context.episode, { kind: 'video', provider: 'fal-ai', model: 'ci-only/wan-i2v-contract', prompt: 'A cat raises its paw.', referenceImageAssetId: image.id, videoParameters: { num_frames: 81, frames_per_second: 16 }, estimatedCostUsd: 0.41, acknowledgePaidCost: true })), /Generation failed after reservation/);
  const state = await context.store.read();
  assert.equal(posts, 1);
  assert.equal(state.spending[0].status, 'unknown');
  assert.deepEqual(state.spending[0].referenceImage, { assetId: image.id, sha256: image.sha256 });
  assert.equal(state.assets.length, 1);
  assert.doesNotMatch(JSON.stringify(state), /hf_fake_ci_only|fake-provider-private-value|data:image/);
});

test('image-to-video receipt recovery requires the exact original reference and retrieves without a second POST', async t => {
  const context = await setup(t, { audioMode: 'silent' });
  let posts = 0;
  const production = new Production(context.store, { env, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'POST');
    posts += 1;
    return Response.json({ request_id: 'i2v-request', status: 'IN_QUEUE', response_url: 'https://queue.fal.run/fal-ai/wan/requests/i2v-request' });
  }, inferenceClient: { imageToVideo: async (args, options) => {
    assert.equal(args.inputs.type, 'image/png');
    await options.fetch('https://router.huggingface.co/fal-ai/fal-ai/wan/v2.2-a14b/image-to-video?_subdomain=queue', { method: 'POST' });
    throw new Error('Interrupted original polling');
  } } });
  const [{ image }] = await addSourceAssets(context, production, { includeAudio: false });
  const secondImage = await production.registerAsset({ episodeId: context.episode.id, sceneId: context.episode.scenes[0].id, kind: 'image', localPath: join(context.directory, 'source.png'), provenance });
  const input = generation(context.episode, { kind: 'video', provider: 'fal-ai', model: 'Wan-AI/Wan2.2-I2V-A14B', referenceImageAssetId: image.id, videoParameters: { num_frames: 81, frames_per_second: 16 } });
  await assert.rejects(production.generateAsset(input), /Generation failed after reservation/);
  const reservation = (await context.store.read()).spending[0];
  assert.match(reservation.referenceImageSnapshotHash, /^[a-f0-9]{64}$/);
  // A new worker must compare against the persisted snapshot from the original
  // POST, rather than treating the current parent metadata as original intent.
  await context.store.transaction(state => {
    state.assets.find(item => item.id === image.id).provenance.commercialLicense.notes = 'Changed parent terms after the worker failed';
  });
  const replies = [Response.json({ status: 'COMPLETED' }), Response.json({ video: { url: 'https://v3.fal.media/recovered-i2v.mp4' } }), new Response(MP4, { headers: { 'content-type': 'video/mp4' } })];
  let gets = 0;
  const recovery = new Production(context.store, { env, inferenceClient: { imageToVideo: async () => assert.fail('GET recovery cannot invoke inference') }, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET');
    gets += 1;
    assert.ok(replies.length);
    return replies.shift();
  } });
  const request = { ...input, resumeReservationId: reservation.id };
  await assert.rejects(recovery.generateAsset(request), /match the original persisted generation request/);
  assert.equal(gets, 0);
  await context.store.transaction(state => { state.assets.find(item => item.id === image.id).provenance = image.provenance; });
  await assert.rejects(recovery.generateAsset({ ...request, referenceImageAssetId: undefined }), /match the original persisted generation request/);
  await assert.rejects(recovery.generateAsset({ ...request, referenceImageAssetId: secondImage.id }), /match the original persisted generation request/);
  assert.equal(gets, 0);
  const asset = await recovery.generateAsset(request);
  assert.deepEqual(asset.provenance.parents, [{ assetId: image.id, sha256: image.sha256 }]);
  assert.deepEqual(await recovery.generateAsset(request), asset);
  const state = await context.store.read();
  assert.equal(gets, 3);
  assert.equal(posts, 1);
  assert.equal(state.spending.length, 1);
  assert.equal(state.spending[0].status, 'completed');
  assert.equal(state.assets.length, 3);
});

test('a reference metadata change during generation preserves the charge barrier and rejects the derived asset', async t => {
  const context = await setup(t, { audioMode: 'silent' });
  let image;
  const production = new Production(context.store, { env, inferenceClient: { imageToVideo: async () => {
    await context.store.transaction(state => { state.assets.find(item => item.id === image.id).provenance.prompt = 'Changed parent intent'; });
    return new Blob([MP4], { type: 'video/mp4' });
  } } });
  [{ image }] = await addSourceAssets(context, production, { includeAudio: false });
  await assert.rejects(production.generateAsset(generation(context.episode, { kind: 'video', provider: 'fal-ai', referenceImageAssetId: image.id })), /Generation failed after reservation/);
  const state = await context.store.read();
  assert.equal(state.spending[0].status, 'unknown');
  assert.equal(state.assets.length, 1);
  assert.deepEqual(await readdir(join(context.directory, 'assets')), [image.path.split('/').at(-1)]);
});

test('Wan final-frame jobs send only owned image bytes and preserve both parents plus explicit FILM intent', async t => {
  const context = await setup(t, { audioMode: 'silent' });
  let start;
  let end;
  const production = new Production(context.store, { env: { ...env, YTFUN_PAID_GENERATION_ENABLED: 'true' }, inferenceClient: { imageToVideo: async (args, options) => {
    assert.equal(args.inputs instanceof Blob, true);
    assert.deepEqual(Buffer.from(await args.inputs.arrayBuffer()), PNG);
    assert.deepEqual(args.parameters, { ...filmVideoParameters, prompt: context.episode.scenes[0].visualPrompt, end_image_url: `data:image/png;base64,${END_PNG.toString('base64')}` });
    assert.equal(options.retry_on_error, false);
    const reservation = (await context.store.read()).spending[0];
    assert.equal(reservation.status, 'reserved');
    assert.equal(reservation.estimatedCostUsd, 0.41);
    assert.deepEqual(reservation.referenceImage, { assetId: start.id, sha256: start.sha256 });
    assert.deepEqual(reservation.endReferenceImage, { assetId: end.id, sha256: end.sha256 });
    assert.match(reservation.referenceImageSnapshotHash, /^[a-f0-9]{64}$/);
    assert.match(reservation.endReferenceImageSnapshotHash, /^[a-f0-9]{64}$/);
    assert.notEqual(reservation.referenceImageSnapshotHash, reservation.endReferenceImageSnapshotHash);
    args.parameters.end_image_url = 'https://example.invalid/changed-by-sdk.png';
    args.parameters.adjust_fps_for_interpolation = false;
    return new Blob([MP4], { type: 'video/mp4' });
  } } });
  [{ image: start }] = await addSourceAssets(context, production, { includeAudio: false });
  end = await addEndReference(context, production);
  const input = generation(context.episode, { kind: 'video', model: 'Wan-AI/Wan2.2-I2V-A14B', provider: 'fal-ai', referenceImageAssetId: start.id, endReferenceImageAssetId: end.id, videoParameters: filmVideoParameters, estimatedCostUsd: 0.41, acknowledgePaidCost: true });
  const jobs = new ProductionJobs(context.store, production);
  const job = await jobs.start({ action: 'generate', input });
  await jobs.running.get(job.id);
  const done = await jobs.get(job.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result.provenance.referenceImage, { assetId: start.id, sha256: start.sha256 });
  assert.deepEqual(done.result.provenance.endReferenceImage, { assetId: end.id, sha256: end.sha256 });
  assert.deepEqual(done.result.provenance.parents, [{ assetId: start.id, sha256: start.sha256 }, { assetId: end.id, sha256: end.sha256 }]);
  assert.deepEqual(done.result.provenance.videoParameters, filmVideoParameters);
  const state = await context.store.read();
  assert.deepEqual(state.assets.find(asset => asset.id === start.id), start);
  assert.deepEqual(state.assets.find(asset => asset.id === end.id), end);
  assert.equal(state.assets.length, 3);
  assert.equal(state.spending[0].productionJobId, job.id);
  assert.equal(state.spending[0].status, 'completed');
  assert.deepEqual(state.spending[0].videoParameters, filmVideoParameters);
  assert.equal(state.episodes[0].approval, null);
  assert.doesNotMatch(JSON.stringify(state), /data:image|fake-token|changed-by-sdk/);
});

test('final frames and FILM reject unsupported routes, incoherent FPS and invalid source evidence before reservation', async t => {
  const context = await setup(t, { audioMode: 'silent', sceneCount: 2 });
  let calls = 0;
  const rejectCall = async () => { calls += 1; assert.fail('Invalid final-frame request reached inference'); };
  const production = new Production(context.store, { env, inferenceClient: { imageToVideo: rejectCall, textToVideo: rejectCall, textToImage: rejectCall } });
  const sources = await addSourceAssets(context, production, { includeAudio: false });
  const start = sources[0].image;
  const end = await addEndReference(context, production);
  const input = generation(context.episode, { kind: 'video', provider: 'fal-ai', model: 'Wan-AI/Wan2.2-I2V-A14B', referenceImageAssetId: start.id, endReferenceImageAssetId: end.id, videoParameters: filmVideoParameters });
  for (const overrides of [{ kind: 'image', videoParameters: undefined }, { kind: 'audio', videoParameters: undefined }, { provider: 'wavespeed' }, { model: 'Wan-AI/Wan2.2-TI2V-5B' }, { model: 'MiniMaxAI/MiniMax-H3' }, { referenceImageAssetId: undefined }]) {
    await assert.rejects(production.generateAsset({ ...input, ...overrides }), /only for video|require fal-ai Wan/);
  }
  for (const videoParameters of [{ interpolator_model: 'film' }, { interpolator_model: 'film', num_interpolated_frames: 1 }, { interpolator_model: 'film', num_interpolated_frames: 1, adjust_fps_for_interpolation: false }, { interpolator_model: 'film', num_interpolated_frames: 0, adjust_fps_for_interpolation: true }, { num_interpolated_frames: 1 }, { interpolator_model: 'none', num_interpolated_frames: 1 }, { adjust_fps_for_interpolation: true }, { ...filmVideoParameters, num_interpolated_frames: 2 }, { ...filmVideoParameters, adjust_fps_for_interpolation: 'true' }, { ...filmVideoParameters, end_image_url: 'https://example.invalid/unverified.png' }]) {
    await assert.rejects(production.generateAsset({ ...input, videoParameters }), /unsupported values or fields/);
  }
  for (const endReferenceImageAssetId of ['https://example.invalid/image.png', randomUUID(), sources[1].image.id]) {
    await assert.rejects(production.generateAsset({ ...input, endReferenceImageAssetId }), /image asset UUID|same episode and scene/);
  }
  for (const change of [{ kind: 'video' }, { episodeId: randomUUID() }, { synthetic: false }, { sha256: 'invalid' }, { provenance: { ...end.provenance, commercialLicense: null } }, { path: 'source.png' }]) {
    await context.store.transaction(state => { Object.assign(state.assets.find(asset => asset.id === end.id), change); });
    await assert.rejects(production.generateAsset(input));
    await context.store.transaction(state => { Object.assign(state.assets.find(asset => asset.id === end.id), end); });
  }
  await writeFile(resolve(context.directory, end.path), Buffer.concat([END_PNG, Buffer.from('external mutation')]));
  await assert.rejects(production.generateAsset(input), /hash does not match/);
  assert.equal(calls, 0);
  assert.equal((await context.store.read()).spending.length, 0);
});

test('owned final frames and FILM can be used independently while FILM remains restricted to Wan A14B I2V', async t => {
  const context = await setup(t, { audioMode: 'silent' });
  const received = [];
  const production = new Production(context.store, { env, inferenceClient: { imageToVideo: async args => {
    received.push(structuredClone(args.parameters));
    return new Blob([MP4], { type: 'video/mp4' });
  } } });
  const [{ image: start }] = await addSourceAssets(context, production, { includeAudio: false });
  const end = await addEndReference(context, production);
  const input = generation(context.episode, { kind: 'video', provider: 'fal-ai', model: 'Wan-AI/Wan2.2-I2V-A14B', referenceImageAssetId: start.id });
  const anchored = await production.generateAsset({ ...input, endReferenceImageAssetId: end.id, videoParameters: pilotVideoParameters });
  assert.equal(received[0].end_image_url, `data:image/png;base64,${END_PNG.toString('base64')}`);
  assert.equal(received[0].interpolator_model, 'none');
  assert.equal(received[0].num_interpolated_frames, 0);
  assert.equal(received[0].adjust_fps_for_interpolation, undefined);
  assert.equal(anchored.provenance.parents.length, 2);
  const interpolated = await production.generateAsset({ ...input, videoParameters: { ...filmVideoParameters, frames_per_second: 24 } });
  assert.equal(received[1].end_image_url, undefined);
  assert.equal(received[1].frames_per_second, 24);
  assert.equal(received[1].interpolator_model, 'film');
  assert.equal(received[1].adjust_fps_for_interpolation, true);
  assert.equal(interpolated.provenance.endReferenceImage, undefined);
  assert.equal(interpolated.provenance.parents.length, 1);
  await assert.rejects(production.generateAsset({ ...input, model: 'other/model', videoParameters: filmVideoParameters }), /require fal-ai Wan/);
  assert.equal(received.length, 2);
});

test('real HF SDK forwards final-frame data URI and FILM without persisting image payloads or repeating a POST', async t => {
  const context = await setup(t, { audioMode: 'silent' });
  let posts = 0;
  const mockFetch = async (url, options) => {
    if (new URL(url).hostname === 'huggingface.co') return Response.json({ inferenceProviderMapping: { 'fal-ai': { providerId: 'fal-ai/wan/v2.2-a14b/image-to-video', status: 'live', task: 'image-to-video' } } });
    assert.equal(url, 'https://router.huggingface.co/fal-ai/fal-ai/wan/v2.2-a14b/image-to-video?_subdomain=queue');
    assert.equal(options.method, 'POST');
    posts += 1;
    assert.equal(posts, 1);
    const payload = JSON.parse(options.body);
    assert.equal(payload.image_url, `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(payload.end_image_url, `data:image/png;base64,${END_PNG.toString('base64')}`);
    assert.equal(payload.interpolator_model, 'film');
    assert.equal(payload.num_interpolated_frames, 1);
    assert.equal(payload.adjust_fps_for_interpolation, true);
    assert.equal(payload.frames_per_second, 16);
    assert.equal(payload.prompt, context.episode.scenes[0].visualPrompt);
    assert.equal(payload.inputs, undefined);
    return Response.json({ error: 'fake-provider-private-final-frame-value' }, { status: 503 });
  };
  const production = new Production(context.store, { env: { ...env, YTFUN_PAID_GENERATION_ENABLED: 'true' }, inferenceClient: new InferenceClient('hf_fake_final_frame_ci_only', { fetch: mockFetch, retry_on_error: true }), fetchImpl: mockFetch });
  const [{ image: start }] = await addSourceAssets(context, production, { includeAudio: false });
  const end = await addEndReference(context, production);
  await assert.rejects(production.generateAsset(generation(context.episode, { kind: 'video', provider: 'fal-ai', model: 'Wan-AI/Wan2.2-I2V-A14B-Diffusers', referenceImageAssetId: start.id, endReferenceImageAssetId: end.id, videoParameters: filmVideoParameters, estimatedCostUsd: 0.41, acknowledgePaidCost: true })), /Generation failed after reservation/);
  const state = await context.store.read();
  assert.equal(posts, 1);
  assert.equal(state.spending[0].status, 'unknown');
  assert.equal(state.assets.length, 2);
  assert.doesNotMatch(JSON.stringify(state), /data:image|fake_final_frame_ci_only|fake-provider-private-final-frame-value/);
});

test('final-frame recovery after restart binds both persisted snapshots and completes idempotently with GET only', async t => {
  const context = await setup(t, { audioMode: 'silent' });
  let posts = 0;
  const production = new Production(context.store, { env: { ...env, YTFUN_PAID_GENERATION_ENABLED: 'true' }, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'POST');
    posts += 1;
    return Response.json({ request_id: 'final-frame-request', status: 'IN_QUEUE', response_url: 'https://queue.fal.run/fal-ai/wan/requests/final-frame-request' });
  }, inferenceClient: { imageToVideo: async (args, options) => {
    await options.fetch('https://router.huggingface.co/fal-ai/fal-ai/wan/v2.2-a14b/image-to-video?_subdomain=queue', { method: 'POST' });
    throw new Error('Interrupted final-frame provider with fake private credential');
  } } });
  const [{ image: start }] = await addSourceAssets(context, production, { includeAudio: false });
  const end = await addEndReference(context, production);
  const alternativeEnd = await addEndReference(context, production);
  const input = generation(context.episode, { kind: 'video', provider: 'fal-ai', model: 'Wan-AI/Wan2.2-I2V-A14B', referenceImageAssetId: start.id, endReferenceImageAssetId: end.id, videoParameters: filmVideoParameters, estimatedCostUsd: 0.41, acknowledgePaidCost: true });
  await assert.rejects(production.generateAsset(input), /Generation failed after reservation/);
  const reservation = (await context.store.read()).spending[0];
  const replies = [Response.json({ status: 'IN_PROGRESS' }), Response.json({ status: 'COMPLETED' }), Response.json({ video: { url: 'https://v3.fal.media/recovered-final-frame.mp4' } }), new Response(MP4, { headers: { 'content-type': 'video/mp4' } })];
  let gets = 0;
  const recovery = new Production(context.store, { env, inferenceClient: { imageToVideo: async () => assert.fail('Recovery cannot submit inference') }, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET');
    gets += 1;
    assert.ok(replies.length);
    return replies.shift();
  } });
  const request = { ...input, acknowledgePaidCost: false, resumeReservationId: reservation.id };
  for (const overrides of [{ endReferenceImageAssetId: undefined }, { endReferenceImageAssetId: alternativeEnd.id }, { videoParameters: { ...filmVideoParameters, frames_per_second: 24 } }]) {
    await assert.rejects(recovery.generateAsset({ ...request, ...overrides }), /match the original persisted generation request/);
  }
  await context.store.transaction(state => { state.assets.find(asset => asset.id === end.id).provenance.commercialLicense.notes = 'Changed final-frame terms after worker restart'; });
  await assert.rejects(recovery.generateAsset(request), /match the original persisted generation request/);
  assert.equal(gets, 0);
  await context.store.transaction(state => { state.assets.find(asset => asset.id === end.id).provenance = end.provenance; });
  assert.deepEqual(await recovery.generateAsset(request), { reservationId: reservation.id, status: 'pending', remoteStatus: 'IN_PROGRESS', submitted: false });
  const asset = await recovery.generateAsset(request);
  assert.deepEqual(asset.provenance.parents, [{ assetId: start.id, sha256: start.sha256 }, { assetId: end.id, sha256: end.sha256 }]);
  assert.deepEqual(asset.provenance.endReferenceImage, { assetId: end.id, sha256: end.sha256 });
  assert.deepEqual(await recovery.generateAsset(request), asset);
  const state = await context.store.read();
  assert.equal(posts, 1);
  assert.equal(gets, 4);
  assert.equal(state.spending.length, 1);
  assert.equal(state.spending[0].estimatedCostUsd, 0.41);
  assert.equal(state.spending[0].status, 'completed');
  assert.equal(state.spending[0].recoveryClaim, undefined);
  assert.equal(state.assets.length, 4);
  assert.doesNotMatch(JSON.stringify(state), /data:image|fake private credential|fake-token/);
});

test('changing final-frame metadata during inference rejects the video and keeps the uncertain charge barrier', async t => {
  const context = await setup(t, { audioMode: 'silent' });
  let end;
  const production = new Production(context.store, { env, inferenceClient: { imageToVideo: async () => {
    await context.store.transaction(state => { state.assets.find(asset => asset.id === end.id).provenance.prompt = 'Changed final-frame intent during generation'; });
    return new Blob([MP4], { type: 'video/mp4' });
  } } });
  const [{ image: start }] = await addSourceAssets(context, production, { includeAudio: false });
  end = await addEndReference(context, production);
  await assert.rejects(production.generateAsset(generation(context.episode, { kind: 'video', provider: 'fal-ai', model: 'Wan-AI/Wan2.2-I2V-A14B', referenceImageAssetId: start.id, endReferenceImageAssetId: end.id, videoParameters: filmVideoParameters })), /Generation failed after reservation/);
  const state = await context.store.read();
  assert.equal(state.spending[0].status, 'unknown');
  assert.equal(state.assets.length, 2);
  assert.deepEqual((await readdir(join(context.directory, 'assets'))).sort(), [start.path.split('/').at(-1), end.path.split('/').at(-1)].sort());
});

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
  assert.deepEqual(received, { args: { model: 'example/licensed-model', provider: 'hf-inference', inputs: context.episode.scenes[0].visualPrompt }, options: { retry_on_error: false, outputType: 'blob' } });
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

test('explicit video pilot parameters reach the SDK and survive in reservation and provenance', async (t) => {
  const context = await setup(t, { audioMode: 'silent' });
  let received;
  const production = new Production(context.store, { env: { ...env, YTFUN_PAID_GENERATION_ENABLED: 'true' }, inferenceClient: { textToVideo: async (args, options) => {
    received = { args: structuredClone(args), options };
    const state = await context.store.read();
    assert.equal(state.spending[0].status, 'reserved');
    assert.deepEqual(state.spending[0].videoParameters, pilotVideoParameters);
    // SDK mutation must not rewrite the reserved intent or asset provenance.
    args.parameters.seed = 7;
    return new Blob([MP4], { type: 'video/mp4' });
  } } });
  const asset = await production.generateAsset(generation(context.episode, { kind: 'video', provider: 'fal-ai', videoParameters: pilotVideoParameters, estimatedCostUsd: 0.2, acknowledgePaidCost: true }));
  assert.deepEqual(received.args, { model: 'example/licensed-model', provider: 'fal-ai', inputs: context.episode.scenes[0].visualPrompt, parameters: pilotVideoParameters });
  assert.equal(received.options.retry_on_error, false);
  assert.equal(typeof received.options.fetch, 'function');
  assert.deepEqual(Object.keys(received.options).sort(), ['fetch', 'retry_on_error']);
  assert.deepEqual(asset.provenance.videoParameters, pilotVideoParameters);
  assert.deepEqual(pilotVideoParameters.seed, 20261001);
  const state = await context.store.read();
  assert.deepEqual(state.assets[0].provenance.videoParameters, pilotVideoParameters);
  assert.deepEqual(state.spending[0].videoParameters, pilotVideoParameters);
  assert.equal(state.spending[0].estimatedCostUsd, 0.2);
  assert.equal(state.spending[0].status, 'completed');
  assert.doesNotMatch(JSON.stringify(state), /fake-token/);
});

test('video parameters reject non-video kinds and unsupported values before reservation or inference', async (t) => {
  const context = await setup(t);
  let requests = 0;
  const request = async () => { requests += 1; assert.fail('Invalid parameters cannot reach inference'); };
  const production = new Production(context.store, { env, inferenceClient: { textToImage: request, textToSpeech: request, textToVideo: request } });
  for (const kind of ['image', 'audio']) {
    await assert.rejects(production.generateAsset(generation(context.episode, { kind, videoParameters: {} })), /only for video/);
  }
  for (const videoParameters of [null, [], { resolution: '1080p' }, { aspect_ratio: '1:1' }, { num_frames: 80 }, { num_frames: 122 }, { num_frames: 81.5 }, { frames_per_second: 15 }, { num_inference_steps: 0 }, { num_inference_steps: 41 }, { seed: -1 }, { seed: 4_294_967_296 }, { interpolator_model: 'film' }, { num_interpolated_frames: 1 }, { enable_prompt_expansion: 'false' }, { authorization: 'not-a-real-secret' }, { enable_safety_checker: false }]) {
    await assert.rejects(production.generateAsset(generation(context.episode, { kind: 'video', videoParameters })), error => {
      assert.match(error.message, /unsupported values or fields/);
      assert.doesNotMatch(error.message, /not-a-real-secret/);
      return true;
    });
  }
  assert.equal(requests, 0);
  const state = await context.store.read();
  assert.equal(state.spending.length, 0);
  assert.equal(state.assets.length, 0);
});

test('omitting video parameters preserves the prior SDK call and does not record invented defaults', async (t) => {
  const context = await setup(t);
  let received;
  const production = new Production(context.store, { env, inferenceClient: { textToVideo: async args => {
    received = args;
    return new Blob([MP4], { type: 'video/mp4' });
  } } });
  const asset = await production.generateAsset(generation(context.episode, { kind: 'video' }));
  assert.deepEqual(received, { model: 'example/licensed-model', provider: 'hf-inference', inputs: context.episode.scenes[0].visualPrompt });
  assert.equal(Object.hasOwn(asset.provenance, 'videoParameters'), false);
  assert.equal(Object.hasOwn((await context.store.read()).spending[0], 'videoParameters'), false);
});

test('asynchronous generation jobs forward partial parameters without adding omitted defaults', async (t) => {
  const context = await setup(t, { audioMode: 'silent' });
  const parameters = { resolution: '480p', seed: 0, enable_prompt_expansion: false };
  const production = new Production(context.store, { env, inferenceClient: { textToVideo: async args => {
    assert.deepEqual(args.parameters, parameters);
    return new Blob([MP4], { type: 'video/mp4' });
  } } });
  const jobs = new ProductionJobs(context.store, production);
  const job = await jobs.start({ action: 'generate', input: generation(context.episode, { kind: 'video', videoParameters: parameters }) });
  await jobs.running.get(job.id);
  const done = await jobs.get(job.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result.provenance.videoParameters, parameters);
  assert.deepEqual((await context.store.read()).spending[0].videoParameters, parameters);
});

test('the real SDK submits a paid video only once after 503 and preserves unknown billing', async (t) => {
  const context = await setup(t, { audioMode: 'silent' });
  let submissions = 0;
  const mockFetch = async (url, init) => {
    if (new URL(url).hostname === 'huggingface.co') {
      assert.match(new URL(url).pathname, /^\/api\/models\/ci-only\/wan-503-contract$/);
      return Response.json({ inferenceProviderMapping: { 'fal-ai': { providerId: 'fal-ai/wan/v2.2-a14b/text-to-video', status: 'live', task: 'text-to-video' } } });
    }
    assert.equal(init.method, 'POST');
    assert.equal(url, 'https://router.huggingface.co/fal-ai/fal-ai/wan/v2.2-a14b/text-to-video?_subdomain=queue');
    assert.equal(init.redirect, 'error');
    submissions += 1;
    // Bound the regression even if a future SDK starts retrying again.
    if (submissions > 1) throw new Error('A second submission is forbidden');
    const payload = JSON.parse(init.body);
    for (const [key, value] of Object.entries(pilotVideoParameters)) assert.deepEqual(payload[key], value);
    return Response.json({ error: 'Ambiguous failure with fake-provider-secret' }, { status: 503 });
  };
  const client = new InferenceClient('hf_fake_ci_only', { retry_on_error: true, fetch: mockFetch });
  const production = new Production(context.store, { env: { ...env, YTFUN_PAID_GENERATION_ENABLED: 'true' }, inferenceClient: client, fetchImpl: mockFetch });
  const input = generation(context.episode, { kind: 'video', provider: 'fal-ai', model: 'ci-only/wan-503-contract', videoParameters: pilotVideoParameters, estimatedCostUsd: 0.2, acknowledgePaidCost: true });
  await assert.rejects(production.generateAsset(input), /Generation failed after reservation/);
  assert.equal(submissions, 1);
  const state = await context.store.read();
  assert.equal(state.spending.length, 1);
  assert.equal(state.spending[0].status, 'unknown');
  assert.deepEqual(state.spending[0].videoParameters, pilotVideoParameters);
  assert.equal(state.assets.length, 0);
  assert.doesNotMatch(JSON.stringify(state), /hf_fake_ci_only|fake-provider-secret/);
  await assert.rejects(production.generateAsset(input), /unknown charge outcome/);
  assert.equal(submissions, 1);
});

test('fal-ai queue identity commits before polling and survives an interrupted generation without resubmission', async (t) => {
  const context = await setup(t, { audioMode: 'silent' });
  const submissionUrl = 'https://router.huggingface.co/fal-ai/fal-ai/wan/v2.2-a14b/text-to-video?_subdomain=queue';
  const responsePath = '/fal-ai/wan/requests/pilot-queue-123';
  let submissions = 0;
  let polling = 0;
  const production = new Production(context.store, {
    env: { ...env, YTFUN_PAID_GENERATION_ENABLED: 'true' },
    fetchImpl: async (url, options) => {
      assert.equal(url, submissionUrl);
      assert.equal(options.method, 'POST');
      submissions += 1;
      return Response.json({ request_id: 'pilot-queue-123', response_url: `https://queue.fal.run${responsePath}`,
        status: 'IN_QUEUE', logs: ['fake-provider-secret'], video: { url: 'https://media.example/video.mp4?token=fake-private-query' } });
    },
    inferenceClient: { textToVideo: async (_args, options) => {
      assert.equal(options.retry_on_error, false);
      const response = await options.fetch(submissionUrl, { method: 'POST', headers: { Authorization: 'Bearer fake-token' } });
      const state = await context.store.read();
      assert.equal(state.spending[0].status, 'reserved');
      assert.deepEqual(state.spending[0].remoteRequest, { provider: 'fal-ai', transport: 'huggingface-router',
        requestId: 'pilot-queue-123', submissionUrl, responsePath, status: 'IN_QUEUE', capturedAt: state.spending[0].remoteRequest.capturedAt });
      assert.match(state.spending[0].remoteRequest.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal((await response.json()).request_id, 'pilot-queue-123');
      polling += 1;
      throw new Error('Simulated polling interruption with fake-provider-secret');
    } },
  });
  const input = generation(context.episode, { kind: 'video', provider: 'fal-ai', estimatedCostUsd: 0.2, acknowledgePaidCost: true });
  await assert.rejects(production.generateAsset(input), /Generation failed after reservation/);
  const state = await context.store.read();
  assert.equal(state.spending[0].status, 'unknown');
  assert.equal(state.spending[0].remoteRequest.requestId, 'pilot-queue-123');
  assert.equal(state.assets.length, 0);
  assert.doesNotMatch(JSON.stringify(state), /fake-token|fake-provider-secret|fake-private-query|logs|media.example/);
  await assert.rejects(production.generateAsset(input), /unknown charge outcome/);
  assert.equal(submissions, 1);
  assert.equal(polling, 1);
});

test('fal-ai receipt persistence failure prevents polling and preserves a sanitized retry barrier even if recording unknown fails', async (t) => {
  for (const failUnknownCommit of [false, true]) {
    const context = await setup(t, { audioMode: 'silent' });
    const transaction = context.store.transaction.bind(context.store);
    context.store.transaction = fn => transaction(state => {
      const result = fn(state);
      if (state.spending.some(item => item.remoteRequest || (failUnknownCommit && item.status === 'unknown'))) {
        throw new Error('Simulated receipt commit failure: fake-private-storage');
      }
      return result;
    });
    let submissions = 0;
    let polling = 0;
    const production = new Production(context.store, {
      env: { ...env, YTFUN_PAID_GENERATION_ENABLED: 'true' },
      fetchImpl: async (_url, options) => {
        assert.equal(options.method, 'POST');
        submissions += 1;
        return Response.json({ request_id: 'pilot-queue-123', status: 'IN_QUEUE',
          response_url: 'https://queue.fal.run/fal-ai/wan/requests/pilot-queue-123' });
      },
      inferenceClient: { textToVideo: async (_args, options) => {
        await options.fetch('https://router.huggingface.co/fal-ai/fal-ai/wan/v2.2-a14b/text-to-video?_subdomain=queue', { method: 'POST' });
        polling += 1;
        assert.fail('Polling cannot begin before the receipt commits');
      } },
    });
    const input = generation(context.episode, { kind: 'video', provider: 'fal-ai', estimatedCostUsd: 0.2, acknowledgePaidCost: true });
    await assert.rejects(production.generateAsset(input), error => {
      assert.match(error.message, /Generation failed after reservation/);
      assert.doesNotMatch(error.message, /fake-private-storage/);
      return true;
    });
    const state = await context.store.read();
    assert.equal(state.spending[0].status, failUnknownCommit ? 'reserved' : 'unknown');
    assert.equal(state.spending[0].remoteRequest, undefined);
    assert.equal(state.assets.length, 0);
    assert.doesNotMatch(JSON.stringify(state), /fake-private-storage/);
    await assert.rejects(production.generateAsset(input), /unknown charge outcome/);
    assert.equal(submissions, 1);
    assert.equal(polling, 0);
  }
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
  const production = new Production(context.store, { env, inferenceClient: { textToImage: async (_args, options) => { assert.equal(options.retry_on_error, false); requests += 1; throw new Error('Provider transport failed: Authorization Bearer secret-provider-token'); } } });
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
  // Persisted episodes from before audioMode existed still use narration.
  await context.store.transaction((state) => { delete state.episodes[0].audioMode; });
  const fake = fakeRenderer(6);
  const production = new Production(context.store, { env, runner: fake.runner });
  const sources = await addSourceAssets(context, production, { alsoVideo: true });
  const render = await production.renderEpisode({ episodeId: context.episode.id });
  assert.equal(render.durationSeconds, 6);
  assert.equal(render.synthetic, true);
  assert.equal(render.audioMode, 'narrated');
  assert.equal(render.hasAudio, true);
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

test('silent generation and import reject audio before spending or requesting inference', async (t) => {
  const context = await setup(t, { audioMode: 'silent' });
  const production = new Production(context.store, { env: {}, inferenceClient: {
    textToSpeech: async () => { assert.fail('Silent production must never request speech'); },
  } });
  await assert.rejects(production.generateAsset(generation(context.episode, { kind: 'audio', prompt: 'Speech must not be requested' })), /Silent episodes cannot generate or import audio/);
  const path = join(context.directory, 'unwanted.wav');
  await writeFile(path, WAV);
  await assert.rejects(production.registerAsset({ episodeId: context.episode.id, sceneId: context.episode.scenes[0].id, kind: 'audio', localPath: path, provenance }), /Silent episodes cannot generate or import audio/);
  const state = await context.store.read();
  assert.equal(state.spending.length, 0);
  assert.equal(state.assets.length, 0);
  assert.equal(state.episodes[0].status, 'planned');
});

test('a narration generation cannot commit after switching to silent; its charge remains uncertain', async (t) => {
  const context = await setup(t);
  const production = new Production(context.store, { env, inferenceClient: {
    textToSpeech: async () => {
      await context.store.transaction((state) => {
        state.episodes[0].audioMode = 'silent';
        delete state.episodes[0].scenes[0].narration;
      });
      return new Blob([WAV], { type: 'audio/wav' });
    },
  } });
  await assert.rejects(production.generateAsset(generation(context.episode, { kind: 'audio' })), /reconcile the provider outcome/);
  const state = await context.store.read();
  assert.equal(state.assets.length, 0);
  assert.equal(state.spending[0].status, 'unknown');
  assert.equal(state.episodes[0].audioMode, 'silent');
  assert.deepEqual(await readdir(join(context.directory, 'assets')), []);
});

test('silent render still requires a visual, but never requires a voice asset', async (t) => {
  const context = await setup(t, { audioMode: 'silent' });
  const production = new Production(context.store, { env, runner: async () => { assert.fail('Missing visual must fail before encoding'); } });
  await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), /requires synthetic visual assets/);
  assert.equal((await context.studio.getEpisode(context.episode.id)).status, 'planned');
});

test('silent images and imported videos render without sound or generated captions, including embedded source audio', async (t) => {
  for (const visualKind of ['image', 'video']) {
    const context = await setup(t, { audioMode: 'silent', sceneCount: 2 });
    const fake = fakeRenderer(6, { finalHasAudio: false, sourceHasAudio: true, onEncode: async ({ options }) => {
      assert.ok((await readdir(options.cwd)).every((name) => !name.endsWith('.srt')));
    } });
    const production = new Production(context.store, { env, runner: fake.runner });
    const sources = await addSourceAssets(context, production, { alsoVideo: visualKind === 'video' });
    // An old unused audio record must neither be selected nor read in silent mode.
    await context.store.transaction((state) => { state.assets.push({ id: 'unused-audio', episodeId: context.episode.id, sceneId: context.episode.scenes[0].id, kind: 'audio', path: 'assets/missing.wav', synthetic: false }); });
    const render = await production.renderEpisode({ episodeId: context.episode.id });
    assert.equal(render.audioMode, 'silent');
    assert.equal(render.hasAudio, false);
    assert.equal(render.durationSeconds, 6);
    assert.equal(render.captionsPath, undefined);
    assert.equal(render.captionsSha256, undefined);
    assert.equal(render.captionsTiming, undefined);
    assert.deepEqual(render.sceneAssets, context.episode.scenes.map((scene, index) => ({ sceneId: scene.id, visualAssetId: sources[index][visualKind].id })));
    const encodes = fake.calls.filter((call) => call.command === env.FFMPEG_PATH);
    assert.equal(encodes.length, 3);
    for (const call of encodes) {
      assert.ok(call.args.includes('-an'));
      assert.ok(call.args.includes('-sn'));
      assert.equal(call.args.filter((arg) => arg === '-i').length, 1);
      assert.ok(!call.args.includes('1:a:0'));
      assert.ok(!call.args.includes('0:a:0'));
      assert.ok(!call.args.includes('-af'));
      assert.ok(!call.args.includes('-c:a'));
      assert.ok(!call.args.includes('-stream_loop'));
      const visualFilter = call.args.indexOf('-vf');
      if (visualFilter !== -1) assert.ok(!call.args[visualFilter + 1].includes('subtitles='));
    }
    assert.ok(!fake.calls.some((call) => call.command === env.FFPROBE_PATH && /\.wav$/.test(call.args.at(-1))));
    assert.ok((await readdir(join(context.directory, 'assets'))).every((name) => !name.endsWith('.srt')));
    const updated = await context.studio.getEpisode(context.episode.id);
    assert.equal(updated.status, 'rendered');
    assert.equal(updated.approval, null);
  }
});

test('silent preflight rejects narration and unsupported modes before reserving a render', async (t) => {
  for (const failure of ['narration', 'audioMode']) {
    const context = await setup(t, { audioMode: 'silent' });
    const production = new Production(context.store, { env, runner: async () => { assert.fail('Invalid silent contract must not invoke encoding'); } });
    await addSourceAssets(context, production);
    await context.store.transaction((state) => {
      if (failure === 'narration') state.episodes[0].scenes[0].narration = 'Unwanted spoken language';
      else state.episodes[0].audioMode = 'sound-design';
    });
    await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), failure === 'narration' ? /Silent episodes cannot contain narration/ : /audioMode must be narrated or silent/);
    const episode = await context.studio.getEpisode(context.episode.id);
    assert.equal(episode.status, 'planned');
    assert.equal(episode.renderAttempt, undefined);
  }
});

test('silent video preflight checks actual stream duration and refuses to loop an incomplete clip', async (t) => {
  for (const duration of [2, 0, 'N/A']) {
    const context = await setup(t, { audioMode: 'silent' });
    const fake = fakeRenderer(3, { finalHasAudio: false, sourceVideoDuration: duration });
    const runner = async (command, args, options) => {
      const response = await fake.runner(command, args, options);
      if (command === env.FFPROBE_PATH) {
        const probe = JSON.parse(response.stdout);
        // An audio/container duration cannot override a shorter video stream.
        if (duration !== 'N/A') probe.format.duration = '10';
        response.stdout = JSON.stringify(probe);
      }
      return response;
    };
    const production = new Production(context.store, { env, runner });
    await addSourceAssets(context, production, { alsoVideo: true });
    await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), duration === 2 ? /shorter than its planned duration/ : /video has no valid duration/);
    assert.equal(fake.calls.filter((call) => call.command === env.FFMPEG_PATH).length, 0);
    const episode = await context.studio.getEpisode(context.episode.id);
    assert.equal(episode.render, null);
    assert.equal(episode.renderAttempt.status, 'failed');
  }
});

test('silent final validation rejects sound, subtitles, missing video and incorrect stream/container duration', async (t) => {
  for (const failure of ['audio', 'subtitle', 'video', 'duration', 'videoDuration']) {
    const context = await setup(t, { audioMode: 'silent' });
    const fake = fakeRenderer(3, { finalHasAudio: false });
    const runner = async (command, args, options) => {
      const response = await fake.runner(command, args, options);
      if (command === env.FFPROBE_PATH && /render-[^/]+\.mp4$/.test(args.at(-1))) {
        const probe = JSON.parse(response.stdout);
        if (failure === 'audio') probe.streams.push({ codec_type: 'audio' });
        if (failure === 'subtitle') probe.streams.push({ codec_type: 'subtitle' });
        if (failure === 'video') probe.streams = [];
        if (failure === 'duration') probe.format.duration = '2';
        if (failure === 'videoDuration') probe.streams[0].duration = '2';
        response.stdout = JSON.stringify(probe);
      }
      return response;
    };
    const production = new Production(context.store, { env, runner });
    await addSourceAssets(context, production);
    await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), /Final render/);
    const episode = await context.studio.getEpisode(context.episode.id);
    assert.equal(episode.render, null);
    assert.equal(episode.renderAttempt.status, 'failed');
    assert.ok((await readdir(join(context.directory, 'assets'))).every((name) => !name.startsWith('render-')));
  }
});

test('an audio mode change during encoding cannot commit a stale silent render', async (t) => {
  const context = await setup(t, { audioMode: 'silent' });
  let changed = false;
  const fake = fakeRenderer(3, { finalHasAudio: false, onEncode: async () => {
    if (changed) return;
    changed = true;
    await context.store.transaction((state) => { state.episodes[0].audioMode = 'narrated'; });
  } });
  const production = new Production(context.store, { env, runner: fake.runner });
  await addSourceAssets(context, production);
  await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }));
  const episode = await context.studio.getEpisode(context.episode.id);
  assert.equal(episode.render, null);
  assert.equal(episode.renderAttempt.status, 'failed');
});

test('persistent production jobs complete a silent video generation and render without a speech provider', async (t) => {
  const context = await setup(t, { audioMode: 'silent' });
  const received = [];
  const fake = fakeRenderer(3, { finalHasAudio: false });
  const production = new Production(context.store, { env, runner: fake.runner, inferenceClient: {
    textToVideo: async (input) => { received.push(input); return new Blob([MP4], { type: 'video/mp4' }); },
    textToSpeech: async () => { assert.fail('A silent job must never request speech'); },
  } });
  const jobs = new ProductionJobs(context.store, production);
  const generationJob = await jobs.start({ action: 'generate', input: generation(context.episode, { kind: 'video' }) });
  await jobs.running.get(generationJob.id);
  assert.equal((await jobs.get(generationJob.id)).status, 'completed');
  assert.equal(received.length, 1);
  assert.equal(received[0].inputs, context.episode.scenes[0].visualPrompt);
  const renderJob = await jobs.start({ action: 'render', input: { episodeId: context.episode.id } });
  await jobs.running.get(renderJob.id);
  const done = await jobs.get(renderJob.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.result.audioMode, 'silent');
  assert.equal(done.result.hasAudio, false);
  assert.equal(done.result.captionsPath, undefined);
  assert.equal((await context.store.read()).spending[0].status, 'completed');
});

test('a missing saved asset during cleanup cannot bypass sanitized unknown billing or lose its queue receipt', async (t) => {
  const context = await setup(t, { audioMode: 'silent' });
  const transaction = context.store.transaction.bind(context.store);
  let failedAssetCommits = 0;
  context.store.transaction = fn => transaction(async state => {
    const result = await fn(state);
    if (state.assets.length > 0) {
      failedAssetCommits += 1;
      // The media file exists before its asset/state commit. Removing it here
      // makes the subsequent cleanup's internalPath lookup fail with ENOENT.
      await rm(resolve(context.directory, state.assets[0].path));
      throw new Error('Simulated asset commit failure: fake-private-commit');
    }
    return result;
  });
  const submissionUrl = 'https://router.huggingface.co/fal-ai/fal-ai/wan/v2.2-a14b/text-to-video?_subdomain=queue';
  const responsePath = '/fal-ai/wan/requests/cleanup-queue-123';
  let submissions = 0;
  const production = new Production(context.store, {
    env: { ...env, YTFUN_PAID_GENERATION_ENABLED: 'true' },
    fetchImpl: async (url, options) => {
      assert.equal(url, submissionUrl);
      assert.equal(options.method, 'POST');
      submissions += 1;
      assert.equal(submissions, 1, 'A second paid submission is forbidden');
      return Response.json({ request_id: 'cleanup-queue-123', status: 'IN_QUEUE',
        response_url: `https://queue.fal.run${responsePath}` });
    },
    inferenceClient: { textToVideo: async (_args, options) => {
      const response = await options.fetch(submissionUrl, { method: 'POST' });
      assert.equal((await response.json()).request_id, 'cleanup-queue-123');
      return new Blob([MP4], { type: 'video/mp4' });
    } },
  });
  const input = generation(context.episode, { kind: 'video', provider: 'fal-ai',
    estimatedCostUsd: 0.2, acknowledgePaidCost: true });
  await assert.rejects(production.generateAsset(input), error => {
    assert.match(error.message, /Generation failed after reservation/);
    assert.doesNotMatch(error.message, /fake-private-commit|ENOENT/);
    assert.equal(error.message.includes(context.directory), false);
    return true;
  });
  const state = await context.store.read();
  assert.equal(failedAssetCommits, 1);
  assert.equal(state.spending.length, 1);
  assert.equal(state.spending[0].status, 'unknown');
  assert.deepEqual(state.spending[0].remoteRequest, { provider: 'fal-ai', transport: 'huggingface-router',
    requestId: 'cleanup-queue-123', submissionUrl, responsePath, status: 'IN_QUEUE',
    capturedAt: state.spending[0].remoteRequest.capturedAt });
  assert.match(state.spending[0].remoteRequest.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(state.assets, []);
  assert.doesNotMatch(JSON.stringify(state), /fake-private-commit|ENOENT/);
  assert.equal(submissions, 1);
  await assert.rejects(production.generateAsset(input), /unknown charge outcome/);
  assert.equal(submissions, 1);
});

test('native long-form rendering accepts more than 12 scenes and a 900-second master', async t => {
  const context = await setup(t, { format: 'long', audioMode: 'silent', sceneCount: 15, sceneDurationSeconds: 60 });
  const fake = fakeRenderer(900, { finalHasAudio: false });
  const production = new Production(context.store, { env, runner: fake.runner });
  await addSourceAssets(context, production);
  const render = await production.renderEpisode({ episodeId: context.episode.id });
  assert.equal(render.durationSeconds, 900);
  assert.equal(render.sceneAssets.length, 15);
  assert.equal(render.audioMode, 'silent');
  assert.equal(render.sizeBytes, MP4.length);
  const encodes = fake.calls.filter(call => call.command === env.FFMPEG_PATH);
  assert.equal(encodes.length, 16);
  assert.ok(encodes.slice(0, -1).every(call => call.args[call.args.indexOf('-t') + 1] === '60'));
  assert.equal((await context.studio.getEpisode(context.episode.id)).status, 'rendered');
});

test('production revalidates long scene/duration caps and the legacy short default before reserving', async t => {
  for (const failure of ['scenes', 'duration', 'legacy']) {
    const context = await setup(t, { format: 'long', audioMode: 'silent', sceneCount: 16, sceneDurationSeconds: 50 });
    await context.store.transaction(state => {
      const episode = state.episodes[0];
      if (failure === 'scenes') episode.scenes = Array.from({ length: 121 }, () => ({ ...episode.scenes[0], id: randomUUID() }));
      if (failure === 'duration') for (const scene of episode.scenes) scene.durationSeconds = 60;
      if (failure === 'legacy') delete episode.format;
    });
    const production = new Production(context.store, { env, runner: async () => assert.fail('Invalid plans must not invoke a media process') });
    await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), failure === 'scenes' ? /1 to 120 scenes/ : failure === 'duration' ? /900 seconds/ : /1 to 12 scenes/);
    assert.equal((await context.store.read()).episodes[0].renderAttempt, undefined);
  }
});

async function remoteRenderContext(t, { format = 'long', sceneCount = 15, sceneDurationSeconds = 15, audioMode = 'silent', probeHook, probeChange } = {}) {
  const context = await setup(t, { format, sceneCount, sceneDurationSeconds, audioMode });
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, env.FFPROBE_PATH, 'Remote registration only probes; it must never encode');
    if (probeHook) await probeHook({ context, args, options });
    const duration = sceneCount * sceneDurationSeconds;
    const probe = { format: { duration: String(duration) }, streams: [
      { codec_type: 'video', width: 1080, height: 1920, avg_frame_rate: '30/1', duration: String(duration) },
      ...(audioMode !== 'silent' ? [{ codec_type: 'audio', duration: String(duration) }] : []),
    ] };
    if (probeChange) probeChange(probe);
    return { exitCode: 0, stdout: JSON.stringify(probe) };
  };
  const production = new Production(context.store, { env, runner });
  const sources = await addSourceAssets(context, production);
  const localPath = join(context.directory, 'returned-master.mp4');
  await writeFile(localPath, MP4);
  const beforeExport = await context.store.read();
  const manifest = await production.exportRenderManifest({ episodeId: context.episode.id });
  assert.deepEqual(await context.store.read(), beforeExport, 'Export must not reserve, approve or mutate the episode');
  assert.equal(calls.length, 0, 'Manifest export does not probe or encode');
  return { ...context, production, sources, localPath, manifest, calls,
    input: { episodeId: context.episode.id, localPath, manifest, provenance } };
}

test('remote assembly binds ordered scene/script/source hashes and independently probes its private copy', async t => {
  const context = await remoteRenderContext(t);
  assert.equal(context.manifest.format, 'long');
  assert.equal(context.manifest.durationSeconds, 225);
  assert.equal(context.manifest.maxRenderBytes, 512 * 1024 * 1024);
  assert.equal(context.manifest.scenes.length, 15);
  for (let index = 0; index < context.sources.length; index += 1) {
    const scene = context.manifest.scenes[index];
    assert.equal(scene.sceneId, context.episode.scenes[index].id);
    assert.equal(scene.visual.assetId, context.sources[index].image.id);
    assert.equal(scene.visual.sha256, context.sources[index].image.sha256);
    assert.match(scene.scriptSha256, /^[a-f0-9]{64}$/);
    assert.match(scene.visual.provenanceSha256, /^[a-f0-9]{64}$/);
    assert.equal(scene.audio, undefined);
  }
  // Property insertion order does not change the exact JSON content contract.
  const reordered = Object.fromEntries(Object.entries(context.manifest).reverse());
  const render = await context.production.registerRemoteRender({ ...context.input, manifest: reordered });
  assert.equal(context.calls.length, 1);
  assert.notEqual(context.calls[0].args.at(-1), context.localPath);
  assert.equal(context.calls[0].options.timeoutMs, 30000);
  assert.equal(render.sha256, createHash('sha256').update(MP4).digest('hex'));
  assert.equal(render.durationSeconds, 225);
  assert.equal(render.framesPerSecond, 30);
  assert.equal(render.hasAudio, false);
  assert.equal(render.provenance.assembly, 'remote');
  assert.equal(render.provenance.snapshotSha256, context.manifest.snapshotSha256);
  assert.deepEqual(render.provenance.parents, context.manifest.scenes.map(scene => ({ assetId: scene.visual.assetId, sha256: scene.visual.sha256, provenanceSha256: scene.visual.provenanceSha256 })));
  await writeFile(context.localPath, Buffer.from('Worker-return file changed after registration'));
  assert.deepEqual(await readFile(resolve(context.directory, render.path)), MP4);
  const episode = await context.studio.getEpisode(context.episode.id);
  assert.equal(episode.status, 'rendered');
  assert.equal(episode.approval, null);
  assert.equal(episode.renderAttempt.status, 'completed');
});

test('long masters can exceed 100 MiB while short masters, source assets and >512 MiB long masters remain bounded', async t => {
  const long = await remoteRenderContext(t, { sceneCount: 1 });
  await truncate(long.localPath, 100 * 1024 * 1024 + 1);
  const render = await long.production.registerRemoteRender(long.input);
  assert.equal(render.sizeBytes, 100 * 1024 * 1024 + 1);
  assert.equal((await stat(resolve(long.directory, render.path))).size, render.sizeBytes);

  for (const format of ['short', 'long']) {
    const context = await remoteRenderContext(t, { format, sceneCount: 1 });
    const limit = (format === 'long' ? 512 : 100) * 1024 * 1024;
    await truncate(context.localPath, limit + 1);
    await assert.rejects(context.production.registerRemoteRender(context.input), /Remote render registration failed/);
    assert.equal(context.calls.length, 0);
    const episode = await context.studio.getEpisode(context.episode.id);
    assert.equal(episode.render, null);
    assert.equal(episode.renderAttempt.status, 'failed');
    assert.ok((await readdir(join(context.directory, 'assets'))).every(name => !name.startsWith('render-')));
  }
  const source = await remoteRenderContext(t, { sceneCount: 1 });
  await truncate(source.localPath, 100 * 1024 * 1024 + 1);
  await assert.rejects(source.production.registerAsset({ episodeId: source.episode.id, sceneId: source.episode.scenes[0].id, kind: 'video', localPath: source.localPath, provenance }), /104857600 bytes/);
  assert.equal((await source.store.read()).assets.length, 1);
});

test('a stale or adulterated remote manifest rejects script/provenance/selection changes before probing', async t => {
  for (const change of ['script', 'provenance', 'selection', 'manifest']) {
    const context = await remoteRenderContext(t, { sceneCount: 1 });
    if (change === 'manifest') context.input.manifest = { ...context.manifest, durationSeconds: 1 };
    else await context.store.transaction(state => {
      if (change === 'script') state.episodes[0].scenes[0].visualPrompt = 'An altered final shot';
      if (change === 'provenance') state.assets[0].provenance.commercialLicense.notes = 'Different source terms';
      if (change === 'selection') state.assets.push({ ...state.assets[0], id: randomUUID() });
    });
    await assert.rejects(context.production.registerRemoteRender(context.input), /manifest does not match/);
    assert.equal(context.calls.length, 0);
    assert.equal((await context.store.read()).episodes[0].renderAttempt, undefined);
  }
});

test('remote verification races cannot commit edited scripts, source evidence/bytes or mutated output', async t => {
  for (const change of ['script', 'provenance', 'sourceBytes', 'outputBytes']) {
    const context = await remoteRenderContext(t, { sceneCount: 1, probeHook: async ({ context, args }) => {
      if (change === 'sourceBytes') await writeFile(resolve(context.directory, (await context.store.read()).assets[0].path), Buffer.concat([PNG, Buffer.from('changed source')]));
      else if (change === 'outputBytes') await writeFile(args.at(-1), Buffer.concat([MP4, Buffer.from('changed master')]));
      else await context.store.transaction(state => {
        if (change === 'script') state.episodes[0].metadata.description = 'Changed during metadata inspection';
        if (change === 'provenance') state.assets[0].provenance.prompt = 'Changed source intent during inspection';
      });
    } });
    await assert.rejects(context.production.registerRemoteRender(context.input), /Remote render registration failed/);
    const episode = await context.studio.getEpisode(context.episode.id);
    assert.equal(episode.render, null);
    assert.equal(episode.approval, null);
    assert.equal(episode.renderAttempt.status, 'failed');
    assert.ok((await readdir(join(context.directory, 'assets'))).every(name => !name.startsWith('render-')));
  }
});

test('remote masters require independently verified planned canvas, FPS, duration and audio mode', async t => {
  for (const failure of ['canvas', 'fps', 'duration', 'videoDuration', 'audio', 'subtitle', 'missingVideo', 'missingNarration']) {
    const context = await remoteRenderContext(t, { sceneCount: 1, audioMode: failure === 'missingNarration' ? 'narrated' : 'silent', probeChange: probe => {
      if (failure === 'canvas') probe.streams[0].width = 720;
      if (failure === 'fps') probe.streams[0].avg_frame_rate = '24/1';
      if (failure === 'duration') probe.format.duration = '16';
      if (failure === 'videoDuration') probe.streams[0].duration = '14';
      if (failure === 'audio') probe.streams.push({ codec_type: 'audio' });
      if (failure === 'subtitle') probe.streams.push({ codec_type: 'subtitle' });
      if (failure === 'missingVideo') probe.streams = [];
      if (failure === 'missingNarration') probe.streams = probe.streams.filter(stream => stream.codec_type !== 'audio');
    } });
    await assert.rejects(context.production.registerRemoteRender(context.input), /Remote render registration failed/);
    assert.equal((await context.studio.getEpisode(context.episode.id)).render, null);
  }
});

test('remote narrated assembly records only approximate scene sidecars and the exact audio parents', async t => {
  const context = await remoteRenderContext(t, { sceneCount: 1, audioMode: 'narrated' });
  const render = await context.production.registerRemoteRender(context.input);
  assert.equal(render.hasAudio, true);
  assert.equal(render.audioMode, 'narrated');
  assert.equal(render.captionsTiming, 'scene-approximate');
  assert.equal(render.sceneAssets[0].audioAssetId, context.sources[0].audio.id);
  assert.equal(render.provenance.parents[1].assetId, context.sources[0].audio.id);
  assert.match(await readFile(resolve(context.directory, render.captionsPath), 'utf8'), /00:00:00,000 --> 00:00:15,000/);
});

test('remote probe failures sanitize private process output and never commit or approve an artifact', async t => {
  const context = await remoteRenderContext(t, { sceneCount: 1, probeHook: async () => { throw new Error('fake-token https://private.example/media?signature=private-secret stderr-private'); } });
  await assert.rejects(context.production.registerRemoteRender(context.input), error => {
    assert.match(error.message, /Remote render registration failed/);
    assert.doesNotMatch(error.message, /fake-token|private-secret|stderr-private/);
    return true;
  });
  const state = await context.store.read();
  assert.doesNotMatch(JSON.stringify(state), /fake-token|private-secret|stderr-private/);
  assert.equal(state.episodes[0].render, null);
  assert.equal(state.episodes[0].approval, null);
  assert.ok((await readdir(join(context.directory, 'assets'))).every(name => !name.startsWith('render-')));
});

test('remote render commit failure cleans the private copy and preserves sources without exposing the store error', async t => {
  const context = await remoteRenderContext(t, { sceneCount: 1 });
  const transaction = context.store.transaction.bind(context.store);
  let failures = 0;
  context.store.transaction = fn => transaction(async state => {
    const result = await fn(state);
    if (state.episodes[0].render?.visualMethod === 'remote-assembly') {
      failures += 1;
      throw new Error('private-store-commit-error');
    }
    return result;
  });
  await assert.rejects(context.production.registerRemoteRender(context.input), error => {
    assert.match(error.message, /Remote render registration failed/);
    assert.doesNotMatch(error.message, /private-store-commit-error/);
    return true;
  });
  const state = await context.store.read();
  assert.equal(failures, 1);
  assert.equal(state.episodes[0].status, 'planned');
  assert.equal(state.episodes[0].renderAttempt.status, 'failed');
  assert.equal(state.episodes[0].render, null);
  assert.equal(state.assets[0].id, context.sources[0].image.id);
  assert.deepEqual(await readFile(resolve(context.directory, state.assets[0].path)), PNG);
  assert.deepEqual(await readFile(context.localPath), MP4);
  assert.doesNotMatch(JSON.stringify(state), /private-store-commit-error/);
  assert.ok((await readdir(join(context.directory, 'assets'))).every(name => !name.startsWith('render-')));
});

test('a remote registration reservation prevents concurrent master registration before a second probe', async t => {
  let entered;
  let release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const context = await remoteRenderContext(t, { sceneCount: 1, probeHook: async () => { entered(); await gate; } });
  const first = context.production.registerRemoteRender(context.input);
  try {
    await ready;
    await assert.rejects(context.production.registerRemoteRender(context.input), /Episode is rendering/);
    assert.equal(context.calls.length, 1);
  } finally { release(); }
  assert.equal((await first).hasAudio, false);
  assert.equal((await context.studio.getEpisode(context.episode.id)).renderAttempt.status, 'completed');
});

test('nonverbal blocks speech generation before token, spending or inference but permits original audio import', async t => {
  const context = await setup(t, { audioMode: 'nonverbal' });
  const production = new Production(context.store, { env: {}, inferenceClient: { textToSpeech: async () => assert.fail('Nonverbal must never call speech synthesis') } });
  await assert.rejects(production.generateAsset(generation(context.episode, { kind: 'audio', prompt: 'Do not speak this prompt' })), /cannot use text-to-speech/);
  assert.deepEqual((await context.store.read()).spending, []);
  const localPath = join(context.directory, 'original-effects.wav');
  await writeFile(localPath, WAV);
  const audio = await production.registerAsset({ episodeId: context.episode.id, sceneId: context.episode.scenes[0].id, kind: 'audio', localPath, provenance: { ...provenance, prompt: 'Original nonverbal mechanical ambience, no spoken language.' } });
  assert.equal(audio.kind, 'audio');
  assert.equal(audio.synthetic, true);
});

test('a speech response cannot commit after its episode switches to nonverbal', async t => {
  const context = await setup(t);
  const production = new Production(context.store, { env, inferenceClient: { textToSpeech: async () => {
    await context.store.transaction(state => {
      state.episodes[0].audioMode = 'nonverbal';
      state.episodes[0].scenes[0].narration = '';
    });
    return new Blob([WAV], { type: 'audio/wav' });
  } } });
  await assert.rejects(production.generateAsset(generation(context.episode, { kind: 'audio' })), /Generation failed after reservation/);
  const state = await context.store.read();
  assert.equal(state.episodes[0].audioMode, 'nonverbal');
  assert.equal(state.spending[0].status, 'unknown');
  assert.deepEqual(state.assets, []);
});

test('nonverbal renderer maps original scene audio and pads without SRT, subtitles or embedded source sound', async t => {
  const context = await setup(t, { audioMode: 'nonverbal', sceneCount: 2 });
  const fake = fakeRenderer(6, { sourceHasAudio: true, onEncode: async ({ options }) => {
    assert.ok((await readdir(options.cwd)).every(name => !name.endsWith('.srt')));
  } });
  const production = new Production(context.store, { env, runner: fake.runner });
  const sources = await addSourceAssets(context, production, { alsoVideo: true });
  const render = await production.renderEpisode({ episodeId: context.episode.id });
  assert.equal(render.audioMode, 'nonverbal');
  assert.equal(render.hasAudio, true);
  for (const field of ['captionsPath', 'captionsSha256', 'captionsTiming']) assert.equal(render[field], undefined);
  assert.deepEqual(render.sceneAssets, sources.map((source, index) => ({ sceneId: context.episode.scenes[index].id, visualAssetId: source.video.id, audioAssetId: source.audio.id })));
  const encodes = fake.calls.filter(call => call.command === env.FFMPEG_PATH);
  assert.equal(encodes.length, 3);
  for (const call of encodes) {
    assert.ok(call.args.includes('-sn'));
    assert.ok(!call.args.includes('-an'));
    assert.ok(!call.args.join(' ').includes('subtitles='));
    assert.ok(!call.args.includes('-stream_loop'));
  }
  for (const [index, call] of encodes.slice(0, -1).entries()) {
    const maps = call.args.flatMap((arg, position) => arg === '-map' ? [call.args[position + 1]] : []);
    assert.deepEqual(maps, ['0:v:0', '1:a:0']);
    assert.ok(call.args.includes(resolve(context.directory, sources[index].audio.path)));
    assert.equal(call.args[call.args.indexOf('-af') + 1], 'apad');
    assert.equal(call.args[call.args.indexOf('-c:a') + 1], 'aac');
  }
  assert.ok((await readdir(join(context.directory, 'assets'))).every(name => !name.endsWith('.srt')));
});

test('nonverbal rendering requires audio and empty narration and refuses to truncate sound or loop a short video', async t => {
  for (const failure of ['missingAudio', 'narration', 'longAudio', 'shortVideo']) {
    const context = await setup(t, { audioMode: 'nonverbal' });
    const fake = fakeRenderer(3, { audioDuration: failure === 'longAudio' ? 3.2 : 2, sourceVideoDuration: failure === 'shortVideo' ? 2 : 3 });
    const production = new Production(context.store, { env, runner: fake.runner });
    await addSourceAssets(context, production, { includeAudio: failure !== 'missingAudio', alsoVideo: true });
    if (failure === 'narration') await context.store.transaction(state => { state.episodes[0].scenes[0].narration = 'Unwanted speech'; });
    const expected = { missingAudio: /requires synthetic visual and nonverbal audio/, narration: /Nonverbal episodes cannot contain narration/, longAudio: /would truncate nonverbal audio/, shortVideo: /nonverbal renders do not loop video/ };
    await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), expected[failure]);
    assert.equal(fake.calls.filter(call => call.command === env.FFMPEG_PATH).length, 0);
    assert.equal((await context.studio.getEpisode(context.episode.id)).render, null);
  }
});

test('nonverbal final validation requires audio throughout the planned duration and rejects subtitle streams', async t => {
  for (const failure of ['missingAudio', 'shortAudio', 'subtitle']) {
    const context = await setup(t, { audioMode: 'nonverbal' });
    const fake = fakeRenderer(3);
    const runner = async (command, args, options) => {
      const result = await fake.runner(command, args, options);
      if (command === env.FFPROBE_PATH && /render-[^/]+\.mp4$/.test(args.at(-1))) {
        const probe = JSON.parse(result.stdout);
        if (failure === 'missingAudio') probe.streams = probe.streams.filter(stream => stream.codec_type !== 'audio');
        if (failure === 'shortAudio') probe.streams.find(stream => stream.codec_type === 'audio').duration = '2';
        if (failure === 'subtitle') probe.streams.push({ codec_type: 'subtitle' });
        result.stdout = JSON.stringify(probe);
      }
      return result;
    };
    const production = new Production(context.store, { env, runner });
    await addSourceAssets(context, production);
    await assert.rejects(production.renderEpisode({ episodeId: context.episode.id }), failure === 'shortAudio' ? /dropped nonverbal audio/ : /Final render failed/);
    assert.equal((await context.studio.getEpisode(context.episode.id)).render, null);
    assert.ok((await readdir(join(context.directory, 'assets'))).every(name => !name.startsWith('render-')));
  }
});

test('remote nonverbal master requires exact audio parents and creates no caption sidecar', async t => {
  const context = await remoteRenderContext(t, { audioMode: 'nonverbal', sceneCount: 1 });
  assert.equal(context.manifest.audioMode, 'nonverbal');
  assert.equal(context.manifest.scenes[0].audio.assetId, context.sources[0].audio.id);
  const render = await context.production.registerRemoteRender(context.input);
  assert.equal(render.audioMode, 'nonverbal');
  assert.equal(render.hasAudio, true);
  assert.equal(render.sceneAssets[0].audioAssetId, context.sources[0].audio.id);
  assert.equal(render.provenance.parents[1].assetId, context.sources[0].audio.id);
  for (const field of ['captionsPath', 'captionsSha256', 'captionsTiming']) assert.equal(render[field], undefined);
  assert.ok((await readdir(join(context.directory, 'assets'))).every(name => !name.endsWith('.srt')));
});

test('remote nonverbal verification rejects missing/short audio and additional subtitle streams', async t => {
  for (const failure of ['missingAudio', 'shortAudio', 'subtitle']) {
    const context = await remoteRenderContext(t, { audioMode: 'nonverbal', sceneCount: 1, probeChange: probe => {
      if (failure === 'missingAudio') probe.streams = probe.streams.filter(stream => stream.codec_type !== 'audio');
      if (failure === 'shortAudio') probe.streams.find(stream => stream.codec_type === 'audio').duration = '14';
      if (failure === 'subtitle') probe.streams.push({ codec_type: 'subtitle' });
    } });
    await assert.rejects(context.production.registerRemoteRender(context.input), /Remote render registration failed/);
    assert.equal((await context.studio.getEpisode(context.episode.id)).render, null);
    assert.ok((await readdir(join(context.directory, 'assets'))).every(name => !name.startsWith('render-')));
  }
});
