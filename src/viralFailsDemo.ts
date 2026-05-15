import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { auditRightsManifest } from "./compliance.js";
import { assertFfmpegAvailable } from "./ffmpeg.js";
import { writeJsonFile } from "./io.js";
import type { ManifestAudit, RightsManifest } from "./types.js";

const width = 720;
const height = 1280;
const fps = 12;
const outputFps = 24;
const durationSeconds = 120;

interface ViralScene {
  id: string;
  title: string;
  caption: string;
  duration: number;
  accent: string;
  baseLikes: number;
  render: (time: number, scene: ViralScene) => string;
}

const scenes: ViralScene[] = [
  {
    id: "scooter-launch",
    title: "Patinete turbo",
    caption: "quando o modo eco some",
    duration: 10,
    accent: "#22d3ee",
    baseLikes: 18400,
    render: scooterScene,
  },
  {
    id: "office-chair",
    title: "Cadeira traiu",
    caption: "home office em modo boss final",
    duration: 10,
    accent: "#fb7185",
    baseLikes: 22600,
    render: chairScene,
  },
  {
    id: "glass-door",
    title: "Porta invisivel",
    caption: "o Wi-Fi caiu e a alma tambem",
    duration: 10,
    accent: "#a78bfa",
    baseLikes: 31900,
    render: glassDoorScene,
  },
  {
    id: "fitness-ball",
    title: "Bola fitness",
    caption: "treino funcional demais",
    duration: 10,
    accent: "#facc15",
    baseLikes: 40200,
    render: fitnessBallScene,
  },
  {
    id: "delivery-ramp",
    title: "Entrega ninja",
    caption: "pedido chegou com plot twist",
    duration: 10,
    accent: "#34d399",
    baseLikes: 27900,
    render: deliveryScene,
  },
  {
    id: "office-dance",
    title: "Dancinha corporativa",
    caption: "sexta-feira as 17h59",
    duration: 10,
    accent: "#60a5fa",
    baseLikes: 51500,
    render: officeDanceScene,
  },
  {
    id: "hall-skate",
    title: "Skate no corredor",
    caption: "ideia ruim, execucao pior",
    duration: 10,
    accent: "#f97316",
    baseLikes: 37200,
    render: hallwaySkateScene,
  },
  {
    id: "pool-splash",
    title: "Piscina inflavel",
    caption: "hidratacao agressiva",
    duration: 10,
    accent: "#38bdf8",
    baseLikes: 48600,
    render: poolScene,
  },
  {
    id: "runaway-rug",
    title: "Tapete rebelde",
    caption: "decoracao com personalidade",
    duration: 10,
    accent: "#c084fc",
    baseLikes: 29800,
    render: rugScene,
  },
  {
    id: "treadmill",
    title: "Esteira sincera",
    caption: "cardio com atualizacao forcada",
    duration: 10,
    accent: "#2dd4bf",
    baseLikes: 55800,
    render: treadmillScene,
  },
  {
    id: "foam-wall",
    title: "Parede fake",
    caption: "stunt seguro, ego no chao",
    duration: 10,
    accent: "#f472b6",
    baseLikes: 33400,
    render: foamWallScene,
  },
  {
    id: "final-recap",
    title: "Score viral",
    caption: "trend alto, risco baixo, replay infinito",
    duration: 10,
    accent: "#4ade80",
    baseLikes: 72000,
    render: recapScene,
  },
];

export async function createViralFailsDemo(outputPath: string): Promise<{ outputPath: string; manifest: RightsManifest; audit: ManifestAudit }> {
  const ffmpegPath = assertFfmpegAvailable();
  const outAbs = resolve(process.cwd(), outputPath);
  const caseDir = dirname(outAbs);
  const frameDir = resolve(caseDir, "frames");
  const audioPath = resolve(caseDir, "soundtrack.wav");

  await mkdir(caseDir, { recursive: true });
  await rm(frameDir, { recursive: true, force: true });
  await mkdir(frameDir, { recursive: true });

  await renderFrames(frameDir);
  await writeSoundtrack(audioPath);
  encodeVideo(ffmpegPath, frameDir, audioPath, outAbs);

  const manifest = buildManifest(outputPath);
  const manifestPath = resolve(caseDir, "rights-manifest.json");
  const editPath = resolve(caseDir, "viral-edit-plan.json");
  await writeJsonFile(relativeToCwd(manifestPath), manifest);
  await writeJsonFile(relativeToCwd(editPath), buildEditMetadata(outputPath));
  const audit = await auditRightsManifest(manifest, { checkFiles: true, maxClipSeconds: 12 });

  return { outputPath, manifest, audit };
}

async function renderFrames(frameDir: string): Promise<void> {
  const totalFrames = durationSeconds * fps;
  const concurrency = 8;
  let nextFrame = 0;

  async function worker(): Promise<void> {
    while (nextFrame < totalFrames) {
      const frame = nextFrame;
      nextFrame += 1;
      const time = frame / fps;
      const file = resolve(frameDir, `frame_${String(frame + 1).padStart(5, "0")}.png`);
      await sharp(Buffer.from(renderFrame(time))).png({ compressionLevel: 6 }).toFile(file);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

function encodeVideo(ffmpegPath: string, frameDir: string, audioPath: string, outputPath: string): void {
  const result = spawnSync(
    ffmpegPath,
    [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      resolve(frameDir, "frame_%05d.png"),
      "-i",
      audioPath,
      "-r",
      String(outputFps),
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to encode viral fails demo:\n${result.stderr}`);
  }
}

function renderFrame(globalTime: number): string {
  const { scene, localTime, sceneIndex } = sceneAt(globalTime);
  const body = scene.render(localTime, scene);
  const overlay = viralOverlay(scene, localTime, globalTime, sceneIndex);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#08111f"/>
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="58%" stop-color="#111827"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#000000" flood-opacity="0.42"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  ${body}
  ${overlay}
</svg>`;
}

function viralOverlay(scene: ViralScene, localTime: number, globalTime: number, sceneIndex: number): string {
  const progress = globalTime / durationSeconds;
  const sceneProgress = localTime / scene.duration;
  const likes = scene.baseLikes + Math.floor(localTime * 740 + Math.max(0, localTime - 5) * 1800);
  const replay = localTime > 7.2 && scene.id !== "final-recap";
  const pulse = 1 + Math.sin(localTime * Math.PI * 6) * 0.06;

  return `
  <rect x="28" y="34" width="450" height="50" rx="25" fill="#020617" opacity="0.74"/>
  <text x="56" y="68" fill="#f8fafc" font-size="25" font-family="Arial, Helvetica, sans-serif" font-weight="700">CASSETADAS AI TEST</text>
  <rect x="28" y="98" width="${664 * progress}" height="8" rx="4" fill="${scene.accent}"/>
  <rect x="28" y="98" width="664" height="8" rx="4" fill="none" stroke="#334155" stroke-width="2"/>
  <text x="56" y="950" fill="#f8fafc" font-size="52" font-family="Arial, Helvetica, sans-serif" font-weight="800">${xml(scene.title)}</text>
  <rect x="48" y="978" width="${Math.max(230, scene.caption.length * 15)}" height="54" rx="27" fill="#020617" opacity="0.72"/>
  <text x="72" y="1014" fill="${scene.accent}" font-size="28" font-family="Arial, Helvetica, sans-serif" font-weight="700">${xml(scene.caption)}</text>
  <g transform="translate(610 650) scale(${pulse.toFixed(3)})">
    <circle cx="0" cy="0" r="34" fill="#f8fafc" opacity="0.94"/>
    <text x="-14" y="12" fill="#ef4444" font-size="37" font-family="Arial, Helvetica, sans-serif" font-weight="900">+</text>
    <text x="-34" y="72" fill="#f8fafc" font-size="22" font-family="Arial, Helvetica, sans-serif" font-weight="700">${compact(likes)}</text>
    <circle cx="0" cy="138" r="30" fill="#f8fafc" opacity="0.9"/>
    <text x="-12" y="150" fill="#111827" font-size="33" font-family="Arial, Helvetica, sans-serif" font-weight="900">!</text>
    <text x="-29" y="203" fill="#f8fafc" font-size="21" font-family="Arial, Helvetica, sans-serif" font-weight="700">${sceneIndex + 1}/12</text>
  </g>
  ${replay ? `<rect x="44" y="160" width="190" height="58" rx="20" fill="${scene.accent}" opacity="0.94"/>
  <text x="74" y="199" fill="#020617" font-size="30" font-family="Arial, Helvetica, sans-serif" font-weight="900">REPLAY</text>` : ""}
  <rect x="58" y="1094" width="604" height="62" rx="31" fill="#020617" opacity="0.7"/>
  <rect x="78" y="1116" width="${564 * sceneProgress}" height="18" rx="9" fill="${scene.accent}"/>
  <text x="74" y="1218" fill="#cbd5e1" font-size="22" font-family="Arial, Helvetica, sans-serif">synthetic owned footage - safe slapstick demo</text>`;
}

function scooterScene(time: number, scene: ViralScene): string {
  const x = lerp(-90, 560, ease(clamp(time / 5.1)));
  const wobble = Math.sin(time * 16) * Math.min(1, time / 2) * 8;
  const crash = Math.max(0, time - 5.1);
  const px = crash > 0 ? 560 + crash * 18 : x;
  const py = crash > 0 ? 750 + Math.sin(crash * 3.8) * 24 + crash * 34 : 760 + wobble;
  const angle = crash > 0 ? clamp(crash / 1.6) * 220 : wobble * 1.5;
  const cone = polygon([[560, 825], [598, 825], [579, 742]], "#fb923c");
  const burst = crash > 0 ? starBurst(575, 754, 105, scene.accent, 10, 0.55) : "";

  return `${street(scene.accent)}
  ${speedLines(time, scene.accent)}
  ${cone}
  ${scooter(px - 18, py + 62, crash > 0 ? -35 : 0, scene.accent)}
  ${person(px, py, 1.05, angle, "#e2e8f0", scene.accent)}
  ${burst}`;
}

function chairScene(time: number, scene: ViralScene): string {
  const sit = clamp(time / 3.2);
  const slide = Math.max(0, time - 3.4);
  const chairX = 380 + slide * 86;
  const personX = 360 + Math.min(slide, 1.8) * 56;
  const fall = clamp((time - 4.6) / 2);
  const angle = fall * 96;
  const y = 730 + fall * 74;

  return `${room(scene.accent)}
  ${desk(70, 710)}
  ${chair(chairX, 780, scene.accent, slide > 0 ? 12 : 0)}
  ${person(personX, y - sit * 30, 1.05, angle, "#f8fafc", scene.accent)}
  ${fall > 0.15 ? starBurst(478, 768, 88, scene.accent, 9, 0.45) : ""}`;
}

function glassDoorScene(time: number, scene: ViralScene): string {
  const walk = clamp(time / 4.8);
  const hit = Math.max(0, time - 4.8);
  const rebound = Math.sin(Math.min(hit, 1.4) * Math.PI) * 80;
  const x = lerp(80, 420, ease(walk)) - rebound;
  const angle = hit > 0 ? -Math.sin(hit * 6) * 18 : Math.sin(time * 6) * 5;

  return `${mall(scene.accent)}
  <rect x="470" y="245" width="12" height="610" fill="#e0f2fe" opacity="0.55"/>
  <rect x="460" y="245" width="170" height="610" fill="#7dd3fc" opacity="0.14" stroke="#bae6fd" stroke-width="4"/>
  ${person(x, 760, 1.05, angle, "#f8fafc", scene.accent)}
  ${hit > 0 ? impactMarks(468, 575, scene.accent) : ""}`;
}

function fitnessBallScene(time: number, scene: ViralScene): string {
  const jump = clamp(time / 3.3);
  const roll = Math.max(0, time - 3.3);
  const ballX = 250 + roll * 82;
  const ballY = 815 + Math.sin(time * 9) * 8;
  const personX = 250 + roll * 92;
  const personY = 680 - Math.sin(jump * Math.PI) * 170 + Math.min(roll, 2.4) * 70;
  const angle = roll > 0 ? roll * 105 : 0;

  return `${gym(scene.accent)}
  <circle cx="${ballX}" cy="${ballY}" r="82" fill="${scene.accent}" opacity="0.82" filter="url(#shadow)"/>
  <path d="M${ballX - 58} ${ballY - 18} Q${ballX} ${ballY - 64} ${ballX + 58} ${ballY - 18}" fill="none" stroke="#f8fafc" stroke-width="7" opacity="0.45"/>
  ${person(personX, personY, 1.02, angle, "#f8fafc", "#fb7185")}
  ${roll > 1.3 ? starBurst(personX, personY + 38, 98, "#fb7185", 11, 0.5) : ""}`;
}

function deliveryScene(time: number, scene: ViralScene): string {
  const go = clamp(time / 5.2);
  const crash = Math.max(0, time - 5.2);
  const x = lerp(20, 460, ease(go));
  const y = 750 - go * 65 + crash * 55;
  const angle = crash > 0 ? 110 * clamp(crash / 1.4) : -8;
  const boxes = [0, 1, 2].map((item) => {
    const bx = x + 48 + Math.sin(time * (4 + item)) * 12 + Math.max(0, crash) * (item - 1) * 80;
    const by = y - 120 - item * 38 - Math.sin(Math.max(0, crash) * Math.PI + item) * 120;
    return box(bx, by, 58, 46, "#c084fc", angle + item * 22);
  }).join("");

  return `${street(scene.accent)}
  <polygon points="60,910 620,780 662,850 80,1010" fill="#1f2937"/>
  ${boxes}
  ${person(x, y, 1, angle, "#f8fafc", scene.accent)}
  ${crash > 0.25 ? starBurst(x + 120, y - 28, 94, scene.accent, 12, 0.48) : ""}`;
}

function officeDanceScene(time: number, scene: ViralScene): string {
  const spin = time < 5.2 ? Math.sin(time * 5) * 22 : (time - 5.2) * 155;
  const slip = Math.max(0, time - 5.2);
  const x = 350 + Math.sin(time * 3.6) * 88 + slip * 42;
  const y = 760 + Math.min(slip, 2) * 38;

  return `${room(scene.accent)}
  ${desk(72, 735)}
  ${person(x, y, 1.08, spin, "#f8fafc", scene.accent)}
  <ellipse cx="${x - 30}" cy="${890 + Math.sin(time * 8) * 8}" rx="52" ry="15" fill="${scene.accent}" opacity="0.28"/>
  ${slip > 0.5 ? motionStars(x - 80, y - 170, scene.accent) : ""}`;
}

function hallwaySkateScene(time: number, scene: ViralScene): string {
  const go = clamp(time / 5.4);
  const crash = Math.max(0, time - 5.4);
  const x = lerp(-80, 510, ease(go));
  const y = 780 + Math.sin(time * 12) * 5 + crash * 54;
  const angle = crash > 0 ? 160 * clamp(crash / 1.5) : Math.sin(time * 10) * 8;

  return `${hallway(scene.accent)}
  <rect x="522" y="690" width="72" height="180" rx="10" fill="#475569"/>
  ${skateboard(x + 6, y + 82, crash > 0 ? 38 : 0, scene.accent)}
  ${person(x, y, 1, angle, "#f8fafc", scene.accent)}
  ${crash > 0 ? impactMarks(528, 710, "#f97316") : ""}`;
}

function poolScene(time: number, scene: ViralScene): string {
  const run = clamp(time / 4.5);
  const splash = Math.max(0, time - 4.5);
  const x = lerp(60, 432, ease(run));
  const y = 720 - Math.sin(run * Math.PI) * 74 + splash * 56;
  const angle = splash > 0 ? 95 * clamp(splash / 1.2) : 0;

  return `${yard(scene.accent)}
  <ellipse cx="445" cy="845" rx="210" ry="92" fill="#0ea5e9" opacity="0.85"/>
  <ellipse cx="445" cy="834" rx="180" ry="60" fill="#38bdf8" opacity="0.72"/>
  ${person(x, y, 1.04, angle, "#f8fafc", scene.accent)}
  ${splash > 0 ? waterSplash(444, 782, splash, scene.accent) : ""}`;
}

function rugScene(time: number, scene: ViralScene): string {
  const walk = clamp(time / 4.2);
  const slip = Math.max(0, time - 4.2);
  const rugX = 230 + slip * 86;
  const x = lerp(70, 330, ease(walk)) + Math.min(slip, 2.1) * 78;
  const y = 750 + slip * 40;
  const angle = slip > 0 ? -130 * clamp(slip / 1.7) : 5;

  return `${room(scene.accent)}
  <rect x="${rugX}" y="868" width="250" height="58" rx="24" fill="${scene.accent}" opacity="0.62" filter="url(#shadow)"/>
  ${person(x, y, 1.04, angle, "#f8fafc", "#38bdf8")}
  ${slip > 0.45 ? speedLines(time, scene.accent) : ""}`;
}

function treadmillScene(time: number, scene: ViralScene): string {
  const speed = time < 5 ? 1 : 1 + (time - 5) * 0.7;
  const slip = Math.max(0, time - 5.7);
  const x = 350 - slip * 52;
  const y = 735 + slip * 42;
  const angle = slip > 0 ? -105 * clamp(slip / 1.2) : Math.sin(time * 8) * 7;
  const beltOffset = (time * 180 * speed) % 80;

  return `${gym(scene.accent)}
  <rect x="190" y="850" width="380" height="70" rx="30" fill="#020617" stroke="#64748b" stroke-width="8"/>
  ${Array.from({ length: 7 }, (_, i) => `<rect x="${190 + i * 80 - beltOffset}" y="882" width="42" height="8" rx="4" fill="${scene.accent}" opacity="0.55"/>`).join("")}
  ${person(x, y, 1.02, angle, "#f8fafc", scene.accent)}
  <text x="230" y="700" fill="${scene.accent}" font-size="34" font-family="Arial, Helvetica, sans-serif" font-weight="900">SPEED ${speed.toFixed(1)}x</text>`;
}

function foamWallScene(time: number, scene: ViralScene): string {
  const sprint = clamp(time / 4.6);
  const hit = Math.max(0, time - 4.6);
  const x = lerp(20, 470, ease(sprint)) - Math.sin(Math.min(hit, 1.2) * Math.PI) * 90;
  const y = 760 + hit * 30;
  const angle = hit > 0 ? -75 * clamp(hit / 1.4) : 12;

  return `${studio(scene.accent)}
  <rect x="520" y="470" width="86" height="420" rx="28" fill="#e5e7eb" opacity="0.82" filter="url(#shadow)"/>
  <text x="522" y="448" fill="#e5e7eb" font-size="24" font-family="Arial, Helvetica, sans-serif">FOAM</text>
  ${person(x, y, 1.05, angle, "#f8fafc", scene.accent)}
  ${hit > 0 ? starBurst(512, 635, 114, scene.accent, 14, 0.58) : ""}`;
}

function recapScene(time: number, scene: ViralScene): string {
  const bar = (label: string, y: number, value: number, color: string) => `
    <text x="90" y="${y - 22}" fill="#f8fafc" font-size="32" font-family="Arial, Helvetica, sans-serif" font-weight="800">${label}</text>
    <rect x="90" y="${y}" width="540" height="42" rx="21" fill="#020617" opacity="0.7"/>
    <rect x="90" y="${y}" width="${540 * value * clamp(time / 4)}" height="42" rx="21" fill="${color}"/>
    <text x="${104 + 540 * value * clamp(time / 4)}" y="${y + 31}" fill="#f8fafc" font-size="25" font-family="Arial, Helvetica, sans-serif" font-weight="900">${Math.round(value * 100)}</text>`;
  const confetti = Array.from({ length: 42 }, (_, i) => {
    const x = (i * 97 + Math.sin(time + i) * 60) % width;
    const y = (120 + i * 31 + time * (60 + (i % 5) * 18)) % 900;
    return `<rect x="${x}" y="${y}" width="10" height="22" rx="3" fill="${i % 3 === 0 ? scene.accent : i % 3 === 1 ? "#38bdf8" : "#facc15"}" transform="rotate(${time * 80 + i * 11} ${x} ${y})" opacity="0.8"/>`;
  }).join("");

  return `<rect x="0" y="0" width="${width}" height="${height}" fill="#07111f"/>
  ${confetti}
  <text x="72" y="270" fill="#f8fafc" font-size="66" font-family="Arial, Helvetica, sans-serif" font-weight="900">VEREDITO</text>
  <text x="72" y="330" fill="${scene.accent}" font-size="40" font-family="Arial, Helvetica, sans-serif" font-weight="900">GREENLIGHT</text>
  ${bar("Trend", 470, 0.88, "#22d3ee")}
  ${bar("Complexidade baixa", 600, 0.72, "#facc15")}
  ${bar("Faturavel", 730, 0.84, "#4ade80")}
  <text x="90" y="890" fill="#cbd5e1" font-size="28" font-family="Arial, Helvetica, sans-serif">Case sintetico pronto para testar edicao, ritmo e score.</text>`;
}

function sceneAt(globalTime: number): { scene: ViralScene; localTime: number; sceneIndex: number } {
  let cursor = 0;
  for (const [index, scene] of scenes.entries()) {
    if (globalTime < cursor + scene.duration || index === scenes.length - 1) {
      return { scene, localTime: globalTime - cursor, sceneIndex: index };
    }
    cursor += scene.duration;
  }
  return { scene: scenes[scenes.length - 1], localTime: scenes[scenes.length - 1].duration, sceneIndex: scenes.length - 1 };
}

function buildManifest(outputPath: string): RightsManifest {
  let cursor = 0;
  const assets = scenes.map((scene) => {
    const start = cursor;
    cursor += scene.duration;
    return {
      id: scene.id,
      localPath: outputPath,
      licenseBasis: "owned" as const,
      start: secondsToClock(start),
      duration: secondsToClock(scene.duration),
      editorialPurpose: `Original synthetic slapstick segment for the viral cassetadas demo: ${scene.title}.`,
      approvedBy: "ytfun-viral-demo-generator",
    };
  });

  return {
    projectTitle: "YTfun viral cassetadas demo",
    editor: "ytfun-viral-demo-generator",
    assets,
  };
}

function buildEditMetadata(outputPath: string): unknown {
  return {
    projectTitle: "YTfun viral cassetadas demo",
    generatedAt: new Date().toISOString(),
    format: {
      width,
      height,
      fps: outputFps,
      durationSeconds,
      orientation: "vertical",
    },
    outputPath,
    scenes: scenes.map((scene, index) => ({
      index: index + 1,
      id: scene.id,
      title: scene.title,
      caption: scene.caption,
      durationSeconds: scene.duration,
      ownedSynthetic: true,
      viralSignals: ["fast hook", "safe slapstick", "caption overlay", "replay beat", "shareable verdict"],
    })),
  };
}

async function writeSoundtrack(path: string): Promise<void> {
  const sampleRate = 44100;
  const samples = durationSeconds * sampleRate;
  const data = Buffer.alloc(samples * 2);
  const impactTimes = scenes.map((_, index) => index * 10 + 5.15).filter((time) => time < durationSeconds - 2);

  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    let sample = 0;
    const beat = t % 0.5;
    if (beat < 0.16) sample += Math.sin(Math.PI * 2 * 82 * t) * Math.exp(-beat * 24) * 0.3;
    const tick = t % 0.25;
    if (tick < 0.035) sample += Math.sin(Math.PI * 2 * 2200 * t) * Math.exp(-tick * 80) * 0.045;
    sample += Math.sin(Math.PI * 2 * 146.83 * t) * 0.025 * (0.5 + 0.5 * Math.sin(Math.PI * 2 * 0.25 * t));

    for (const impact of impactTimes) {
      const dt = t - impact;
      if (dt >= 0 && dt < 0.68) {
        const freq = 620 - dt * 520;
        sample += Math.sin(Math.PI * 2 * freq * t) * Math.exp(-dt * 4.8) * 0.22;
      }
      if (dt >= 0 && dt < 0.1) {
        sample += pseudoNoise(i) * Math.exp(-dt * 45) * 0.16;
      }
    }

    const clamped = Math.max(-0.9, Math.min(0.9, sample));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }

  await writeFile(path, wavHeader(samples, sampleRate, 1, 16));
  await writeFile(path, data, { flag: "a" });
}

function wavHeader(samples: number, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = samples * blockAlign;
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function person(x: number, y: number, scale: number, angle: number, color: string, accent: string): string {
  return `<g transform="translate(${x} ${y}) rotate(${angle}) scale(${scale})" filter="url(#shadow)">
    <circle cx="0" cy="-120" r="34" fill="${color}"/>
    <rect x="-26" y="-84" width="52" height="92" rx="22" fill="${accent}"/>
    <line x1="-20" y1="-54" x2="-76" y2="-8" stroke="${color}" stroke-width="18" stroke-linecap="round"/>
    <line x1="20" y1="-54" x2="78" y2="-14" stroke="${color}" stroke-width="18" stroke-linecap="round"/>
    <line x1="-16" y1="2" x2="-62" y2="92" stroke="${color}" stroke-width="20" stroke-linecap="round"/>
    <line x1="18" y1="2" x2="68" y2="88" stroke="${color}" stroke-width="20" stroke-linecap="round"/>
  </g>`;
}

function scooter(x: number, y: number, angle: number, accent: string): string {
  return `<g transform="translate(${x} ${y}) rotate(${angle})">
    <line x1="-70" y1="0" x2="62" y2="0" stroke="${accent}" stroke-width="15" stroke-linecap="round"/>
    <line x1="38" y1="-6" x2="18" y2="-110" stroke="#e2e8f0" stroke-width="12" stroke-linecap="round"/>
    <line x1="-60" y1="22" x2="64" y2="22" stroke="#0f172a" stroke-width="14" stroke-linecap="round"/>
    <circle cx="-58" cy="25" r="18" fill="#cbd5e1"/>
    <circle cx="58" cy="25" r="18" fill="#cbd5e1"/>
  </g>`;
}

function skateboard(x: number, y: number, angle: number, accent: string): string {
  return `<g transform="translate(${x} ${y}) rotate(${angle})">
    <rect x="-86" y="-14" width="172" height="28" rx="14" fill="${accent}"/>
    <circle cx="-54" cy="24" r="14" fill="#cbd5e1"/>
    <circle cx="54" cy="24" r="14" fill="#cbd5e1"/>
  </g>`;
}

function chair(x: number, y: number, accent: string, angle: number): string {
  return `<g transform="translate(${x} ${y}) rotate(${angle})" filter="url(#shadow)">
    <rect x="-52" y="-112" width="104" height="88" rx="14" fill="${accent}"/>
    <rect x="-72" y="-30" width="144" height="36" rx="18" fill="#e2e8f0"/>
    <line x1="-48" y1="0" x2="-70" y2="94" stroke="#94a3b8" stroke-width="10"/>
    <line x1="48" y1="0" x2="70" y2="94" stroke="#94a3b8" stroke-width="10"/>
  </g>`;
}

function desk(x: number, y: number): string {
  return `<rect x="${x}" y="${y}" width="238" height="34" rx="10" fill="#334155"/>
  <rect x="${x + 18}" y="${y - 102}" width="102" height="72" rx="8" fill="#1e293b" stroke="#64748b" stroke-width="6"/>
  <line x1="${x + 34}" y1="${y + 34}" x2="${x + 8}" y2="${y + 170}" stroke="#475569" stroke-width="10"/>
  <line x1="${x + 210}" y1="${y + 34}" x2="${x + 238}" y2="${y + 170}" stroke="#475569" stroke-width="10"/>`;
}

function box(x: number, y: number, w: number, h: number, color: string, angle: number): string {
  return `<g transform="translate(${x} ${y}) rotate(${angle})">
    <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="8" fill="${color}" stroke="#f8fafc" stroke-width="4"/>
    <line x1="${-w / 2}" y1="0" x2="${w / 2}" y2="0" stroke="#f8fafc" stroke-width="4" opacity="0.6"/>
  </g>`;
}

function street(accent: string): string {
  return `<rect x="0" y="820" width="${width}" height="460" fill="#111827"/>
  <path d="M0 890 C170 836 360 860 720 800 L720 1280 L0 1280 Z" fill="#1f2937"/>
  ${Array.from({ length: 8 }, (_, i) => `<rect x="${i * 120 - 20}" y="${925 + i * 2}" width="64" height="12" rx="6" fill="${accent}" opacity="0.42"/>`).join("")}`;
}

function room(accent: string): string {
  return `<rect x="0" y="800" width="${width}" height="480" fill="#111827"/>
  <rect x="0" y="220" width="${width}" height="580" fill="#172033"/>
  <line x1="0" y1="800" x2="${width}" y2="800" stroke="${accent}" stroke-width="7" opacity="0.42"/>
  ${Array.from({ length: 6 }, (_, i) => `<rect x="${60 + i * 116}" y="292" width="66" height="102" rx="12" fill="#0f172a" opacity="0.55"/>`).join("")}`;
}

function gym(accent: string): string {
  return `<rect x="0" y="790" width="${width}" height="490" fill="#111827"/>
  <rect x="0" y="220" width="${width}" height="570" fill="#10202b"/>
  <circle cx="126" cy="360" r="60" fill="${accent}" opacity="0.15"/>
  <circle cx="590" cy="410" r="86" fill="${accent}" opacity="0.13"/>
  <line x1="0" y1="790" x2="${width}" y2="790" stroke="${accent}" stroke-width="7" opacity="0.5"/>`;
}

function mall(accent: string): string {
  return `<rect x="0" y="820" width="${width}" height="460" fill="#172033"/>
  <rect x="0" y="230" width="${width}" height="590" fill="#101827"/>
  <rect x="60" y="312" width="240" height="260" rx="26" fill="${accent}" opacity="0.12"/>
  <rect x="74" y="326" width="212" height="232" rx="20" fill="#020617" opacity="0.35"/>
  <line x1="0" y1="820" x2="${width}" y2="820" stroke="#94a3b8" stroke-width="6" opacity="0.45"/>`;
}

function hallway(accent: string): string {
  return `<polygon points="0,1280 720,1280 520,640 200,640" fill="#111827"/>
  <polygon points="0,260 200,640 520,640 720,260" fill="#172033"/>
  <line x1="200" y1="640" x2="0" y2="1280" stroke="${accent}" stroke-width="8" opacity="0.34"/>
  <line x1="520" y1="640" x2="720" y2="1280" stroke="${accent}" stroke-width="8" opacity="0.34"/>`;
}

function yard(accent: string): string {
  return `<rect x="0" y="790" width="${width}" height="490" fill="#064e3b"/>
  <rect x="0" y="220" width="${width}" height="570" fill="#0f766e"/>
  <circle cx="110" cy="320" r="80" fill="${accent}" opacity="0.16"/>
  <circle cx="580" cy="290" r="120" fill="#bae6fd" opacity="0.12"/>`;
}

function studio(accent: string): string {
  return `<rect x="0" y="790" width="${width}" height="490" fill="#111827"/>
  <rect x="0" y="220" width="${width}" height="570" fill="#191027"/>
  <circle cx="154" cy="322" r="82" fill="${accent}" opacity="0.16"/>
  <rect x="80" y="840" width="560" height="28" rx="14" fill="${accent}" opacity="0.32"/>`;
}

function speedLines(time: number, accent: string): string {
  return Array.from({ length: 16 }, (_, i) => {
    const x = (i * 93 - ((time * 210) % 93)) % 780 - 40;
    const y = 430 + ((i * 71) % 390);
    return `<line x1="${x}" y1="${y}" x2="${x + 62}" y2="${y - 18}" stroke="${accent}" stroke-width="8" stroke-linecap="round" opacity="0.22"/>`;
  }).join("");
}

function starBurst(x: number, y: number, radius: number, color: string, points: number, opacity: number): string {
  const lines = Array.from({ length: points }, (_, i) => {
    const angle = (Math.PI * 2 * i) / points;
    return `<line x1="${x}" y1="${y}" x2="${x + Math.cos(angle) * radius}" y2="${y + Math.sin(angle) * radius}" stroke="${color}" stroke-width="9" stroke-linecap="round" opacity="${opacity}"/>`;
  }).join("");
  return `<g>${lines}<circle cx="${x}" cy="${y}" r="34" fill="${color}" opacity="${opacity * 0.6}"/></g>`;
}

function impactMarks(x: number, y: number, color: string): string {
  return `${starBurst(x, y, 76, color, 8, 0.5)}
  <text x="${x - 72}" y="${y - 58}" fill="${color}" font-size="42" font-family="Arial, Helvetica, sans-serif" font-weight="900">POW</text>`;
}

function motionStars(x: number, y: number, color: string): string {
  return Array.from({ length: 5 }, (_, i) => {
    const px = x + i * 44;
    const py = y + Math.sin(i) * 34;
    return starBurst(px, py, 22, color, 5, 0.5);
  }).join("");
}

function waterSplash(x: number, y: number, time: number, color: string): string {
  return Array.from({ length: 22 }, (_, i) => {
    const angle = -Math.PI + (Math.PI * 2 * i) / 22;
    const dist = Math.min(160, time * 120 + (i % 4) * 16);
    return `<circle cx="${x + Math.cos(angle) * dist}" cy="${y + Math.sin(angle) * dist * 0.65}" r="${10 + (i % 3) * 4}" fill="${i % 2 ? color : "#e0f2fe"}" opacity="${Math.max(0, 0.8 - time * 0.14)}"/>`;
  }).join("");
}

function polygon(points: Array<[number, number]>, fill: string): string {
  return `<polygon points="${points.map(([x, y]) => `${x},${y}`).join(" ")}" fill="${fill}"/>`;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}

function secondsToClock(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `00:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function relativeToCwd(path: string): string {
  return path.replace(`${resolve(process.cwd())}/`, "");
}

function pseudoNoise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function ease(value: number): number {
  return value * value * (3 - 2 * value);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function lerp(from: number, to: number, value: number): number {
  return from + (to - from) * value;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
