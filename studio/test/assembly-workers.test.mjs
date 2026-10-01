import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { audioReceiptPath, hash, packAssemblyPacket, packetHash, unpackAssemblyPacket, validateRenderPacket } from '../scripts/assembly-packets.mjs';
import { runAudioWorker } from '../scripts/remote-audio-worker.mjs';
import { runRenderWorker, shortCommand, verifiedProbe, ownedAudioArtifact } from '../scripts/remote-render-worker.mjs';

const sha = input => hash(String(input));
const launch = packet => ({ schemaVersion: 1, type: packet.type, batchId: packet.id, episodeId: packet.episodeId, packetSha256: packetHash(packet) });
const audioPacket = () => ({ schemaVersion: 1, type: 'audio', id: randomUUID(), episodeId: randomUUID(), scenes: Array.from({ length: 96 }, (_, i) => ({ index: i + 1, sceneId: randomUUID(), title: `Original world ${i + 1}`, genre: 'cosmic', seed: 1000 + i, durationSeconds: 7.5 })) });
const mockWav = () => {
  const bytes = Buffer.alloc(44 + 48000 * 7.5 * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
};
const mp4 = input => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from(String(input))]);
function finalProbe(seconds) { return { format: { duration: String(seconds) }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, avg_frame_rate: '30/1', duration: String(seconds) }, { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', duration: String(seconds) }] }; }

async function context(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-assembly-ci-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'studio/batches'), { recursive: true });
  const temporary = join(directory, 'runner'); await mkdir(temporary);
  return { directory, env: { GITHUB_ACTIONS: 'true', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'Giomaster/ytfun', GITHUB_RUN_ID: '123', GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKSPACE: directory, RUNNER_TEMP: temporary, GITHUB_TOKEN: 'fixture-actions-token', HF_TOKEN: 'fixture-hf-token' } };
}

function renderFixture(audio = audioPacket()) {
  const wav = mockWav(); const waveHash = hash(wav);
  const receipt = { schemaVersion: 1, type: 'original-audio', batchId: audio.id, episodeId: audio.episodeId, packetSha256: packetHash(audio), repository: 'Giomaster/ytfun', runId: 11, commitSha: 'b'.repeat(40), spec: { encoding: 'PCM', sampleRate: 48000, channels: 2, bitsPerSample: 16 }, scenes: audio.scenes.map(scene => ({ ...scene, path: audioReceiptPath(scene.index), sha256: waveHash, sizeBytes: wav.length, synthesis: { algorithm: 'fixture-no-synthesis' } })) };
  const scenes = audio.scenes.map(scene => ({ sceneId: scene.sceneId, durationSeconds: 7.5, scriptSha256: sha(`script-${scene.index}`), visual: { assetId: randomUUID(), path: `assets/video-${scene.index}.mp4`, kind: 'video', sha256: hash(mp4(scene.index)), provenanceSha256: sha(`visual-license-${scene.index}`) }, audio: { assetId: randomUUID(), path: `assets/audio-${scene.index}.wav`, kind: 'audio', sha256: waveHash, provenanceSha256: sha(`audio-license-${scene.index}`) } }));
  const packet = { schemaVersion: 1, type: 'render', id: randomUUID(), episodeId: audio.episodeId, manifest: { schemaVersion: 1, episodeId: audio.episodeId, format: 'long', audioMode: 'nonverbal', durationSeconds: 720, maxRenderBytes: 512 * 1024 * 1024, width: 1080, height: 1920, framesPerSecond: 30, editorialSha256: sha('editorial'), snapshotSha256: sha('snapshot'), scenes }, visuals: scenes.map((scene, i) => ({ assetId: scene.visual.assetId, sha256: scene.visual.sha256, remoteRequest: { provider: 'fal-ai', transport: 'huggingface-router', requestId: `request-${i + 1}`, responsePath: `/fal-ai/wan-model/requests/request-${i + 1}/response` } })), audioArtifact: { artifactId: 21, runId: 11, repository: 'Giomaster/ytfun', commitSha: 'b'.repeat(40), batchId: audio.id, packetSha256: packetHash(audio), manifestSha256: packetHash(receipt) } };
  return { packet, wav, receipt };
}
function ownedFetch(packet, mutation) {
  return async (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.ok(String(url).startsWith('https://api.github.com/repos/Giomaster/ytfun/actions/'));
    const value = String(url).includes('/artifacts/') ? { id: 21, name: `ai-meow-audio-${packet.audioArtifact.batchId}`, expired: false, size_in_bytes: 140000000, workflow_run: { id: 11, head_sha: 'b'.repeat(40) } } : { id: 11, repository: { full_name: 'Giomaster/ytfun' }, head_repository: { full_name: 'Giomaster/ytfun' }, head_sha: 'b'.repeat(40), head_branch: 'codex/ai-original-studio', path: '.github/workflows/ai-meow-audio.yml', event: 'push', status: 'completed', conclusion: 'success' };
    mutation?.(value); return Response.json(value);
  };
}

test('assembly packets bind exact launch identity, scene count/order and source receipt/hash mappings', () => {
  const audio = audioPacket(); const packed = packAssemblyPacket(audio);
  assert.deepEqual(unpackAssemblyPacket(packed.encoded, launch(audio), 'audio'), audio);
  assert.throws(() => unpackAssemblyPacket(packed.encoded, { ...launch(audio), packetSha256: sha('wrong') }, 'audio'), /differs from this launch/);
  assert.throws(() => packAssemblyPacket({ ...audio, scenes: audio.scenes.slice(1) }));
  assert.throws(() => packAssemblyPacket({ ...audio, credentials: 'must never be accepted' }));
  assert.throws(() => unpackAssemblyPacket('A'.repeat(48 * 1024), launch(audio), 'audio'), /invalid/);
  const { packet } = renderFixture(audio);
  assert.deepEqual(validateRenderPacket(packet), packet);
  for (const mutation of [p => { p.visuals[0].sha256 = sha('wrong-source'); }, p => { p.manifest.scenes[0].audio.kind = 'video'; }, p => { p.visuals[0].remoteRequest.responsePath += '?token=fixture'; }, p => { p.visuals[0].remoteRequest.responsePath = '/fal-ai/../../requests/request-1'; }, p => { p.manifest.scenes[0].durationSeconds = 5; }, p => { p.visuals[1].sha256 = p.visuals[0].sha256; }]) {
    const changed = structuredClone(packet); mutation(changed); assert.throws(() => validateRenderPacket(changed));
  }
});

test('audio worker uploads only originals/receipt and refuses invalid launch before synthesis or upload', async t => {
  const c = await context(t); const packet = audioPacket();
  await writeFile(join(c.directory, 'studio/batches/audio-launch.json'), JSON.stringify(launch(packet)));
  c.env.AI_MEOW_AUDIO_PACKET = packAssemblyPacket(packet).encoded;
  let synthesized = 0; let uploaded = 0;
  const artifact = { uploadArtifact: async (name, files, root, options) => {
    uploaded++; assert.equal(name, `ai-meow-audio-${packet.id}`); assert.equal(files.length, 97); assert.equal(options.retentionDays, 7);
    const receipt = JSON.parse(await readFile(join(root, 'audio-manifest.json')));
    assert.equal(receipt.scenes.length, 96); assert.ok(!JSON.stringify(receipt).includes('fixture-actions-token')); return { id: 21 };
  } };
  await assert.rejects(runAudioWorker({ env: { ...c.env, AI_MEOW_AUDIO_PACKET: 'invalid' }, artifact, synthesize: () => { synthesized++; return mockWav(); }, describe: () => ({ algorithm: 'fixture' }) }), /Remote original audio production failed/);
  assert.equal(synthesized, 0); assert.equal(uploaded, 0);
  const result = await runAudioWorker({ env: c.env, artifact, synthesize: () => { synthesized++; return mockWav(); }, describe: () => ({ algorithm: 'fixture' }) });
  assert.equal(result.scenes, 96); assert.equal(synthesized, 96); assert.equal(uploaded, 1);
});

test('render profile requires 30fps/full-duration original stereo audio, strips metadata and never loops', () => {
  assert.equal(verifiedProbe(finalProbe(720), 720).durationSeconds, 720);
  for (const mutation of [p => { p.streams.pop(); }, p => { p.streams[0].avg_frame_rate = '16/1'; }, p => { p.streams[1].duration = '700'; }, p => { p.streams.push({ codec_type: 'subtitle' }); }, p => { p.streams[1].channels = 1; }]) { const changed = finalProbe(720); mutation(changed); assert.throws(() => verifiedProbe(changed, 720)); }
  const args = shortCommand('original.mp4', 'own.wav', 'output.mp4');
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '0:v:0', '-map', '1:a:0']);
  assert.equal(args[args.indexOf('-map_metadata') + 1], '-1');
  assert.equal(args[args.indexOf('-maxrate') + 1], '2200k');
  assert.equal(args[args.indexOf('-bufsize') + 1], '4400k');
  assert.equal(args[args.indexOf('-preset') + 1], 'fast');
  assert.equal(args[args.indexOf('-threads') + 1], '4');
  assert.ok(!args.some(arg => /stream_loop|subtitles=|drawtext=/.test(arg)));
});

test('unowned or changed audio artifacts fail before provider recovery or encoding', async t => {
  const c = await context(t); const { packet } = renderFixture();
  await writeFile(join(c.directory, 'studio/batches/render-launch.json'), JSON.stringify(launch(packet))); c.env.AI_MEOW_RENDER_PACKET = packAssemblyPacket(packet).encoded;
  let downloads = 0; let recoveries = 0; let commands = 0;
  await assert.rejects(runRenderWorker({ env: c.env, artifact: { downloadArtifact: async () => { downloads++; } }, fetchImpl: ownedFetch(packet, value => { if (value.workflow_run) value.workflow_run.id = 99; }), recover: async () => { recoveries++; }, runner: async () => { commands++; } }), /Remote original assembly failed/);
  assert.equal(downloads, 0); assert.equal(recoveries, 0); assert.equal(commands, 0);
});
test('owned audio archive rejects digest failure, missing destination and a different directory', async t => {
  const c = await context(t); const { packet } = renderFixture();
  const directory = join(c.env.RUNNER_TEMP, 'audio'); await mkdir(directory);
  for (const [downloaded, message] of [
    [{downloadPath: directory, digestMismatch: true}, /Audio archive digest mismatch/],
    [{digestMismatch: false}, /Audio archive destination missing/],
    [{downloadPath: c.directory, digestMismatch: false}, /Audio archive destination differs/],
  ]) {
    await assert.rejects(ownedAudioArtifact(packet, {env:c.env, directory,
      artifact:{downloadArtifact:async()=>downloaded}, fetchImpl:ownedFetch(packet)}), message);
  }
});

test('remote assembly uses 96 exact original videos/WAVs and publishes only verified media plus sanitized receipt', async t => {
  const c = await context(t); const { packet, wav, receipt } = renderFixture();
  await writeFile(join(c.directory, 'studio/batches/render-launch.json'), JSON.stringify(launch(packet))); c.env.AI_MEOW_RENDER_PACKET = packAssemblyPacket(packet).encoded;
  let recoveries = 0; let encodes = 0; let uploaded = 0;
  const artifact = {
    downloadArtifact: async (id, options) => {
      assert.equal(id, 21); assert.deepEqual(options.findBy, { token: 'fixture-actions-token', workflowRunId: 11, repositoryOwner: 'Giomaster', repositoryName: 'ytfun' });
      await mkdir(join(options.path, 'audio')); await writeFile(join(options.path, 'audio-manifest.json'), JSON.stringify(receipt));
      for (let index = 1; index <= 96; index++) await writeFile(join(options.path, audioReceiptPath(index)), wav);
      return { downloadPath: options.path, digestMismatch: false };
    },
    uploadArtifact: async (name, files, root) => {
      uploaded++; assert.equal(files.length, 106); assert.ok(files.every(file => !file.includes('/sources/')));
      const result = JSON.parse(await readFile(join(root, 'render-manifest.json')));
      assert.equal(result.master.durationSeconds, 720); assert.equal(result.shorts.length, 96); assert.equal(result.compilations.length, 8);
      assert.ok(result.compilations.every(item => item.durationSeconds === 90 && item.sourceSceneIds.length === 12));
      const raw = JSON.stringify(result); assert.ok(!/fixture-hf-token|fixture-actions-token|responsePath|request-\d|prompt/.test(raw));
      return { id: 31 };
    },
  };
  const runner = async (binary, args) => {
    const filename = args.at(-1);
    if (binary === 'ffmpeg') {
      encodes++; await writeFile(filename, mp4(basename(filename))); return { stdout: '' };
    }
    if (filename.includes('/sources/')) return { stdout: JSON.stringify({ format: { duration: '7.5625' }, streams: [{ codec_type: 'video', duration: '7.5625' }] }) };
    return { stdout: JSON.stringify(finalProbe(filename.includes('/shorts/') ? 7.5 : filename.includes('/compilations/') ? 90 : 720)) };
  };
  const result = await runRenderWorker({ env: c.env, artifact, fetchImpl: ownedFetch(packet), recover: async request => { recoveries++; return { remoteStatus: 'COMPLETED', blob: new Blob([mp4(Number(request.requestId.split('-').at(-1)))], { type: 'video/mp4' }) }; }, runner });
  assert.equal(result.status, 'completed'); assert.equal(recoveries, 96); assert.equal(encodes, 105); assert.equal(uploaded, 1);
  for (const outcome of ['pending', 'wrong-hash']) {
    const changed = { ...packet, id: randomUUID() };
    await writeFile(join(c.directory, 'studio/batches/render-launch.json'), JSON.stringify(launch(changed)));
    const env = { ...c.env, AI_MEOW_RENDER_PACKET: packAssemblyPacket(changed).encoded };
    let recoveryCalls = 0;
    await assert.rejects(runRenderWorker({ env, artifact, fetchImpl: ownedFetch(changed), recover: async () => {
      recoveryCalls++;
      return outcome === 'pending' ? { remoteStatus: 'IN_PROGRESS' } : { remoteStatus: 'COMPLETED', blob: new Blob([mp4('a different unregistered source')]) };
    }, runner: async () => assert.fail('Pending or mismatched sources must not start any media command') }), /Remote original assembly failed/);
    assert.equal(recoveryCalls, 1, 'No automatic provider recovery loop or resubmission');
    assert.equal(uploaded, 1, 'No assembly artifact can claim completion for a failed source');
  }
});
