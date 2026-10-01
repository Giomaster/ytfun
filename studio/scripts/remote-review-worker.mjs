import { DefaultArtifactClient } from '@actions/artifact';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { recoverFalVideo } from '../src/fal-queue-recovery.mjs';
import { audioReceiptPath, hash, packetHash, remoteContext, SOURCE_MAX_BYTES } from './assembly-packets.mjs';
import { mediaCommand, ownedAudioArtifact, shortCommand, verifiedProbe } from './remote-render-worker.mjs';
import { unpackReviewPacket } from './review-packets.mjs';

/** Production review copies only. GET-only; never approves, publishes or changes Studio. */
export async function runReviewWorker({ env = process.env, artifact = new DefaultArtifactClient(), fetchImpl = fetch,
  recover = recoverFalVideo, runner = mediaCommand, retrieveAudio = ownedAudioArtifact } = {}) {
  try {
    const context = remoteContext(env);
    if (!env.HF_TOKEN || !env.GITHUB_TOKEN) throw new Error('Original source connections required');
    const launch = JSON.parse(await readFile(join(env.GITHUB_WORKSPACE, 'studio/batches/review-launch.json'), 'utf8'));
    const packet = unpackReviewPacket(env.AI_MEOW_REVIEW_PACKET, launch);
    const directory = resolve(env.RUNNER_TEMP, `review-${packet.id}`);
    const outputDirectory = join(directory, 'output');
    const audioDirectory = join(directory, 'audio');
    const sourcesDirectory = join(directory, 'sources');
    await mkdir(outputDirectory, { recursive: true });
    await mkdir(audioDirectory, { recursive: true });
    await mkdir(sourcesDirectory, { recursive: true });
    // An audio verification projection, never an exported master/render manifest.
    await retrieveAudio({ episodeId: packet.episodeId, audioArtifact: packet.audioArtifact,
      manifest: { scenes: packet.audioBindings } }, { env, artifact, fetchImpl, directory: audioDirectory });
    const receipt = { schemaVersion: 1, type: 'audiovisual-review', batchId: packet.id, episodeId: packet.episodeId,
      packetSha256: packetHash(packet), ...context, reviewOnly: true, approved: false, published: false, samples: [] };
    const files = [];
    for (const source of packet.sources) {
      const recovered = await recover(source.remoteRequest, { hfToken: env.HF_TOKEN, fetchImpl });
      if (recovered.remoteStatus !== 'COMPLETED' || recovered.requestId !== source.remoteRequest.requestId || !(recovered.blob instanceof Blob) || recovered.blob.size > SOURCE_MAX_BYTES) throw new Error('Original source is not ready');
      const bytes = Buffer.from(await recovered.blob.arrayBuffer());
      if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp' || hash(bytes) !== source.sha256) throw new Error('Original source integrity changed');
      const stem = String(source.index).padStart(3, '0');
      const video = join(sourcesDirectory, `${stem}.mp4`);
      const audio = join(audioDirectory, audioReceiptPath(source.index));
      await writeFile(video, bytes, { flag: 'wx', mode: 0o600 });
      const originalProbe = JSON.parse((await runner('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', video], { timeoutMs: 30000 })).stdout);
      const visual = originalProbe.streams?.find(stream => stream.codec_type === 'video');
      const seconds = Number(visual?.duration ?? originalProbe.format?.duration);
      if (!visual || !Number.isFinite(seconds) || seconds < 7.5) throw new Error('Original source is too short');
      const output = join(outputDirectory, `${stem}.mp4`);
      await runner('ffmpeg', shortCommand(video, audio, output));
      const probe = JSON.parse((await runner('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', output], { timeoutMs: 30000 })).stdout);
      const profile = verifiedProbe(probe, 7.5);
      const rendered = await readFile(output);
      if (rendered.length < 12 || rendered.length > SOURCE_MAX_BYTES || rendered.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Review output is invalid');
      const audition = join(outputDirectory, `${stem}.mp3`);
      await runner('ffmpeg', ['-nostdin', '-v', 'error', '-i', audio, '-map', '0:a:0', '-map_metadata', '-1', '-t', '7.5', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-n', audition]);
      const auditionBytes = await readFile(audition);
      if (!auditionBytes.length || auditionBytes.length > 1024 * 1024) throw new Error('Audition output exceeds cap');
      receipt.samples.push({ index: source.index, sceneId: source.sceneId, sourceAssetId: source.assetId,
        sourceSha256: source.sha256, audioSourceSha256: packet.audioBindings[source.index - 1].audio.sha256,
        path: `${stem}.mp4`, sha256: hash(rendered), sizeBytes: rendered.length, ...profile,
        audition: { path: `${stem}.mp3`, sha256: hash(auditionBytes), sizeBytes: auditionBytes.length } });
      files.push(output, audition);
    }
    const receiptFile = join(outputDirectory, 'review-manifest.json');
    await writeFile(receiptFile, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    files.push(receiptFile);
    const uploaded = await artifact.uploadArtifact(`ai-meow-review-${packet.id}`, files, outputDirectory, { retentionDays: 7, compressionLevel: 0 });
    if (!Number.isSafeInteger(uploaded.id) || uploaded.id < 1) throw new Error('Review artifact receipt missing');
    return { batchId: packet.id, artifactId: uploaded.id, samples: packet.sources.length, reviewOnly: true, manifestSha256: packetHash(receipt), ...context };
  } catch { throw new Error('Remote audiovisual review failed. No inference, approval, publication or canonical mutation occurred'); }
}
