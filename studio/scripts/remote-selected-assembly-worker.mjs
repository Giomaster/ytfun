import { DefaultArtifactClient } from '@actions/artifact';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { recoverFalVideo } from '../src/fal-queue-recovery.mjs';
import { audioReceiptPath, hash, packetHash, remoteContext, SCENE_SECONDS, SOURCE_MAX_BYTES, MASTER_MAX_BYTES } from './assembly-packets.mjs';
import { mediaCommand, ownedAudioArtifact, outputRecord, probeFile, shortCommand } from './remote-render-worker.mjs';
import { unpackSelectedAssemblyPacket } from './selected-assembly-packets.mjs';

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
