import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { canonicalJson, packetHash } from './assembly-packets.mjs';

const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const request = z.object({ provider: z.literal('fal-ai'), transport: z.literal('huggingface-router'),
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  responsePath: z.string().max(2048).regex(/^\/fal-ai\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/),
}).strict().refine(value => value.responsePath.endsWith(`/requests/${value.requestId}`) || value.responsePath.endsWith(`/requests/${value.requestId}/response`));
const schema = z.object({ schemaVersion: z.literal(1), type: z.literal('review'), id: uuid, episodeId: uuid,
  sources: z.array(z.object({ index: z.number().int().min(1).max(96), sceneId: uuid, assetId: uuid,
    sha256: sha, acceptedVisualSha256: sha, remoteRequest: request }).strict()).min(1).max(12),
  audioBindings: z.array(z.object({ sceneId: uuid, audio: z.object({ sha256: sha }).strict() }).strict()).length(96),
  audioArtifact: z.object({ artifactId: z.number().int().positive(), runId: z.number().int().positive(),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), commitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    batchId: uuid, packetSha256: sha, manifestSha256: sha }).strict(),
}).strict();
const launchSchema = z.object({ schemaVersion: z.literal(1), type: z.literal('review'), batchId: uuid, episodeId: uuid, packetSha256: sha }).strict();
const unique = values => new Set(values).size === values.length;

export function validateReviewPacket(value) {
  const packet = schema.parse(value);
  for (const field of ['index', 'sceneId', 'assetId', 'sha256']) if (!unique(packet.sources.map(source => source[field]))) throw new Error('Review sources must be distinct');
  if (!unique(packet.sources.map(source => source.remoteRequest.requestId)) || !unique(packet.audioBindings.map(binding => binding.sceneId))) throw new Error('Review source/audio identities must be unique');
  for (const source of packet.sources) {
    if (source.acceptedVisualSha256 !== source.sha256 || packet.audioBindings[source.index - 1].sceneId !== source.sceneId) throw new Error('Exact accepted visual and original scene audio are required');
  }
  return packet;
}
export function packReviewPacket(value) {
  const packet = validateReviewPacket(value);
  const encoded = gzipSync(canonicalJson(packet)).toString('base64');
  if (encoded.length >= 48 * 1024) throw new Error('Private review packet is oversized');
  return { encoded, packetSha256: packetHash(packet) };
}
export function unpackReviewPacket(encoded, launch) {
  try {
    const instruction = launchSchema.parse(launch);
    if (typeof encoded !== 'string' || !encoded || encoded.length >= 48 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid envelope');
    const compressed = Buffer.from(encoded, 'base64');
    if (compressed.toString('base64') !== encoded) throw new Error('Invalid envelope');
    const packet = validateReviewPacket(JSON.parse(gunzipSync(compressed, { maxOutputLength: 2 * 1024 * 1024 })));
    if (packet.id !== instruction.batchId || packet.episodeId !== instruction.episodeId || packetHash(packet) !== instruction.packetSha256) throw new Error('Changed identity');
    return packet;
  } catch { throw new Error('Private review packet differs from its exact launch'); }
}
