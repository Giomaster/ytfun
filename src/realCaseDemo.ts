import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { auditRightsManifest } from "./compliance.js";
import { assertFfmpegAvailable } from "./ffmpeg.js";
import { writeJsonFile } from "./io.js";
import type { ManifestAudit, RightsManifest } from "./types.js";

interface RealClip {
  id: string;
  localPath: string;
  sourceUrl: string;
  creator: string;
  title: string;
  ss: string;
  duration: string;
  caption: string;
  tag: string;
}

interface AudioAsset {
  id: string;
  localPath: string;
  sourceUrl: string;
  title: string;
  creator: string;
  role: "music" | "sfx";
  usedInLazyMode: boolean;
}

interface Segment {
  id: string;
  clip: RealClip;
  ss: string;
  duration: string;
  caption: string;
  tag: string;
  label?: string;
}

type VisualMode = "none" | "minimal";

const clips: RealClip[] = [
  {
    id: "confetti-8143317",
    localPath: "data/cases/real-cassetadas/sources/confetti-8143317.mp4",
    sourceUrl: "https://www.pexels.com/video/falling-confetti-8143317/",
    creator: "olia danilevich",
    title: "Falling Confetti",
    ss: "00:00:00",
    duration: "00:00:08",
    caption: "case real: clips licenciados + edicao",
    tag: "HOOK",
  },
  {
    id: "skateboarder-falling-4759036",
    localPath: "data/cases/real-cassetadas/sources/skateboarder-falling-4759036.mp4",
    sourceUrl: "https://www.pexels.com/video/a-skateboarder-falling-4759036/",
    creator: "Tima Miroshnichenko",
    title: "A Skateboarder Falling",
    ss: "00:00:00",
    duration: "00:00:06",
    caption: "quando o plano era so pousar",
    tag: "SKATE",
  },
  {
    id: "skateboard-rooftop-fall-2791953",
    localPath: "data/cases/real-cassetadas/sources/skateboard-rooftop-fall-2791953.mp4",
    sourceUrl: "https://www.pexels.com/video/person-falling-down-from-skateboard-2791953/",
    creator: "cottonbro studio",
    title: "Skateboarder falls on a rooftop terrace",
    ss: "00:00:01",
    duration: "00:00:08",
    caption: "o rooftop nao perdoa",
    tag: "ROOFTOP",
  },
  {
    id: "sofa-fall-3700267",
    localPath: "data/cases/real-cassetadas/sources/sofa-fall-3700267.mp4",
    sourceUrl: "https://www.pexels.com/video/funny-video-of-a-man-falling-from-a-sofa-3700267/",
    creator: "RingTheBell.com Task Manager",
    title: "A playful scene of a man jumping playfully over a sofa indoors",
    ss: "00:00:02",
    duration: "00:00:10",
    caption: "sala de estar, modo acrobacia",
    tag: "SOFA",
  },
  {
    id: "skate-flip-fall-5155837",
    localPath: "data/cases/real-cassetadas/sources/skate-flip-fall-5155837.mp4",
    sourceUrl: "https://www.pexels.com/video/a-skateboarder-falls-while-doing-a-flip-5155837/",
    creator: "Budgeron Bach",
    title: "Skateboarder performs stylish tricks in a modern urban skatepark",
    ss: "00:00:00",
    duration: "00:00:06",
    caption: "flip bonito, final honesto",
    tag: "FLIP",
  },
];

const audioAssets: AudioAsset[] = [
  {
    id: "mixkit-upbeat-jazz-644",
    localPath: "data/cases/real-cassetadas/audio/mixkit-upbeat-jazz-644.mp3",
    sourceUrl: "https://mixkit.co/free-stock-music/upbeat/",
    title: "Upbeat Jazz",
    creator: "Francisco Alvear / Mixkit",
    role: "music",
    usedInLazyMode: true,
  },
  {
    id: "mixkit-fast-rocket-whoosh-1714",
    localPath: "data/cases/real-cassetadas/audio/mixkit-fast-rocket-whoosh-1714.mp3",
    sourceUrl: "https://mixkit.co/free-sound-effects/whoosh/",
    title: "Fast rocket whoosh",
    creator: "Mixkit",
    role: "sfx",
    usedInLazyMode: false,
  },
  {
    id: "mixkit-fast-small-sweep-166",
    localPath: "data/cases/real-cassetadas/audio/mixkit-fast-small-sweep-166.mp3",
    sourceUrl: "https://mixkit.co/free-sound-effects/sweep/",
    title: "Fast small sweep transition",
    creator: "Mixkit",
    role: "sfx",
    usedInLazyMode: true,
  },
  {
    id: "mixkit-martial-arts-fast-punch-616",
    localPath: "data/cases/real-cassetadas/audio/mixkit-martial-arts-fast-punch-616.mp3",
    sourceUrl: "https://mixkit.co/free-sound-effects/punch/",
    title: "Martial arts fast punch",
    creator: "Mixkit",
    role: "sfx",
    usedInLazyMode: false,
  },
  {
    id: "mixkit-cool-impact-movie-trailer-1489",
    localPath: "data/cases/real-cassetadas/audio/mixkit-cool-impact-movie-trailer-1489.mp3",
    sourceUrl: "https://mixkit.co/free-sound-effects/impact/",
    title: "Cool impact movie trailer",
    creator: "Mixkit",
    role: "sfx",
    usedInLazyMode: false,
  },
  {
    id: "mixkit-cartoon-toy-whistle-13",
    localPath: "data/cases/real-cassetadas/audio/mixkit-cartoon-toy-whistle-13.mp3",
    sourceUrl: "https://mixkit.co/free-sound-effects/funny/",
    title: "Cartoon toy whistle",
    creator: "Mixkit",
    role: "sfx",
    usedInLazyMode: false,
  },
];

const segments: Segment[] = [
  { id: "hook", clip: clips[0], ss: "00:00:00", duration: "00:00:03", caption: "case real: clips licenciados + edicao", tag: "REAL CASE", label: "BAIXO LIFT" },
  { id: "skate-main", clip: clips[1], ss: "00:00:00", duration: "00:00:06", caption: "quando o plano era so pousar", tag: "MOMENTO 1" },
  { id: "skate-replay", clip: clips[1], ss: "00:00:03", duration: "00:00:03", caption: "replay: o pe desistiu primeiro", tag: "REPLAY", label: "REPLAY" },
  { id: "roof-main", clip: clips[2], ss: "00:00:01", duration: "00:00:08", caption: "o rooftop nao perdoa", tag: "MOMENTO 2" },
  { id: "roof-replay", clip: clips[2], ss: "00:00:05", duration: "00:00:03", caption: "replay: gravidade venceu", tag: "REPLAY", label: "REPLAY" },
  { id: "sofa-main", clip: clips[3], ss: "00:00:02", duration: "00:00:09", caption: "sala de estar, modo acrobacia", tag: "MOMENTO 3" },
  { id: "sofa-replay", clip: clips[3], ss: "00:00:07", duration: "00:00:03", caption: "replay: sofa 1 x 0 atleta", tag: "REPLAY", label: "REPLAY" },
  { id: "flip-main", clip: clips[4], ss: "00:00:00", duration: "00:00:06", caption: "flip bonito, final honesto", tag: "MOMENTO 4" },
  { id: "flip-replay", clip: clips[4], ss: "00:00:03", duration: "00:00:03", caption: "replay: quase viral por tecnica", tag: "REPLAY", label: "REPLAY" },
  { id: "outro", clip: clips[0], ss: "00:00:00", duration: "00:00:06", caption: "pronto para editar", tag: "SCORE", label: "GREENLIGHT" },
];

export async function createRealCaseDemo(
  outputPath: string,
  options: { visualMode?: VisualMode } = {},
): Promise<{ outputPath: string; manifest: RightsManifest; audit: ManifestAudit }> {
  const ffmpegPath = assertFfmpegAvailable();
  const visualMode = options.visualMode ?? "none";
  const outAbs = resolve(process.cwd(), outputPath);
  const caseDir = dirname(outAbs);
  const segmentDir = resolve(caseDir, "segments");
  const concatPath = resolve(caseDir, "concat.txt");

  await mkdir(segmentDir, { recursive: true });
  await assertSourcesExist();

  const segmentFiles: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const file = resolve(segmentDir, `${String(index + 1).padStart(2, "0")}-${segment.id}.mp4`);
    renderSegment(ffmpegPath, segment, file, visualMode);
    segmentFiles.push(file);
  }

  await writeFile(concatPath, segmentFiles.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
  encodeFinal(ffmpegPath, concatPath, outAbs);

  const manifest = buildManifest();
  const manifestPath = resolve(caseDir, "rights-manifest.json");
  const editPath = resolve(caseDir, "real-case-edit-plan.json");
  await writeJsonFile(relativeToCwd(manifestPath), manifest);
  await writeJsonFile(relativeToCwd(editPath), buildEditMetadata(outputPath, visualMode));
  const audit = await auditRightsManifest(manifest, { checkFiles: true, maxClipSeconds: 12 });

  return { outputPath, manifest, audit };
}

async function assertSourcesExist(): Promise<void> {
  const missing: string[] = [];
  for (const asset of [...clips, ...audioAssets]) {
    try {
      await access(resolve(process.cwd(), asset.localPath));
    } catch {
      missing.push(asset.localPath);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing source clips:\n- ${missing.join("\n- ")}`);
  }
}

function renderSegment(ffmpegPath: string, segment: Segment, outputPath: string, visualMode: VisualMode): void {
  const fontRegular = fontPath(false);
  const fontBold = fontPath(true);
  const overlay = visualOverlay(visualMode, segment, fontRegular, fontBold);
  const filter = [
    "[0:v]split=2[bg][fg]",
    "[bg]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,gblur=sigma=28,eq=brightness=-0.14:saturation=0.95[bg2]",
    "[fg]scale=720:1280:force_original_aspect_ratio=decrease,setsar=1[fg2]",
    `[bg2][fg2]overlay=(W-w)/2:(H-h)/2:shortest=1${overlay ? `,${overlay}` : ""},fps=30,format=yuv420p[v]`,
  ].join(";");

  const result = spawnSync(
    ffmpegPath,
    [
      "-y",
      "-ss",
      segment.ss,
      "-t",
      segment.duration,
      "-i",
      resolve(process.cwd(), segment.clip.localPath),
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-r",
      "30",
      "-pix_fmt",
      "yuv420p",
      outputPath,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to render ${segment.id}:\n${result.stderr}`);
  }
}

function encodeFinal(ffmpegPath: string, concatPath: string, outputPath: string): void {
  const music = audioAssets.find((asset) => asset.role === "music");
  if (!music) throw new Error("Music asset is required");
  const sfx = audioAssets.filter((asset) => asset.role === "sfx" && asset.usedInLazyMode);
  const inputs = [
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-stream_loop",
    "-1",
    "-i",
    resolve(process.cwd(), music.localPath),
    ...sfx.flatMap((asset) => ["-i", resolve(process.cwd(), asset.localPath)]),
  ];
  const audioFilter = buildAudioFilter(sfx.length);
  const result = spawnSync(
    ffmpegPath,
    [
      "-y",
      ...inputs,
      "-filter_complex",
      audioFilter,
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-shortest",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-r",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to encode real case demo:\n${result.stderr}`);
  }
}

function buildManifest(): RightsManifest {
  return {
    projectTitle: "YTfun real cassetadas case",
    editor: "ytfun-real-case-generator",
    assets: [
      ...clips.map((clip) => ({
        id: clip.id,
        localPath: clip.localPath,
        sourceUrl: clip.sourceUrl,
        licenseBasis: "licensed" as const,
        permissionEvidence: "https://www.pexels.com/license/",
        start: clip.ss,
        duration: clip.duration,
        editorialPurpose: `Licensed Pexels source footage used as a real low-lift editing case: ${clip.title}. Creator: ${clip.creator}.`,
        approvedBy: "ytfun-real-case-generator",
      })),
      ...audioAssets.filter((asset) => asset.usedInLazyMode).map((asset) => ({
        id: asset.id,
        localPath: asset.localPath,
        sourceUrl: asset.sourceUrl,
        licenseBasis: "licensed" as const,
        permissionEvidence: "https://mixkit.co/license/",
        start: "00:00:00",
        duration: "00:00:06",
        editorialPurpose: `Licensed Mixkit ${asset.role} asset used to improve pacing and audio fit: ${asset.title}.`,
        approvedBy: "ytfun-real-case-generator",
      })),
    ],
  };
}

function buildEditMetadata(outputPath: string, visualMode: VisualMode): unknown {
  return {
    projectTitle: "YTfun real cassetadas case",
    generatedAt: new Date().toISOString(),
    outputPath,
    format: {
      width: 720,
      height: 1280,
      orientation: "vertical",
      target: "shorts/reels/tiktok",
      durationSeconds: totalDurationSeconds(),
      visualMode,
    },
    sources: clips.map((clip) => ({
      id: clip.id,
      title: clip.title,
      creator: clip.creator,
      sourceUrl: clip.sourceUrl,
      licenseEvidence: "https://www.pexels.com/license/",
      sourceOrigin: "likely_licensed_or_permissioned",
    })),
    audio: audioAssets.filter((asset) => asset.usedInLazyMode).map((asset) => ({
      id: asset.id,
      title: asset.title,
      creator: asset.creator,
      role: asset.role,
      sourceUrl: asset.sourceUrl,
      licenseEvidence: "https://mixkit.co/license/",
    })),
    segments: segments.map((segment, index) => ({
      index: index + 1,
      id: segment.id,
      sourceId: segment.clip.id,
      start: segment.ss,
      duration: segment.duration,
      caption: segment.caption,
      editorialLift: "low",
    })),
  };
}

function visualOverlay(visualMode: VisualMode, segment: Segment, fontRegular: string, fontBold: string): string {
  if (visualMode === "none") return "";
  const outro = segment.id === "outro" ? scoreOverlay(fontBold) : "";
  return [
    "drawbox=x=0:y=0:w=720:h=1280:color=black@0.06:t=fill",
    "drawbox=x=34:y=44:w=652:h=4:color=white@0.18:t=fill",
    `drawbox=x=34:y=44:w=${progressWidth(segment)}:h=4:color=0xffffff@0.72:t=fill`,
    drawTextShadow("cassetadas", 42, 94, 22, "white", fontBold, 2),
    drawTextShadow(segment.tag.toLowerCase(), 42, 128, 17, "0xd1d5db", fontRegular, 1),
    drawTextShadow(segment.caption, 42, 1100, 34, "white", fontBold, 3),
    drawTextShadow("@ytfun", 42, 1198, 21, "0xe5e7eb", fontRegular, 1),
    outro,
  ].filter(Boolean).join(",");
}

function scoreOverlay(fontBold: string): string {
  return [
    drawTextShadow("GREENLIGHT", 64, 470, 54, "white", fontBold, 4),
    drawTextShadow("baixo lift, edicao limpa", 64, 532, 27, "0xe5e7eb", fontBold, 2),
  ].join(",");
}

function drawPill(text: string, x: number, y: number, color: string, font: string): string {
  return [
    `drawbox=x=${x}:y=${y}:w=${Math.max(150, text.length * 17)}:h=48:color=${color}@0.92:t=fill`,
    drawText(text, x + 18, y + 33, 24, "black", font),
  ].join(",");
}

function drawText(text: string, x: number, y: number, size: number, color: string, font: string): string {
  return `drawtext=fontfile='${escapeFilter(font)}':text='${escapeFilter(text)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}:line_spacing=12`;
}

function drawTextShadow(text: string, x: number, y: number, size: number, color: string, font: string, border: number): string {
  return `${drawText(text, x, y, size, color, font)}:borderw=${border}:bordercolor=0x000000@0.72`;
}

function drawTextBox(
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  boxColor: string,
  font: string,
  padding: number,
): string {
  return `${drawText(text, x, y, size, color, font)}:box=1:boxcolor=${boxColor}:boxborderw=${padding}`;
}

function buildAudioFilter(sfxCount: number): string {
  const duration = totalDurationSeconds();
  const transitionInput = sfxCount > 0 ? 2 : undefined;
  const events = transitionInput === undefined
    ? []
    : segmentStartTimes().slice(1).map((at) => ({ input: transitionInput, at, volume: 0.16 }));
  const chains = [`[1:a]atrim=0:${duration},volume=0.34,afade=t=out:st=${Math.max(0, duration - 1.5)}:d=1.5[music]`];
  const labels = ["[music]"];
  for (const [index, event] of events.entries()) {
    const label = `sfx${index}`;
    chains.push(
      `[${event.input}:a]atrim=0:1.2,volume=${event.volume},adelay=${Math.round(event.at * 1000)}:all=1[${label}]`,
    );
    labels.push(`[${label}]`);
  }
  chains.push(`${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0,alimiter=limit=0.92[aout]`);
  return chains.join(";");
}

function progressWidth(segment: Segment): number {
  const index = segments.findIndex((item) => item.id === segment.id);
  return Math.max(28, Math.round(652 * ((index + 1) / segments.length)));
}

function totalDurationSeconds(): number {
  return segments.reduce((sum, segment) => sum + durationSeconds(segment.duration), 0);
}

function segmentStartTimes(): number[] {
  let cursor = 0;
  return segments.map((segment) => {
    const start = cursor;
    cursor += durationSeconds(segment.duration);
    return start;
  });
}

function durationSeconds(clock: string): number {
  const [hours, minutes, seconds] = clock.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

function fontPath(bold: boolean): string {
  if (process.platform === "darwin") {
    return bold
      ? "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
      : "/System/Library/Fonts/Supplemental/Arial.ttf";
  }
  return bold ? "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
}

function escapeFilter(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function relativeToCwd(path: string): string {
  return path.replace(`${resolve(process.cwd())}/`, "");
}
