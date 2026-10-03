import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { episodeLimits } from '../src/domain.mjs';
import { audioReceiptPath, hash, packetHash } from '../scripts/assembly-packets.mjs';
import { packSelectedAssemblyPacket } from '../scripts/selected-assembly-packets.mjs';
import { mediaCommand, ownedAudioArtifact, verifiedProbe } from '../scripts/remote-render-worker.mjs';
import { runSelectedAssemblyWorker } from '../scripts/remote-selected-assembly-worker.mjs';

const PROFILE = { width: 1080, height: 1920, framesPerSecond: 30 };
const REPOSITORY = 'Giomaster/ytfun';
const mp4 = label => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from(label)]);
const launch = packet => ({ schemaVersion: packet.schemaVersion, type: 'selected-assembly', batchId: packet.id,
  episodeId: packet.episodeId, packetSha256: packetHash(packet) });

function wav(seed, audibleRange) {
  const bytes = Buffer.alloc(44 + 48000 * 7.5 * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  if (audibleRange) {
    for (let frame = 0; frame < 48000 * 7.5; frame++) {
      const time = frame / 48000;
      const sample = time >= audibleRange[0] && time < audibleRange[1]
        ? Math.round(6000 * Math.sin(2 * Math.PI * (220 + seed * 10) * time)) : 0;
      bytes.writeInt16LE(sample, 44 + frame * 4); bytes.writeInt16LE(sample, 46 + frame * 4);
    }
  } else bytes.writeInt16LE(seed, 44);
  return bytes;
}

function fixture({ durations = [7.5, 7.5], visualStarts = [0.0625, 0.0625], audioStarts = [0, 0], tones = false } = {}) {
  const episodeId = randomUUID(); const archives = new Map();
  const selectedIndices = [2, 1];
  const audioInputs = selectedIndices.map((selectedIndex, offset) => {
    const id = randomUUID(); const sourceEpisodeId = randomUUID(); const artifactId = 21 + offset;
    const batchId = randomUUID(); const runId = 11 + offset; const commitSha = String(offset + 1).repeat(40);
    const files = new Map(Array.from({ length: 2 }, (_, index) => [index + 1,
      wav((offset + 1) * 10 + index + 1, tones && index + 1 === selectedIndex
        ? [audioStarts[offset], audioStarts[offset] + durations[offset]] : undefined)]));
    const audioBindings = Array.from(files, ([index, bytes]) => ({ sceneId: randomUUID(), audio: { sha256: hash(bytes) } }));
    const receipt = { schemaVersion: 1, type: 'original-audio', batchId, episodeId: sourceEpisodeId,
      packetSha256: hash(`audio-packet-${offset}`), repository: REPOSITORY, runId, commitSha,
      spec: { encoding: 'PCM', sampleRate: 48000, channels: 2, bitsPerSample: 16 },
      scenes: audioBindings.map((binding, index) => ({ index: index + 1, sceneId: binding.sceneId,
        path: audioReceiptPath(index + 1), durationSeconds: 7.5, sha256: binding.audio.sha256,
        sizeBytes: files.get(index + 1).length, synthesis: { algorithm: 'fixture-no-inference' } })) };
    const audioArtifact = { artifactId, runId, repository: REPOSITORY, commitSha, batchId,
      packetSha256: receipt.packetSha256, manifestSha256: packetHash(receipt) };
    archives.set(artifactId, { files, receipt, audioArtifact });
    return { id, sourceEpisodeId, audioArtifact, audioBindings };
  });
  const originals = new Map();
  const scenes = durations.map((durationSeconds, index) => {
    const bytes = mp4(`original-${index}`); const input = audioInputs[index];
    const binding = input.audioBindings[selectedIndices[index] - 1];
    const scene = { sceneId: randomUUID(), durationSeconds, scriptSha256: hash(`script-${index}`),
      visual: { assetId: randomUUID(), path: `assets/selected-${index}.mp4`, kind: 'video', sha256: hash(bytes), provenanceSha256: hash(`visual-rights-${index}`) },
      audio: { assetId: randomUUID(), path: `assets/selected-${index}.wav`, kind: 'audio', sha256: binding.audio.sha256, provenanceSha256: hash(`audio-rights-${index}`) } };
    originals.set(`request-${index}`, bytes);
    return scene;
  });
  const sources = scenes.map((scene, index) => ({ assetId: scene.visual.assetId, sourceAssetId: randomUUID(),
    sourceEpisodeId: randomUUID(), sourceSceneId: randomUUID(), sha256: scene.visual.sha256,
    sourceIndex: selectedIndices[index], audioInputId: audioInputs[index].id,
    audioSourceSceneId: audioInputs[index].audioBindings[selectedIndices[index] - 1].sceneId,
    sourceRangeSeconds: [visualStarts[index], visualStarts[index] + durations[index]],
    audioRangeSeconds: [audioStarts[index], audioStarts[index] + durations[index]],
    remoteRequest: { provider: 'fal-ai', transport: 'huggingface-router', requestId: `request-${index}`,
      responsePath: `/fal-ai/wan/requests/request-${index}/response` } })).reverse();
  const packet = { schemaVersion: 2, type: 'selected-assembly', id: randomUUID(), episodeId,
    manifest: { schemaVersion: 1, episodeId, format: 'short', audioMode: 'nonverbal',
      durationSeconds: durations.reduce((sum, seconds) => sum + seconds, 0), maxRenderBytes: episodeLimits('short').maxRenderBytes,
      ...PROFILE, editorialSha256: hash('editorial'), snapshotSha256: hash('snapshot'), scenes },
    sources, audioInputs: audioInputs.reverse() };
  return { packet, archives, originals };
}

async function context(t, packet) {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-shared-assembly-ci-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'studio/batches'), { recursive: true });
  await writeFile(join(directory, 'studio/batches/selected-assembly-launch.json'), JSON.stringify(launch(packet)));
  const temporary = join(directory, 'runner'); await mkdir(temporary);
  return { directory, env: { GITHUB_ACTIONS: 'true', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_RUN_ID: '123', GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKSPACE: directory, RUNNER_TEMP: temporary,
    GITHUB_TOKEN: 'fixture-actions-token', HF_TOKEN: 'fixture-hf-token', AI_MEOW_SELECTED_ASSEMBLY_PACKET: packSelectedAssemblyPacket(packet).encoded } };
}

function finalProbe(seconds) {
  return { format: { duration: String(seconds) }, streams: [
    { codec_type: 'video', codec_name: 'h264', ...PROFILE, avg_frame_rate: '30/1', duration: String(seconds), sample_aspect_ratio: '1:1' },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', duration: String(seconds) },
  ] };
}

function harness({ packet, archives, originals }, options = {}) {
  const calls = { fetch: [], audio: [], download: [], recover: [], commands: [], upload: [] };
  let uploadedReceipt;
  const fetchImpl = async (url, request) => {
    assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer fixture-actions-token'); calls.fetch.push(String(url));
    const artifactMatch = String(url).match(/\/actions\/artifacts\/(\d+)$/);
    const runMatch = String(url).match(/\/actions\/runs\/(\d+)$/);
    assert.ok(artifactMatch || runMatch, 'Only original artifact/run ownership GETs are expected');
    const archive = artifactMatch ? archives.get(Number(artifactMatch[1]))
      : [...archives.values()].find(item => item.audioArtifact.runId === Number(runMatch[1]));
    const input = archive.audioArtifact;
    return Response.json(artifactMatch ? { id: input.artifactId, name: `ai-meow-audio-${input.batchId}`,
      expired: false, size_in_bytes: 10000000, digest: `sha256:${hash(`archive-${input.artifactId}`)}`,
      workflow_run: { id: input.runId, head_sha: input.commitSha } }
      : { id: input.runId, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
        head_sha: input.commitSha, head_branch: 'codex/ai-original-studio', path: '.github/workflows/ai-meow-audio.yml',
        event: 'push', status: 'completed', conclusion: 'success' });
  };
  const artifact = {
    downloadArtifact: async (id, download) => {
      calls.download.push({ id, ...download }); const archive = archives.get(id);
      assert.equal(download.findBy.workflowRunId, archive.audioArtifact.runId);
      assert.equal(download.expectedHash, `sha256:${hash(`archive-${id}`)}`);
      await mkdir(join(download.path, 'audio'));
      await writeFile(join(download.path, 'audio-manifest.json'), JSON.stringify(archive.receipt));
      for (const [index, original] of archive.files) {
        const bytes = Buffer.from(original);
        if (options.corruptUnselectedAudio && id === packet.audioInputs[0].audioArtifact.artifactId && index === 2) bytes[44] ^= 1;
        await writeFile(join(download.path, audioReceiptPath(index)), bytes);
      }
      return { downloadPath: download.path, digestMismatch: false };
    },
    uploadArtifact: async (name, files, directory, upload) => {
      calls.upload.push({ name, files, directory, upload });
      assert.equal(name, `ai-meow-selected-assembly-${packet.id}`);
      assert.deepEqual(files.map(file => basename(file)).sort(), ['master.mp4', 'render-manifest.json']);
      assert.ok(files.every(file => dirname(file) === directory));
      assert.deepEqual(upload, { retentionDays: 7, compressionLevel: 0 });
      uploadedReceipt = JSON.parse(await readFile(join(directory, 'render-manifest.json')));
      return { id: 31 };
    },
  };
  const retrieveAudio = async (projection, workerOptions) => {
    calls.audio.push({ projection, directory: workerOptions.directory });
    return ownedAudioArtifact(projection, workerOptions);
  };
  const recover = async (request, workerOptions) => {
    calls.recover.push(request.requestId); assert.equal(workerOptions.hfToken, 'fixture-hf-token');
    if (options.getFailure) throw new Error('fixture-hf-token private-provider-error');
    return { remoteStatus: options.pending ? 'IN_PROGRESS' : 'COMPLETED',
      requestId: options.wrongRequest ? 'request-unknown' : request.requestId,
      blob: new Blob([options.wrongHash ? mp4('changed') : originals.get(request.requestId)]) };
  };
  const runner = async (binary, args) => {
    calls.commands.push({ binary, args }); const filename = args.at(-1);
    if (binary === 'ffmpeg') {
      assert.ok(!args.some(arg => /stream_loop|aloop=|tpad=|apad=|subtitles=|drawtext=/.test(arg)));
      assert.equal(args[args.indexOf('-map_metadata') + 1], '-1');
      await writeFile(filename, mp4(basename(filename))); return { stdout: '' };
    }
    assert.equal(binary, 'ffprobe');
    if (filename.includes('/sources/')) return { stdout: JSON.stringify({ format: { duration: '7.5625' },
      streams: [{ codec_type: 'video', duration: options.shortVisual ? '7.55' : '7.5625' }] }) };
    if (filename.endsWith('.wav')) return { stdout: JSON.stringify({ format: { duration: '7.5' },
      streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', channels: 2, sample_rate: '48000', duration: options.shortAudio ? '7.49' : '7.5' }] }) };
    const seconds = basename(filename) === 'master.mp4' ? packet.manifest.durationSeconds
      : packet.manifest.scenes[Number(basename(filename, '.mp4')) - 1].durationSeconds;
    return { stdout: JSON.stringify(finalProbe(seconds)) };
  };
  return { artifact, fetchImpl, retrieveAudio, recover, runner, calls, get receipt() { return uploadedReceipt; } };
}

function assertSelections(h, packet) {
  assert.equal(h.calls.audio.length, packet.audioInputs.length);
  assert.equal(new Set(h.calls.audio.map(call => call.directory)).size, packet.audioInputs.length);
  for (const [index, call] of h.calls.audio.entries()) {
    const input = packet.audioInputs[index];
    assert.deepEqual(call.projection, { episodeId: input.sourceEpisodeId, audioArtifact: input.audioArtifact,
      manifest: { scenes: input.audioBindings } }, 'Verify the full original archive, including unselected bindings');
  }
  const encodings = h.calls.commands.filter(call => call.binary === 'ffmpeg');
  assert.equal(encodings.length, packet.manifest.scenes.length + 1);
  for (const [index, scene] of packet.manifest.scenes.entries()) {
    const source = packet.sources.find(item => item.assetId === scene.visual.assetId); const args = encodings[index].args;
    const inputs = args.flatMap((arg, offset) => arg === '-i' ? [args[offset + 1]] : []);
    const inputCall = h.calls.audio.find(call => call.projection.audioArtifact.artifactId
      === packet.audioInputs.find(input => input.id === source.audioInputId).audioArtifact.artifactId);
    assert.equal(inputs[1], join(inputCall.directory, audioReceiptPath(source.sourceIndex)));
    assert.equal(args[args.indexOf('-filter_complex') + 1],
      `[0:v:0]trim=start=${source.sourceRangeSeconds[0]}:end=${source.sourceRangeSeconds[1]},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1[v];[1:a:0]atrim=start=${source.audioRangeSeconds[0]}:end=${source.audioRangeSeconds[1]},asetpts=PTS-STARTPTS[a]`);
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '[v]', '-map', '[a]']);
    assert.equal(args[args.indexOf('-t') + 1], String(scene.durationSeconds));
  }
  const master = encodings.at(-1).args;
  assert.equal(master.filter(arg => arg === '-i').length, 1, 'Final mux must use selected segments, never original audio lists');
  assert.deepEqual(master.slice(master.indexOf('-map'), master.indexOf('-map') + 4), ['-map', '0:v:0', '-map', '0:a:0']);
  assert.equal(master[master.indexOf('-c:v') + 1], 'copy'); assert.equal(master[master.indexOf('-c:a') + 1], 'copy');
}

test('shared v2 assembles two full 7.5-second selections from independent owned audio archives without duplicate GETs', async t => {
  const f = fixture(); const c = await context(t, f.packet); const h = harness(f);
  const result = await runSelectedAssemblyWorker({ env: c.env, ...h }); assert.equal(result.status, 'completed');
  assert.equal(result.scenes, 2); assert.equal(result.artifactId, 31); assertSelections(h, f.packet);
  assert.deepEqual(h.calls.recover, ['request-0', 'request-1']);
  assert.equal(h.calls.fetch.length, 4); assert.equal(h.calls.download.length, 2); assert.equal(h.calls.upload.length, 1);
  const masterArgs = h.calls.commands.filter(call => call.binary === 'ffmpeg').at(-1).args;
  assert.equal(await readFile(masterArgs[masterArgs.indexOf('-i') + 1], 'utf8'),
    "file 'segments/001.mp4'\nduration 7.5\nfile 'segments/002.mp4'\nduration 7.5\n");
  assert.equal(h.receipt.master.durationSeconds, 15); assert.equal(result.manifestSha256, packetHash(h.receipt));
  assert.equal(h.receipt.master.sha256, result.masterSha256);
  const before = { audio: h.calls.audio.length, get: h.calls.recover.length, download: h.calls.download.length, commands: h.calls.commands.length, upload: h.calls.upload.length };
  await assert.rejects(runSelectedAssemblyWorker({ env: c.env, ...h }), /\[packet\]/);
  assert.deepEqual({ audio: h.calls.audio.length, get: h.calls.recover.length, download: h.calls.download.length, commands: h.calls.commands.length, upload: h.calls.upload.length }, before);
  for (const downloaded of h.calls.download) {
    const archive = f.archives.get(downloaded.id);
    assert.deepEqual(JSON.parse(await readFile(join(downloaded.path, 'audio-manifest.json'))), archive.receipt);
    for (const [index, bytes] of archive.files) assert.equal(hash(await readFile(join(downloaded.path, audioReceiptPath(index)))), hash(bytes));
  }
});

test('shared v2 receipt preserves original visual and audio identities separately from target bindings', async t => {
  const f = fixture(); const c = await context(t, f.packet); const h = harness(f);
  await runSelectedAssemblyWorker({ env: c.env, ...h }); const receipt = h.receipt;
  assert.equal(receipt.schemaVersion, 2); assert.equal(receipt.type, 'selected-original-assembly');
  assert.equal(receipt.episodeId, f.packet.episodeId); assert.equal(receipt.packetSha256, packetHash(f.packet));
  assert.equal(receipt.sourceManifestSha256, packetHash(f.packet.manifest)); assert.equal(receipt.sourceSnapshotSha256, f.packet.manifest.snapshotSha256);
  assert.deepEqual({ repository: receipt.repository, runId: receipt.runId, commitSha: receipt.commitSha },
    { repository: REPOSITORY, runId: 123, commitSha: 'a'.repeat(40) });
  assert.equal(receipt.approved, false); assert.equal(receipt.published, false); assert.equal(receipt.inferenceSubmitted, false);
  assert.equal(receipt.sourceEpisodeId, undefined, 'Multiple visual origins cannot be relabelled as one original episode');
  assert.deepEqual(receipt.audioInputs, f.packet.audioInputs.map(input => ({ ...input,
    audioReceiptSha256: f.archives.get(input.audioArtifact.artifactId).audioArtifact.manifestSha256 })));
  for (const [index, actual] of receipt.sourceScenes.entries()) {
    const scene = f.packet.manifest.scenes[index]; const source = f.packet.sources.find(item => item.assetId === scene.visual.assetId);
    const input = f.packet.audioInputs.find(item => item.id === source.audioInputId);
    assert.equal(actual.sceneId, scene.sceneId); assert.equal(actual.visualAssetId, scene.visual.assetId);
    assert.equal(actual.audioAssetId, scene.audio.assetId); assert.equal(actual.visualSha256, source.sha256); assert.equal(actual.audioSha256, scene.audio.sha256);
    for (const field of ['sourceAssetId', 'sourceEpisodeId', 'sourceSceneId', 'sourceIndex', 'audioInputId', 'audioSourceSceneId', 'sourceRangeSeconds', 'audioRangeSeconds']) assert.deepEqual(actual[field], source[field]);
    assert.notEqual(actual.sourceSceneId, actual.audioSourceSceneId); assert.notEqual(actual.sourceEpisodeId, actual.audioSourceEpisodeId);
    assert.equal(actual.audioSourceEpisodeId, input.sourceEpisodeId); assert.deepEqual(actual.audioArtifact, input.audioArtifact);
    assert.equal(actual.audioReceiptSha256, input.audioArtifact.manifestSha256); assert.equal(actual.originalAudioSha256, scene.audio.sha256);
    assert.equal(actual.originalAudioPath, audioReceiptPath(source.sourceIndex));
    assert.deepEqual(actual.outputRangeSeconds, [index * 7.5, (index + 1) * 7.5]);
    assert.equal(actual.measuredOriginalDurationSeconds, 7.5625); assert.equal(actual.measuredOriginalAudioDurationSeconds, 7.5);
    assert.equal(Number(actual.sourceProbe.streams[0].duration), 7.5625); assert.equal(Number(actual.audioProbe.streams[0].duration), 7.5);
    assert.deepEqual(actual.segment.probe, finalProbe(7.5));
  }
  assert.deepEqual(receipt.masterProbe, finalProbe(15));
  assert.ok(!/fixture-hf-token|fixture-actions-token|responsePath|request-\d|private-provider/.test(JSON.stringify(receipt)));
});

test('shared v2 trims variable visual and audio offsets and records cumulative target ranges', async t => {
  const f = fixture({ durations: [2, 3.25], visualStarts: [0.5, 0.0625], audioStarts: [0.75, 2] });
  const c = await context(t, f.packet); const h = harness(f);
  await runSelectedAssemblyWorker({ env: c.env, ...h }); assertSelections(h, f.packet);
  assert.equal(h.receipt.master.durationSeconds, 5.25);
  assert.deepEqual(h.receipt.sourceScenes.map(scene => scene.outputRangeSeconds), [[0, 2], [2, 5.25]]);
  assert.deepEqual(h.receipt.sourceScenes.map(scene => scene.audioRangeSeconds), [[0.75, 2.75], [2, 5.25]]);
});

for (const [option, stage] of [['shortVisual', 'original-probe'], ['shortAudio', 'audio-probe'],
  ['getFailure', 'original-get'], ['pending', 'original-get'], ['wrongHash', 'original-get'], ['wrongRequest', 'original-get']]) {
  test(`shared v2 rejects ${option} using actual stream duration and sanitizes the failure`, async t => {
    const f = fixture(); const c = await context(t, f.packet); const h = harness(f, { [option]: true });
    await assert.rejects(runSelectedAssemblyWorker({ env: c.env, ...h }), error =>
      error.message.includes(`[${stage}]`) && /No inference, approval, publication or canonical mutation/.test(error.message)
      && !/fixture-hf-token|private-provider-error/.test(error.message));
    assert.equal(h.calls.recover.length, 1); assert.equal(h.calls.commands.filter(call => call.binary === 'ffmpeg').length, 0);
    assert.equal(h.calls.upload.length, 0, 'A failed original cannot produce a success artifact');
  });
}

test('shared v2 rejects corruption in an unselected original WAV before any video recovery or media command', async t => {
  const f = fixture(); const c = await context(t, f.packet); const h = harness(f, { corruptUnselectedAudio: true });
  await assert.rejects(runSelectedAssemblyWorker({ env: c.env, ...h }), /\[audio-verification\]/);
  assert.equal(h.calls.audio.length, 1); assert.equal(h.calls.download.length, 1);
  assert.equal(h.calls.recover.length, 0); assert.equal(h.calls.commands.length, 0); assert.equal(h.calls.upload.length, 0);
});

// The owner's laptop never runs these tests or media commands. GitHub Actions is the authority.
test('CI FFmpeg preserves selected audio offsets through segment concatenation',
  { skip: process.env.GITHUB_ACTIONS !== 'true', timeout: 480000 }, async t => {
    const f = fixture({ durations: [2, 3.25], visualStarts: [0.5, 0.0625], audioStarts: [0.75, 2], tones: true });
    const c = await context(t, f.packet); const h = harness(f); const generated = join(c.directory, 'fixture-sources');
    await mkdir(generated);
    for (const [index, scene] of f.packet.manifest.scenes.entries()) {
      const source = f.packet.sources.find(item => item.assetId === scene.visual.assetId); const filename = join(generated, `${index}.mp4`);
      await mediaCommand('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${index ? 'blue' : 'red'}:s=72x128:r=16:d=7.5625`,
        '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-t', '7.5625', '-n', filename]);
      const bytes = await readFile(filename); f.originals.set(source.remoteRequest.requestId, bytes);
      source.sha256 = hash(bytes); scene.visual.sha256 = source.sha256;
    }
    await writeFile(join(c.directory, 'studio/batches/selected-assembly-launch.json'), JSON.stringify(launch(f.packet)));
    c.env.AI_MEOW_SELECTED_ASSEMBLY_PACKET = packSelectedAssemblyPacket(f.packet).encoded;
    const result = await runSelectedAssemblyWorker({ env: c.env, ...h, runner: mediaCommand });
    assert.equal(result.status, 'completed'); assert.equal(h.calls.recover.length, 2);
    assert.equal(verifiedProbe(h.receipt.masterProbe, 5.25, PROFILE).hasAudio, true);
    const pcm = join(c.directory, 'selected-audio.pcm'); const master = join(h.calls.upload[0].directory, 'master.mp4');
    await mediaCommand('ffmpeg', ['-nostdin', '-v', 'error', '-i', master, '-map', '0:a:0', '-f', 's16le', '-ar', '48000', '-ac', '2', '-n', pcm]);
    const bytes = await readFile(pcm);
    const rms = start => {
      let sum = 0; const count = Math.floor(0.15 * 48000); const first = Math.floor(start * 48000);
      for (let frame = first; frame < first + count; frame++) sum += (bytes.readInt16LE(frame * 4) / 32768) ** 2;
      return Math.sqrt(sum / count);
    };
    assert.ok(rms(0.15) > 0.08, 'The first selected offset begins inside its tone, not at the original silent start');
    assert.ok(rms(2.15) > 0.08, 'The second selected offset retains its trimmed audio after concatenation');
    assert.deepEqual(h.receipt.sourceScenes.map(scene => scene.audioRangeSeconds), [[0.75, 2.75], [2, 5.25]]);
  });
