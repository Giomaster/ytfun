import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { episodeLimits } from '../src/domain.mjs';
import { canonicalJson, hash, packetHash } from '../scripts/assembly-packets.mjs';
import { packSelectedAssemblyPacket, unpackSelectedAssemblyPacket, validateSelectedAssemblyPacket } from '../scripts/selected-assembly-packets.mjs';

const PORTRAIT = { width: 1080, height: 1920, framesPerSecond: 30 };
const LANDSCAPE = { width: 1920, height: 1080, framesPerSecond: 30 };
const launch = packet => ({ schemaVersion: packet.schemaVersion, type: 'selected-assembly', batchId: packet.id,
  episodeId: packet.episodeId, packetSha256: packetHash(packet) });
const unsafeEnvelope = packet => gzipSync(canonicalJson(packet)).toString('base64');

function fixture({ durations = [7.5, 7.5], format = 'short', profile = PORTRAIT, originalAudioCount = 96 } = {}) {
  const episodeId = randomUUID();
  const audioInputs = Array.from({ length: 2 }, (_, inputOffset) => ({ id: randomUUID(), sourceEpisodeId: randomUUID(),
    audioArtifact: { artifactId: 21 + inputOffset, runId: 11 + inputOffset, repository: 'Giomaster/ytfun',
      commitSha: 'b'.repeat(40), batchId: randomUUID(), packetSha256: hash(`audio-packet-${inputOffset}`),
      manifestSha256: hash(`audio-receipt-${inputOffset}`) },
    audioBindings: Array.from({ length: originalAudioCount }, (_, offset) => ({ sceneId: randomUUID(),
      audio: { sha256: hash(`original-wav-${inputOffset}-${offset + 1}`) } })) }));
  const visualEpisodes = [randomUUID(), randomUUID()];
  const sources = [];
  const scenes = durations.map((durationSeconds, offset) => {
    const input = audioInputs[offset % 2]; const sourceIndex = Math.floor(offset / 2) + 1;
    const originalAudio = input.audioBindings[sourceIndex - 1];
    const scene = { sceneId: randomUUID(), durationSeconds, scriptSha256: hash(`target-script-${offset}`),
      visual: { assetId: randomUUID(), path: `assets/selected-${offset + 1}.mp4`, kind: 'video',
        sha256: hash(`original-video-${offset}`), provenanceSha256: hash(`original-video-rights-${offset}`) },
      audio: { assetId: randomUUID(), path: `assets/selected-${offset + 1}.wav`, kind: 'audio',
        sha256: originalAudio.audio.sha256, provenanceSha256: hash(`original-audio-rights-${offset}`) } };
    sources.push({ assetId: scene.visual.assetId, sha256: scene.visual.sha256, sourceAssetId: randomUUID(),
      sourceEpisodeId: visualEpisodes[offset % 2], sourceSceneId: randomUUID(), audioSourceSceneId: originalAudio.sceneId,
      sourceIndex, audioInputId: input.id, sourceRangeSeconds: [0.0625, durationSeconds + 0.0625],
      audioRangeSeconds: [0, durationSeconds], remoteRequest: { provider: 'fal-ai', transport: 'huggingface-router',
        requestId: `shared-request-${offset + 1}`, responsePath: `/fal-ai/wan/requests/shared-request-${offset + 1}/response` } });
    return scene;
  });
  return { schemaVersion: 2, type: 'selected-assembly', id: randomUUID(), episodeId,
    manifest: { schemaVersion: 1, episodeId, format, audioMode: 'nonverbal', ...profile,
      durationSeconds: durations.reduce((sum, duration) => sum + duration, 0), maxRenderBytes: episodeLimits(format).maxRenderBytes,
      editorialSha256: hash('shared-editorial'), snapshotSha256: hash('shared-snapshot'), scenes },
    audioInputs, sources: sources.reverse() };
}

function sourceFor(packet, offset = 0) {
  return packet.sources.find(source => source.assetId === packet.manifest.scenes[offset].visual.assetId);
}

function legacyFixture() {
  const packet = fixture({ durations: [7.5], originalAudioCount: 1 });
  const source = sourceFor(packet); const input = packet.audioInputs[0];
  return { schemaVersion: 1, type: packet.type, id: packet.id, episodeId: packet.episodeId,
    sourceEpisodeId: input.sourceEpisodeId, manifest: packet.manifest,
    sources: [{ assetId: source.assetId, sha256: source.sha256, sourceSceneId: input.audioBindings[0].sceneId,
      sourceIndex: 1, remoteRequest: source.remoteRequest }], audioBindings: input.audioBindings, audioArtifact: input.audioArtifact };
}

test('four distinct shared fragments bind two native plans to exact 15-second audiovisual selections', () => {
  const fragments = Array.from({ length: 4 }, () => fixture());
  assert.equal(new Set(fragments.map(packet => packet.episodeId)).size, 4);
  assert.equal(new Set(fragments.map(packetHash)).size, 4);
  for (const packet of fragments) {
    const packed = packSelectedAssemblyPacket(packet);
    assert.deepEqual(validateSelectedAssemblyPacket(packet), packet);
    assert.deepEqual(unpackSelectedAssemblyPacket(packed.encoded, launch(packet)), packet);
    assert.equal(packed.packetSha256, packetHash(packet));
    assert.equal(packet.manifest.schemaVersion, 1, 'Keep the exact manifest exported by Production');
    assert.equal(packet.manifest.durationSeconds, 15);
    assert.equal(packet.audioInputs.length, 2);
    assert.ok(packet.audioInputs.every(input => input.audioBindings.length === 96), 'Original artifact bindings are not reduced to the selected subset');
    assert.deepEqual(packet.manifest.scenes.map(scene => scene.durationSeconds), [7.5, 7.5]);
    assert.ok(packet.sources.every(source => source.sourceIndex === 1), 'Original indices are scoped to each audio input');
    for (const source of packet.sources) {
      const input = packet.audioInputs.find(item => item.id === source.audioInputId);
      assert.notEqual(source.sourceEpisodeId, input.sourceEpisodeId, 'Visual and audio original episodes remain independent');
      assert.notEqual(source.sourceSceneId, source.audioSourceSceneId);
      assert.deepEqual(source.sourceRangeSeconds, [0.0625, 7.5625]);
      assert.deepEqual(source.audioRangeSeconds, [0, 7.5]);
    }
  }
});

test('shared packets retain destination order, complete original audio inputs, variable scene durations and either exact canvas', () => {
  for (const profile of [PORTRAIT, LANDSCAPE]) {
    const packet = fixture({ durations: [2.25, 3.125, 1.5], profile });
    const source = sourceFor(packet, 2); const input = packet.audioInputs.find(item => item.id === source.audioInputId);
    source.sourceIndex = 96; source.audioSourceSceneId = input.audioBindings[95].sceneId;
    packet.manifest.scenes[2].audio.sha256 = input.audioBindings[95].audio.sha256;
    const packed = packSelectedAssemblyPacket(packet);
    assert.deepEqual(unpackSelectedAssemblyPacket(packed.encoded, launch(packet)), packet);
    assert.equal(packet.manifest.durationSeconds, 6.875);
    const reordered = structuredClone(packet); reordered.manifest.scenes.reverse();
    assert.deepEqual(validateSelectedAssemblyPacket(reordered), reordered);
    assert.throws(() => unpackSelectedAssemblyPacket(packSelectedAssemblyPacket(reordered).encoded, launch(packet)), /differs/);
  }
  const long = fixture({ durations: Array.from({ length: 120 }, () => 7.5), format: 'long' });
  for (const source of long.sources) source.sourceRangeSeconds = [0, 7.5];
  assert.equal(validateSelectedAssemblyPacket(long).manifest.durationSeconds, 900);
  assert.equal(long.audioInputs[0].audioBindings.length, 96);
  const short = fixture({ durations: Array.from({ length: 12 }, () => 15) });
  assert.equal(validateSelectedAssemblyPacket(short).manifest.durationSeconds, 180,
    'The packet contract uses destination limits; the worker must verify real source and WAV durations');
});

test('shared direct finishing can retain the exact visual episode, scene and asset identities without relabeling its audio origin', () => {
  const packet = fixture();
  for (const scene of packet.manifest.scenes) {
    const source = packet.sources.find(item => item.assetId === scene.visual.assetId);
    source.sourceEpisodeId = packet.episodeId; source.sourceSceneId = scene.sceneId; source.sourceAssetId = scene.visual.assetId;
  }
  assert.deepEqual(validateSelectedAssemblyPacket(packet), packet);
  assert.deepEqual(unpackSelectedAssemblyPacket(packSelectedAssemblyPacket(packet).encoded, launch(packet)), packet);
  assert.ok(packet.audioInputs.every(input => input.sourceEpisodeId !== packet.episodeId));
});

test('shared packets reject duplicate originals, duplicate targets, unsafe retrieval and mismatched audio input lineage', () => {
  const mutations = [
    ['duplicate original video hash', p => { p.sources[1].sha256 = p.sources[0].sha256; }],
    ['duplicate original visual asset', p => { p.sources[1].sourceAssetId = p.sources[0].sourceAssetId; }],
    ['duplicate original visual scene', p => { p.sources[1].sourceSceneId = p.sources[0].sourceSceneId; }],
    ['duplicate original request', p => { p.sources[1].remoteRequest = p.sources[0].remoteRequest; }],
    ['duplicate target visual mapping', p => { p.sources[1].assetId = p.sources[0].assetId; }],
    ['duplicate target scene', p => { p.manifest.scenes[1].sceneId = p.manifest.scenes[0].sceneId; }],
    ['duplicate target visual asset', p => { p.manifest.scenes[1].visual.assetId = p.manifest.scenes[0].visual.assetId; }],
    ['duplicate target audio asset', p => { p.manifest.scenes[1].audio.assetId = p.manifest.scenes[0].audio.assetId; }],
    ['duplicate audio input identity', p => { p.audioInputs[1].id = p.audioInputs[0].id; }],
    ['missing audio input', p => { p.audioInputs.pop(); }],
    ['unknown audio input', p => { p.sources[0].audioInputId = randomUUID(); }],
    ['wrong selected original audio scene', p => { p.sources[0].audioSourceSceneId = randomUUID(); }],
    ['false visual scene used as audio scene', p => { p.sources[0].audioSourceSceneId = p.sources[0].sourceSceneId; }],
    ['wrong audio input', p => { p.sources[0].audioInputId = p.audioInputs[0].id; }],
    ['wrong audio hash', p => { p.manifest.scenes[0].audio.sha256 = hash('unowned-audio'); }],
    ['wrong original audio index', p => { p.sources[0].sourceIndex = 96; }],
    ['missing original binding', p => { p.audioInputs[1].audioBindings.length = 0; }],
    ['duplicate unused original binding', p => { p.audioInputs[0].audioBindings[95].sceneId = p.audioInputs[0].audioBindings[0].sceneId; }],
    ['wrong visual hash', p => { p.sources[0].sha256 = hash('unowned-video'); }],
    ['unmapped visual target', p => { p.sources[0].assetId = randomUUID(); }],
    ['missing source', p => { p.sources.pop(); }],
    ['extra source', p => { p.sources.push(structuredClone(p.sources[0])); }],
    ['index below artifact bounds', p => { p.sources[0].sourceIndex = 0; }],
    ['index above artifact bounds', p => { p.sources[0].sourceIndex = 97; }],
    ['unbound GET path', p => { p.sources[0].remoteRequest.requestId = 'other-request'; }],
    ['credential in GET path', p => { p.sources[0].remoteRequest.responsePath += '?token=private'; }],
    ['GET path traversal', p => { p.sources[0].remoteRequest.responsePath = '/fal-ai/../../requests/shared-request-2/response'; }],
    ['false artifact metadata', p => { p.audioInputs[0].audioArtifact.sourceEpisodeId = p.episodeId; }],
    ['credentials in packet', p => { p.credentials = 'private'; }],
    ['legacy top-level audio alias', p => { p.audioArtifact = p.audioInputs[0].audioArtifact; }],
    ['legacy top-level source episode', p => { p.sourceEpisodeId = p.episodeId; }],
  ];
  for (const [name, mutate] of mutations) {
    const changed = fixture(); mutate(changed);
    assert.throws(() => validateSelectedAssemblyPacket(changed), undefined, name);
    assert.throws(() => packSelectedAssemblyPacket(changed), undefined, name);
    assert.throws(() => unpackSelectedAssemblyPacket(unsafeEnvelope(changed), launch(changed)), /differs/, name);
  }
  const duplicateIndex = fixture(); const first = sourceFor(duplicateIndex); const second = sourceFor(duplicateIndex, 1);
  second.audioInputId = first.audioInputId; second.sourceIndex = first.sourceIndex; second.audioSourceSceneId = first.audioSourceSceneId;
  duplicateIndex.manifest.scenes[1].audio.sha256 = duplicateIndex.manifest.scenes[0].audio.sha256;
  assert.throws(() => validateSelectedAssemblyPacket(duplicateIndex), /distinct/, 'The same index cannot be selected twice from one audio input');
});

test('shared packet ranges, totals and manifest fields are finite, bounded and exact without padded time', () => {
  const mutations = [
    ['missing visual range', p => { delete p.sources[0].sourceRangeSeconds; }],
    ['missing audio range', p => { delete p.sources[0].audioRangeSeconds; }],
    ['negative range', p => { p.sources[0].sourceRangeSeconds = [-0.0625, 7.4375]; }],
    ['empty range', p => { p.sources[0].sourceRangeSeconds = [7.5, 7.5]; }],
    ['reversed range', p => { p.sources[0].audioRangeSeconds = [7.5, 0]; }],
    ['visual duration mismatch', p => { p.sources[0].sourceRangeSeconds = [0, 7.5625]; }],
    ['audio duration mismatch', p => { p.sources[0].audioRangeSeconds = [0, 7]; }],
    ['extra range coordinate', p => { p.sources[0].sourceRangeSeconds.push(8); }],
    ['range exceeds bounds', p => { p.sources[0].sourceRangeSeconds = [900, 907.5]; }],
    ['range NaN', p => { p.sources[0].audioRangeSeconds[1] = Number.NaN; }],
    ['range infinity', p => { p.sources[0].sourceRangeSeconds[1] = Number.POSITIVE_INFINITY; }],
    ['string range', p => { p.sources[0].audioRangeSeconds[1] = '7.5'; }],
    ['zero scene duration', p => { p.manifest.scenes[0].durationSeconds = 0; }],
    ['negative scene duration', p => { p.manifest.scenes[0].durationSeconds = -7.5; }],
    ['scene below domain bound', p => { p.manifest.scenes[0].durationSeconds = 0.5; }],
    ['infinite scene duration', p => { p.manifest.scenes[0].durationSeconds = Number.POSITIVE_INFINITY; }],
    ['scene above domain bound', p => { p.manifest.scenes[0].durationSeconds = 60.001; }],
    ['total mismatch', p => { p.manifest.durationSeconds = 15.001; }],
    ['total above format bound', p => { p.manifest.durationSeconds = 181; }],
    ['empty selection', p => { p.manifest.scenes = []; p.sources = []; p.manifest.durationSeconds = 0; }],
    ['episode differs from snapshot', p => { p.manifest.episodeId = randomUUID(); }],
    ['changed snapshot schema', p => { p.manifest.schemaVersion = 2; }],
    ['wrong format byte cap', p => { p.manifest.maxRenderBytes = episodeLimits('long').maxRenderBytes; }],
    ['wrong canvas', p => { p.manifest.width = p.manifest.height; }],
    ['unsupported resolution', p => { p.manifest.width = 1280; p.manifest.height = 720; }],
    ['unsupported fps', p => { p.manifest.framesPerSecond = 24; }],
    ['wrong audio mode', p => { p.manifest.audioMode = 'narrated'; }],
    ['unsafe descriptor path', p => { p.manifest.scenes[0].visual.path = '../outside.mp4'; }],
  ];
  for (const [name, mutate] of mutations) {
    const changed = fixture(); mutate(changed);
    assert.throws(() => validateSelectedAssemblyPacket(changed), undefined, name);
  }
  for (const duration of [0.999, 60.001]) {
    assert.throws(() => validateSelectedAssemblyPacket(fixture({ durations: [duration] })), undefined,
      'Even exact ranges and totals must respect the 1-to-60-second scene contract exported by Production');
  }
  for (const duration of [1, 60]) assert.equal(validateSelectedAssemblyPacket(fixture({ durations: [duration] })).manifest.durationSeconds, duration);
  const tooManyShortScenes = fixture({ durations: Array.from({ length: 13 }, () => 7.5) });
  assert.throws(() => packSelectedAssemblyPacket(tooManyShortScenes));
  const tooManyLongScenes = fixture({ durations: Array.from({ length: 121 }, () => 1), format: 'long' });
  assert.throws(() => packSelectedAssemblyPacket(tooManyLongScenes));
});

test('selected envelopes isolate v1 and v2 identities and preserve the legacy packet and fingerprint', () => {
  for (const packet of [legacyFixture(), fixture()]) {
    const canonicalBefore = canonicalJson(packet); const expectedHash = packetHash(packet);
    const packed = packSelectedAssemblyPacket(packet);
    assert.equal(canonicalJson(validateSelectedAssemblyPacket(packet)), canonicalBefore);
    assert.equal(packed.packetSha256, expectedHash);
    assert.deepEqual(unpackSelectedAssemblyPacket(packed.encoded, launch(packet)), packet);
    for (const changedLaunch of [
      { ...launch(packet), schemaVersion: packet.schemaVersion === 1 ? 2 : 1 },
      { ...launch(packet), packetSha256: hash('changed') }, { ...launch(packet), batchId: randomUUID() },
      { ...launch(packet), episodeId: randomUUID() }, { ...launch(packet), type: 'render' },
      { ...launch(packet), credentials: 'private' },
    ]) assert.throws(() => unpackSelectedAssemblyPacket(packed.encoded, changedLaunch), /differs/);
    for (const encoded of ['invalid', 'A'.repeat(48 * 1024), `${packed.encoded}\n`]) {
      assert.throws(() => unpackSelectedAssemblyPacket(encoded, launch(packet)), /differs/);
    }
  }
  const legacy = legacyFixture(); legacy.audioInputs = fixture().audioInputs;
  assert.throws(() => packSelectedAssemblyPacket(legacy), undefined, 'v2 audio inputs cannot silently change a v1 fingerprint');
  const changedLegacyDuration = legacyFixture(); changedLegacyDuration.manifest.scenes[0].durationSeconds = 7;
  changedLegacyDuration.manifest.durationSeconds = 7;
  assert.throws(() => packSelectedAssemblyPacket(changedLegacyDuration), undefined, 'v1 retains its exact 7.5-second scene contract');
});
