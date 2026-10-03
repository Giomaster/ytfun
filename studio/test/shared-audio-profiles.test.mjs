import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describeSphereAudio, synthesizeSphereAudio } from '../scripts/original-sphere-audio.mjs';
import { packAssemblyPacket, unpackAssemblyPacket } from '../scripts/assembly-packets.mjs';

// CI only: generate fixtures in the remote test job, never on the owner's Mac.
test('shared texture packets preserve the exact profile and original nonverbal PCM contract', () => {
  const hashes = new Set();
  for (const audioProfile of ['warm-room', 'wax-road', 'wood-room']) {
    const options = { audioProfile, seed: 2026100410, durationSeconds: 7.5, title: 'Shared miniature story', genre: 'original quiet room' };
    const description = describeSphereAudio(options);
    assert.equal(description.profile, audioProfile);
    assert.equal(description.originalProcedural, true);
    assert.deepEqual(description.construction, { recordedSamples: false, speechSynthesis: false, textAudio: false, modelCalls: false, synchronizedEffects: false });
    const wav = synthesizeSphereAudio(options);
    assert.equal(wav.length, 44 + 48000 * 7.5 * 4);
    assert.equal(wav.readUInt32LE(24), 48000);
    assert.equal(wav.readUInt16LE(22), 2);
    assert.equal(wav.readUInt16LE(34), 16);
    let peak = 0;
    for (let offset = 44; offset < wav.length; offset += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
    assert.ok(peak > 0 && peak <= Math.ceil(0.18 * 32767));
    assert.ok(wav.subarray(wav.length - 4800).every(byte => byte === 0), 'the last25ms settle to silence');
    hashes.add(createHash('sha256').update(wav).digest('hex'));
    const packet = { schemaVersion: 1, type: 'audio', id: randomUUID(), episodeId: randomUUID(), scenes: [{ index: 1, sceneId: randomUUID(), title: options.title, genre: options.genre, seed: options.seed, durationSeconds: 7.5, audioProfile }] };
    const packed = packAssemblyPacket(packet);
    const launch = { schemaVersion: 1, type: 'audio', batchId: packet.id, episodeId: packet.episodeId, packetSha256: packed.packetSha256 };
    assert.equal(unpackAssemblyPacket(packed.encoded, launch, 'audio').scenes[0].audioProfile, audioProfile);
  }
  assert.equal(hashes.size, 3, 'different texture requests produce different original signals');
});
