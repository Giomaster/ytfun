import { DefaultArtifactClient } from '@actions/artifact';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { recoverFalVideo } from '../src/fal-queue-recovery.mjs';
import { audioReceiptPath, hash, packetHash, remoteContext, SCENE_SECONDS, SOURCE_MAX_BYTES, MASTER_MAX_BYTES, validateAudioReceipt } from './assembly-packets.mjs';
import { mediaCommand, ownedAudioArtifact, outputRecord, probeFile, shortCommand } from './remote-render-worker.mjs';
import { unpackSelectedAssemblyPacket } from './selected-assembly-packets.mjs';

function selectedSegmentCommand(video, audio, output, scene, source, spec) {
  const [visualStart, visualEnd] = source.sourceRangeSeconds;
  const [audioStart, audioEnd] = source.audioRangeSeconds;
  const { width, height, framesPerSecond } = spec;
  return ['-nostdin', '-v', 'error', '-i', video, '-i', audio, '-filter_complex',
    `[0:v:0]trim=start=${visualStart}:end=${visualEnd},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${framesPerSecond},setsar=1[v];[1:a:0]atrim=start=${audioStart}:end=${audioEnd},asetpts=PTS-STARTPTS[a]`,
    '-map', '[v]', '-map', '[a]', '-map_metadata', '-1', '-sn', '-dn', '-t', String(scene.durationSeconds), '-r', String(framesPerSecond),
    '-c:v', 'libx264', '-preset', 'fast', '-threads', '4', '-crf', '20', '-maxrate', '2200k', '-bufsize', '4400k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-n', output];
}

function measuredDuration(probe, kind, range) {
  const stream = probe.streams.find(item => item.codec_type === kind);
  const seconds = Number(stream?.duration ?? probe.format?.duration);
  if (!stream || !Number.isFinite(seconds) || seconds <= 0 || range[1] > seconds + 1e-9) throw new Error('Selected range exceeds its actual original stream; no looping or time padding');
  return seconds;
}

async function runSharedAssemblyWorker(packet, { env, artifact, fetchImpl, recover, runner, retrieveAudio,
  startedAt, context, directory, outputDirectory, audioDirectory, sourceDirectory, segmentsDirectory, setStage }) {
  setStage('audio-verification');
  const inputs = new Map();
  const receipt = { schemaVersion: 2, type: 'selected-original-assembly', batchId: packet.id, episodeId: packet.episodeId,
    packetSha256: packetHash(packet), sourceManifestSha256: packetHash(packet.manifest), sourceSnapshotSha256: packet.manifest.snapshotSha256,
    ...context, audioInputs: [], approved: false, published: false, inferenceSubmitted: false,
    encoding: { preset: 'fast', threads: 4, crf: 20, maxrateKbps: 2200, bufsizeKbps: 4400, audioKbps: 128 },
    timing: { sourceRecoveryMs: 0, segmentEncodingMs: 0, assemblyEncodingMs: 0 }, sourceScenes: [] };
  for (const [offset, input] of packet.audioInputs.entries()) {
    // Each original archive keeps its own extraction root and complete scene bindings.
    const inputDirectory = join(audioDirectory, `input-${String(offset + 1).padStart(3, '0')}`);
    await mkdir(inputDirectory, { mode: 0o700 });
    const projection = { episodeId: input.sourceEpisodeId, audioArtifact: input.audioArtifact, manifest: { scenes: input.audioBindings } };
    const originalReceipt = validateAudioReceipt(await retrieveAudio(projection,
      { env, artifact, fetchImpl, directory: inputDirectory }), projection);
    inputs.set(input.id, { ...input, directory: inputDirectory, receipt: originalReceipt });
    receipt.audioInputs.push({ id: input.id, sourceEpisodeId: input.sourceEpisodeId, audioArtifact: input.audioArtifact,
      audioBindings: input.audioBindings, audioReceiptSha256: packetHash(originalReceipt) });
  }
  const originals = new Map(); const audioProbes = new Map(); const segmentList = [];
  let outputStart = 0;
  for (const [offset, scene] of packet.manifest.scenes.entries()) {
    const source = packet.sources.find(item => item.assetId === scene.visual.assetId);
    const input = inputs.get(source.audioInputId); const stem = String(offset + 1).padStart(3, '0');
    setStage('original-get');
    // Cache by exact GET receipt, never by a target alias or an original audio index.
    const originalKey = packetHash(source.remoteRequest);
    let original = originals.get(originalKey);
    if (!original) {
      const recoveryStartedAt = Date.now();
      const recovered = await recover(source.remoteRequest, { hfToken: env.HF_TOKEN, fetchImpl });
      receipt.timing.sourceRecoveryMs += Date.now() - recoveryStartedAt;
      if (recovered.remoteStatus !== 'COMPLETED' || recovered.requestId !== source.remoteRequest.requestId || !(recovered.blob instanceof Blob) || recovered.blob.size < 12 || recovered.blob.size > SOURCE_MAX_BYTES) throw new Error('Original source is not ready');
      const bytes = Buffer.from(await recovered.blob.arrayBuffer());
      if (hash(bytes) !== source.sha256 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Original source integrity changed');
      const path = join(sourceDirectory, `${stem}.mp4`);
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      setStage('original-probe');
      original = { path, sha256: source.sha256, probe: await probeFile(path, runner) };
      originals.set(originalKey, original);
    }
    if (original.sha256 !== source.sha256) throw new Error('Original source integrity changed');
    setStage('original-probe');
    const visualSeconds = measuredDuration(original.probe, 'video', source.sourceRangeSeconds);
    setStage('audio-probe');
    const audio = join(input.directory, audioReceiptPath(source.sourceIndex));
    const audioKey = `${input.id}:${source.sourceIndex}`;
    let audioProbe = audioProbes.get(audioKey);
    if (!audioProbe) { audioProbe = await probeFile(audio, runner); audioProbes.set(audioKey, audioProbe); }
    const audioSeconds = measuredDuration(audioProbe, 'audio', source.audioRangeSeconds);
    setStage('segment-encoding');
    const segment = join(segmentsDirectory, `${stem}.mp4`); const encodingStartedAt = Date.now();
    await runner('ffmpeg', selectedSegmentCommand(original.path, audio, segment, scene, source, packet.manifest));
    receipt.timing.segmentEncodingMs += Date.now() - encodingStartedAt;
    const segmentRecord = await outputRecord(segment, `segments/${stem}.mp4`, scene.durationSeconds, SOURCE_MAX_BYTES,
      runner, packet.manifest, { includeProbe: true });
    segmentList.push(`file 'segments/${stem}.mp4'\nduration ${scene.durationSeconds}\n`);
    const originalAudio = input.receipt.scenes[source.sourceIndex - 1];
    receipt.sourceScenes.push({ order: offset + 1, sceneId: scene.sceneId, durationSeconds: scene.durationSeconds,
      sourceAssetId: source.sourceAssetId, sourceEpisodeId: source.sourceEpisodeId, sourceSceneId: source.sourceSceneId,
      sourceIndex: source.sourceIndex, audioInputId: source.audioInputId, audioSourceSceneId: source.audioSourceSceneId,
      audioSourceEpisodeId: input.sourceEpisodeId, audioArtifact: input.audioArtifact, audioReceiptSha256: packetHash(input.receipt),
      originalAudioPath: originalAudio.path, originalAudioSha256: originalAudio.sha256,
      visualAssetId: scene.visual.assetId, visualSha256: scene.visual.sha256, audioAssetId: scene.audio.assetId, audioSha256: scene.audio.sha256,
      sourceRangeSeconds: source.sourceRangeSeconds, audioRangeSeconds: source.audioRangeSeconds,
      outputRangeSeconds: [outputStart, outputStart + scene.durationSeconds], measuredOriginalDurationSeconds: visualSeconds,
      measuredOriginalAudioDurationSeconds: audioSeconds, sourceProbe: original.probe, audioProbe, segment: segmentRecord });
    outputStart += scene.durationSeconds;
  }
  setStage('assembly-encoding');
  const list = join(directory, 'segments.list');
  await writeFile(list, segmentList.join(''), { flag: 'wx', mode: 0o600 });
  const master = join(outputDirectory, 'master.mp4'); const assemblyStartedAt = Date.now();
  // Both streams come from the encoded selections, including their actual audio offsets.
  await runner('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'concat', '-safe', '1', '-i', list,
    '-map', '0:v:0', '-map', '0:a:0', '-map_metadata', '-1', '-sn', '-dn', '-c:v', 'copy', '-c:a', 'copy',
    '-t', String(packet.manifest.durationSeconds), '-movflags', '+faststart', '-n', master]);
  receipt.timing.assemblyEncodingMs = Date.now() - assemblyStartedAt;
  setStage('master-verification');
  const { probe: masterProbe, ...masterRecord } = await outputRecord(master, 'master.mp4', packet.manifest.durationSeconds,
    Math.min(MASTER_MAX_BYTES, packet.manifest.maxRenderBytes), runner, packet.manifest, { includeProbe: true });
  receipt.master = masterRecord; receipt.masterProbe = masterProbe;
  receipt.timing.workerElapsedBeforeUploadMs = Date.now() - startedAt;
  const receiptFile = join(outputDirectory, 'render-manifest.json');
  await writeFile(receiptFile, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  setStage('artifact-upload');
  const name = `ai-meow-selected-assembly-${packet.id}`;
  const uploaded = await artifact.uploadArtifact(name, [master, receiptFile], outputDirectory, { retentionDays: 7, compressionLevel: 0 });
  if (!Number.isSafeInteger(uploaded.id) || uploaded.id < 1) throw new Error('Assembly artifact receipt missing');
  return { status: 'completed', batchId: packet.id, episodeId: packet.episodeId, artifactId: uploaded.id, artifactName: name,
    scenes: packet.manifest.scenes.length, manifestSha256: packetHash(receipt), masterSha256: receipt.master.sha256, ...context };
}

/** Explicit selection of existing originals; GET-only, no inference or canonical mutations. */
export async function runSelectedAssemblyWorker({ env = process.env, artifact = new DefaultArtifactClient(), fetchImpl = fetch,
  recover = recoverFalVideo, runner = mediaCommand, retrieveAudio = ownedAudioArtifact } = {}) {
  let stage = 'packet';
  try {
    const startedAt = Date.now();
    const context = remoteContext(env);
    if (!env.HF_TOKEN || !env.GITHUB_TOKEN) throw new Error('Original source connections required');
    const launch = await readFile(join(env.GITHUB_WORKSPACE, 'studio/batches/selected-assembly-launch.json'));
    if (launch.length > 4096) throw new Error('Launch is oversized');
    const packet = unpackSelectedAssemblyPacket(env.AI_MEOW_SELECTED_ASSEMBLY_PACKET, JSON.parse(launch));
    const directory = resolve(env.RUNNER_TEMP, `ai-meow-selected-assembly-${packet.id}`);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    const outputDirectory = join(directory, 'output'); const audioDirectory = join(directory, 'audio');
    const sourceDirectory = join(directory, 'sources'); const segmentsDirectory = join(directory, 'segments');
    for (const path of [outputDirectory, audioDirectory, sourceDirectory, segmentsDirectory]) await mkdir(path, { mode: 0o700 });
    if (packet.schemaVersion === 2) return await runSharedAssemblyWorker(packet, { env, artifact, fetchImpl, recover, runner,
      retrieveAudio, startedAt, context, directory, outputDirectory, audioDirectory, sourceDirectory, segmentsDirectory,
      setStage: value => { stage = value; } });
    stage = 'audio-verification';
    // Validate the full original artifact against its parent, then select by ORIGINAL index.
    await retrieveAudio({ episodeId: packet.sourceEpisodeId, audioArtifact: packet.audioArtifact,
      manifest: { scenes: packet.audioBindings } }, { env, artifact, fetchImpl, directory: audioDirectory });
    const receipt = { schemaVersion: 1, type: 'selected-original-assembly', batchId: packet.id, episodeId: packet.episodeId,
      sourceEpisodeId: packet.sourceEpisodeId, packetSha256: packetHash(packet), sourceManifestSha256: packetHash(packet.manifest),
      sourceSnapshotSha256: packet.manifest.snapshotSha256, ...context, audioArtifact: packet.audioArtifact,
      approved: false, published: false, inferenceSubmitted: false,
      encoding: { preset: 'fast', threads: 4, crf: 20, maxrateKbps: 2200, bufsizeKbps: 4400, audioKbps: 128 },
      timing: { sourceRecoveryMs: 0, segmentEncodingMs: 0, assemblyEncodingMs: 0 }, sourceScenes: [] };
    const videoList = []; const audioList = [];
    for (const [offset, scene] of packet.manifest.scenes.entries()) {
      const source = packet.sources.find(item => item.assetId === scene.visual.assetId);
      const stem = String(offset + 1).padStart(3, '0');
      stage = 'original-get';
      const recoveryStartedAt = Date.now();
      const recovered = await recover(source.remoteRequest, { hfToken: env.HF_TOKEN, fetchImpl });
      receipt.timing.sourceRecoveryMs += Date.now() - recoveryStartedAt;
      if (recovered.remoteStatus !== 'COMPLETED' || recovered.requestId !== source.remoteRequest.requestId || !(recovered.blob instanceof Blob) || recovered.blob.size < 12 || recovered.blob.size > SOURCE_MAX_BYTES) throw new Error('Original source is not ready');
      const bytes = Buffer.from(await recovered.blob.arrayBuffer());
      if (hash(bytes) !== source.sha256 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Original source integrity changed');
      const original = join(sourceDirectory, `${stem}.mp4`);
      await writeFile(original, bytes, { flag: 'wx', mode: 0o600 });
      stage = 'original-probe';
      const probe = await probeFile(original, runner);
      const visual = probe.streams.find(stream => stream.codec_type === 'video');
      const seconds = Number(visual?.duration ?? probe.format?.duration);
      if (!visual || !Number.isFinite(seconds) || seconds + 0.05 < SCENE_SECONDS) throw new Error('Original source is too short; no looping');
      stage = 'segment-encoding';
      const segment = join(segmentsDirectory, `${stem}.mp4`);
      const encodingStartedAt = Date.now();
      await runner('ffmpeg', shortCommand(original, join(audioDirectory, audioReceiptPath(source.sourceIndex)), segment, packet.manifest));
      receipt.timing.segmentEncodingMs += Date.now() - encodingStartedAt;
      await outputRecord(segment, `${stem}.mp4`, SCENE_SECONDS, SOURCE_MAX_BYTES, runner, packet.manifest);
      // Names originate only from validated integer indices, never remote paths.
      videoList.push(`file 'segments/${stem}.mp4'\nduration ${SCENE_SECONDS}\n`);
      audioList.push(`file 'audio/${audioReceiptPath(source.sourceIndex)}'\nduration ${SCENE_SECONDS}\n`);
      receipt.sourceScenes.push({ order: offset + 1, sceneId: scene.sceneId, sourceSceneId: source.sourceSceneId,
        sourceIndex: source.sourceIndex, visualAssetId: scene.visual.assetId, visualSha256: scene.visual.sha256,
        audioAssetId: scene.audio.assetId, audioSha256: scene.audio.sha256,
        sourceRangeSeconds: [0, SCENE_SECONDS], outputRangeSeconds: [offset * SCENE_SECONDS, (offset + 1) * SCENE_SECONDS],
        measuredOriginalDurationSeconds: seconds, sourceProbe: probe });
    }
    stage = 'assembly-encoding';
    const videos = join(directory, 'videos.list'); const audios = join(directory, 'audios.list');
    await writeFile(videos, videoList.join(''), { flag: 'wx', mode: 0o600 });
    await writeFile(audios, audioList.join(''), { flag: 'wx', mode: 0o600 });
    const master = join(outputDirectory, 'master.mp4');
    const assemblyStartedAt = Date.now();
    await runner('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'concat', '-safe', '1', '-i', videos, '-f', 'concat', '-safe', '1', '-i', audios,
      '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '-1', '-sn', '-dn', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-t', String(packet.manifest.durationSeconds), '-movflags', '+faststart', '-n', master]);
    receipt.timing.assemblyEncodingMs = Date.now() - assemblyStartedAt;
    stage = 'master-verification';
    const { probe: masterProbe, ...masterRecord } = await outputRecord(master, 'master.mp4', packet.manifest.durationSeconds,
      Math.min(MASTER_MAX_BYTES, packet.manifest.maxRenderBytes), runner, packet.manifest, { includeProbe: true });
    receipt.master = masterRecord;
    receipt.masterProbe = masterProbe;
    receipt.timing.workerElapsedBeforeUploadMs = Date.now() - startedAt;
    const receiptFile = join(outputDirectory, 'render-manifest.json');
    await writeFile(receiptFile, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    stage = 'artifact-upload';
    const name = `ai-meow-selected-assembly-${packet.id}`;
    const uploaded = await artifact.uploadArtifact(name, [master, receiptFile], outputDirectory, { retentionDays: 7, compressionLevel: 0 });
    if (!Number.isSafeInteger(uploaded.id) || uploaded.id < 1) throw new Error('Assembly artifact receipt missing');
    return { status: 'completed', batchId: packet.id, episodeId: packet.episodeId, artifactId: uploaded.id, artifactName: name,
      scenes: packet.manifest.scenes.length, manifestSha256: packetHash(receipt), masterSha256: receipt.master.sha256, ...context };
  } catch {
    throw new Error(`Remote selected assembly failed [${stage}]. No inference, approval, publication or canonical mutation occurred`);
  }
}
