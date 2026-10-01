import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describeSphereAudio, synthesizeSphereAudio } from '../scripts/original-sphere-audio.mjs';

// CI only. These are in-memory DSP contracts; no files, encoders, samples,
// providers, spoken content or network are used to produce the audio fixtures.
const options = Object.freeze({ durationSeconds: 7.5, seed: 20261001, genre: 'elemental', title: 'An original sphere opens into a luminous interior' });
const profiles = ['elemental', 'cosmic', 'liquid', 'mechanical', 'organic', 'prismatic'];
const cache = new Map();
function fixture(genre = options.genre) {
  if (!cache.has(genre)) cache.set(genre, synthesizeSphereAudio({ ...options, genre }));
  return cache.get(genre);
}

function samples(wav) {
  const frames = wav.readUInt32LE(40) / 4;
  const left = new Int16Array(frames);
  const right = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = wav.readInt16LE(44 + frame * 4);
    right[frame] = wav.readInt16LE(46 + frame * 4);
  }
  return { left, right, frames };
}

function rms(channel, start = 0, end = channel.length) {
  start = Math.round(start);
  end = Math.round(end);
  let energy = 0;
  for (let frame = start; frame < end; frame += 1) energy += channel[frame] ** 2;
  return Math.sqrt(energy / (end - start));
}

test('original synthesis emits a complete 48 kHz stereo little-endian PCM16 WAV of exactly 7.5 seconds', () => {
  const wav = fixture();
  assert.ok(Buffer.isBuffer(wav));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt32LE(28), 192000);
  assert.equal(wav.readUInt16LE(32), 4);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), 7.5 * 48000 * 4);
  assert.equal(wav.length, 44 + 7.5 * 192000);
});

test('same seed/title/genre/duration reproduces exact bytes without mutating options', () => {
  const before = { ...options };
  assert.deepEqual(synthesizeSphereAudio(options), fixture());
  assert.deepEqual(options, before);
  const firstHash = createHash('sha256').update(fixture()).digest('hex');
  assert.notEqual(createHash('sha256').update(synthesizeSphereAudio({ ...options, seed: options.seed + 1 })).digest('hex'), firstHash);
  assert.notEqual(createHash('sha256').update(synthesizeSphereAudio({ ...options, title: 'A different original sphere with the same elemental material' })).digest('hex'), firstHash);
});

test('six material profiles produce distinct original signals and immutable derived descriptions', () => {
  const hashes = new Set();
  for (const genre of profiles) {
    const input = { ...options, genre };
    const metadata = describeSphereAudio(input);
    assert.equal(metadata.profile, genre);
    assert.equal(metadata.algorithm, 'original-sphere-audio-v1');
    assert.equal(metadata.originalProcedural, true);
    assert.deepEqual(metadata.construction, { recordedSamples: false, speechSynthesis: false, textAudio: false, modelCalls: false });
    hashes.add(createHash('sha256').update(fixture(genre)).digest('hex'));
    // Metadata is a fresh copy; caller mutation cannot alter later sound/profile.
    metadata.cuesSeconds.fracture = 0;
    metadata.construction.recordedSamples = true;
    assert.equal(describeSphereAudio(input).cuesSeconds.fracture, 2.8);
    assert.equal(describeSphereAudio(input).construction.recordedSamples, false);
  }
  assert.equal(hashes.size, 6);
});

test('all profiles retain peak headroom, negligible channel DC and useful stereo without destructive mono cancellation', () => {
  for (const genre of profiles) {
    const { left, right, frames } = samples(fixture(genre));
    let peak = 0, leftSum = 0, rightSum = 0, differences = 0, monoEnergy = 0, stereoEnergy = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      peak = Math.max(peak, Math.abs(left[frame]), Math.abs(right[frame]));
      leftSum += left[frame]; rightSum += right[frame];
      if (left[frame] !== right[frame]) differences += 1;
      monoEnergy += ((left[frame] + right[frame]) / 2) ** 2;
      stereoEnergy += (left[frame] ** 2 + right[frame] ** 2) / 2;
    }
    assert.ok(peak <= Math.ceil(0.76 * 32767), `${genre}: peak exceeds declared headroom`);
    assert.ok(peak >= 0.7 * 32767, `${genre}: signal should use controlled peak normalization`);
    assert.ok(Math.abs(leftSum / frames) < 1, `${genre}: left DC exceeds one PCM unit`);
    assert.ok(Math.abs(rightSum / frames) < 1, `${genre}: right DC exceeds one PCM unit`);
    assert.ok(differences > frames / 4, `${genre}: stereo channels must not be duplicated`);
    assert.ok(monoEnergy > stereoEnergy * 0.25, `${genre}: mono mix must retain substantial energy`);
  }
});

test('contact/fracture/reveal carry energy and every profile settles into silent boundaries with a smooth final fade', () => {
  for (const genre of profiles) {
    const { left, right, frames } = samples(fixture(genre));
    assert.equal(left[0], 0); assert.equal(right[0], 0);
    for (const channel of [left, right]) {
      const tailStart = frames - Math.round(0.025 * 48000);
      assert.ok(channel.subarray(tailStart).every(sample => sample === 0), `${genre}: final boundary must be silent`);
      assert.ok(rms(channel, 0.8 * 48000, 1.0 * 48000) > 10, `${genre}: contact is missing`);
      assert.ok(rms(channel, 1.2 * 48000, 2.4 * 48000) > 10, `${genre}: material resistance is missing`);
      assert.ok(rms(channel, 2.8 * 48000, 3.1 * 48000) > 100, `${genre}: main fracture is missing`);
      assert.ok(rms(channel, 3.5 * 48000, 5.5 * 48000) > 100, `${genre}: held reveal is missing`);
      const earlyTail = rms(channel, 6.25 * 48000, 6.75 * 48000);
      const finalTail = rms(channel, 7.25 * 48000, 7.475 * 48000);
      assert.ok(finalTail < earlyTail * 0.3, `${genre}: ending must fade, not cut abruptly`);
      assert.ok(Math.abs(channel[tailStart] - channel[tailStart - 1]) <= 1, `${genre}: terminal fade discontinuity`);
    }
  }
});

test('bounded duration scales the editorial cues and the number of PCM frames instead of padding a fixed-length result', () => {
  const input = { ...options, durationSeconds: 3.75 };
  const metadata = describeSphereAudio(input);
  assert.deepEqual(metadata.cuesSeconds, { contact: 0.4, resistanceEnd: 1.3, fracture: 1.4, revealStart: 1.6, revealHoldEnd: 2.75, end: 3.75 });
  const wav = synthesizeSphereAudio(input);
  assert.equal(wav.readUInt32LE(40), 3.75 * 192000);
  assert.equal(samples(wav).frames, 3.75 * 48000);
});

test('invalid/unbounded inputs are rejected and unsigned seed endpoints remain valid metadata', () => {
  for (const mutation of [{ durationSeconds: 0 }, { durationSeconds: 31 }, { durationSeconds: NaN }, { durationSeconds: Infinity }, { durationSeconds: '7.5' }, { seed: -1 }, { seed: 4294967296 }, { seed: 0.5 }, { seed: '123' }, { genre: '' }, { title: '' }, { title: 'x'.repeat(301) }]) {
    assert.throws(() => synthesizeSphereAudio({ ...options, ...mutation }));
    assert.throws(() => describeSphereAudio({ ...options, ...mutation }));
  }
  assert.throws(() => synthesizeSphereAudio(undefined));
  assert.throws(() => synthesizeSphereAudio([]));
  assert.equal(describeSphereAudio({ ...options, seed: 0 }).seed, 0);
  assert.equal(describeSphereAudio({ ...options, seed: 0xffffffff }).seed, 0xffffffff);
});

test('no speech/model/sample execution path exists by construction; text influences numeric identity only', async () => {
  const source = await readFile(new URL('../scripts/original-sphere-audio.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.deepEqual(imports, ['node:crypto']);
  assert.doesNotMatch(source, /\b(?:fetch|spawn|exec|readFile|writeFile|import)\s*\(/);
  assert.doesNotMatch(source, /Math\.random\s*\(|process\.(?:env|argv)|Buffer\.from\s*\([^)]*,\s*['"]base64['"]/);
  assert.doesNotMatch(source, /textToSpeech|InferenceClient|phoneme\s*[:=]|formant\s*[:=]/);
});
