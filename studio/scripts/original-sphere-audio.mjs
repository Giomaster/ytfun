import { createHash } from 'node:crypto';

// Original procedural sound only: oscillators, locally seeded noise and short
// reflections. Input text chooses numeric timbre; it is never spoken/sonified.
// No CLI, files, samples, model calls, environment, network or module side effects.
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const TARGET_PEAK = 0.76;
const TEXTURE_PEAK = 0.18;
const TAU = 2 * Math.PI;
const REFERENCE_DURATION = 7.5;
const SHARED_TEXTURES = {
  'warm-room': { low: 45, color: 520, width: 0.16, texture: 'Quiet warm room texture with a soft onset and settled ending, without timed or synchronized effects.' },
  'wax-road': { low: 180, color: 2400, width: 0.14, texture: 'Fine dry wax and paper texture with a soft onset and settled ending, without timed or synchronized effects.' },
  'wood-room': { low: 90, color: 1100, width: 0.12, texture: 'Soft wooden miniature room texture with a soft onset and settled ending, without timed or synchronized effects.' },
};
const PROFILES = {
  elemental: { contact: 740, body: 72, modes: [181, 307, 491], reveal: [146, 220, 293, 440], roughness: 0.95, cutoff: 1650, particles: 8, particleFrequency: 1250, sweep: -35, width: 0.18 },
  cosmic: { contact: 410, body: 47, modes: [83, 139, 227], reveal: [98, 147, 196, 294], roughness: 0.36, cutoff: 760, particles: 5, particleFrequency: 1640, sweep: 55, width: 0.42 },
  liquid: { contact: 550, body: 86, modes: [163, 271, 449], reveal: [220, 294, 392, 588], roughness: 0.28, cutoff: 950, particles: 12, particleFrequency: 520, sweep: -75, width: 0.3 },
  mechanical: { contact: 1290, body: 63, modes: [167, 331, 517], reveal: [130, 195, 260, 390], roughness: 0.7, cutoff: 2300, particles: 9, particleFrequency: 2170, sweep: -15, width: 0.2 },
  organic: { contact: 360, body: 97, modes: [113, 179, 283], reveal: [196, 247, 294, 392], roughness: 0.44, cutoff: 1100, particles: 7, particleFrequency: 680, sweep: 20, width: 0.28 },
  prismatic: { contact: 1850, body: 123, modes: [373, 593, 941], reveal: [523, 659, 784, 1046], roughness: 0.24, cutoff: 1900, particles: 11, particleFrequency: 2900, sweep: 45, width: 0.4 },
};
const PROFILE_WORDS = {
  elemental: /\b(elemental|element|stone|rock|lava|fire|ice|mineral|pedra|rocha|fogo|gelo)\b/,
  cosmic: /\b(cosmic|cosmos|space|galaxy|nebula|astral|portal|espaco|galaxia|cosmico)\b/,
  liquid: /\b(liquid|water|fluid|ocean|bubble|agua|liquido|oceano|bolha)\b/,
  mechanical: /\b(mechanical|machine|clockwork|metal|gear|robot|mecanico|maquina|engrenagem)\b/,
  organic: /\b(organic|forest|plant|wood|seed|nature|organico|floresta|planta|madeira|semente)\b/,
  prismatic: /\b(prismatic|prism|crystal|glass|rainbow|gem|prismatico|prisma|cristal|vidro|arco iris)\b/,
};

function text(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${name} must be nonempty text of at most ${maximum} characters`);
  return value.trim();
}

function normalized(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Audio options are required');
  const { durationSeconds, seed, audioProfile } = input;
  if (!Number.isFinite(durationSeconds) || durationSeconds < 3 || durationSeconds > 30) throw new Error('durationSeconds must be finite and between 3 and 30 seconds');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed must be an unsigned 32-bit integer');
  if (audioProfile !== undefined && !['cloth-rest', 'quiet-water', ...Object.keys(SHARED_TEXTURES)].includes(audioProfile)) throw new Error('audioProfile must be a supported original texture when supplied');
  return { durationSeconds, seed, genre: text(input.genre, 'genre', 160), title: text(input.title, 'title', 300),
    ...(audioProfile ? { audioProfile } : {}) };
}

function identity(input) {
  const options = normalized(input);
  const digest = createHash('sha256').update(JSON.stringify(options)).digest();
  if (options.audioProfile) return { options, digest, profile: options.audioProfile };
  const folded = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const names = Object.keys(PROFILES);
  const profile = names.find(name => PROFILE_WORDS[name].test(folded(options.genre)))
    ?? names.find(name => PROFILE_WORDS[name].test(folded(options.title)))
    ?? names[digest.readUInt32LE(4) % names.length];
  return { options, digest, profile };
}

export function describeSphereAudio(input) {
  const { options, digest, profile } = identity(input);
  if (options.audioProfile) return {
    algorithm: `original-${profile}-audio-v1`, profile, seed: options.seed,
    inputSha256: digest.toString('hex'), durationSeconds: options.durationSeconds,
    sampleRate: SAMPLE_RATE, channels: CHANNELS, bitsPerSample: BITS_PER_SAMPLE,
    peakLimit: TEXTURE_PEAK, originalProcedural: true,
    construction: { recordedSamples: false, speechSynthesis: false, textAudio: false, modelCalls: false, synchronizedEffects: false },
    texture: SHARED_TEXTURES[profile]?.texture ?? (profile === 'quiet-water'
      ? 'Continuous gently drifting water and wind texture, soft onset and calm ending; no contact, fracture or reveal accents.'
      : 'Continuous soft filtered noise, gentle onset and a calm fade into rest; no contact, fracture or reveal accents.'),
  };
  const scale = options.durationSeconds / REFERENCE_DURATION;
  return {
    algorithm: 'original-sphere-audio-v1', profile, seed: options.seed,
    inputSha256: digest.toString('hex'), durationSeconds: options.durationSeconds,
    sampleRate: SAMPLE_RATE, channels: CHANNELS, bitsPerSample: BITS_PER_SAMPLE,
    peakLimit: TARGET_PEAK, originalProcedural: true,
    construction: { recordedSamples: false, speechSynthesis: false, textAudio: false, modelCalls: false },
    cuesSeconds: { contact: 0.8 * scale, resistanceEnd: 2.6 * scale, fracture: 2.8 * scale, revealStart: 3.2 * scale, revealHoldEnd: 5.5 * scale, end: options.durationSeconds },
  };
}

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function smooth(value) {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

function gate(time, start, end, attack, release) {
  return smooth((time - start) / attack) * smooth((end - time) / release);
}

function fade(frame, frames) {
  const tailSilence = Math.round(0.025 * SAMPLE_RATE);
  return smooth(frame / (0.025 * SAMPLE_RATE))
    * smooth((frames - 1 - tailSilence - frame) / (0.65 * SAMPLE_RATE));
}

function eventsFor(profile, random, scale, detune) {
  const event = (start, duration, amplitude, frequency, pan, decay, noise = 0) => ({
    start: start * scale, duration: duration * scale, amplitude, frequency: frequency * detune,
    left: Math.cos((pan + 1) * Math.PI / 4), right: Math.sin((pan + 1) * Math.PI / 4),
    decay: decay * scale, noise, phase: random() * TAU,
  });
  const events = [event(0.8, 0.22, 0.22, profile.contact, -0.08, 0.055, 0.22),
    event(2.8, 0.55, 0.36, profile.body * 1.4, 0, 0.16, 0.15)];
  // Small fractures lead into the main break; dispersed material/particles
  // follow it. All attacks/releases are continuous to avoid digital clicks.
  for (let index = 0; index < 4; index += 1) events.push(event(2.42 + index * 0.083, 0.085, 0.055 + index * 0.012, profile.contact * (0.7 + random() * 0.6), (random() - 0.5) * 0.35, 0.025, 0.8));
  for (let index = 0; index < profile.particles; index += 1) {
    const start = 3.05 + index * (2.8 / profile.particles) + random() * 0.09;
    events.push(event(start, profile === PROFILES.liquid ? 0.24 : 0.18, 0.035 * (1 - index / (profile.particles + 1)), profile.particleFrequency * (0.65 + random() * 0.8), (random() - 0.5) * 0.9, 0.065, 0.035));
  }
  events.push(event(5.7, 0.45, 0.038, profile.body * 1.8, 0.1, 0.13, 0.08));
  return events;
}

function continuousTextureAudio(options, digest) {
  const frames = Math.round(options.durationSeconds * SAMPLE_RATE);
  const random = randomSource((options.seed ^ digest.readUInt32LE(0)) >>> 0);
  const left = new Float64Array(frames); const right = new Float64Array(frames);
  const water = options.audioProfile === 'quiet-water';
  const texture = SHARED_TEXTURES[options.audioProfile];
  const lowCoefficient = 1 - Math.exp(-TAU * (texture?.low ?? (water ? 120 : 70)) / SAMPLE_RATE);
  const colorCoefficient = 1 - Math.exp(-TAU * (texture?.color ?? (water ? 1650 : 850)) / SAMPLE_RATE);
  const tailSilence = 0.025;
  const envelope = frame => {
    const time = frame / SAMPLE_RATE;
    return smooth(time / 0.6) * smooth((options.durationSeconds - tailSilence - time) / 1.4);
  };
  let lowShared = 0, colorShared = 0, lowLeft = 0, colorLeft = 0, lowRight = 0, colorRight = 0;
  let leftSum = 0, rightSum = 0, envelopeSum = 0;
  // A continuous texture rather than timed effects: no material impacts,
  // pitched reveal, speech, samples or claim of synchronization with the video.
  for (let frame = 0; frame < frames; frame += 1) {
    const commonNoise = random() * 2 - 1;
    const leftNoise = random() * 2 - 1; const rightNoise = random() * 2 - 1;
    lowShared += lowCoefficient * (commonNoise - lowShared);
    colorShared += colorCoefficient * (commonNoise - colorShared);
    lowLeft += lowCoefficient * (leftNoise - lowLeft); colorLeft += colorCoefficient * (leftNoise - colorLeft);
    lowRight += lowCoefficient * (rightNoise - lowRight); colorRight += colorCoefficient * (rightNoise - colorRight);
    const width = texture?.width ?? (water ? 0.28 : 0.2);
    const drift = water ? 0.9 + 0.1 * Math.sin(TAU * 0.35 * frame / SAMPLE_RATE) : 1;
    const shared = (colorShared - lowShared) * (1 - width);
    left[frame] = (shared + (colorLeft - lowLeft) * width) * drift;
    right[frame] = (shared + (colorRight - lowRight) * width) * drift;
    const window = envelope(frame);
    leftSum += left[frame] * window; rightSum += right[frame] * window; envelopeSum += window;
  }
  const leftOffset = leftSum / envelopeSum; const rightOffset = rightSum / envelopeSum;
  let peak = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const window = envelope(frame);
    left[frame] = (left[frame] - leftOffset) * window;
    right[frame] = (right[frame] - rightOffset) * window;
    peak = Math.max(peak, Math.abs(left[frame]), Math.abs(right[frame]));
  }
  if (!Number.isFinite(peak) || peak <= 0) throw new Error('Procedural continuous texture produced no finite signal');
  const gain = TEXTURE_PEAK / peak;
  const dataBytes = frames * CHANNELS * (BITS_PER_SAMPLE / 8);
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(CHANNELS, 22); wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE / 8, 28);
  wav.writeUInt16LE(CHANNELS * BITS_PER_SAMPLE / 8, 32); wav.writeUInt16LE(BITS_PER_SAMPLE, 34);
  wav.write('data', 36, 'ascii'); wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    wav.writeInt16LE(Math.round(Math.max(-TEXTURE_PEAK, Math.min(TEXTURE_PEAK, left[frame] * gain)) * 32767), 44 + frame * 4);
    wav.writeInt16LE(Math.round(Math.max(-TEXTURE_PEAK, Math.min(TEXTURE_PEAK, right[frame] * gain)) * 32767), 46 + frame * 4);
  }
  return wav;
}

export function synthesizeSphereAudio(input) {
  const { options, digest, profile: name } = identity(input);
  if (options.audioProfile) return continuousTextureAudio(options, digest);
  const profile = PROFILES[name];
  const scale = options.durationSeconds / REFERENCE_DURATION;
  const frames = Math.round(options.durationSeconds * SAMPLE_RATE);
  const random = randomSource((options.seed ^ digest.readUInt32LE(0)) >>> 0);
  const detune = 0.96 + digest.readUInt16LE(8) / 65535 * 0.08;
  const events = eventsFor(profile, random, scale, detune);
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  const phases = profile.reveal.map(() => random() * TAU);
  const lowCoefficient = 1 - Math.exp(-TAU * 130 / SAMPLE_RATE);
  const colorCoefficient = 1 - Math.exp(-TAU * profile.cutoff / SAMPLE_RATE);
  const delayFrames = Math.round(0.041 * SAMPLE_RATE);
  let lowLeft = 0, lowRight = 0, colorLeft = 0, colorRight = 0;
  let leftSum = 0, rightSum = 0, fadeSum = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / SAMPLE_RATE;
    const beat = time / scale;
    const noiseLeft = random() * 2 - 1;
    const noiseRight = random() * 2 - 1;
    lowLeft += lowCoefficient * (noiseLeft - lowLeft);
    lowRight += lowCoefficient * (noiseRight - lowRight);
    colorLeft += colorCoefficient * (noiseLeft - colorLeft);
    colorRight += colorCoefficient * (noiseRight - colorRight);
    const resistance = gate(beat, 0.86, 2.66, 0.12, 0.15) * (0.25 + 0.75 * smooth((beat - 0.86) / 1.74));
    const grain = 0.68 + 0.32 * Math.sin(TAU * (name === 'mechanical' ? 17 : 9.3) * time) ** 2;
    const friction = resistance * profile.roughness * grain * 0.11;
    let l = (colorLeft - lowLeft) * friction;
    let r = (colorRight - lowRight) * friction;
    if (resistance > 0) {
      const tension = Math.sin(TAU * profile.body * detune * time) * resistance * 0.023;
      l += tension; r += tension;
    }
    for (const event of events) {
      const elapsed = time - event.start;
      if (elapsed <= 0 || elapsed >= event.duration) continue;
      const envelope = gate(elapsed, 0, event.duration, Math.min(0.004 * scale, event.duration / 5), event.duration / 4) * Math.exp(-elapsed / event.decay);
      // Inharmonic modes retain material identity without phoneme/formant banks.
      const tone = (Math.sin(TAU * event.frequency * elapsed + event.phase)
        + 0.4 * Math.sin(TAU * event.frequency * 1.713 * elapsed + event.phase)
        + 0.2 * Math.sin(TAU * event.frequency * 2.317 * elapsed)) / 1.6;
      const sample = event.amplitude * envelope * ((1 - event.noise) * tone + event.noise * (noiseLeft + noiseRight) / 2);
      l += sample * event.left; r += sample * event.right;
    }
    if (beat >= 2.8) {
      const elapsed = time - 2.8 * scale;
      const ring = gate(beat, 2.8, 4.25, 0.015, 0.35) * Math.exp(-elapsed / (0.46 * scale));
      const modes = profile.modes.reduce((sum, frequency, index) => sum + Math.sin(TAU * frequency * detune * elapsed) / (index + 1), 0);
      l += modes * ring * 0.058; r += modes * ring * 0.058;
    }
    if (beat >= 3.2) {
      const elapsed = time - 3.2 * scale;
      const reveal = smooth((beat - 3.2) / 0.65) * (beat <= 5.5 ? 1 : Math.exp(-1.45 * (beat - 5.5)));
      let shimmerLeft = 0, shimmerRight = 0;
      for (const [index, frequency] of profile.reveal.entries()) {
        const sweepPhase = profile.sweep * 0.55 * scale * (1 - Math.exp(-elapsed / (0.55 * scale)));
        const modulation = 0.76 + 0.24 * Math.sin(TAU * (0.37 + index * 0.19) * time + phases[index]);
        shimmerLeft += Math.sin(TAU * (frequency * detune * elapsed + sweepPhase) + phases[index]) * modulation;
        shimmerRight += Math.sin(TAU * ((frequency * detune + profile.width * (index + 1)) * elapsed + sweepPhase) + phases[index]) * modulation;
      }
      l += reveal * (shimmerLeft * 0.042 + (colorLeft - lowLeft) * 0.018);
      r += reveal * (shimmerRight * 0.042 + (colorRight - lowRight) * 0.018);
    }
    // Low-gain crossed early reflections supply width without negating the
    // mono mix. Stable feedback remains below unity; final fade applies after it.
    if (frame >= delayFrames) { l += right[frame - delayFrames] * 0.1; r += left[frame - delayFrames] * 0.1; }
    left[frame] = l; right[frame] = r;
    const window = fade(frame, frames);
    leftSum += l * window; rightSum += r * window; fadeSum += window;
  }
  // Weighted DC correction preserves silent boundaries and removes DC from
  // both final channels before quantization, including the faded tails.
  const leftOffset = leftSum / fadeSum;
  const rightOffset = rightSum / fadeSum;
  let peak = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const window = fade(frame, frames);
    left[frame] = (left[frame] - leftOffset) * window;
    right[frame] = (right[frame] - rightOffset) * window;
    peak = Math.max(peak, Math.abs(left[frame]), Math.abs(right[frame]));
  }
  if (!Number.isFinite(peak) || peak <= 0) throw new Error('Procedural audio produced no finite signal');
  const gain = TARGET_PEAK / peak;
  const dataBytes = frames * CHANNELS * (BITS_PER_SAMPLE / 8);
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(CHANNELS, 22); wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE / 8, 28);
  wav.writeUInt16LE(CHANNELS * BITS_PER_SAMPLE / 8, 32); wav.writeUInt16LE(BITS_PER_SAMPLE, 34);
  wav.write('data', 36, 'ascii'); wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    wav.writeInt16LE(Math.round(Math.max(-TARGET_PEAK, Math.min(TARGET_PEAK, left[frame] * gain)) * 32767), 44 + frame * 4);
    wav.writeInt16LE(Math.round(Math.max(-TARGET_PEAK, Math.min(TARGET_PEAK, right[frame] * gain)) * 32767), 46 + frame * 4);
  }
  return wav;
}
