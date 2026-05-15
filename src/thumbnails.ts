import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { assertFfmpegAvailable } from "./ffmpeg.js";
import { readJsonFile, writeJsonFile } from "./io.js";

export interface ThumbnailConfig {
  format?: "png" | "jpeg";
  width?: number;
  height?: number;
  defaults?: ThumbnailStyle;
  variants: ThumbnailVariant[];
}

export interface ThumbnailStyle {
  videoPath?: string;
  timestamp?: string;
  effectText?: string;
  accent?: string;
  textColor?: string;
  gradientOpacity?: number;
  gradientCenterXPercent?: number;
  gradientCenterYPercent?: number;
  gradientRadiusPercent?: number;
}

export interface ThumbnailVariant extends ThumbnailStyle {
  id: string;
}

export interface ThumbnailOutput {
  generatedAt: string;
  width: number;
  height: number;
  files: Array<{
    id: string;
    path: string;
    sourcePath: string;
    timestamp: string;
    effectText?: string;
  }>;
}

interface ResolvedThumbnailStyle {
  videoPath: string;
  timestamp: string;
  effectText?: string;
  accent: string;
  textColor: string;
  gradientOpacity: number;
  gradientCenterXPercent: number;
  gradientCenterYPercent: number;
  gradientRadiusPercent: number;
}

export async function loadThumbnailConfig(path: string): Promise<ThumbnailConfig> {
  const config = await readJsonFile<ThumbnailConfig>(path);
  validateThumbnailConfig(config);
  return config;
}

export async function renderThumbnails(config: ThumbnailConfig, outDir: string): Promise<ThumbnailOutput> {
  const width = config.width ?? 1280;
  const height = config.height ?? 720;
  const format = config.format ?? "png";
  const ffmpegPath = assertFfmpegAvailable();
  await mkdir(outDir, { recursive: true });

  const files = [];
  for (const variant of config.variants) {
    const style = resolveStyle(config.defaults, variant);
    const extension = format === "jpeg" ? "jpg" : "png";
    const outputPath = resolve(outDir, `${safeName(variant.id)}.${extension}`);
    await renderFrameThumbnail({
      ffmpegPath,
      sourcePath: resolve(process.cwd(), style.videoPath),
      outputPath,
      style,
      width,
      height,
      format,
    });
    files.push({
      id: variant.id,
      path: relativeToCwd(outputPath),
      sourcePath: style.videoPath,
      timestamp: style.timestamp,
      effectText: style.effectText,
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    width,
    height,
    files,
  };
  await writeJsonFile(resolve(outDir, "thumbnails-output.json"), output);
  return output;
}

async function renderFrameThumbnail(options: {
  ffmpegPath: string;
  sourcePath: string;
  outputPath: string;
  style: ResolvedThumbnailStyle;
  width: number;
  height: number;
  format: "png" | "jpeg";
}): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "ytfun-thumbnail-"));
  const framePath = join(tempDir, "frame.png");
  try {
    extractFrame(options.ffmpegPath, options.sourcePath, options.style.timestamp, framePath);
    const overlay = buildForegroundOverlay(options.style, options.width, options.height);
    const image = sharp(framePath)
      .resize(options.width, options.height, {
        fit: "cover",
        position: sharp.strategy.attention,
      })
      .composite([{ input: Buffer.from(overlay), blend: "over" }]);

    if (options.format === "jpeg") {
      await image.jpeg({ quality: 92, mozjpeg: true }).toFile(options.outputPath);
    } else {
      await image.png({ compressionLevel: 8 }).toFile(options.outputPath);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function extractFrame(ffmpegPath: string, sourcePath: string, timestamp: string, framePath: string): void {
  const result = spawnSync(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      timestamp,
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      framePath,
    ],
    { encoding: "utf8" },
  );

  if (result.error || result.status !== 0) {
    const reason = result.stderr || result.stdout || result.error?.message || "unknown ffmpeg error";
    throw new Error(`Failed to extract thumbnail frame from ${relativeToCwd(sourcePath)} at ${timestamp}:\n${reason}`);
  }
}

function buildForegroundOverlay(style: ResolvedThumbnailStyle, width: number, height: number): string {
  const centerX = Math.round(width * (style.gradientCenterXPercent / 100));
  const centerY = Math.round(height * (style.gradientCenterYPercent / 100));
  const radius = Math.round(Math.max(width, height) * (style.gradientRadiusPercent / 100));
  const midOpacity = Number((style.gradientOpacity * 0.42).toFixed(3));
  const effectText = style.effectText?.trim();
  const text = effectText ? buildEffectText(effectText, style.textColor, width, height) : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <radialGradient id="foregroundGlow" gradientUnits="userSpaceOnUse" cx="${centerX}" cy="${centerY}" r="${radius}">
      <stop offset="0%" stop-color="${style.accent}" stop-opacity="${style.gradientOpacity}"/>
      <stop offset="48%" stop-color="${style.accent}" stop-opacity="${midOpacity}"/>
      <stop offset="100%" stop-color="${style.accent}" stop-opacity="0"/>
    </radialGradient>
    <filter id="effectShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#foregroundGlow)"/>
  ${text}
</svg>`;
}

function buildEffectText(effectText: string, textColor: string, width: number, height: number): string {
  const length = Array.from(effectText).length;
  const fontSize = Math.round(
    length <= 3 ? width * 0.13 : length <= 6 ? width * 0.105 : length <= 10 ? width * 0.082 : width * 0.064,
  );
  const x = Math.round(width * 0.91);
  const y = Math.round(height * 0.82);
  const strokeWidth = Math.max(8, Math.round(fontSize * 0.09));

  return `<text x="${x}" y="${y}" text-anchor="end" fill="${textColor}" stroke="#000000" stroke-opacity="0.36" stroke-width="${strokeWidth}" paint-order="stroke fill" font-size="${fontSize}" font-family="Arial, Helvetica, sans-serif" font-weight="900" filter="url(#effectShadow)">${xml(effectText)}</text>`;
}

function validateThumbnailConfig(config: ThumbnailConfig): void {
  const errors: string[] = [];
  if (!Array.isArray(config.variants) || config.variants.length === 0) {
    errors.push("variants must contain at least one thumbnail");
  }
  if (config.format && config.format !== "png" && config.format !== "jpeg") {
    errors.push("format must be either png or jpeg");
  }
  if (config.width !== undefined && (!Number.isInteger(config.width) || config.width <= 0)) {
    errors.push("width must be a positive integer");
  }
  if (config.height !== undefined && (!Number.isInteger(config.height) || config.height <= 0)) {
    errors.push("height must be a positive integer");
  }
  validateStyle("defaults", config.defaults, errors);

  for (const [index, variant] of (config.variants ?? []).entries()) {
    if (!variant.id) errors.push(`variants[${index}].id is required`);
    if (!variant.videoPath && !config.defaults?.videoPath) {
      errors.push(`variants[${index}].videoPath is required when defaults.videoPath is not set`);
    }
    validateStyle(`variants[${index}]`, variant, errors);
  }
  if (errors.length > 0) {
    throw new Error(`Invalid thumbnail config:\n- ${errors.join("\n- ")}`);
  }
}

function validateStyle(label: string, style: ThumbnailStyle | undefined, errors: string[]): void {
  if (!style) return;
  if (style.accent !== undefined && !isHexColor(style.accent)) {
    errors.push(`${label}.accent must be a hex color`);
  }
  if (style.textColor !== undefined && !isHexColor(style.textColor)) {
    errors.push(`${label}.textColor must be a hex color`);
  }
  if (style.gradientOpacity !== undefined && !isUnit(style.gradientOpacity)) {
    errors.push(`${label}.gradientOpacity must be between 0 and 1`);
  }
  for (const key of ["gradientCenterXPercent", "gradientCenterYPercent", "gradientRadiusPercent"] as const) {
    const value = style[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      errors.push(`${label}.${key} must be a positive number`);
    }
  }
}

function resolveStyle(defaults: ThumbnailStyle | undefined, variant: ThumbnailVariant): ResolvedThumbnailStyle {
  const videoPath = variant.videoPath ?? defaults?.videoPath;
  if (!videoPath) {
    throw new Error(`Thumbnail variant ${variant.id} has no videoPath`);
  }
  const effectText = variant.effectText ?? defaults?.effectText;
  return {
    videoPath,
    timestamp: variant.timestamp ?? defaults?.timestamp ?? "00:00:01",
    effectText: effectText?.trim() ? effectText.trim() : undefined,
    accent: variant.accent ?? defaults?.accent ?? "#22d3ee",
    textColor: variant.textColor ?? defaults?.textColor ?? "#ffffff",
    gradientOpacity: variant.gradientOpacity ?? defaults?.gradientOpacity ?? 0.58,
    gradientCenterXPercent: clamp(variant.gradientCenterXPercent ?? defaults?.gradientCenterXPercent ?? 88, 1, 120),
    gradientCenterYPercent: clamp(variant.gradientCenterYPercent ?? defaults?.gradientCenterYPercent ?? 88, 1, 120),
    gradientRadiusPercent: clamp(variant.gradientRadiusPercent ?? defaults?.gradientRadiusPercent ?? 74, 10, 160),
  };
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "thumbnail";
}

function relativeToCwd(path: string): string {
  return path.replace(`${resolve(process.cwd())}/`, "");
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$/.test(value);
}

function isUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
