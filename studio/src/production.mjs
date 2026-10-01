import { constants } from 'node:fs';
import { mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { episodeReviewHash } from './domain.mjs';
import { falQueueReceiptFetch } from './fal-queue-receipt.mjs';
import { recoverFalVideo } from './fal-queue-recovery.mjs';

const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WAN_A14B_I2V_MODELS = new Set(['Wan-AI/Wan2.2-I2V-A14B', 'Wan-AI/Wan2.2-I2V-A14B-Diffusers']);
const MAX_PROBE_BYTES = 1024 * 1024;
const KINDS = new Set(['image', 'audio', 'video']);
const PUBLICATION_FREEZE_STATUSES = new Set(['reserved', 'uploading', 'sending', 'unknown', 'processing', 'uploaded', 'scheduled', 'published']);
const MIME_EXTENSIONS = {
  image: { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' },
  audio: { 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/flac': '.flac', 'audio/mp4': '.m4a' },
  video: { 'video/mp4': '.mp4', 'video/webm': '.webm' },
};

// Explicit pilot controls, a bounded subset of the Wan 2.2 fal API. No defaults:
// omitting parameters preserves the provider's existing generation behavior.
export const videoParametersSchema = z.strictObject({
  resolution: z.enum(['480p', '580p', '720p']).optional(),
  aspect_ratio: z.enum(['16:9', '9:16']).optional(),
  num_frames: z.number().int().min(81).max(121).optional(),
  frames_per_second: z.union([z.literal(16), z.literal(24)]).optional(),
  num_inference_steps: z.number().int().min(1).max(40).optional(),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
  interpolator_model: z.enum(['none', 'film']).optional(),
  num_interpolated_frames: z.union([z.literal(0), z.literal(1)]).optional(),
  adjust_fps_for_interpolation: z.boolean().optional(),
  enable_prompt_expansion: z.boolean().optional(),
});

export const imageParametersSchema = z.strictObject({
  width: z.number().int().min(256).max(2048).optional(),
  height: z.number().int().min(256).max(2048).optional(),
  num_inference_steps: z.number().int().min(1).max(50).optional(),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
});

function imageParametersFor(kind, value) {
  if (value === undefined) return undefined;
  if (kind !== 'image') throw new Error('imageParameters is allowed only for image generation');
  const parsed = imageParametersSchema.safeParse(value);
  if (!parsed.success) throw new Error('imageParameters contains unsupported values or fields');
  if ((parsed.data.width === undefined) !== (parsed.data.height === undefined)) throw new Error('imageParameters width and height must be provided together');
  return parsed.data;
}

function imageSdkParameters(provider, parameters) {
  if (parameters === undefined || provider !== 'fal-ai' || parameters.width === undefined) return parameters;
  // The fal SDK flattens parameters without translating width/height. Its
  // image API expects the bounded dimensions under image_size instead.
  const { width, height, ...remaining } = parameters;
  return { ...remaining, image_size: { width, height } };
}

function videoParametersFor(kind, value) {
  if (value === undefined) return undefined;
  if (kind !== 'video') throw new Error('videoParameters is allowed only for video generation');
  const parsed = videoParametersSchema.safeParse(value);
  if (!parsed.success) throw new Error('videoParameters contains unsupported values or fields');
  // Keep the clip duration stable: one FILM frame doubles 16/24 to 32/48 fps.
  // Require explicit controls rather than inheriting undocumented combinations.
  if (parsed.data.interpolator_model === 'film') {
    if (parsed.data.num_interpolated_frames !== 1 || parsed.data.adjust_fps_for_interpolation !== true) throw new Error('videoParameters contains unsupported values or fields: FILM requires one interpolated frame and FPS adjustment');
  } else if (parsed.data.num_interpolated_frames === 1 ||
      (parsed.data.adjust_fps_for_interpolation !== undefined && (parsed.data.interpolator_model !== 'none' || parsed.data.num_interpolated_frames !== 0))) {
    throw new Error('videoParameters contains unsupported values or fields: interpolation controls must be coherent');
  }
  return parsed.data;
}

function requireWanFrameControls({ kind, model, provider, parameters, referenceImageAssetId, endReferenceImageAssetId }) {
  if (endReferenceImageAssetId === undefined && parameters?.interpolator_model !== 'film' && parameters?.adjust_fps_for_interpolation === undefined) return;
  if (kind !== 'video' || provider !== 'fal-ai' || !WAN_A14B_I2V_MODELS.has(model) || referenceImageAssetId === undefined) throw new Error('Final-frame and interpolation controls require fal-ai Wan2.2-I2V-A14B with an initial reference image');
}

function requiredText(value, name, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be nonempty text (maximum ${max} characters)`);
  return value.trim();
}

function evidence(value) {
  const url = requiredText(value?.url, 'commercialLicense.url', 2000);
  if (!/^https?:\/\//i.test(url)) throw new Error('commercialLicense.url must be an HTTP(S) evidence URL');
  const parsed = new URL(url);
  if (!parsed.hostname || parsed.username || parsed.password) throw new Error('commercialLicense.url must not contain credentials');
  return { url, notes: requiredText(value?.notes, 'commercialLicense.notes', 10000) };
}

function requireKind(kind) {
  if (!KINDS.has(kind)) throw new Error('kind must be image, audio or video');
}

function audioMode(episode) {
  const mode = episode.audioMode ?? 'narrated';
  if (!['narrated', 'silent'].includes(mode)) throw new Error('audioMode must be narrated or silent');
  return mode;
}

function requireProductionKind(episode, kind) {
  if (audioMode(episode) === 'silent' && kind === 'audio') throw new Error('Silent episodes cannot generate or import audio assets');
}

function mediaDuration(probe, stream) {
  return Number(stream.duration === undefined || stream.duration === 'N/A' ? probe.format?.duration : stream.duration);
}

function sceneContext(state, episodeId, sceneId) {
  const episode = state.episodes.find((item) => item.id === episodeId);
  if (!episode) throw new Error('Episode does not exist');
  const scene = episode.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error('Scene does not belong to episode');
  const project = state.projects.find((item) => item.id === episode.projectId);
  if (!project) throw new Error('Project does not exist');
  return { episode, scene, project };
}

function mutableEpisode(episode, state) {
  if (['rendering', 'publishing', 'processing', 'uploaded', 'scheduled', 'unknown', 'published'].includes(episode.status)) throw new Error(`Episode is ${episode.status}; assets cannot change now`);
  if (state.publications.some((item) => item.episodeId === episode.id && PUBLICATION_FREEZE_STATUSES.has(item.status))) throw new Error('Episode has a reserved, uploaded or unknown publication; reconcile it before changing production assets');
  if (state.projects.find((item) => item.id === episode.projectId)?.status !== 'active') throw new Error('The episode project must be active for production');
}

function invalidate(episode) {
  episode.approval = null;
  episode.render = null;
  episode.status = 'planned';
  delete episode.renderError;
}

function hasPendingGeneration(state, episodeId, sceneId, kind) {
  return state.spending.some((item) => item.episodeId === episodeId && item.sceneId === sceneId && item.kind === kind && ['reserved', 'unknown'].includes(item.status));
}

function assertBudget(state, project, estimatedCostUsd) {
  if (project.budgetMonthlyUsd === null || project.budgetMonthlyUsd === undefined) return;
  if (!Number.isFinite(project.budgetMonthlyUsd) || project.budgetMonthlyUsd < 0) throw new Error('Project monthly budget is invalid');
  const month = new Date().toISOString().slice(0, 7);
  const committed = state.spending.filter((item) => item.projectId === project.id && item.createdAt?.startsWith(month) && ['reserved', 'completed', 'unknown'].includes(item.status)).reduce((sum, item) => sum + item.estimatedCostUsd, 0);
  if (!Number.isFinite(committed) || committed + estimatedCostUsd > project.budgetMonthlyUsd) throw new Error('Generation would exceed the optional monthly project budget');
}

function detectType(bytes, kind) {
  if (kind === 'image') {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  }
  if (kind === 'audio') {
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return '.wav';
    if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return '.mp3';
    if (bytes.toString('ascii', 0, 4) === 'OggS') return '.ogg';
    if (bytes.toString('ascii', 0, 4) === 'fLaC') return '.flac';
    if (bytes.toString('ascii', 4, 8) === 'ftyp') return '.m4a';
  }
  if (kind === 'video') {
    if (bytes.toString('ascii', 4, 8) === 'ftyp') return '.mp4';
    if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return '.webm';
  }
  throw new Error(`File header is not a supported ${kind} format`);
}

async function boundedFile(path, maximum = MAX_ASSET_BYTES) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > maximum) throw new Error(`Asset must be a regular nonempty file no larger than ${maximum} bytes`);
    const chunks = [];
    let length = 0;
    while (length <= maximum) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, maximum - length + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    if (length !== info.size || length > maximum) throw new Error('File changed while reading or exceeds the size limit');
    return Buffer.concat(chunks, length);
  } finally {
    await handle.close();
  }
}

async function assetRoot(store) {
  const directory = resolve(store.directory);
  const root = await realpath(directory);
  await mkdir(resolve(root, 'assets'), { recursive: true });
  const assets = await realpath(resolve(root, 'assets'));
  if (relative(root, assets) !== 'assets') throw new Error('Asset directory must remain inside the studio store');
  return { root, assets };
}

async function internalPath(store, path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\0')) throw new Error('Stored asset path must be relative');
  const { root, assets } = await assetRoot(store);
  const actual = await realpath(resolve(root, path));
  if (!actual.startsWith(`${assets}${sep}`)) throw new Error('Stored asset path escapes the assets directory');
  return actual;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function referenceImageAsset(state, episodeId, sceneId, assetId) {
  const asset = state.assets.find(item => item.id === assetId);
  if (!asset || asset.kind !== 'image' || asset.episodeId !== episodeId || asset.sceneId !== sceneId) throw new Error('Reference must be an image asset from the same episode and scene');
  if (asset.synthetic !== true || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '')) throw new Error('Reference image must be synthetic with a recorded SHA-256');
  requiredText(asset.provenance?.provider, 'reference image provider', 100);
  requiredText(asset.provenance?.model, 'reference image model', 300);
  requiredText(asset.provenance?.prompt, 'reference image prompt');
  evidence(asset.provenance?.commercialLicense);
  return asset;
}

function referenceSnapshot(asset) {
  return JSON.stringify({ id: asset.id, path: asset.path, sha256: asset.sha256, synthetic: asset.synthetic, provenance: asset.provenance });
}

async function loadReferenceImage(store, state, episodeId, sceneId, assetId, name = 'referenceImageAssetId') {
  if (assetId === undefined) return undefined;
  if (typeof assetId !== 'string' || !UUID.test(assetId)) throw new Error(`${name} must be an image asset UUID`);
  const asset = referenceImageAsset(state, episodeId, sceneId, assetId);
  const bytes = await boundedFile(await internalPath(store, asset.path));
  if (sha256(bytes) !== asset.sha256) throw new Error('Reference image file hash does not match its recorded SHA-256');
  const extension = detectType(bytes, 'image');
  const type = Object.keys(MIME_EXTENSIONS.image).find(mime => MIME_EXTENSIONS.image[mime] === extension);
  const snapshot = referenceSnapshot(asset);
  return { descriptor: { assetId, sha256: asset.sha256 }, snapshot, snapshotHash: sha256(Buffer.from(snapshot)), blob: new Blob([bytes], { type }) };
}

function assertReferenceUnchanged(state, episodeId, sceneId, reference) {
  if (reference === undefined) return;
  const asset = referenceImageAsset(state, episodeId, sceneId, reference.descriptor.assetId);
  if (referenceSnapshot(asset) !== reference.snapshot) throw new Error('Reference image changed during generation');
}

function referenceProvenance(reference, endReference) {
  if (reference === undefined) return {};
  return {
    referenceImage: { ...reference.descriptor },
    ...(endReference === undefined ? {} : { endReferenceImage: { ...endReference.descriptor } }),
    parents: [reference, ...(endReference === undefined ? [] : [endReference])].map(item => ({ ...item.descriptor })),
  };
}

function referenceReservation(reference, endReference) {
  return {
    ...(reference === undefined ? {} : { referenceImage: { ...reference.descriptor }, referenceImageSnapshotHash: reference.snapshotHash }),
    ...(endReference === undefined ? {} : { endReferenceImage: { ...endReference.descriptor }, endReferenceImageSnapshotHash: endReference.snapshotHash }),
  };
}

async function saveAsset(store, bytes, extension, fields) {
  const { assets } = await assetRoot(store);
  const id = randomUUID();
  const path = `assets/${id}${extension}`;
  await writeFile(resolve(assets, `${id}${extension}`), bytes, { flag: 'wx', mode: 0o600 });
  return { id, ...fields, path, sha256: sha256(bytes), synthetic: true, createdAt: new Date().toISOString() };
}

// No shell and bounded output. The production runner is injectable; CI uses a fake.
async function runCommand(command, args, { cwd, timeoutMs = 600000 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let stopped = false;
    const stop = (message) => {
      if (stopped) return;
      stopped = true;
      child.kill('SIGKILL');
      reject(new Error(message));
    };
    const timer = setTimeout(() => stop(`${command} timed out`), timeoutMs);
    const append = (target, data) => {
      size += data.length;
      if (size > MAX_PROBE_BYTES) return stop(`${command} exceeded the output limit`);
      if (target === 'stdout') stdout += data.toString();
      else stderr += data.toString();
    };
    child.stdout.on('data', (data) => append('stdout', data));
    child.stderr.on('data', (data) => append('stderr', data));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stopped) return;
      if (code !== 0) reject(new Error(`${command} exited with ${code}: ${stderr.slice(-2000)}`));
      else accept({ stdout, stderr, exitCode: code });
    });
  });
}

function timestamp(seconds) {
  const total = Math.round(seconds * 1000);
  return `${String(Math.floor(total / 3600000)).padStart(2, '0')}:${String(Math.floor(total / 60000) % 60).padStart(2, '0')}:${String(Math.floor(total / 1000) % 60).padStart(2, '0')},${String(total % 1000).padStart(3, '0')}`;
}

function captionText(value) {
  return requiredText(value, 'scene narration').replace(/\r/g, '').replace(/\n+/g, ' ').replace(/-->/g, '→');
}

function captions(scenes) {
  let offset = 0;
  return scenes.map((scene, index) => {
    const start = offset;
    offset += scene.durationSeconds;
    return `${index + 1}\n${timestamp(start)} --> ${timestamp(offset)}\n${captionText(scene.narration)}\n`;
  }).join('\n');
}

function fingerprint(episode, selected) {
  return sha256(Buffer.from(JSON.stringify({ editorial: episodeReviewHash(episode), audioMode: audioMode(episode), selected })));
}

function selectSceneAssets(state, episode) {
  const narrated = audioMode(episode) === 'narrated';
  return episode.scenes.map((scene) => {
    const matching = state.assets.filter((asset) => asset.episodeId === episode.id && asset.sceneId === scene.id);
    const visual = matching.findLast((asset) => asset.kind === 'video') ?? matching.findLast((asset) => asset.kind === 'image');
    const audio = narrated ? matching.findLast((asset) => asset.kind === 'audio') : undefined;
    if (!visual || (narrated && !audio)) throw new Error(`Scene ${scene.id} requires synthetic visual${narrated ? ' and narration audio' : ''} assets`);
    for (const asset of [visual, ...(audio ? [audio] : [])]) {
      if (asset.synthetic !== true) throw new Error('Only attested synthetic assets can be rendered');
      evidence(asset.provenance?.commercialLicense);
    }
    return { sceneId: scene.id, visual, audio };
  });
}

/** Cloud inference and asynchronous rendering; no scraping or downloaded source footage. */
export class Production {
  constructor(store, { env = process.env, inferenceClient, runner = runCommand, fetchImpl = fetch } = {}) {
    this.store = store;
    this.env = env;
    this.inferenceClient = inferenceClient;
    this.runner = runner;
    this.fetch = fetchImpl;
  }

  async generateAsset({ episodeId, sceneId, kind, model, provider, prompt, videoParameters, imageParameters, referenceImageAssetId, endReferenceImageAssetId, estimatedCostUsd, pricingSourceUrl, commercialLicense, acknowledgePaidCost = false, resumeReservationId, productionJobId }) {
    requireKind(kind);
    const parameters = videoParametersFor(kind, videoParameters);
    const imageSettings = imageParametersFor(kind, imageParameters);
    if (referenceImageAssetId !== undefined && kind !== 'video') throw new Error('referenceImageAssetId is allowed only for video generation');
    if (endReferenceImageAssetId !== undefined && kind !== 'video') throw new Error('endReferenceImageAssetId is allowed only for video generation');
    model = requiredText(model, 'model', 300);
    provider = requiredText(provider, 'provider', 100);
    if (provider === 'auto') throw new Error('Choose an explicit provider so the cost and license evidence refer to the actual service');
    requireWanFrameControls({ kind, model, provider, parameters, referenceImageAssetId, endReferenceImageAssetId });
    const license = evidence(commercialLicense);
    const pricing = evidence({ url: pricingSourceUrl, notes: 'Caller-supplied estimate; zero does not prove the provider will not bill.' });
    if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) throw new Error('estimatedCostUsd must be an explicit nonnegative finite estimate');
    const initial = await this.store.read();
    const context = sceneContext(initial, episodeId, sceneId);
    requireProductionKind(context.episode, kind);
    if (!this.env.HF_TOKEN) throw new Error('HF_TOKEN is required for cloud inference');
    const inputs = requiredText(prompt ?? (kind === 'audio' ? context.scene.narration : context.scene.visualPrompt), 'prompt');
    const reference = await loadReferenceImage(this.store, initial, episodeId, sceneId, referenceImageAssetId);
    const endReference = await loadReferenceImage(this.store, initial, episodeId, sceneId, endReferenceImageAssetId, 'endReferenceImageAssetId');
    if (resumeReservationId !== undefined) return this.recoverAsset({
      episodeId, sceneId, kind, model, provider, inputs, parameters, estimatedCostUsd,
      pricingSourceUrl: pricing.url, commercialLicense: license, resumeReservationId, reference, endReference,
    });
    if (estimatedCostUsd > 0 && (acknowledgePaidCost !== true || this.env.YTFUN_PAID_GENERATION_ENABLED !== 'true')) throw new Error('Paid generation needs explicit per-call cost acknowledgment and YTFUN_PAID_GENERATION_ENABLED=true');
    const id = randomUUID();
    await this.store.transaction((state) => {
      const { episode, project } = sceneContext(state, episodeId, sceneId);
      mutableEpisode(episode, state);
      requireProductionKind(episode, kind);
      assertReferenceUnchanged(state, episodeId, sceneId, reference);
      assertReferenceUnchanged(state, episodeId, sceneId, endReference);
      if (productionJobId !== undefined && !state.productionJobs?.some(job => job.id === productionJobId && job.action === 'generate' && job.episodeId === episodeId && job.status === 'running')) throw new Error('Generation job is not the active owner of this episode request');
      if (hasPendingGeneration(state, episodeId, sceneId, kind)) throw new Error('A previous generation is reserved or has an unknown charge outcome; reconcile it before retrying');
      assertBudget(state, project, estimatedCostUsd);
      state.spending.push({ id, projectId: project.id, episodeId, sceneId, kind, provider, model, prompt: inputs, commercialLicense: license, ...(productionJobId === undefined ? {} : { productionJobId }), ...(parameters === undefined ? {} : { videoParameters: { ...parameters } }), ...(imageSettings === undefined ? {} : { imageParameters: { ...imageSettings } }), ...referenceReservation(reference, endReference), estimatedCostUsd, pricingSourceUrl: pricing.url, priceNote: pricing.notes, status: 'reserved', createdAt: new Date().toISOString() });
      invalidate(episode);
    });
    let asset;
    try {
      const client = this.inferenceClient ?? new (await import('@huggingface/inference')).InferenceClient(this.env.HF_TOKEN);
      const method = reference ? 'imageToVideo' : { image: 'textToImage', audio: 'textToSpeech', video: 'textToVideo' }[kind];
      // Official SDK textToVideo/textToSpeech return Blob; textToImage is forced to Blob.
      // A 503 may have an ambiguous charge outcome; disable the SDK's recursive retry.
      const options = { retry_on_error: false, ...(kind === 'image' ? { outputType: 'blob' } : {}) };
      // The SDK polls only after this supported hook returns its POST response.
      // Preserve the remote queue identity before polling can outlive this worker.
      if (kind === 'video' && provider === 'fal-ai') options.fetch = falQueueReceiptFetch(this.store, id, { fetchImpl: this.fetch });
      const sdkParameters = kind === 'image' ? imageSdkParameters(provider, imageSettings) : parameters;
      const args = reference
        ? { model, provider, inputs: reference.blob, parameters: { ...parameters, prompt: inputs,
          ...(endReference === undefined ? {} : { end_image_url: `data:${endReference.blob.type};base64,${Buffer.from(await endReference.blob.arrayBuffer()).toString('base64')}` }),
        } }
        : { model, provider, inputs, ...(sdkParameters === undefined ? {} : { parameters: structuredClone(sdkParameters) }) };
      const output = await client[method](args, options);
      if (!(output instanceof Blob) || output.size === 0 || output.size > MAX_ASSET_BYTES) throw new Error('Inference response must be a nonempty Blob no larger than 100 MiB');
      const extension = MIME_EXTENSIONS[kind][output.type.toLowerCase().split(';')[0]];
      if (!extension) throw new Error(`Unsupported ${kind} response MIME type`);
      const bytes = Buffer.from(await output.arrayBuffer());
      if (detectType(bytes, kind) !== extension) throw new Error('Inference response MIME type does not match its file header');
      asset = await saveAsset(this.store, bytes, extension, { episodeId, sceneId, kind, provenance: { provider, model, prompt: inputs, ...(parameters === undefined ? {} : { videoParameters: { ...parameters } }), ...(imageSettings === undefined ? {} : { imageParameters: { ...imageSettings } }), ...referenceProvenance(reference, endReference), commercialLicense: license } });
      return await this.store.transaction((state) => {
        const { episode } = sceneContext(state, episodeId, sceneId);
        mutableEpisode(episode, state);
        requireProductionKind(episode, kind);
        assertReferenceUnchanged(state, episodeId, sceneId, reference);
        assertReferenceUnchanged(state, episodeId, sceneId, endReference);
        state.assets.push(asset);
        const reservation = state.spending.find((item) => item.id === id);
        if (!reservation || reservation.status !== 'reserved') throw new Error('Generation reservation changed during inference');
        reservation.status = 'completed';
        reservation.assetId = asset.id;
        reservation.completedAt = new Date().toISOString();
        invalidate(episode);
        return asset;
      });
    } catch (error) {
      if (asset) {
        try {
          await rm(await internalPath(this.store, asset.path), { force: true });
        } catch {
          // Cleanup/path failures cannot skip recording the uncertain outcome.
        }
      }
      try {
        await this.store.transaction((state) => {
          const reservation = state.spending.find((item) => item.id === id);
          if (reservation?.status === 'reserved') {
            reservation.status = 'unknown';
            reservation.error = 'Generation did not complete locally; provider billing must be reconciled before retrying.';
            reservation.failedAt = new Date().toISOString();
          }
        });
      } catch {
        // If storage is still unavailable, the committed reserved state remains
        // a retry barrier. Never expose the secondary storage error or resubmit.
      }
      // Provider exceptions may embed request headers, URLs or response bodies.
      // Never return them through MCP or persist them in the job/state records.
      throw new Error(`Generation failed after reservation ${id}; reconcile the provider outcome before retrying.`);
    }
  }

  async recoverAsset({ episodeId, sceneId, kind, model, provider, inputs, parameters, estimatedCostUsd, pricingSourceUrl, commercialLicense, resumeReservationId, reference, endReference }) {
    if (kind !== 'video' || provider !== 'fal-ai' || typeof resumeReservationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resumeReservationId)) throw new Error('Recovery requires the UUID of an existing fal-ai video reservation');
    const attemptId = randomUUID();
    const claim = await this.store.transaction(state => {
      const { episode } = sceneContext(state, episodeId, sceneId);
      mutableEpisode(episode, state);
      const reservation = state.spending.find(item => item.id === resumeReservationId);
      if (!reservation || reservation.episodeId !== episodeId || reservation.sceneId !== sceneId ||
          reservation.kind !== kind || reservation.provider !== provider || reservation.model !== model ||
          reservation.prompt !== inputs || reservation.estimatedCostUsd !== estimatedCostUsd ||
          reservation.pricingSourceUrl !== pricingSourceUrl ||
          JSON.stringify(reservation.videoParameters) !== JSON.stringify(parameters) ||
          JSON.stringify(reservation.referenceImage) !== JSON.stringify(reference?.descriptor) ||
          reservation.referenceImageSnapshotHash !== reference?.snapshotHash ||
          JSON.stringify(reservation.endReferenceImage) !== JSON.stringify(endReference?.descriptor) ||
          reservation.endReferenceImageSnapshotHash !== endReference?.snapshotHash ||
          JSON.stringify(reservation.commercialLicense) !== JSON.stringify(commercialLicense)) throw new Error('Recovery inputs must match the original persisted generation request');
      assertReferenceUnchanged(state, episodeId, sceneId, reference);
      assertReferenceUnchanged(state, episodeId, sceneId, endReference);
      if (reservation.status === 'completed') {
        const asset = state.assets.find(item => item.id === reservation.assetId && item.episodeId === episodeId && item.sceneId === sceneId);
        if (!asset) throw new Error('Completed generation has no recorded asset');
        return { asset };
      }
      if (!['reserved', 'unknown'].includes(reservation.status) || !reservation.remoteRequest) throw new Error('A persisted remote queue receipt is required; recovery never submits a replacement');
      const originalJob = state.productionJobs?.find(job => job.id === reservation.productionJobId);
      if (originalJob?.status === 'running' || state.productionJobs?.some(job => job.action === 'generate' && job.episodeId === episodeId && job.status === 'running' && job.resumeReservationId !== resumeReservationId)) throw new Error('The original generation worker is still active or unreconciled');
      if (reservation.status === 'reserved' && !['failed', 'interrupted'].includes(originalJob?.status)) throw new Error('A reserved generation requires reconciliation of its stopped original worker');
      if (reservation.recoveryClaim && Date.parse(reservation.recoveryClaim.expiresAt) > Date.now()) throw new Error('This generation is already being retrieved');
      reservation.recoveryClaim = { id: attemptId, expiresAt: new Date(Date.now() + 240_000).toISOString() };
      return { receipt: reservation.remoteRequest };
    });
    if (claim.asset) return claim.asset;
    let asset;
    try {
      const result = await recoverFalVideo(claim.receipt, { hfToken: this.env.HF_TOKEN, fetchImpl: this.fetch });
      if (!result.blob) {
        return await this.store.transaction(state => {
          const reservation = state.spending.find(item => item.id === resumeReservationId);
          if (reservation?.recoveryClaim?.id !== attemptId) throw new Error('Recovery claim changed');
          if (reservation.status === 'completed') {
            const existing = state.assets.find(item => item.id === reservation.assetId);
            if (!existing) throw new Error('Completed generation has no recorded asset');
            delete reservation.recoveryClaim;
            return existing;
          }
          reservation.remoteRequest.status = result.remoteStatus;
          reservation.remoteRequest.checkedAt = new Date().toISOString();
          delete reservation.recoveryClaim;
          return { reservationId: resumeReservationId, status: 'pending', remoteStatus: result.remoteStatus, submitted: false };
        });
      }
      const bytes = Buffer.from(await result.blob.arrayBuffer());
      asset = await saveAsset(this.store, bytes, detectType(bytes, 'video'), {
        episodeId, sceneId, kind, provenance: { provider, model, prompt: inputs,
          ...(parameters === undefined ? {} : { videoParameters: { ...parameters } }),
          ...referenceProvenance(reference, endReference), commercialLicense },
      });
      const committed = await this.store.transaction(state => {
        const { episode } = sceneContext(state, episodeId, sceneId);
        mutableEpisode(episode, state);
        assertReferenceUnchanged(state, episodeId, sceneId, reference);
        assertReferenceUnchanged(state, episodeId, sceneId, endReference);
        const reservation = state.spending.find(item => item.id === resumeReservationId);
        if (reservation?.recoveryClaim?.id !== attemptId) throw new Error('Recovery claim changed');
        if (reservation.status === 'completed') {
          const existing = state.assets.find(item => item.id === reservation.assetId);
          if (!existing) throw new Error('Completed generation has no recorded asset');
          delete reservation.recoveryClaim;
          return { asset: existing, reused: true };
        }
        if (!['reserved', 'unknown'].includes(reservation.status)) throw new Error('Generation reservation changed during retrieval');
        state.assets.push(asset);
        reservation.status = 'completed';
        reservation.assetId = asset.id;
        reservation.completedAt = new Date().toISOString();
        reservation.remoteRequest.status = 'COMPLETED';
        reservation.remoteRequest.checkedAt = reservation.completedAt;
        delete reservation.recoveryClaim;
        delete reservation.error;
        invalidate(episode);
        return { asset, reused: false };
      });
      if (committed.reused) {
        try { await rm(await internalPath(this.store, asset.path), { force: true }); }
        catch { /* Cleanup must not hide the original completed asset. */ }
      }
      return committed.asset;
    } catch {
      if (asset) {
        try { await rm(await internalPath(this.store, asset.path), { force: true }); }
        catch { /* Path/cleanup failures must not skip recording the outcome. */ }
      }
      await this.store.transaction(state => {
        const reservation = state.spending.find(item => item.id === resumeReservationId);
        if (reservation?.recoveryClaim?.id === attemptId) {
          delete reservation.recoveryClaim;
          if (reservation.status === 'reserved') reservation.status = 'unknown';
          reservation.recoveryError = 'The existing request could not be retrieved locally; preserve its receipt and do not submit again.';
        }
      }).catch(() => {});
      throw new Error(`Recovery failed for reservation ${resumeReservationId}; preserve its receipt and do not submit again.`);
    }
  }

  async registerAsset({ episodeId, sceneId, kind, localPath, provenance }) {
    requireKind(kind);
    if (provenance?.synthetic !== true) throw new Error('provenance.synthetic=true must attest that all inputs are generated or licensed');
    const normalized = { provider: requiredText(provenance.provider, 'provenance.provider', 100), model: requiredText(provenance.model, 'provenance.model', 300), prompt: requiredText(provenance.prompt, 'provenance.prompt'), commercialLicense: evidence(provenance.commercialLicense) };
    if (typeof localPath !== 'string' || !isAbsolute(localPath)) throw new Error('localPath must be an absolute local file path');
    const state = await this.store.read();
    const { episode } = sceneContext(state, episodeId, sceneId);
    mutableEpisode(episode, state);
    requireProductionKind(episode, kind);
    if (hasPendingGeneration(state, episodeId, sceneId, kind)) throw new Error('Reconcile the pending generation before replacing this asset');
    const actual = await realpath(localPath);
    const bytes = await boundedFile(actual);
    const asset = await saveAsset(this.store, bytes, detectType(bytes, kind), { episodeId, sceneId, kind, provenance: normalized });
    try {
      return await this.store.transaction((draft) => {
        const { episode } = sceneContext(draft, episodeId, sceneId);
        mutableEpisode(episode, draft);
        requireProductionKind(episode, kind);
        if (hasPendingGeneration(draft, episodeId, sceneId, kind)) throw new Error('Generation started during asset registration');
        draft.assets.push(asset);
        invalidate(episode);
        return asset;
      });
    } catch (error) {
      await rm(await internalPath(this.store, asset.path), { force: true }).catch(() => {});
      throw error;
    }
  }

  async probe(path) {
    const result = await this.runner(this.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { timeoutMs: 30000 });
    if (result.exitCode !== undefined && result.exitCode !== 0) throw new Error('ffprobe failed');
    if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_PROBE_BYTES) throw new Error('ffprobe output exceeds the limit');
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed.streams)) throw new Error('ffprobe did not return stream information');
    return parsed;
  }

  async renderEpisode({ episodeId }) {
    const attemptId = randomUUID();
    const snapshot = await this.store.transaction((state) => {
      const episode = state.episodes.find((item) => item.id === episodeId);
      if (!episode) throw new Error('Episode does not exist');
      mutableEpisode(episode, state);
      if (state.spending.some((item) => item.episodeId === episodeId && ['reserved', 'unknown'].includes(item.status))) throw new Error('Reconcile outstanding generation reservations before rendering');
      if (!Array.isArray(episode.scenes) || !episode.scenes.length || episode.scenes.length > 12) throw new Error('Rendering requires 1 to 12 scenes');
      const mode = audioMode(episode);
      let durationSeconds = 0;
      for (const scene of episode.scenes) {
        if (!Number.isFinite(scene.durationSeconds) || scene.durationSeconds <= 0) throw new Error('Each scene needs a positive duration');
        if (mode === 'narrated') captionText(scene.narration);
        else if (scene.narration !== undefined && scene.narration !== null && (typeof scene.narration !== 'string' || scene.narration.trim())) throw new Error('Silent episodes cannot contain narration');
        durationSeconds += scene.durationSeconds;
      }
      if (durationSeconds > 180) throw new Error('Rendered episodes cannot exceed 180 seconds');
      const selected = selectSceneAssets(state, episode);
      invalidate(episode);
      episode.status = 'rendering';
      episode.renderAttempt = { id: attemptId, status: 'rendering', startedAt: new Date().toISOString() };
      return { episode, selected, fingerprint: fingerprint(episode, selected), durationSeconds, audioMode: mode };
    });
    let scratch;
    let finalPath;
    let captionsPath;
    try {
      const { assets } = await assetRoot(this.store);
      scratch = resolve(assets, `render-work-${attemptId}`);
      await mkdir(scratch, { recursive: false, mode: 0o700 });
      const clips = [];
      const narrated = snapshot.audioMode === 'narrated';
      for (let index = 0; index < snapshot.episode.scenes.length; index += 1) {
        const scene = snapshot.episode.scenes[index];
        const { visual, audio } = snapshot.selected[index];
        const visualPath = await internalPath(this.store, visual.path);
        const audioPath = audio ? await internalPath(this.store, audio.path) : undefined;
        if (sha256(await boundedFile(visualPath)) !== visual.sha256 || (audio && sha256(await boundedFile(audioPath)) !== audio.sha256)) throw new Error('An asset changed on disk after registration');
        if (narrated) {
          const audioProbe = await this.probe(audioPath);
          const audioStream = audioProbe.streams.find((stream) => stream.codec_type === 'audio');
          const audioDuration = audioStream ? mediaDuration(audioProbe, audioStream) : NaN;
          if (!audioStream || !Number.isFinite(audioDuration) || audioDuration <= 0) throw new Error('Scene narration audio is empty or has no valid duration');
          if (audioDuration > scene.durationSeconds + 0.05) throw new Error(`Scene ${scene.id} would truncate narration; increase its duration`);
        }
        const visualProbe = await this.probe(visualPath);
        const visualStream = visualProbe.streams.find((stream) => stream.codec_type === 'video');
        if (!visualStream) throw new Error('Scene visual has no video/image stream');
        if (!narrated && visual.kind === 'video') {
          const visualDuration = mediaDuration(visualProbe, visualStream);
          if (!Number.isFinite(visualDuration) || visualDuration <= 0) throw new Error(`Scene ${scene.id} video has no valid duration`);
          if (visualDuration + 0.05 < scene.durationSeconds) throw new Error(`Scene ${scene.id} video is shorter than its planned duration; silent renders do not loop video`);
        }
        const srtName = `scene-${index}.srt`;
        if (narrated) await writeFile(resolve(scratch, srtName), captions([scene]), { mode: 0o600 });
        const clip = resolve(scratch, `clip-${index}.mp4`);
        const visualFilter = visual.kind === 'image'
          ? "scale=1200:2134:force_original_aspect_ratio=decrease,pad=1200:2134:(ow-iw)/2:(oh-ih)/2:color=black,zoompan=z='min(1.08,1+on*0.0003)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30,setsar=1"
          : 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1';
        const subtitleFilter = `subtitles=filename=${srtName}:force_style='FontSize=18,Alignment=2,MarginV=70,Outline=2'`;
        // Silent output selects only video, even when an imported clip contains sound.
        await this.runner(this.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-y', ...(visual.kind === 'image' ? ['-loop', '1', '-framerate', '30'] : narrated ? ['-stream_loop', '-1'] : []), '-i', visualPath, ...(narrated ? ['-i', audioPath] : []), '-map', '0:v:0', ...(narrated ? ['-map', '1:a:0'] : ['-an', '-sn']), '-vf', narrated ? `${visualFilter},${subtitleFilter}` : visualFilter, ...(narrated ? ['-af', 'apad'] : []), '-t', String(scene.durationSeconds), '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-maxrate', '4M', '-bufsize', '8M', '-pix_fmt', 'yuv420p', ...(narrated ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'] : []), '-movflags', '+faststart', clip], { cwd: scratch, timeoutMs: 600000 });
        clips.push(`file 'clip-${index}.mp4'`);
      }
      await writeFile(resolve(scratch, 'concat.txt'), `${clips.join('\n')}\n`, { mode: 0o600 });
      finalPath = resolve(assets, `render-${attemptId}.mp4`);
      if (narrated) captionsPath = resolve(assets, `render-${attemptId}.srt`);
      await this.runner(this.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-map', '0:v:0', ...(narrated ? ['-map', '0:a:0'] : ['-an', '-sn']), '-c', 'copy', '-movflags', '+faststart', finalPath], { cwd: scratch, timeoutMs: 600000 });
      if (narrated) await writeFile(captionsPath, captions(snapshot.episode.scenes), { flag: 'wx', mode: 0o600 });
      const finalBytes = await boundedFile(finalPath);
      const finalProbe = await this.probe(finalPath);
      const videoStream = finalProbe.streams.find((stream) => stream.codec_type === 'video');
      const audioStream = finalProbe.streams.find((stream) => stream.codec_type === 'audio');
      const durationSeconds = Number(finalProbe.format?.duration);
      const [fpsNumerator, fpsDenominator = '1'] = String(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate ?? '').split('/');
      const framesPerSecond = Number(fpsNumerator) / Number(fpsDenominator);
      if (!videoStream || (narrated ? !audioStream : audioStream || finalProbe.streams.some((stream) => stream.codec_type === 'subtitle')) || videoStream.width !== 1080 || videoStream.height !== 1920 || !Number.isFinite(framesPerSecond) || Math.abs(framesPerSecond - 30) > 0.05 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 180 || Math.abs(durationSeconds - snapshot.durationSeconds) > 0.5) throw new Error('Final render failed resolution, frame rate, audio or duration validation');
      const videoDuration = mediaDuration(finalProbe, videoStream);
      if (!Number.isFinite(videoDuration) || Math.abs(videoDuration - snapshot.durationSeconds) > 0.5) throw new Error('Final render video duration does not match the planned scenes');
      if (narrated) {
        const audioDuration = mediaDuration(finalProbe, audioStream);
        if (!Number.isFinite(audioDuration) || Math.abs(audioDuration - snapshot.durationSeconds) > 0.5) throw new Error('Final render dropped narration audio');
      }
      // Recheck files after encoding as well as the editorial snapshot inside the commit.
      for (const { visual, audio } of snapshot.selected) {
        for (const asset of [visual, ...(audio ? [audio] : [])]) {
          if (sha256(await boundedFile(await internalPath(this.store, asset.path))) !== asset.sha256) throw new Error('Source asset changed during render');
        }
      }
      const render = { path: `assets/render-${attemptId}.mp4`, sha256: sha256(finalBytes), durationSeconds, width: videoStream.width, height: videoStream.height, framesPerSecond, format: 'mp4', audioMode: snapshot.audioMode, hasAudio: Boolean(audioStream), ...(narrated ? { captionsPath: `assets/render-${attemptId}.srt`, captionsSha256: sha256(await boundedFile(captionsPath)), captionsTiming: 'scene-approximate' } : {}), sceneAssets: snapshot.selected.map(({ sceneId, visual, audio }) => ({ sceneId, visualAssetId: visual.id, ...(audio ? { audioAssetId: audio.id } : {}) })), visualMethod: snapshot.selected.some(({ visual }) => visual.kind === 'image') ? 'includes-animated-images' : 'generated-video', synthetic: true, createdAt: new Date().toISOString() };
      return await this.store.transaction((state) => {
        const episode = state.episodes.find((item) => item.id === episodeId);
        if (!episode || episode.status !== 'rendering' || episode.renderAttempt?.id !== attemptId || fingerprint(episode, selectSceneAssets(state, episode)) !== snapshot.fingerprint) throw new Error('Episode or selected assets changed during rendering; render cannot be committed');
        episode.render = render;
        episode.approval = null;
        episode.status = 'rendered';
        episode.renderAttempt.status = 'completed';
        episode.renderAttempt.completedAt = new Date().toISOString();
        return render;
      });
    } catch (error) {
      if (finalPath) await rm(finalPath, { force: true }).catch(() => {});
      if (captionsPath) await rm(captionsPath, { force: true }).catch(() => {});
      await this.store.transaction((state) => {
        const episode = state.episodes.find((item) => item.id === episodeId);
        if (episode?.renderAttempt?.id === attemptId) {
          episode.status = 'planned';
          episode.approval = null;
          episode.render = null;
          episode.renderAttempt.status = 'failed';
          episode.renderError = String(error.message).slice(0, 2000);
        }
      });
      throw error;
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}
