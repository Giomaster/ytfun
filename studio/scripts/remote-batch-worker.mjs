import { InferenceClient } from '@huggingface/inference';
import { DefaultArtifactClient } from '@actions/artifact';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { falQueueReceiptFetch } from '../src/fal-queue-receipt.mjs';
import { BATCH_PARAMETERS, hash, packetHash, sourceUrl, validatePacket } from '../src/remote-batch.mjs';

export function unpackPacket(value, expectedHash) {
  if (typeof value !== 'string' || value.length > 65536) throw new Error('Private batch packet missing or oversized');
  const bytes = gunzipSync(Buffer.from(value, 'base64'), { maxOutputLength: 2 * 1024 * 1024 });
  const packet = validatePacket(JSON.parse(bytes));
  if (packetHash(packet) !== expectedHash) throw new Error('Launch identity differs from the authorized packet');
  return packet;
}

async function command(binary, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errorBytes = 0;
    child.stderr.on('data', bytes => { errorBytes += bytes.length; if (errorBytes > 1024 * 1024) child.kill(); });
    child.on('error', () => reject(new Error('Remote media preparation could not start')));
    child.on('close', code => code === 0 ? resolveResult() : reject(new Error('Remote media preparation failed')));
  });
}

async function originalVideo(source, fetchImpl) {
  const response = await fetchImpl(sourceUrl(source.url), { redirect: 'error', signal: AbortSignal.timeout(180000) });
  if (!response.ok || Number(response.headers.get('content-length')) > 100 * 1024 * 1024) throw new Error('Original video cannot be retrieved safely');
  const reader = response.body.getReader();
  const pieces = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 100 * 1024 * 1024) throw new Error('Original video exceeds the source cap');
      pieces.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = Buffer.concat(pieces);
  if (hash(bytes) !== source.sha256 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Original video hash or header mismatch');
  return bytes;
}

export async function assertNoPreviousSubmission({ repository, artifactName, token, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) throw new Error('Verified Actions repository context is required');
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error' });
  if (!response.ok) throw new Error('Cannot establish the prior-charge barrier');
  const data = await response.json();
  if (!Array.isArray(data.artifacts) || data.artifacts.some(x => x.name === artifactName) || data.total_count !== 0) throw new Error('Prior reservation exists. Reconcile its queue receipt; never resubmit automatically');
}

// The HF SDK deliberately unrefs its polling timer. A CLI/JS Action must retain
// a referenced handle until the requested production operation has persisted.
export async function withInferenceLiveness(operation) {
  const keepAlive = setInterval(() => {}, 1000);
  try { return await operation(); } finally { clearInterval(keepAlive); }
}

/** One bounded provider submission per matrix job. Checkpoints commit before POST and before polling. */
export async function runWorker(options = {}) { return withInferenceLiveness(() => worker(options)); }

async function worker({ env = process.env, artifact = new DefaultArtifactClient(), client, fetchImpl = fetch, runner = command } = {}) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_RUN_ATTEMPT !== '1' || env.YTFUN_BATCH_PAID_ENABLED !== 'true' || !env.HF_TOKEN) throw new Error('Fresh authorized remote production run is required');
  const launch = JSON.parse(await readFile(join(env.GITHUB_WORKSPACE, 'studio/batches/launch.json'), 'utf8'));
  const packet = unpackPacket(env.AI_MEOW_BATCH_PACKET, launch.packetSha256);
  if (Date.now() > Date.parse(packet.authorizationExpiresAt) || Date.now() + 300000 < Date.parse(packet.authorizedAt)) throw new Error('The batch paid-call authorization window expired');
  if (launch.batchId !== packet.id || !Array.isArray(launch.sceneIndices) || !launch.sceneIndices.includes(Number(env.SPHERE_INDEX))) throw new Error('Scene not selected by this launch');
  const scene = packet.scenes.find(x => x.index === Number(env.SPHERE_INDEX));
  if (!scene) throw new Error('Scene missing from the private packet');
  const stem = `sphere-${packet.id}-${String(scene.index).padStart(3, '0')}`;
  const directory = resolve(env.RUNNER_TEMP, stem);
  await mkdir(directory, { recursive: true });
  const checkpointFile = join(directory, 'checkpoint.json');
  const ledger = { version: 1, batchId: packet.id, packetSha256: packetHash(packet), remoteRunId: env.GITHUB_RUN_ID, commitSha: env.GITHUB_SHA, episodeId: packet.episodeId, sceneId: scene.sceneId, reservationId: scene.reservationId, sourceSha256: packet.source.sha256, estimatedCostUsd: packet.estimatedCostPerSceneUsd, actualCostUsd: null, spending: [{ id: scene.reservationId, provider: 'fal-ai', kind: 'video', status: 'reserved' }] };
  const upload = async (suffix, files) => artifact.uploadArtifact(`${stem}-${suffix}`, files, directory, { retentionDays: 7, compressionLevel: 0 });
  const checkpoint = async suffix => { await writeFile(checkpointFile, JSON.stringify(ledger), { mode: 0o600 }); await upload(suffix, [checkpointFile]); };
  await assertNoPreviousSubmission({ repository: env.GITHUB_REPOSITORY, artifactName: `${stem}-reserved`, token: env.GITHUB_TOKEN, fetchImpl });
  const video = await originalVideo(packet.source, fetchImpl);
  const sourcePath = join(directory, 'original.mp4'); const referencePath = join(directory, 'reference.png');
  await writeFile(sourcePath, video, { mode: 0o600 });
  await runner('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-frames:v', '1', '-y', referencePath]);
  const reference = await readFile(referencePath);
  if (reference.length > 100 * 1024 * 1024 || reference.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Original frame extraction failed');
  ledger.referenceImageSha256 = hash(reference);
  await checkpoint('reserved');
  const store = { transaction: async fn => { const value = fn(ledger); await checkpoint('receipt'); return value; } };
  try {
    const sdk = client ?? new InferenceClient(env.HF_TOKEN);
    const output = await sdk.imageToVideo({ model: packet.model, provider: packet.provider, inputs: new Blob([reference], { type: 'image/png' }), parameters: { ...BATCH_PARAMETERS, seed: scene.seed, prompt: scene.prompt } }, { retry_on_error: false, fetch: falQueueReceiptFetch(store, scene.reservationId, { fetchImpl }) });
    if (!(output instanceof Blob) || output.size < 12 || output.size > 100 * 1024 * 1024 || output.type.split(';')[0] !== 'video/mp4') throw new Error('Provider output is not a bounded MP4');
    const bytes = Buffer.from(await output.arrayBuffer());
    if (bytes.toString('ascii', 4, 8) !== 'ftyp' || !ledger.spending[0].remoteRequest) throw new Error('MP4 header or durable queue receipt is missing');
    const filename = join(directory, 'original-result.mp4');
    await writeFile(filename, bytes, { mode: 0o600 });
    ledger.status = 'completed'; ledger.sha256 = hash(bytes); ledger.remoteRequest = ledger.spending[0].remoteRequest; ledger.completedAt = new Date().toISOString(); ledger.spending[0].status = 'completed';
    const resultFile = join(directory, 'result.json');
    await writeFile(resultFile, JSON.stringify(ledger), { mode: 0o600 });
    await upload('result', [resultFile, filename, referencePath]);
    return { batchId: packet.id, index: scene.index, status: 'completed', sha256: ledger.sha256 };
  } catch {
    ledger.status = 'attention'; ledger.spending[0].status = 'unknown';
    await checkpoint('attention').catch(() => {});
    throw new Error('Remote generation needs reconciliation. Its reservation and queue receipt are preserved; no replacement was submitted');
  }
}
