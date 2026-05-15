import { access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { auditRightsManifest } from "./compliance.js";
import { assertFfmpegAvailable } from "./ffmpeg.js";
import { readJsonFile, writeJsonFile } from "./io.js";
import type {
  FirstPartyShortCut,
  FirstPartyShortsConfig,
  FirstPartyShortsOutput,
  RightsManifest,
  ShortsVisualMode,
} from "./types.js";

export async function loadFirstPartyShortsConfig(path: string): Promise<FirstPartyShortsConfig> {
  const config = await readJsonFile<FirstPartyShortsConfig>(path);
  validateConfig(config);
  return config;
}

export async function createFirstPartyShorts(
  config: FirstPartyShortsConfig,
  outDir: string,
): Promise<{ output: FirstPartyShortsOutput; manifest: RightsManifest }> {
  const ffmpegPath = assertFfmpegAvailable();
  const visualMode = config.visualMode ?? "none";
  const sourcePath = resolve(process.cwd(), config.sourcePath);
  await access(sourcePath);
  await mkdir(outDir, { recursive: true });

  const shorts = [];
  for (const cut of config.shorts) {
    const outputPath = resolve(outDir, `${safeName(cut.id)}.mp4`);
    renderShort(ffmpegPath, sourcePath, cut, outputPath, visualMode);
    shorts.push({
      id: cut.id,
      title: cut.title,
      outputPath: relativeToCwd(outputPath),
      start: cut.start,
      duration: cut.duration,
      sourceOrigin: "likely_original_channel" as const,
      editorialLift: "low" as const,
    });
  }

  const output: FirstPartyShortsOutput = {
    projectTitle: config.projectTitle,
    generatedAt: new Date().toISOString(),
    sourcePath: config.sourcePath,
    visualMode,
    shorts,
  };
  const manifest = buildManifest(config, output);

  await writeJsonFile(resolve(outDir, "shorts-output.json"), output);
  await writeJsonFile(resolve(outDir, "rights-manifest.json"), manifest);

  const audit = await auditRightsManifest(manifest, { checkFiles: true, maxClipSeconds: 90 });
  if (!audit.ok) {
    throw new Error(`Generated first-party shorts manifest failed audit:\n- ${audit.errors.join("\n- ")}`);
  }

  return { output, manifest };
}

function renderShort(
  ffmpegPath: string,
  sourcePath: string,
  cut: FirstPartyShortCut,
  outputPath: string,
  visualMode: ShortsVisualMode,
): void {
  const filter = buildVideoFilter(cut, visualMode);
  const result = spawnSync(
    ffmpegPath,
    [
      "-y",
      "-ss",
      cut.start,
      "-t",
      cut.duration,
      "-i",
      sourcePath,
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      "-map",
      "0:a?",
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
      "128k",
      "-movflags",
      "+faststart",
      "-shortest",
      outputPath,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to render short ${cut.id}:\n${result.stderr}`);
  }
}

function buildVideoFilter(cut: FirstPartyShortCut, visualMode: ShortsVisualMode): string {
  const overlay = visualMode === "minimal" ? `,${minimalOverlay(cut)}` : "";
  return [
    "[0:v]split=2[bg][fg]",
    "[bg]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,gblur=sigma=28,eq=brightness=-0.12:saturation=0.95[bg2]",
    "[fg]scale=720:1280:force_original_aspect_ratio=decrease,setsar=1[fg2]",
    `[bg2][fg2]overlay=(W-w)/2:(H-h)/2:shortest=1${overlay},fps=30,format=yuv420p[v]`,
  ].join(";");
}

function minimalOverlay(cut: FirstPartyShortCut): string {
  const font = fontPath(true);
  const text = cut.caption ?? cut.title;
  return drawTextShadow(text, 42, 1100, 34, "white", font, 3);
}

function buildManifest(config: FirstPartyShortsConfig, output: FirstPartyShortsOutput): RightsManifest {
  return {
    projectTitle: config.projectTitle,
    editor: "ytfun-first-party-shorts",
    assets: output.shorts.map((short) => ({
      id: short.id,
      localPath: short.outputPath,
      sourceUrl: config.sourceUrl,
      licenseBasis: "owned",
      start: short.start,
      duration: short.duration,
      editorialPurpose: `First-party Short cut from original channel video: ${short.title}.`,
      approvedBy: "ytfun-first-party-shorts",
    })),
  };
}

function validateConfig(config: FirstPartyShortsConfig): void {
  const errors: string[] = [];
  if (!config.projectTitle) errors.push("projectTitle is required");
  if (!config.sourcePath) errors.push("sourcePath is required");
  if (config.visualMode && config.visualMode !== "none" && config.visualMode !== "minimal") {
    errors.push("visualMode must be none or minimal");
  }
  if (!Array.isArray(config.shorts) || config.shorts.length === 0) {
    errors.push("shorts must contain at least one cut");
  }
  for (const [index, cut] of (config.shorts ?? []).entries()) {
    if (!cut.id) errors.push(`shorts[${index}].id is required`);
    if (!cut.title) errors.push(`shorts[${index}].title is required`);
    if (!cut.start) errors.push(`shorts[${index}].start is required`);
    if (!cut.duration) errors.push(`shorts[${index}].duration is required`);
  }
  if (errors.length > 0) {
    throw new Error(`Invalid first-party shorts config:\n- ${errors.join("\n- ")}`);
  }
}

function drawTextShadow(text: string, x: number, y: number, size: number, color: string, font: string, border: number): string {
  return `drawtext=fontfile='${escapeFilter(font)}':text='${escapeFilter(text)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}:borderw=${border}:bordercolor=0x000000@0.72`;
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

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "short";
}

function relativeToCwd(path: string): string {
  return path.replace(`${resolve(process.cwd())}/`, "");
}
