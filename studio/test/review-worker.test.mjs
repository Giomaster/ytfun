import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { hash, packetHash } from '../scripts/assembly-packets.mjs';
import { packReviewPacket, unpackReviewPacket, validateReviewPacket } from '../scripts/review-packets.mjs';
import { runReviewWorker } from '../scripts/remote-review-worker.mjs';

const mp4 = value => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from(String(value))]);
function fixture() {
  const audioBindings = Array.from({ length: 96 }, (_, index) => ({ sceneId: randomUUID(), audio: { sha256: hash(`audio-${index}`) } }));
  const sources = [1, 17].map(index => ({ index, sceneId: audioBindings[index - 1].sceneId, assetId: randomUUID(),
    sha256: hash(mp4(index)), acceptedVisualSha256: hash(mp4(index)),
    remoteRequest: { provider: 'fal-ai', transport: 'huggingface-router', requestId: `request-${index}`, responsePath: `/fal-ai/wan/requests/request-${index}/response` } }));
  return { schemaVersion: 1, type: 'review', id: randomUUID(), episodeId: randomUUID(), sources, audioBindings,
    audioArtifact: { artifactId: 21, runId: 11, repository: 'Giomaster/ytfun', commitSha: 'b'.repeat(40), batchId: randomUUID(), packetSha256: hash('audio-packet'), manifestSha256: hash('audio-manifest') } };
}
const launch = packet => ({ schemaVersion: 1, type: 'review', batchId: packet.id, episodeId: packet.episodeId, packetSha256: packetHash(packet) });
async function context(t, packet) {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-review-ci-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'studio/batches'), { recursive: true });
  await writeFile(join(directory, 'studio/batches/review-launch.json'), JSON.stringify(launch(packet)));
  const temporary = join(directory, 'runner'); await mkdir(temporary);
  return { GITHUB_ACTIONS: 'true', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'Giomaster/ytfun',
    GITHUB_RUN_ID: '123', GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKSPACE: directory, RUNNER_TEMP: temporary,
    GITHUB_TOKEN: 'fixture-actions-token', HF_TOKEN: 'fixture-hf-token', AI_MEOW_REVIEW_PACKET: packReviewPacket(packet).encoded };
}

test('review packet binds the exact private selection, launch and accepted source hashes', () => {
  const packet = fixture(); const packed = packReviewPacket(packet);
  assert.deepEqual(unpackReviewPacket(packed.encoded, launch(packet)), packet);
  assert.throws(() => unpackReviewPacket(packed.encoded, { ...launch(packet), packetSha256: hash('wrong') }), /differs/);
  assert.throws(() => packReviewPacket({ ...packet, credentials: 'not an accepted field' }));
  assert.throws(() => unpackReviewPacket('A'.repeat(48 * 1024), launch(packet)), /differs/);
});
test('review packets reject duplicates, reordered audio, rejected hashes and unsafe request paths', () => {
  for (const mutate of [p => { p.sources[1] = p.sources[0]; }, p => { p.sources[0].acceptedVisualSha256 = hash('rejected'); },
    p => { [p.audioBindings[0], p.audioBindings[1]] = [p.audioBindings[1], p.audioBindings[0]]; },
    p => { p.sources[0].remoteRequest.responsePath += '?token=private'; },
    p => { p.sources[0].remoteRequest.responsePath = '/fal-ai/../../requests/request-1'; },
    p => { p.sources[0].remoteRequest.requestId = 'different-request'; }]) {
    const packet = fixture(); mutate(packet); assert.throws(() => validateReviewPacket(packet));
  }
});
test('invalid or rerun review context fails before audio recovery, GETs and media commands', async t => {
  const packet = fixture(); const env = await context(t, packet); let work = 0;
  const options = { retrieveAudio: async () => { work++; }, recover: async () => { work++; }, runner: async () => { work++; } };
  await assert.rejects(runReviewWorker({ ...options, env: { ...env, GITHUB_RUN_ATTEMPT: '2' } }), /No inference/);
  await assert.rejects(runReviewWorker({ ...options, env: { ...env, AI_MEOW_REVIEW_PACKET: 'wrong' } }), /No inference/);
  assert.equal(work, 0);
});
test('audio ownership verification precedes all provider GETs and media encoding', async t => {
  const packet = fixture(); const env = await context(t, packet); let later = 0;
  await assert.rejects(runReviewWorker({ env, retrieveAudio: async () => { throw new Error('Unowned artifact'); },
    recover: async () => { later++; }, runner: async () => { later++; } }), /No inference/);
  assert.equal(later, 0);
});
test('changed original hash fails before encoding, without a replacement generation', async t => {
  const packet = fixture(); const env = await context(t, packet); let commands = 0;
  await assert.rejects(runReviewWorker({ env, retrieveAudio: async () => {},
    recover: async receipt => ({ remoteStatus: 'COMPLETED', requestId: receipt.requestId, blob: new Blob([mp4('changed')]) }),
    runner: async () => { commands++; } }), /No inference/);
  assert.equal(commands, 0);
});
test('pending GET-only source remains pending and cannot become an assembled review', async t => {
  const packet = fixture(); const env = await context(t, packet); let commands = 0;
  await assert.rejects(runReviewWorker({ env, retrieveAudio: async () => {},
    recover: async receipt => ({ remoteStatus: 'IN_PROGRESS', requestId: receipt.requestId }),
    runner: async () => { commands++; } }), /No inference/);
  assert.equal(commands, 0);
});
test('review outputs bind exact visuals/audio but never claim approval or publication', async t => {
  const packet = fixture(); const env = await context(t, packet); let recoveries = 0; let commands = 0; let uploaded = 0;
  const retrieveAudio = async (projection, { directory }) => {
    assert.deepEqual(projection.manifest.scenes, packet.audioBindings);
    assert.deepEqual(projection.audioArtifact, packet.audioArtifact);
    await mkdir(join(directory, 'audio'));
    for (const source of packet.sources) await writeFile(join(directory, 'audio', `${String(source.index).padStart(3, '0')}.wav`), 'fixture-original-audio');
  };
  const runner = async (binary, args) => {
    commands++; const filename = args.at(-1);
    if (binary === 'ffmpeg') {
      assert.equal(args[args.indexOf('-map_metadata') + 1], '-1');
      if (filename.endsWith('.mp4')) {
        assert.equal(args[args.indexOf('-map') + 3], '1:a:0');
        assert.equal(args[args.indexOf('-t') + 1], '7.5');
      }
      await writeFile(filename, filename.endsWith('.mp3') ? Buffer.from('ID3-fixture-mp3') : mp4(basename(filename)));
      return { stdout: '' };
    }
    if (filename.includes('/sources/')) return { stdout: JSON.stringify({ format: { duration: '7.5625' }, streams: [{ codec_type: 'video', duration: '7.5625' }] }) };
    return { stdout: JSON.stringify({ format: { duration: '7.5' }, streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, avg_frame_rate: '30/1', duration: '7.5' },
      { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', duration: '7.5' }] }) };
  };
  const artifact = { uploadArtifact: async (name, files, root) => {
    uploaded++; assert.equal(name, `ai-meow-review-${packet.id}`); assert.equal(files.length, 5);
    const receipt = JSON.parse(await readFile(join(root, 'review-manifest.json')));
    assert.equal(receipt.reviewOnly, true); assert.equal(receipt.approved, false); assert.equal(receipt.published, false);
    assert.deepEqual(receipt.samples.map(sample => sample.sourceSha256), packet.sources.map(source => source.sha256));
    assert.deepEqual(receipt.samples.map(sample => sample.audioSourceSha256), packet.sources.map(source => packet.audioBindings[source.index - 1].audio.sha256));
    assert.ok(!/fixture-hf-token|fixture-actions-token|responsePath|request-\d|prompt/.test(JSON.stringify(receipt)));
    return { id: 31 };
  } };
  const result = await runReviewWorker({ env, artifact, retrieveAudio, runner,
    recover: async receipt => { recoveries++; return { remoteStatus: 'COMPLETED', requestId: receipt.requestId, blob: new Blob([mp4(Number(receipt.requestId.split('-')[1]))]) }; } });
  assert.equal(result.samples, 2); assert.equal(result.reviewOnly, true); assert.equal(result.artifactId, 31);
  assert.equal(recoveries, 2); assert.equal(commands, 8); assert.equal(uploaded, 1);
});
