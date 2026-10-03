import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';

export const SCENE_COUNT = 96;
export const SCENE_SECONDS = 7.5;
export const SOURCE_MAX_BYTES = 100 * 1024 * 1024;
export const MASTER_MAX_BYTES = 220 * 1024 * 1024;
const MAX_PACKET_CHARS = 48 * 1024;
const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const label = maximum => z.string().trim().min(1).max(maximum).refine(value => !/[\u0000-\u001f]/.test(value));
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const assetPath = z.string().max(400).regex(/^assets\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/);
const descriptor = kind => z.object({ assetId: uuid, path: assetPath, kind: z.literal(kind), sha256: sha, provenanceSha256: sha }).strict();
const remoteRequest = z.object({
  provider: z.literal('fal-ai'), transport: z.literal('huggingface-router'),
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  responsePath: z.string().max(2048).regex(/^\/fal-ai\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/),
}).strict().refine(value => value.responsePath.endsWith(`/requests/${value.requestId}`) || value.responsePath.endsWith(`/requests/${value.requestId}/response`));

const audioSchema = z.object({
  schemaVersion: z.literal(1), type: z.literal('audio'), id: uuid, episodeId: uuid,
  scenes: z.array(z.object({ index: z.number().int().min(1).max(SCENE_COUNT), sceneId: uuid, title: label(160), genre: label(80), seed: z.number().int().min(0).max(0xffffffff), durationSeconds: z.literal(SCENE_SECONDS), audioProfile: z.enum(['cloth-rest', 'quiet-water']).optional() }).strict()).min(1).max(SCENE_COUNT),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(1), episodeId: uuid, format: z.literal('long'), audioMode: z.literal('nonverbal'),
  durationSeconds: z.literal(720), maxRenderBytes: z.literal(512 * 1024 * 1024),
  width: z.union([z.literal(1080), z.literal(1920)]), height: z.union([z.literal(1080), z.literal(1920)]), framesPerSecond: z.literal(30), editorialSha256: sha, snapshotSha256: sha,
  scenes: z.array(z.object({ sceneId: uuid, durationSeconds: z.literal(SCENE_SECONDS), scriptSha256: sha, visual: descriptor('video'), audio: descriptor('audio') }).strict()).length(SCENE_COUNT),
}).strict().refine(value => value.width !== value.height, { message: 'Render canvas must be 1080x1920 or 1920x1080' });
const renderSchema = z.object({
  schemaVersion: z.literal(1), type: z.literal('render'), id: uuid, episodeId: uuid, manifest: manifestSchema,
  visuals: z.array(z.object({ assetId: uuid, sha256: sha, remoteRequest }).strict()).length(SCENE_COUNT),
  audioArtifact: z.object({ artifactId: z.number().int().positive(), runId: z.number().int().positive(), repository, commitSha: commit, batchId: uuid, packetSha256: sha, manifestSha256: sha }).strict(),
}).strict();
const launchSchema = z.object({ schemaVersion: z.literal(1), type: z.enum(['audio', 'render']), batchId: uuid, episodeId: uuid, packetSha256: sha }).strict();

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(value).digest('hex');
export const packetHash = packet => hash(canonicalJson(packet));
const unique = (values, name) => { if (new Set(values).size !== values.length) throw new Error(`${name} must be unique`); };

export function validateAudioPacket(value) {
  const packet = audioSchema.parse(value);
  unique(packet.scenes.map(scene => scene.sceneId), 'Audio scene IDs');
  if (packet.scenes.some((scene, index) => scene.index !== index + 1)) throw new Error('Audio scenes must be contiguous in exact order beginning at 1');
  return packet;
}

export function validateRenderPacket(value) {
  const packet = renderSchema.parse(value);
  if (packet.episodeId !== packet.manifest.episodeId) throw new Error('Render episode differs from its exact manifest');
  unique(packet.manifest.scenes.map(scene => scene.sceneId), 'Render scene IDs');
  unique(packet.manifest.scenes.map(scene => scene.visual.assetId), 'Visual asset IDs');
  unique(packet.manifest.scenes.map(scene => scene.audio.assetId), 'Audio asset IDs');
  unique(packet.visuals.map(source => source.assetId), 'Retrieved visual IDs');
  unique(packet.visuals.map(source => source.sha256), 'Original video hashes');
  unique(packet.visuals.map(source => source.remoteRequest.requestId), 'Original provider request IDs');
  for (const scene of packet.manifest.scenes) {
    const source = packet.visuals.find(item => item.assetId === scene.visual.assetId);
    if (!source || source.sha256 !== scene.visual.sha256) throw new Error('Visual retrieval does not match the exact source manifest');
  }
  return packet;
}

export function packAssemblyPacket(packet) {
  const validated = packet.type === 'audio' ? validateAudioPacket(packet) : validateRenderPacket(packet);
  const encoded = gzipSync(canonicalJson(validated)).toString('base64');
  if (encoded.length >= MAX_PACKET_CHARS) throw new Error('Compressed packet must fit below 48 KiB');
  return { encoded, packetSha256: packetHash(validated) };
}

export function unpackAssemblyPacket(encoded, launch, type) {
  try {
    const instruction = launchSchema.parse(launch);
    if (instruction.type !== type || typeof encoded !== 'string' || !encoded || encoded.length >= MAX_PACKET_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid packet envelope');
    const compressed = Buffer.from(encoded, 'base64');
    if (compressed.toString('base64') !== encoded) throw new Error('Noncanonical packet envelope');
    const packet = JSON.parse(gunzipSync(compressed, { maxOutputLength: 2 * 1024 * 1024 }));
    const validated = type === 'audio' ? validateAudioPacket(packet) : validateRenderPacket(packet);
    if (validated.id !== instruction.batchId || validated.episodeId !== instruction.episodeId || packetHash(validated) !== instruction.packetSha256) throw new Error('Packet identity changed');
    return validated;
  } catch { throw new Error('Authorized assembly packet is missing, invalid or differs from this launch'); }
}

export function remoteContext(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_RUN_ATTEMPT !== '1' || !repository.safeParse(env.GITHUB_REPOSITORY).success || !commit.safeParse(env.GITHUB_SHA).success || !Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) || Number(env.GITHUB_RUN_ID) < 1 || !env.GITHUB_WORKSPACE || !env.RUNNER_TEMP) throw new Error('A fresh owned Actions production run is required');
  return { repository: env.GITHUB_REPOSITORY, runId: Number(env.GITHUB_RUN_ID), commitSha: env.GITHUB_SHA };
}

export function audioReceiptPath(index) { return `audio/${String(index).padStart(3, '0')}.wav`; }
export function validateAudioReceipt(value, packet) {
  const expected = packet.audioArtifact;
  if (!value || value.schemaVersion !== 1 || value.type !== 'original-audio' || value.batchId !== expected.batchId || value.episodeId !== packet.episodeId || value.packetSha256 !== expected.packetSha256 || value.repository !== expected.repository || value.runId !== expected.runId || value.commitSha !== expected.commitSha || packetHash(value) !== expected.manifestSha256 || !Array.isArray(value.scenes) || value.scenes.length !== packet.manifest.scenes.length) throw new Error('Original audio receipt differs from the authorized artifact');
  for (const [index, scene] of packet.manifest.scenes.entries()) {
    const audio = value.scenes[index];
    if (audio.index !== index + 1 || audio.sceneId !== scene.sceneId || audio.path !== audioReceiptPath(index + 1) || audio.durationSeconds !== SCENE_SECONDS || audio.sha256 !== scene.audio.sha256 || audio.sizeBytes !== 44 + 48000 * SCENE_SECONDS * 4) throw new Error('Original audio does not match its imported scene/hash');
  }
  return value;
}
