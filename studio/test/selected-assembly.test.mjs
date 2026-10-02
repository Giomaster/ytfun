import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { episodeLimits } from '../src/domain.mjs';
import { recoverFalVideo } from '../src/fal-queue-recovery.mjs';
import { audioReceiptPath, canonicalJson, hash, packetHash } from '../scripts/assembly-packets.mjs';
import { mediaCommand, ownedAudioArtifact, verifiedProbe } from '../scripts/remote-render-worker.mjs';
import { packSelectedAssemblyPacket, unpackSelectedAssemblyPacket, validateSelectedAssemblyPacket } from '../scripts/selected-assembly-packets.mjs';
import { runSelectedAssemblyWorker } from '../scripts/remote-selected-assembly-worker.mjs';

const SOURCE_INDICES = [82, 1, 49, 2, 81, 4, 18, 3, 17];
const SHORT_SOURCE_INDICES = [6, 7, 19, 20, 33, 50, 51];
const LANDSCAPE = { width: 1920, height: 1080, framesPerSecond: 30 };
const PORTRAIT = { width: 1080, height: 1920, framesPerSecond: 30 };
const mp4 = input => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from(String(input))]);
const launch = packet => ({ schemaVersion: 1, type: 'selected-assembly', batchId: packet.id, episodeId: packet.episodeId, packetSha256: packetHash(packet) });
const unsafeEnvelope = packet => gzipSync(canonicalJson(packet)).toString('base64');
const wavHashes = new Map();

function mockWav(index) {
  const bytes = Buffer.alloc(44 + 48000 * 7.5 * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  bytes.writeInt16LE(index, 44);
  return bytes;
}

function wavHash(index) {
  if (!wavHashes.has(index)) wavHashes.set(index, hash(mockWav(index)));
  return wavHashes.get(index);
}

function fixture(indices = SOURCE_INDICES, profile = LANDSCAPE, format = 'long') {
  const sourceEpisodeId = randomUUID(); const episodeId = randomUUID();
  const audioBindings = Array.from({ length: 96 }, (_, offset) => ({ sceneId: randomUUID(), audio: { sha256: wavHash(offset + 1) } }));
  const audioBatchId = randomUUID(); const audioPacketSha256 = hash('fixture-original-audio-packet');
  const audioReceipt = { schemaVersion: 1, type: 'original-audio', batchId: audioBatchId, episodeId: sourceEpisodeId,
    packetSha256: audioPacketSha256, repository: 'Giomaster/ytfun', runId: 11, commitSha: 'b'.repeat(40),
    spec: { encoding: 'PCM', sampleRate: 48000, channels: 2, bitsPerSample: 16 },
    scenes: audioBindings.map((binding, offset) => ({ index: offset + 1, sceneId: binding.sceneId,
      path: audioReceiptPath(offset + 1), durationSeconds: 7.5, sha256: binding.audio.sha256,
      sizeBytes: 44 + 48000 * 7.5 * 4, synthesis: { algorithm: 'fixture-no-synthesis' } })) };
  const scenes = indices.map(index => ({ sceneId: randomUUID(), durationSeconds: 7.5, scriptSha256: hash(`script-${index}`),
    visual: { assetId: randomUUID(), path: `assets/source-${index}.mp4`, kind: 'video', sha256: hash(mp4(index)), provenanceSha256: hash(`video-rights-${index}`) },
    audio: { assetId: randomUUID(), path: `assets/audio-${index}.wav`, kind: 'audio', sha256: wavHash(index), provenanceSha256: hash(`audio-rights-${index}`) } }));
  const sources = scenes.map((scene, offset) => ({ assetId: scene.visual.assetId, sha256: scene.visual.sha256,
    sourceSceneId: audioBindings[indices[offset] - 1].sceneId, sourceIndex: indices[offset],
    remoteRequest: { provider: 'fal-ai', transport: 'huggingface-router', requestId: `request-${indices[offset]}`,
      responsePath: `/fal-ai/wan/requests/request-${indices[offset]}/response` } })).reverse();
  const packet = { schemaVersion: 1, type: 'selected-assembly', id: randomUUID(), episodeId, sourceEpisodeId,
    manifest: { schemaVersion: 1, episodeId, format, audioMode: 'nonverbal', durationSeconds: indices.length * 7.5,
      maxRenderBytes: episodeLimits(format).maxRenderBytes, ...profile, editorialSha256: hash('editorial'), snapshotSha256: hash('snapshot'), scenes },
    sources, audioBindings, audioArtifact: { artifactId: 21, runId: 11, repository: 'Giomaster/ytfun', commitSha: 'b'.repeat(40),
      batchId: audioBatchId, packetSha256: audioPacketSha256, manifestSha256: packetHash(audioReceipt) } };
  return { packet, audioReceipt };
}

async function context(t, packet) {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-selected-assembly-ci-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'studio/batches'), { recursive: true });
  await writeFile(join(directory, 'studio/batches/selected-assembly-launch.json'), JSON.stringify(launch(packet)));
  const temporary = join(directory, 'runner'); await mkdir(temporary);
  return { directory, env: { GITHUB_ACTIONS: 'true', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'Giomaster/ytfun',
    GITHUB_RUN_ID: '123', GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKSPACE: directory, RUNNER_TEMP: temporary,
    GITHUB_TOKEN: 'fixture-actions-token', HF_TOKEN: 'fixture-hf-token', AI_MEOW_SELECTED_ASSEMBLY_PACKET: packSelectedAssemblyPacket(packet).encoded } };
}

function finalProbe(seconds, profile = LANDSCAPE) {
  return { format: { duration: String(seconds) }, streams: [
    { codec_type: 'video', codec_name: 'h264', width: profile.width, height: profile.height, avg_frame_rate: '30/1', duration: String(seconds), sample_aspect_ratio: '1:1' },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', duration: String(seconds) },
  ] };
}

function assertReceipt(receipt, packet) {
  assert.equal(receipt.type, 'selected-original-assembly');
  assert.equal(receipt.episodeId, packet.episodeId); assert.equal(receipt.sourceEpisodeId, packet.sourceEpisodeId);
  assert.equal(receipt.packetSha256, packetHash(packet)); assert.equal(receipt.sourceManifestSha256, packetHash(packet.manifest));
  assert.equal(receipt.approved, false); assert.equal(receipt.published, false); assert.equal(receipt.inferenceSubmitted, false);
  assert.deepEqual(receipt.sourceScenes, packet.manifest.scenes.map((scene, offset) => {
    const source = packet.sources.find(item => item.assetId === scene.visual.assetId);
    return { order: offset + 1, sceneId: scene.sceneId, sourceSceneId: source.sourceSceneId, sourceIndex: source.sourceIndex,
      visualAssetId: scene.visual.assetId, visualSha256: scene.visual.sha256, audioAssetId: scene.audio.assetId,
      audioSha256: scene.audio.sha256, sourceRangeSeconds: [0, 7.5], outputRangeSeconds: [offset * 7.5, (offset + 1) * 7.5] };
  }));
  assert.equal(receipt.master.durationSeconds, packet.manifest.durationSeconds);
  assert.equal(receipt.master.width, packet.manifest.width); assert.equal(receipt.master.height, packet.manifest.height);
  assert.equal(receipt.master.framesPerSecond, 30); assert.equal(receipt.master.audioMode, 'nonverbal');
  assert.equal(receipt.master.hasAudio, true); assert.equal(receipt.master.audioCodec, 'aac');
  assert.equal(receipt.master.channels, 2); assert.equal(receipt.master.sampleRate, 48000);
  assert.ok(!/fixture-hf-token|fixture-actions-token|responsePath|request-\d|prompt/.test(JSON.stringify(receipt)));
}

function harness(packet, audioReceipt, options = {}) {
  const calls = { fetch: [], recover: [], audio: 0, download: 0, commands: [], upload: 0 };
  let uploadedReceipt;
  const fetchImpl = async (url, request) => {
    calls.fetch.push(String(url)); assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error');
    if (String(url).startsWith('https://api.github.com/repos/Giomaster/ytfun/actions/')) {
      assert.equal(request.headers.Authorization, 'Bearer fixture-actions-token');
      const value = String(url).includes('/artifacts/')
        ? { id: 21, name: `ai-meow-audio-${packet.audioArtifact.batchId}`, expired: false, size_in_bytes: 140000000,
          digest: `sha256:${hash('fixture-original-audio-archive')}`, workflow_run: { id: options.unownedAudio ? 99 : 11, head_sha: 'b'.repeat(40) } }
        : { id: 11, repository: { full_name: 'Giomaster/ytfun' }, head_repository: { full_name: 'Giomaster/ytfun' },
          head_sha: 'b'.repeat(40), head_branch: 'codex/ai-original-studio', path: '.github/workflows/ai-meow-audio.yml',
          event: 'push', status: 'completed', conclusion: 'success' };
      return Response.json(value);
    }
    if (String(url).startsWith('https://router.huggingface.co/')) {
      assert.equal(request.headers.Authorization, 'Bearer fixture-hf-token');
      const index = Number(String(url).match(/request-(\d+)/)?.[1]); assert.ok(packet.sources.some(source => source.sourceIndex === index));
      if (String(url).includes('/status?')) {
        if (options.getFailure) return Response.json({ error: 'fixture-hf-token private-provider-error' }, { status: 503 });
        return Response.json({ status: options.pending ? 'IN_PROGRESS' : 'COMPLETED', request_id: `request-${index}` });
      }
      return Response.json({ video: { url: `https://fal.media/source-${index}.mp4` } });
    }
    assert.match(String(url), /^https:\/\/fal\.media\/source-\d+\.mp4$/);
    assert.equal(request.headers.Authorization, undefined, 'Provider credentials must not reach public media downloads');
    const index = Number(String(url).match(/source-(\d+)/)[1]);
    return new Response(mp4(options.wrongHash ? 'unregistered-original' : index), { headers: { 'content-type': 'video/mp4' } });
  };
  const artifact = {
    downloadArtifact: async (id, optionsForDownload) => {
      calls.download++; assert.equal(id, 21);
      assert.deepEqual(optionsForDownload.findBy, { token: 'fixture-actions-token', workflowRunId: 11, repositoryOwner: 'Giomaster', repositoryName: 'ytfun' });
      assert.equal(optionsForDownload.expectedHash, `sha256:${hash('fixture-original-audio-archive')}`);
      await mkdir(join(optionsForDownload.path, 'audio'));
      await writeFile(join(optionsForDownload.path, 'audio-manifest.json'), JSON.stringify(audioReceipt));
      for (let index = 1; index <= 96; index++) {
        const wav = mockWav(index); if (options.corruptWavIndex === index) wav[44] ^= 1;
        await writeFile(join(optionsForDownload.path, audioReceiptPath(index)), wav);
      }
      return { downloadPath: optionsForDownload.path, digestMismatch: false };
    },
    uploadArtifact: async (name, files, root, uploadOptions) => {
      calls.upload++; assert.equal(name, `ai-meow-selected-assembly-${packet.id}`);
      assert.deepEqual(files.map(file => basename(file)).sort(), ['master.mp4', 'render-manifest.json']);
      assert.ok(files.every(file => dirname(file) === root));
      assert.deepEqual(uploadOptions, { retentionDays: 7, compressionLevel: 0 });
      uploadedReceipt = JSON.parse(await readFile(join(root, 'render-manifest.json')));
      assertReceipt(uploadedReceipt, packet);
      assert.equal(uploadedReceipt.master.sha256, hash(await readFile(join(root, 'master.mp4'))));
      return { id: 31 };
    },
  };
  const retrieveAudio = async (projection, workerOptions) => {
    calls.audio++;
    assert.equal(projection.episodeId, packet.sourceEpisodeId);
    assert.notEqual(projection.episodeId, packet.episodeId);
    assert.deepEqual(projection.audioArtifact, packet.audioArtifact);
    assert.deepEqual(projection.manifest.scenes, packet.audioBindings);
    assert.equal(projection.manifest.scenes.length, 96, 'Verify the complete parent audio artifact before selecting original WAV indices');
    if (options.mockAudio) {
      await mkdir(join(workerOptions.directory, 'audio'));
      for (const source of packet.sources) await writeFile(join(workerOptions.directory, audioReceiptPath(source.sourceIndex)), mockWav(source.sourceIndex));
      return audioReceipt;
    }
    return ownedAudioArtifact(projection, workerOptions);
  };
  const recover = async (request, workerOptions) => {
    calls.recover.push(request.requestId);
    if (options.wrongRequest) return { remoteStatus: 'COMPLETED', requestId: 'request-unowned', blob: new Blob([mp4(SOURCE_INDICES[0])]) };
    return recoverFalVideo(request, workerOptions);
  };
  const runner = async (binary, args) => {
    calls.commands.push({ binary, args }); const filename = args.at(-1);
    if (binary === 'ffmpeg') {
      assert.ok(!args.some(arg => /stream_loop|aloop=|tpad=|subtitles=|drawtext=/.test(arg)), 'Only complete original scenes, without loops or padding time');
      assert.equal(args[args.indexOf('-map_metadata') + 1], '-1');
      assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '0:v:0', '-map', '1:a:0']);
      const inputs = args.flatMap((arg, index) => arg === '-i' ? [args[index + 1]] : []);
      if (args.includes('-vf')) {
        const offset = Number(basename(filename, '.mp4')) - 1;
        const source = packet.sources.find(item => item.assetId === packet.manifest.scenes[offset].visual.assetId);
        assert.equal(hash(await readFile(inputs[0])), source.sha256);
        assert.equal(basename(inputs[1]), basename(audioReceiptPath(source.sourceIndex)));
        assert.equal(hash(await readFile(inputs[1])), packet.manifest.scenes[offset].audio.sha256);
        assert.equal(args[args.indexOf('-t') + 1], '7.5');
        assert.equal(args[args.indexOf('-vf') + 1], `scale=${packet.manifest.width}:${packet.manifest.height}:force_original_aspect_ratio=decrease,pad=${packet.manifest.width}:${packet.manifest.height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1`);
      } else {
        assert.equal(args[args.indexOf('-t') + 1], String(packet.manifest.durationSeconds));
        assert.equal(args[args.indexOf('-c:v') + 1], 'copy'); assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
        assert.equal(await readFile(inputs[0], 'utf8'), packet.manifest.scenes.map((_, offset) => `file 'segments/${String(offset + 1).padStart(3, '0')}.mp4'\nduration 7.5\n`).join(''));
        assert.equal(await readFile(inputs[1], 'utf8'), packet.manifest.scenes.map(scene => {
          const source = packet.sources.find(item => item.assetId === scene.visual.assetId);
          return `file 'audio/${audioReceiptPath(source.sourceIndex)}'\nduration 7.5\n`;
        }).join(''));
      }
      await writeFile(filename, mp4(basename(filename))); return { stdout: '' };
    }
    assert.equal(binary, 'ffprobe');
    if (filename.includes('/sources/')) return { stdout: JSON.stringify({ format: { duration: options.shortSource ? '7' : '7.5625' }, streams: [{ codec_type: 'video', duration: options.shortSource ? '7' : '7.5625' }] }) };
    return { stdout: JSON.stringify(finalProbe(basename(filename) === 'master.mp4' ? packet.manifest.durationSeconds : 7.5, packet.manifest)) };
  };
  return { artifact, fetchImpl, recover, runner, retrieveAudio, calls, get receipt() { return uploadedReceipt; } };
}

test('selected packets preserve exact destination order, parent bindings, launch identity and either canvas', () => {
  for (const profile of [LANDSCAPE, PORTRAIT]) {
    const { packet } = fixture(SOURCE_INDICES, profile); const packed = packSelectedAssemblyPacket(packet);
    assert.deepEqual(validateSelectedAssemblyPacket(packet), packet);
    assert.deepEqual(unpackSelectedAssemblyPacket(packed.encoded, launch(packet)), packet);
    assert.equal(packed.packetSha256, packetHash(packet));
    for (const changedLaunch of [{ ...launch(packet), packetSha256: hash('changed') }, { ...launch(packet), episodeId: randomUUID() },
      { ...launch(packet), batchId: randomUUID() }, { ...launch(packet), type: 'render' }, { ...launch(packet), credentials: 'private' }]) {
      assert.throws(() => unpackSelectedAssemblyPacket(packed.encoded, changedLaunch), /differs from its exact launch/);
    }
    for (const encoded of ['invalid', 'A'.repeat(48 * 1024), `${packed.encoded}\n`]) {
      assert.throws(() => unpackSelectedAssemblyPacket(encoded, launch(packet)), /differs from its exact launch/);
    }
    const reordered = structuredClone(packet); reordered.manifest.scenes.reverse();
    assert.deepEqual(validateSelectedAssemblyPacket(reordered), reordered);
    assert.throws(() => unpackSelectedAssemblyPacket(packSelectedAssemblyPacket(reordered).encoded, launch(packet)), /differs/);
  }
  for (const count of [1, 96]) {
    const { packet } = fixture(Array.from({ length: count }, (_, offset) => offset + 1));
    assert.equal(validateSelectedAssemblyPacket(packet).manifest.durationSeconds, count * 7.5);
  }
});

test('native short packets bind the exact format cap and destination limits while retaining all 96 parent audio bindings', () => {
  const limits = episodeLimits('short');
  assert.deepEqual([limits.maxScenes, limits.maxDurationSeconds, limits.maxRenderBytes], [12, 180, 100 * 1024 * 1024]);
  for (const profile of [PORTRAIT, LANDSCAPE]) {
    for (const indices of [[96], SHORT_SOURCE_INDICES, [...Array.from({ length: 11 }, (_, offset) => offset + 1), 96]]) {
      const { packet } = fixture(indices, profile, 'short'); const packed = packSelectedAssemblyPacket(packet);
      assert.deepEqual(validateSelectedAssemblyPacket(packet), packet);
      assert.deepEqual(unpackSelectedAssemblyPacket(packed.encoded, launch(packet)), packet);
      assert.equal(packet.manifest.maxRenderBytes, limits.maxRenderBytes);
      assert.equal(packet.manifest.durationSeconds, indices.length * 7.5);
      assert.equal(packet.audioBindings.length, 96);
      const wrongCap = structuredClone(packet); wrongCap.manifest.maxRenderBytes = 512 * 1024 * 1024;
      assert.throws(() => packSelectedAssemblyPacket(wrongCap));
      assert.throws(() => unpackSelectedAssemblyPacket(unsafeEnvelope(wrongCap), launch(wrongCap)), /differs/);
    }
  }
  const { packet: long } = fixture(Array.from({ length: 96 }, (_, offset) => offset + 1));
  assert.equal(validateSelectedAssemblyPacket(long).manifest.durationSeconds, 720);
  long.manifest.maxRenderBytes = limits.maxRenderBytes;
  assert.throws(() => packSelectedAssemblyPacket(long), undefined, 'A short cap cannot replace the exact long manifest contract');
  const { packet: tooManyScenes } = fixture(Array.from({ length: 13 }, (_, offset) => offset + 1), PORTRAIT, 'short');
  assert.throws(() => packSelectedAssemblyPacket(tooManyScenes), undefined, '13 short scenes exceed the destination limit even below 180 seconds');
  const { packet: short } = fixture(SHORT_SOURCE_INDICES, PORTRAIT, 'short');
  for (const mutate of [
    value => { value.manifest.durationSeconds = limits.maxDurationSeconds + 1; },
    value => { value.manifest.durationSeconds = limits.maxDurationSeconds; },
    value => { value.manifest.maxRenderBytes = limits.maxRenderBytes - 1; },
    value => { value.manifest.format = 'unknown'; },
    value => { value.manifest.scenes[0].durationSeconds = 7.25; },
  ]) {
    const invalid = structuredClone(short); mutate(invalid);
    assert.throws(() => packSelectedAssemblyPacket(invalid));
    assert.throws(() => unpackSelectedAssemblyPacket(unsafeEnvelope(invalid), launch(invalid)), /differs/);
  }
});

test('selected packets reject clones, mismatched mappings, unsafe retrieval and changed exact manifest contracts', () => {
  const mutations = [
    p => { p.sources[1].sha256 = p.sources[0].sha256; }, p => { p.sources[1].assetId = p.sources[0].assetId; },
    p => { p.sources[1].sourceIndex = p.sources[0].sourceIndex; }, p => { p.sources[1].sourceSceneId = p.sources[0].sourceSceneId; },
    p => { p.sources[1].remoteRequest = p.sources[0].remoteRequest; },
    p => { p.manifest.scenes[1].sceneId = p.manifest.scenes[0].sceneId; },
    p => { p.manifest.scenes[1].visual.assetId = p.manifest.scenes[0].visual.assetId; },
    p => { p.manifest.scenes[1].audio.assetId = p.manifest.scenes[0].audio.assetId; },
    p => { p.sources[0].sha256 = hash('unregistered-video'); }, p => { p.sources[0].assetId = randomUUID(); },
    p => { p.sources[0].sourceSceneId = randomUUID(); }, p => { p.sources[0].sourceIndex = 96; },
    p => { p.manifest.scenes[0].audio.sha256 = p.audioBindings[95].audio.sha256; },
    p => { [p.audioBindings[81], p.audioBindings[0]] = [p.audioBindings[0], p.audioBindings[81]]; },
    p => { p.audioBindings[95].sceneId = p.audioBindings[0].sceneId; }, p => { p.audioBindings.pop(); },
    p => { p.sources[0].sourceIndex = 0; }, p => { p.sources[0].sourceIndex = 97; },
    p => { p.sources[0].remoteRequest.responsePath += '?token=private'; },
    p => { p.sources[0].remoteRequest.responsePath = '/fal-ai/../../requests/request-17/response'; },
    p => { p.sources[0].remoteRequest.requestId = 'different-request'; },
    p => { p.sources.pop(); }, p => { p.sources.push(structuredClone(p.sources[0])); },
    p => { p.manifest.scenes[0].durationSeconds = 7; }, p => { p.manifest.durationSeconds = 720; },
    p => { p.manifest.scenes = []; p.sources = []; p.manifest.durationSeconds = 0; },
    p => { p.manifest.scenes.push(...Array.from({ length: 88 }, () => structuredClone(p.manifest.scenes[0]))); p.manifest.durationSeconds = 727.5; },
    p => { p.manifest.episodeId = randomUUID(); }, p => { p.sourceEpisodeId = p.episodeId; },
    p => { p.manifest.width = 1080; }, p => { p.manifest.width = 1280; p.manifest.height = 720; },
    p => { p.manifest.width = '1920'; }, p => { p.manifest.framesPerSecond = 24; },
    p => { p.manifest.format = 'short'; }, p => { p.manifest.audioMode = 'narration'; },
    p => { p.manifest.scenes[0].visual.path = '../outside.mp4'; }, p => { p.manifest.scenes[0].audio.kind = 'video'; },
    p => { p.credentials = 'must-not-enter-a-private-packet'; },
  ];
  const { packet } = fixture();
  for (const [index, mutate] of mutations.entries()) {
    const changed = structuredClone(packet); mutate(changed);
    assert.throws(() => validateSelectedAssemblyPacket(changed), undefined, `Mutation ${index} must not become an authorized assembly`);
    assert.throws(() => packSelectedAssemblyPacket(changed));
  }
});

test('invalid packets, changed launch hashes and nonfresh Actions contexts fail before any external I/O', async t => {
  const { packet } = fixture(); const c = await context(t, packet); let io = 0;
  const options = { artifact: { downloadArtifact: async () => { io++; }, uploadArtifact: async () => { io++; } },
    fetchImpl: async () => { io++; }, retrieveAudio: async () => { io++; }, recover: async () => { io++; }, runner: async () => { io++; } };
  for (const changedEnv of [{ ...c.env, GITHUB_ACTIONS: 'false' }, { ...c.env, GITHUB_RUN_ATTEMPT: '2' },
    { ...c.env, HF_TOKEN: '' }, { ...c.env, GITHUB_TOKEN: '' }, { ...c.env, AI_MEOW_SELECTED_ASSEMBLY_PACKET: 'invalid' }]) {
    await assert.rejects(runSelectedAssemblyWorker({ ...options, env: changedEnv }), /No inference, approval, publication or canonical mutation/);
  }
  const changed = structuredClone(packet); changed.manifest.scenes[0].audio.sha256 = hash('wrong-source-wav');
  await writeFile(join(c.directory, 'studio/batches/selected-assembly-launch.json'), JSON.stringify(launch(changed)));
  await assert.rejects(runSelectedAssemblyWorker({ ...options, env: { ...c.env, AI_MEOW_SELECTED_ASSEMBLY_PACKET: unsafeEnvelope(changed) } }), /\[packet\]/);
  await writeFile(join(c.directory, 'studio/batches/selected-assembly-launch.json'), JSON.stringify({ ...launch(packet), packetSha256: hash('changed-launch') }));
  await assert.rejects(runSelectedAssemblyWorker({ ...options, env: c.env }), /\[packet\]/);
  assert.equal(io, 0);
});

test('nine landscape originals use GET-only recovery and original WAV indices in manifest order; only master and receipt leave the worker', async t => {
  const { packet, audioReceipt } = fixture(); const c = await context(t, packet); const h = harness(packet, audioReceipt);
  const result = await runSelectedAssemblyWorker({ env: c.env, ...h });
  assert.equal(result.status, 'completed'); assert.equal(result.scenes, 9); assert.equal(result.artifactId, 31);
  assert.equal(result.manifestSha256, packetHash(h.receipt)); assert.equal(result.masterSha256, h.receipt.master.sha256);
  assert.equal(h.calls.audio, 1); assert.equal(h.calls.download, 1); assert.equal(h.calls.upload, 1);
  assert.deepEqual(h.calls.recover, SOURCE_INDICES.map(index => `request-${index}`));
  assert.equal(h.calls.fetch.length, 2 + 3 * 9);
  assert.equal(h.calls.commands.filter(call => call.binary === 'ffmpeg').length, 10);
  assert.equal(h.calls.commands.filter(call => call.binary === 'ffprobe').length, 19);
  const before = { fetch: h.calls.fetch.length, recover: h.calls.recover.length, audio: h.calls.audio,
    download: h.calls.download, commands: h.calls.commands.length, upload: h.calls.upload };
  await assert.rejects(runSelectedAssemblyWorker({ env: c.env, ...h }), /\[packet\]/);
  assert.deepEqual({ fetch: h.calls.fetch.length, recover: h.calls.recover.length, audio: h.calls.audio,
    download: h.calls.download, commands: h.calls.commands.length, upload: h.calls.upload }, before, 'The same owned run cannot recover or upload the batch a second time');
});

test('seven native short sources retain original WAV indices and the 100 MiB master cap', async t => {
  const { packet, audioReceipt } = fixture(SHORT_SOURCE_INDICES, PORTRAIT, 'short');
  const c = await context(t, packet); const h = harness(packet, audioReceipt, { mockAudio: true });
  const result = await runSelectedAssemblyWorker({ env: c.env, ...h });
  assert.equal(result.status, 'completed'); assert.equal(result.scenes, 7);
  assert.equal(h.calls.audio, 1); assert.equal(h.calls.upload, 1);
  assert.deepEqual(h.calls.recover, SHORT_SOURCE_INDICES.map(index => `request-${index}`));
  assert.equal(h.calls.fetch.length, 3 * 7);
  assert.equal(h.calls.commands.filter(call => call.binary === 'ffmpeg').length, 8);
  assert.equal(h.receipt.master.durationSeconds, 52.5);
  assert.ok(h.receipt.master.sizeBytes <= episodeLimits('short').maxRenderBytes);

  const oversizedContext = await context(t, packet); const oversized = harness(packet, audioReceipt, { mockAudio: true });
  const runner = async (binary, args) => {
    const result = await oversized.runner(binary, args);
    if (binary === 'ffmpeg' && basename(args.at(-1)) === 'master.mp4') {
      await truncate(args.at(-1), episodeLimits('short').maxRenderBytes + 1);
    }
    return result;
  };
  await assert.rejects(runSelectedAssemblyWorker({ env: oversizedContext.env, ...oversized, runner }), /\[master-verification\]/);
  assert.equal(oversized.calls.upload, 0, 'An oversized short master cannot leave the worker as a success artifact');
});

for (const outcome of ['getFailure', 'pending', 'wrongHash', 'wrongRequest', 'shortSource']) {
  test(`selected assembly stops after one ${outcome} without resubmission, looping or a success artifact`, async t => {
    const { packet, audioReceipt } = fixture(); const c = await context(t, packet);
    const h = harness(packet, audioReceipt, { mockAudio: true, [outcome]: true });
    await assert.rejects(runSelectedAssemblyWorker({ env: c.env, ...h }), error =>
      /No inference, approval, publication or canonical mutation/.test(error.message) && !/fixture-hf-token|private-provider-error/.test(error.message));
    assert.equal(h.calls.recover.length, 1); assert.equal(h.calls.upload, 0);
    assert.equal(h.calls.commands.filter(call => call.binary === 'ffmpeg').length, 0);
    assert.equal(h.calls.commands.filter(call => call.binary === 'ffprobe').length, outcome === 'shortSource' ? 1 : 0);
    if (outcome === 'getFailure' || outcome === 'pending') assert.equal(h.calls.fetch.length, 1, 'No recovery polling or automatic retries');
  });
}

for (const outcome of ['unownedAudio', 'corruptWavIndex']) {
  test(`the complete parent audio verification rejects ${outcome} before provider recovery or encoding`, async t => {
    const { packet, audioReceipt } = fixture(); const c = await context(t, packet);
    const h = harness(packet, audioReceipt, { [outcome]: outcome === 'corruptWavIndex' ? 96 : true });
    await assert.rejects(runSelectedAssemblyWorker({ env: c.env, ...h }), /\[audio-verification\]/);
    assert.equal(h.calls.recover.length, 0); assert.equal(h.calls.commands.length, 0); assert.equal(h.calls.upload, 0);
    assert.equal(h.calls.download, outcome === 'unownedAudio' ? 0 : 1);
  });
}

// The owner's machine never executes media checks. Only GitHub Actions runs this integration.
for (const { title, indices, profile, format } of [
  { title: 'nine complete originals into a 67.5-second landscape master', indices: SOURCE_INDICES, profile: LANDSCAPE, format: 'long' },
  { title: 'seven native short originals into a 52.5-second portrait master', indices: SHORT_SOURCE_INDICES, profile: PORTRAIT, format: 'short' },
]) {
  test(`CI FFmpeg assembles ${title} with full AAC audio`,
    { skip: process.env.GITHUB_ACTIONS !== 'true', timeout: 480000 }, async t => {
      const { packet } = fixture(indices, profile, format); const c = await context(t, packet);
      const originals = new Map(); const generated = join(c.directory, 'ci-originals'); await mkdir(generated);
      const colors = ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan', 'orange', 'purple', 'lime'];
      for (const [offset, scene] of packet.manifest.scenes.entries()) {
        const source = packet.sources.find(item => item.assetId === scene.visual.assetId);
        const filename = join(generated, `${source.sourceIndex}.mp4`);
        await mediaCommand('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${colors[offset]}:s=72x128:r=30:d=7.5`,
          '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-t', '7.5', '-n', filename]);
        const bytes = await readFile(filename); originals.set(source.remoteRequest.requestId, bytes);
        source.sha256 = hash(bytes); scene.visual.sha256 = source.sha256;
      }
      await writeFile(join(c.directory, 'studio/batches/selected-assembly-launch.json'), JSON.stringify(launch(packet)));
      c.env.AI_MEOW_SELECTED_ASSEMBLY_PACKET = packSelectedAssemblyPacket(packet).encoded;
      let outputDirectory; let uploadedReceipt; let recovered = 0; let uploaded = 0;
      const runner = async (binary, args, options) => {
        assert.ok(!args.some(arg => /stream_loop|aloop=|tpad=/.test(arg)));
        return mediaCommand(binary, args, options);
      };
      const result = await runSelectedAssemblyWorker({ env: c.env, runner,
        fetchImpl: async () => assert.fail('CI integration uses only fixture originals and WAVs'),
        retrieveAudio: async (projection, { directory }) => {
          assert.equal(projection.episodeId, packet.sourceEpisodeId); assert.deepEqual(projection.manifest.scenes, packet.audioBindings);
          await mkdir(join(directory, 'audio'));
          for (const source of packet.sources) await writeFile(join(directory, audioReceiptPath(source.sourceIndex)), mockWav(source.sourceIndex));
        },
        recover: async request => {
          recovered++; return { remoteStatus: 'COMPLETED', requestId: request.requestId, blob: new Blob([originals.get(request.requestId)], { type: 'video/mp4' }) };
        },
        artifact: { uploadArtifact: async (name, files, root) => {
          uploaded++; outputDirectory = root; assert.equal(name, `ai-meow-selected-assembly-${packet.id}`);
          assert.deepEqual(files.map(file => basename(file)).sort(), ['master.mp4', 'render-manifest.json']);
          uploadedReceipt = JSON.parse(await readFile(join(root, 'render-manifest.json')));
          return { id: 31 };
        } },
      });
      assert.equal(result.status, 'completed'); assert.equal(recovered, indices.length); assert.equal(uploaded, 1);
      const master = join(outputDirectory, 'master.mp4');
      const probe = JSON.parse((await mediaCommand('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', master])).stdout);
      const verified = verifiedProbe(probe, packet.manifest.durationSeconds, profile);
      assert.ok(Math.abs(verified.durationSeconds - packet.manifest.durationSeconds) < 0.1);
      assert.ok(Math.abs(Number(probe.streams.find(stream => stream.codec_type === 'audio').duration) - packet.manifest.durationSeconds) < 0.1);
      assert.ok(uploadedReceipt.master.sizeBytes <= episodeLimits(format).maxRenderBytes);
      assert.equal(uploadedReceipt.master.sha256, hash(await readFile(master)));
      assert.deepEqual(uploadedReceipt.sourceScenes.map(scene => scene.sourceIndex), indices);
      assert.equal(uploadedReceipt.approved, false); assert.equal(uploadedReceipt.published, false);
      await mediaCommand('ffmpeg', ['-nostdin', '-v', 'error', '-i', master, '-f', 'null', '-']);
    });
}
