import { DefaultArtifactClient } from '@actions/artifact';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { audioReceiptPath, hash, packetHash, remoteContext, unpackAssemblyPacket } from './assembly-packets.mjs';
import { describeSphereAudio, synthesizeSphereAudio } from './original-sphere-audio.mjs';

/** Production only: procedural originals, no downloaded samples or inference. */
export async function runAudioWorker({ env = process.env, artifact = new DefaultArtifactClient(), synthesize = synthesizeSphereAudio, describe = describeSphereAudio } = {}) {
  try {
    const context = remoteContext(env);
    const launchBytes = await readFile(join(env.GITHUB_WORKSPACE, 'studio/batches/audio-launch.json'));
    if (launchBytes.length > 4096) throw new Error('Launch is oversized');
    const packet = unpackAssemblyPacket(env.AI_MEOW_AUDIO_PACKET, JSON.parse(launchBytes), 'audio');
    const directory = resolve(env.RUNNER_TEMP, `ai-meow-audio-${packet.id}`);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await mkdir(join(directory, 'audio'), { mode: 0o700 });
    const receipt = { schemaVersion: 1, type: 'original-audio', batchId: packet.id, episodeId: packet.episodeId, packetSha256: packetHash(packet), ...context, spec: { encoding: 'PCM', sampleRate: 48000, channels: 2, bitsPerSample: 16 }, scenes: [] };
    const files = [];
    for (const scene of packet.scenes) {
      const options = { durationSeconds: scene.durationSeconds, seed: scene.seed, genre: scene.genre, title: scene.title,
        ...(scene.audioProfile ? { audioProfile: scene.audioProfile } : {}) };
      const bytes = synthesize(options);
      if (!Buffer.isBuffer(bytes) || bytes.length !== 44 + 48000 * scene.durationSeconds * 4 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Original sound did not produce its exact WAV contract');
      const path = audioReceiptPath(scene.index);
      const filename = join(directory, path);
      await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
      files.push(filename);
      receipt.scenes.push({ ...scene, path, sha256: hash(bytes), sizeBytes: bytes.length, synthesis: describe(options) });
    }
    const receiptFile = join(directory, 'audio-manifest.json');
    await writeFile(receiptFile, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    files.push(receiptFile);
    const name = `ai-meow-audio-${packet.id}`;
    const uploaded = await artifact.uploadArtifact(name, files, directory, { retentionDays: 7, compressionLevel: 0 });
    if (!Number.isSafeInteger(uploaded.id) || uploaded.id < 1) throw new Error('Original sound artifact receipt is missing');
    return { batchId: packet.id, episodeId: packet.episodeId, status: 'completed', scenes: receipt.scenes.length, artifactId: uploaded.id, artifactName: name, manifestSha256: packetHash(receipt), ...context };
  } catch { throw new Error('Remote original audio production failed; no inference, publication or canonical studio mutation occurred'); }
}
