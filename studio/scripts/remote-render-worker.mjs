import { DefaultArtifactClient } from '@actions/artifact';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { recoverFalVideo } from '../src/fal-queue-recovery.mjs';
import { MASTER_MAX_BYTES, SCENE_SECONDS, SOURCE_MAX_BYTES, audioReceiptPath, hash, packetHash, remoteContext, unpackAssemblyPacket, validateAudioReceipt } from './assembly-packets.mjs';

const AUDIO_MAX_BYTES = 160 * 1024 * 1024;
const FINAL_SPEC = { width: 1080, height: 1920, framesPerSecond: 30 };

export async function mediaCommand(binary, args, { timeoutMs = 480000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let outputBytes = 0; let errorBytes = 0; let rejected = false;
    const stop = () => { rejected = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout.on('data', bytes => { outputBytes += bytes.length; if (outputBytes > 1024 * 1024) stop(); else chunks.push(bytes); });
    child.stderr.on('data', bytes => { errorBytes += bytes.length; if (errorBytes > 1024 * 1024) stop(); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Remote media process could not start')); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0 || rejected) reject(new Error('Remote media process failed')); else resolveResult({ stdout: Buffer.concat(chunks).toString('utf8') }); });
  });
}

async function boundedFile(filename, maximum) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > maximum) throw new Error('Media must be a bounded regular file');
    const bytes = await file.readFile();
    if (bytes.length !== info.size || bytes.length > maximum) throw new Error('Media changed while reading');
    return bytes;
  } finally { await file.close(); }
}

async function mediaDigest(filename, maximum) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 12 || info.size > maximum) throw new Error('MP4 must be a bounded regular file');
    const buffer = Buffer.alloc(1024 * 1024); const digest = createHash('sha256'); let sizeBytes = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      if (sizeBytes === 0 && buffer.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Output is not MP4');
      sizeBytes += bytesRead; if (sizeBytes > maximum) throw new Error('Output exceeded its cap while reading');
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (sizeBytes !== info.size) throw new Error('MP4 changed while reading');
    return { sha256: digest.digest('hex'), sizeBytes };
  } finally { await file.close(); }
}

async function githubJson(path, { repository, token, fetchImpl }) {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/${path}`, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Cannot verify owned audio artifact');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing artifact metadata');
  const chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 65536) throw new Error('Artifact metadata is oversized'); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { await reader.cancel().catch(() => {}); throw new Error('Invalid owned artifact metadata'); }
  finally { reader.releaseLock(); }
}

export async function ownedAudioArtifact(packet, { env, artifact, fetchImpl = fetch, directory }) {
  const input = packet.audioArtifact;
  if (input.repository !== env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN) throw new Error('Audio artifact must belong to this repository');
  const auth = { repository: input.repository, token: env.GITHUB_TOKEN, fetchImpl };
  const metadata = await githubJson(`actions/artifacts/${input.artifactId}`, auth);
  const run = await githubJson(`actions/runs/${input.runId}`, auth);
  const name = `ai-meow-audio-${input.batchId}`;
  if (metadata.id !== input.artifactId || metadata.name !== name || metadata.expired !== false || !Number.isSafeInteger(metadata.size_in_bytes) || metadata.size_in_bytes < 1 || metadata.size_in_bytes > AUDIO_MAX_BYTES || metadata.workflow_run?.id !== input.runId || metadata.workflow_run?.head_sha !== input.commitSha || run.id !== input.runId || run.repository?.full_name !== input.repository || run.head_repository?.full_name !== input.repository || run.head_sha !== input.commitSha || run.head_branch !== 'codex/ai-original-studio' || run.path !== '.github/workflows/ai-meow-audio.yml' || run.event !== 'push' || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Audio artifact/run ownership or identity changed');
  const [repositoryOwner, repositoryName] = input.repository.split('/');
  const expectedHash = /^sha256:[a-f0-9]{64}$/.test(metadata.digest ?? '') ? metadata.digest.slice(7) : undefined;
  const downloaded = await artifact.downloadArtifact(input.artifactId, { path: directory, findBy: { token: env.GITHUB_TOKEN, workflowRunId: input.runId, repositoryOwner, repositoryName }, ...(expectedHash ? { expectedHash } : {}) });
  if (downloaded.digestMismatch) throw new Error('Audio archive digest mismatch');
  if (!downloaded.downloadPath) throw new Error('Audio archive destination missing');
  if (await realpath(downloaded.downloadPath) !== await realpath(directory)) throw new Error('Audio archive destination differs');
  const receipt = validateAudioReceipt(JSON.parse(await boundedFile(join(directory, 'audio-manifest.json'), 1024 * 1024)), packet);
  for (const [index, scene] of packet.manifest.scenes.entries()) {
    const bytes = await boundedFile(join(directory, audioReceiptPath(index + 1)), SOURCE_MAX_BYTES);
    if (bytes.length !== receipt.scenes[index].sizeBytes || hash(bytes) !== scene.audio.sha256 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.toString('ascii', 12, 16) !== 'fmt ' || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 2 || bytes.readUInt32LE(24) !== 48000 || bytes.readUInt32LE(28) !== 192000 || bytes.readUInt16LE(32) !== 4 || bytes.readUInt16LE(34) !== 16 || bytes.toString('ascii', 36, 40) !== 'data' || bytes.readUInt32LE(40) !== 48000 * SCENE_SECONDS * 4) throw new Error('Original audio WAV/hash does not match the manifest');
  }
  return receipt;
}

function duration(probe, stream) { return Number(stream?.duration ?? probe.format?.duration); }
function rate(stream) { const [n, d = '1'] = String(stream?.avg_frame_rate ?? '').split('/'); return Number(n) / Number(d); }
async function probeFile(filename, runner) {
  const result = await runner('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filename], { timeoutMs: 30000 });
  if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 1024 * 1024) throw new Error('Media probe is oversized');
  const probe = JSON.parse(result.stdout);
  if (!Array.isArray(probe.streams)) throw new Error('Media probe is missing streams');
  return probe;
}
export function verifiedProbe(probe, seconds) {
  const videos = probe.streams.filter(stream => stream.codec_type === 'video');
  const audios = probe.streams.filter(stream => stream.codec_type === 'audio');
  const video = videos[0]; const audio = audios[0];
  if (probe.streams.length !== 2 || videos.length !== 1 || audios.length !== 1 || video.codec_name !== 'h264' || audio.codec_name !== 'aac' || video.width !== 1080 || video.height !== 1920 || Math.abs(rate(video) - 30) > 0.05 || !Number.isFinite(rate(video)) || audio.channels !== 2 || Number(audio.sample_rate) !== 48000 || [Number(probe.format?.duration), duration(probe, video), duration(probe, audio)].some(value => !Number.isFinite(value) || Math.abs(value - seconds) > 0.5)) throw new Error('Rendered streams do not match the planned duration/profile');
  return { durationSeconds: Number(probe.format.duration), ...FINAL_SPEC, videoCodec: 'h264', audioCodec: 'aac', channels: 2, sampleRate: 48000, hasAudio: true, audioMode: 'nonverbal' };
}
async function outputRecord(filename, path, seconds, cap, runner) {
  const digest = await mediaDigest(filename, cap);
  const metadata = verifiedProbe(await probeFile(filename, runner), seconds);
  const current = await mediaDigest(filename, cap);
  if (current.sha256 !== digest.sha256 || current.sizeBytes !== digest.sizeBytes) throw new Error('Output changed while probing');
  return { path, ...digest, ...metadata };
}

export function shortCommand(video, audio, output) {
  return ['-nostdin', '-v', 'error', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '-1', '-sn', '-dn', '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1', '-t', String(SCENE_SECONDS), '-r', '30', '-c:v', 'libx264', '-preset', 'fast', '-threads', '4', '-crf', '20', '-maxrate', '2200k', '-bufsize', '4400k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-n', output];
}

async function assemble(indices, { directory, outputDirectory, filename, runner }) {
  const videos = join(directory, `${filename}.video-list`); const audios = join(directory, `${filename}.audio-list`);
  // These relative names are generated solely from bounded integer indices.
  await writeFile(videos, indices.map(index => `file 'output/shorts/${String(index).padStart(3, '0')}.mp4'\nduration ${SCENE_SECONDS}\n`).join(''), { flag: 'wx', mode: 0o600 });
  await writeFile(audios, indices.map(index => `file 'audio/audio/${String(index).padStart(3, '0')}.wav'\nduration ${SCENE_SECONDS}\n`).join(''), { flag: 'wx', mode: 0o600 });
  const output = join(outputDirectory, filename);
  await runner('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'concat', '-safe', '1', '-i', videos, '-f', 'concat', '-safe', '1', '-i', audios, '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '-1', '-sn', '-dn', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-t', String(indices.length * SCENE_SECONDS), '-movflags', '+faststart', '-n', output]);
  return output;
}

/** GET-only source recovery and original assembly; never submits inference or mutates Studio. */
export async function runRenderWorker({ env = process.env, artifact = new DefaultArtifactClient(), fetchImpl = fetch, recover = recoverFalVideo, runner = mediaCommand } = {}) {
  try {
    const startedAt = Date.now();
    const context = remoteContext(env);
    if (!env.HF_TOKEN) throw new Error('Original source recovery requires the authorized provider token');
    const launchBytes = await readFile(join(env.GITHUB_WORKSPACE, 'studio/batches/render-launch.json'));
    if (launchBytes.length > 4096) throw new Error('Launch is oversized');
    const packet = unpackAssemblyPacket(env.AI_MEOW_RENDER_PACKET, JSON.parse(launchBytes), 'render');
    const directory = resolve(env.RUNNER_TEMP, `ai-meow-render-${packet.id}`);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    const outputDirectory = join(directory, 'output'); const audioDirectory = join(directory, 'audio'); const sourceDirectory = join(directory, 'sources');
    for (const path of [outputDirectory, audioDirectory, sourceDirectory]) await mkdir(path, { mode: 0o700 });
    await mkdir(join(outputDirectory, 'shorts'), { mode: 0o700 }); await mkdir(join(outputDirectory, 'compilations'), { mode: 0o700 });
    await ownedAudioArtifact(packet, { env, artifact, fetchImpl, directory: audioDirectory });
    const receipt = { schemaVersion: 1, type: 'original-assembly', batchId: packet.id, episodeId: packet.episodeId, packetSha256: packetHash(packet), sourceManifestSha256: packetHash(packet.manifest), sourceSnapshotSha256: packet.manifest.snapshotSha256, ...context, audioArtifact: packet.audioArtifact, encoding: { preset: 'fast', threads: 4, crf: 20, maxrateKbps: 2200, bufsizeKbps: 4400, audioKbps: 128 }, timing: { sourceRecoveryMs: 0, shortEncodingMs: 0, assemblyEncodingMs: 0 }, sourceScenes: [], shorts: [], compilations: [] };
    const files = [];
    for (const [offset, scene] of packet.manifest.scenes.entries()) {
      const index = offset + 1; const source = packet.visuals.find(item => item.assetId === scene.visual.assetId);
      const recoveryStartedAt = Date.now();
      const recovered = await recover(source.remoteRequest, { hfToken: env.HF_TOKEN, fetchImpl });
      receipt.timing.sourceRecoveryMs += Date.now() - recoveryStartedAt;
      if (recovered.remoteStatus !== 'COMPLETED' || !(recovered.blob instanceof Blob) || recovered.blob.size < 12 || recovered.blob.size > SOURCE_MAX_BYTES) throw new Error('Original video is not completed or bounded');
      const bytes = Buffer.from(await recovered.blob.arrayBuffer());
      if (hash(bytes) !== source.sha256 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Original video hash differs from its imported source');
      const original = join(sourceDirectory, `${String(index).padStart(3, '0')}.mp4`);
      await writeFile(original, bytes, { flag: 'wx', mode: 0o600 });
      const sourceProbe = await probeFile(original, runner); const sourceVideo = sourceProbe.streams.find(stream => stream.codec_type === 'video');
      if (!sourceVideo || !Number.isFinite(duration(sourceProbe, sourceVideo)) || duration(sourceProbe, sourceVideo) + 0.05 < SCENE_SECONDS) throw new Error('Original video is shorter than its planned complete scene; no looping');
      const path = `shorts/${String(index).padStart(3, '0')}.mp4`; const output = join(outputDirectory, path);
      const encodingStartedAt = Date.now();
      await runner('ffmpeg', shortCommand(original, join(audioDirectory, audioReceiptPath(index)), output));
      receipt.timing.shortEncodingMs += Date.now() - encodingStartedAt;
      receipt.shorts.push({ index, sceneId: scene.sceneId, sourceSceneIds: [scene.sceneId], sourceTimeRanges: [{ sceneId: scene.sceneId, startSeconds: offset * SCENE_SECONDS, endSeconds: index * SCENE_SECONDS }], ...await outputRecord(output, path, SCENE_SECONDS, SOURCE_MAX_BYTES, runner) });
      receipt.sourceScenes.push({ sceneId: scene.sceneId, visualAssetId: scene.visual.assetId, visualSha256: scene.visual.sha256, audioAssetId: scene.audio.assetId, audioSha256: scene.audio.sha256 });
      files.push(output);
    }
    for (let offset = 0; offset < 96; offset += 12) {
      const indices = Array.from({ length: 12 }, (_, index) => offset + index + 1); const index = offset / 12 + 1;
      const path = `compilations/${String(index).padStart(2, '0')}.mp4`;
      const encodingStartedAt = Date.now();
      const output = await assemble(indices, { directory, outputDirectory, audioDirectory, filename: path.replace('/', '-'), runner });
      receipt.timing.assemblyEncodingMs += Date.now() - encodingStartedAt;
      const target = join(outputDirectory, path);
      // The assembly helper writes a flat trusted name; keep the public archive organised.
      await rename(output, target);
      receipt.compilations.push({ index, sourceSceneIds: packet.manifest.scenes.slice(offset, offset + 12).map(scene => scene.sceneId), sourceTimeRanges: [{ startSeconds: offset * SCENE_SECONDS, endSeconds: (offset + 12) * SCENE_SECONDS }], ...await outputRecord(target, path, 90, SOURCE_MAX_BYTES, runner) }); files.push(target);
    }
    const masterEncodingStartedAt = Date.now();
    const master = await assemble(Array.from({ length: 96 }, (_, index) => index + 1), { directory, outputDirectory, audioDirectory, filename: 'master.mp4', runner });
    receipt.timing.assemblyEncodingMs += Date.now() - masterEncodingStartedAt;
    receipt.master = await outputRecord(master, 'master.mp4', 720, MASTER_MAX_BYTES, runner); files.push(master);
    receipt.timing.workerElapsedBeforeUploadMs = Date.now() - startedAt;
    const receiptFile = join(outputDirectory, 'render-manifest.json'); await writeFile(receiptFile, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 }); files.push(receiptFile);
    const name = `ai-meow-render-${packet.id}`;
    const uploaded = await artifact.uploadArtifact(name, files, outputDirectory, { retentionDays: 7, compressionLevel: 0 });
    if (!Number.isSafeInteger(uploaded.id) || uploaded.id < 1) throw new Error('Assembly artifact receipt is missing');
    return { status: 'completed', batchId: packet.id, episodeId: packet.episodeId, artifactId: uploaded.id, artifactName: name, manifestSha256: packetHash(receipt), masterSha256: receipt.master.sha256, shorts: 96, compilations: 8, ...context };
  } catch { throw new Error('Remote original assembly failed; preserve source receipts and correct the inputs before a new launch. No inference, publication or canonical studio mutation occurred'); }
}
