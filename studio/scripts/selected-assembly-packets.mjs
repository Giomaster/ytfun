import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { episodeLimits } from '../src/domain.mjs';
import { canonicalJson, packetHash, SCENE_COUNT, SCENE_SECONDS } from './assembly-packets.mjs';

const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const assetPath = z.string().max(400).regex(/^assets\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/);
const descriptor = kind => z.object({ assetId: uuid, path: assetPath, kind: z.literal(kind), sha256: sha, provenanceSha256: sha }).strict();
const request = z.object({ provider: z.literal('fal-ai'), transport: z.literal('huggingface-router'),
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  responsePath: z.string().max(2048).regex(/^\/fal-ai\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/),
}).strict().refine(value => value.responsePath.endsWith(`/requests/${value.requestId}`) || value.responsePath.endsWith(`/requests/${value.requestId}/response`));
const sceneSchema = z.object({ sceneId: uuid, durationSeconds: z.literal(SCENE_SECONDS), scriptSha256: sha,
  visual: descriptor('video'), audio: descriptor('audio') }).strict();
const manifestFields = { schemaVersion: z.literal(1), episodeId: uuid, audioMode: z.literal('nonverbal'),
  width: z.union([z.literal(1080), z.literal(1920)]), height: z.union([z.literal(1080), z.literal(1920)]),
  framesPerSecond: z.literal(30), editorialSha256: sha, snapshotSha256: sha,
};
const manifestFor = (format, maximumScenes, maximumDurationSeconds, maxRenderBytes) => z.object({
  ...manifestFields, format: z.literal(format), durationSeconds: z.number().positive().max(maximumDurationSeconds),
  maxRenderBytes: z.literal(maxRenderBytes), scenes: z.array(sceneSchema).min(1).max(maximumScenes),
}).strict();
const shortLimits = episodeLimits('short');
const manifestSchema = z.discriminatedUnion('format', [
  manifestFor('long', SCENE_COUNT, SCENE_COUNT * SCENE_SECONDS, 512 * 1024 * 1024),
  manifestFor('short', Math.min(SCENE_COUNT, shortLimits.maxScenes), shortLimits.maxDurationSeconds, shortLimits.maxRenderBytes),
]).refine(value => value.width !== value.height && value.durationSeconds === value.scenes.length * SCENE_SECONDS);
const schema = z.object({ schemaVersion: z.literal(1), type: z.literal('selected-assembly'), id: uuid,
  episodeId: uuid, sourceEpisodeId: uuid, manifest: manifestSchema,
  sources: z.array(z.object({ assetId: uuid, sha256: sha, sourceSceneId: uuid,
    sourceIndex: z.number().int().min(1).max(SCENE_COUNT), remoteRequest: request }).strict()).min(1).max(SCENE_COUNT),
  audioBindings: z.array(z.object({ sceneId: uuid, audio: z.object({ sha256: sha }).strict() }).strict()).min(1).max(SCENE_COUNT),
  audioArtifact: z.object({ artifactId: z.number().int().positive(), runId: z.number().int().positive(),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), commitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    batchId: uuid, packetSha256: sha, manifestSha256: sha }).strict(),
}).strict();
const longLimits = episodeLimits('long');
const selectedRange = z.tuple([
  z.number().finite().min(0).max(longLimits.maxDurationSeconds),
  z.number().finite().positive().max(longLimits.maxDurationSeconds),
]).refine(([start, end]) => end > start, { message: 'A selected range must have a positive duration' });
const audioBinding = z.object({ sceneId: uuid, audio: z.object({ sha256: sha }).strict() }).strict();
const audioArtifact = z.object({ artifactId: z.number().int().positive(), runId: z.number().int().positive(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), commitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  batchId: uuid, packetSha256: sha, manifestSha256: sha }).strict();
const selectedManifestFor = format => {
  const limits = episodeLimits(format);
  return z.object({ ...manifestFields, format: z.literal(format),
    durationSeconds: z.number().finite().positive().max(limits.maxDurationSeconds),
    maxRenderBytes: z.literal(limits.maxRenderBytes),
    scenes: z.array(z.object({ sceneId: uuid,
      durationSeconds: z.number().finite().min(1).max(60), scriptSha256: sha,
      visual: descriptor('video'), audio: descriptor('audio') }).strict()).min(1).max(limits.maxScenes),
  }).strict();
};
const selectedManifest = z.discriminatedUnion('format', [selectedManifestFor('long'), selectedManifestFor('short')])
  .refine(value => value.width !== value.height, { message: 'Render canvas must be 1080x1920 or 1920x1080' });
const sharedSchema = z.object({ schemaVersion: z.literal(2), type: z.literal('selected-assembly'), id: uuid,
  episodeId: uuid, manifest: selectedManifest,
  audioInputs: z.array(z.object({ id: uuid, sourceEpisodeId: uuid, audioArtifact,
    audioBindings: z.array(audioBinding).min(1).max(SCENE_COUNT) }).strict()).min(1).max(longLimits.maxScenes),
  sources: z.array(z.object({ assetId: uuid, sha256: sha, sourceAssetId: uuid, sourceEpisodeId: uuid,
    sourceSceneId: uuid, audioSourceSceneId: uuid, sourceIndex: z.number().int().min(1).max(SCENE_COUNT),
    audioInputId: uuid, sourceRangeSeconds: selectedRange, audioRangeSeconds: selectedRange,
    remoteRequest: request }).strict()).min(1).max(longLimits.maxScenes),
}).strict();
const launchSchema = z.object({ schemaVersion: z.literal(1), type: z.literal('selected-assembly'),
  batchId: uuid, episodeId: uuid, packetSha256: sha }).strict();
const sharedLaunchSchema = launchSchema.extend({ schemaVersion: z.literal(2) });
const distinct = values => { if (new Set(values).size !== values.length) throw new Error('Selected assembly sources and scene identities must be distinct'); };
const sameDuration = (left, right) => Math.abs(left - right) <= 1e-9;

function validateSharedAssemblyPacket(value) {
  const packet = sharedSchema.parse(value);
  if (packet.episodeId !== packet.manifest.episodeId || packet.sources.length !== packet.manifest.scenes.length) throw new Error('Selected assembly requires its own exact episode/manifest');
  for (const values of [packet.manifest.scenes.map(scene => scene.sceneId), packet.manifest.scenes.map(scene => scene.visual.assetId),
    packet.manifest.scenes.map(scene => scene.audio.assetId), packet.audioInputs.map(input => input.id),
    ...['assetId', 'sha256', 'sourceAssetId', 'sourceSceneId'].map(field => packet.sources.map(source => source[field])),
    packet.sources.map(source => source.remoteRequest.requestId)]) distinct(values);
  const inputs = new Map(packet.audioInputs.map(input => [input.id, input]));
  for (const input of packet.audioInputs) {
    distinct(input.audioBindings.map(binding => binding.sceneId));
    distinct(packet.sources.filter(source => source.audioInputId === input.id).map(source => source.sourceIndex));
  }
  const totalDuration = packet.manifest.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  if (!sameDuration(totalDuration, packet.manifest.durationSeconds)) throw new Error('Selected scene durations do not match the exact manifest total');
  for (const scene of packet.manifest.scenes) {
    const source = packet.sources.find(item => item.assetId === scene.visual.assetId);
    const input = source && inputs.get(source.audioInputId);
    const audio = input && input.audioBindings[source.sourceIndex - 1];
    if (!source || !audio || source.sha256 !== scene.visual.sha256 || audio.sceneId !== source.audioSourceSceneId ||
        audio.audio.sha256 !== scene.audio.sha256) throw new Error('Selected source does not match its exact visual and original audio input binding');
    if (!sameDuration(source.sourceRangeSeconds[1] - source.sourceRangeSeconds[0], scene.durationSeconds) ||
        !sameDuration(source.audioRangeSeconds[1] - source.audioRangeSeconds[0], scene.durationSeconds)) {
      throw new Error('Selected visual and audio ranges must each match the exact scene duration');
    }
  }
  return packet;
}

/** A new exact manifest with explicit bindings to existing video requests and original WAVs. */
export function validateSelectedAssemblyPacket(value) {
  if (value?.schemaVersion === 2) return validateSharedAssemblyPacket(value);
  const packet = schema.parse(value);
  if (packet.episodeId !== packet.manifest.episodeId || packet.sources.length !== packet.manifest.scenes.length) throw new Error('Selected assembly requires its own exact episode/manifest');
  for (const values of [packet.manifest.scenes.map(scene => scene.sceneId), packet.manifest.scenes.map(scene => scene.visual.assetId),
    packet.manifest.scenes.map(scene => scene.audio.assetId), packet.audioBindings.map(binding => binding.sceneId),
    ...['assetId', 'sha256', 'sourceSceneId', 'sourceIndex'].map(field => packet.sources.map(source => source[field])),
    packet.sources.map(source => source.remoteRequest.requestId)]) distinct(values);
  for (const scene of packet.manifest.scenes) {
    const source = packet.sources.find(item => item.assetId === scene.visual.assetId);
    const audio = source && packet.audioBindings[source.sourceIndex - 1];
    if (!source || !audio || source.sha256 !== scene.visual.sha256 || audio.sceneId !== source.sourceSceneId || audio.audio.sha256 !== scene.audio.sha256) throw new Error('Selected source does not match its exact visual and original audio binding');
  }
  if (packet.episodeId === packet.sourceEpisodeId && (packet.audioBindings.length !== packet.manifest.scenes.length ||
      packet.manifest.scenes.some((scene, index) => {
        const source = packet.sources.find(item => item.assetId === scene.visual.assetId);
        return source.sourceSceneId !== scene.sceneId || source.sourceIndex !== index + 1;
      }))) throw new Error('Direct finalization requires every original scene and audio binding in exact episode order');
  return packet;
}

export function packSelectedAssemblyPacket(value) {
  const packet = validateSelectedAssemblyPacket(value);
  const encoded = gzipSync(canonicalJson(packet)).toString('base64');
  if (encoded.length >= 48 * 1024) throw new Error('Private selected assembly packet is oversized');
  return { encoded, packetSha256: packetHash(packet) };
}

export function unpackSelectedAssemblyPacket(encoded, launch) {
  try {
    const instruction = (launch?.schemaVersion === 2 ? sharedLaunchSchema : launchSchema).parse(launch);
    if (typeof encoded !== 'string' || !encoded || encoded.length >= 48 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid envelope');
    const compressed = Buffer.from(encoded, 'base64');
    if (compressed.toString('base64') !== encoded) throw new Error('Invalid envelope');
    const packet = validateSelectedAssemblyPacket(JSON.parse(gunzipSync(compressed, { maxOutputLength: 2 * 1024 * 1024 })));
    if (packet.schemaVersion !== instruction.schemaVersion || packet.id !== instruction.batchId || packet.episodeId !== instruction.episodeId || packetHash(packet) !== instruction.packetSha256) throw new Error('Changed identity');
    return packet;
  } catch { throw new Error('Private selected assembly packet differs from its exact launch'); }
}
