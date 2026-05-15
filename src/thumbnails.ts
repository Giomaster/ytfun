import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
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
  autoFrame?: boolean;
  candidateTimestamps?: string[];
  autoAccent?: boolean;
  autoEmojis?: boolean;
  context?: string;
  effectText?: string;
  effectEmojis?: string[];
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
    effectEmojis?: string[];
    accent: string;
    autoFrameScore?: number;
  }>;
}

interface ResolvedThumbnailStyle {
  videoPath: string;
  timestamp: string;
  autoFrame: boolean;
  candidateTimestamps: string[];
  autoAccent: boolean;
  autoEmojis: boolean;
  context?: string;
  effectText?: string;
  effectEmojis: string[];
  accent: string;
  textColor: string;
  gradientOpacity: number;
  gradientCenterXPercent: number;
  gradientCenterYPercent: number;
  gradientRadiusPercent: number;
}

const emojiSvgCache = new Map<string, string>();
const NOTO_EMOJI_REF = "8998f5dd683424a73e2314a8c1f1e359c19e8742";
const DEFAULT_CANDIDATE_TIMESTAMPS = ["00:00:01", "00:00:03", "00:00:05", "00:00:08", "00:00:12", "00:00:18"];

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
    const result = await renderFrameThumbnail({
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
      timestamp: result.style.timestamp,
      effectText: result.style.effectText,
      effectEmojis: result.style.effectEmojis.length > 0 ? result.style.effectEmojis : undefined,
      accent: result.style.accent,
      autoFrameScore: result.frameScore,
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
}): Promise<{ style: ResolvedThumbnailStyle; frameScore?: number }> {
  const tempDir = await mkdtemp(join(tmpdir(), "ytfun-thumbnail-"));
  const framePath = join(tempDir, "frame.png");
  try {
    const frameSelection = await prepareFrame(options.ffmpegPath, options.sourcePath, framePath, options.style, tempDir);
    const selectedStyle = { ...options.style, timestamp: frameSelection.timestamp };
    const finalStyle = await resolveAutomaticStyle(selectedStyle, frameSelection.framePath);
    const overlay = buildForegroundOverlay(finalStyle, options.width, options.height);
    const emojiComposites = await buildEmojiComposites(finalStyle.effectEmojis, options.width, options.height);
    const image = sharp(frameSelection.framePath)
      .resize(options.width, options.height, {
        fit: "cover",
        position: sharp.strategy.attention,
      })
      .composite([{ input: Buffer.from(overlay), blend: "over" }, ...emojiComposites]);

    if (options.format === "jpeg") {
      await image.jpeg({ quality: 92, mozjpeg: true }).toFile(options.outputPath);
    } else {
      await image.png({ compressionLevel: 8 }).toFile(options.outputPath);
    }
    return { style: finalStyle, frameScore: frameSelection.score };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function prepareFrame(
  ffmpegPath: string,
  sourcePath: string,
  framePath: string,
  style: ResolvedThumbnailStyle,
  tempDir: string,
): Promise<{ framePath: string; timestamp: string; score?: number }> {
  if (!style.autoFrame) {
    extractFrame(ffmpegPath, sourcePath, style.timestamp, framePath);
    return { framePath, timestamp: style.timestamp };
  }

  const candidates = [];
  for (const [index, timestamp] of style.candidateTimestamps.entries()) {
    const candidatePath = join(tempDir, `candidate-${index}.png`);
    try {
      extractFrame(ffmpegPath, sourcePath, timestamp, candidatePath);
      const score = await scoreThumbnailFrame(candidatePath);
      candidates.push({ framePath: candidatePath, timestamp, score });
    } catch {
      // Keep trying later timestamps; short videos may not have every configured sample.
    }
  }

  const selected = candidates.sort((a, b) => b.score - a.score)[0];
  if (!selected) {
    extractFrame(ffmpegPath, sourcePath, style.timestamp, framePath);
    return { framePath, timestamp: style.timestamp };
  }
  return selected;
}

async function resolveAutomaticStyle(
  style: ResolvedThumbnailStyle,
  framePath: string,
): Promise<ResolvedThumbnailStyle> {
  const autoEmojis = style.autoEmojis && style.effectEmojis.length === 0 ? chooseContextEmojis(style.context) : [];
  const accent = style.autoAccent ? await chooseAccentFromFrame(framePath) : style.accent;
  return {
    ...style,
    accent,
    effectEmojis: autoEmojis.length > 0 ? autoEmojis : style.effectEmojis,
  };
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

async function scoreThumbnailFrame(framePath: string): Promise<number> {
  const { data, info } = await sharp(framePath)
    .resize(180, 100, { fit: "cover", position: sharp.strategy.attention })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const luminance: number[] = [];
  let saturationTotal = 0;

  for (let index = 0; index < data.length; index += info.channels) {
    const r = data[index] ?? 0;
    const g = data[index + 1] ?? 0;
    const b = data[index + 2] ?? 0;
    const luma = lumaOf(r, g, b);
    luminance.push(luma);
    saturationTotal += saturationOf(r, g, b);
  }

  const mean = average(luminance);
  const contrast = Math.sqrt(average(luminance.map((value) => (value - mean) ** 2)));
  const brightnessBalance = clamp(100 - Math.abs(mean - 128) * 0.85);
  const saturation = (saturationTotal / luminance.length) * 100;
  const edgeEnergy = scoreEdgeEnergy(luminance, info.width, info.height);

  return roundScore(contrast * 0.72 + brightnessBalance * 0.32 + saturation * 0.3 + edgeEnergy * 0.45);
}

async function chooseAccentFromFrame(framePath: string): Promise<string> {
  const { data, info } = await sharp(framePath)
    .resize(96, 54, { fit: "cover", position: sharp.strategy.attention })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bins = Array.from({ length: 18 }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));

  for (let index = 0; index < data.length; index += info.channels) {
    const r = data[index] ?? 0;
    const g = data[index + 1] ?? 0;
    const b = data[index + 2] ?? 0;
    const [hue, saturation, lightness] = rgbToHsl(r, g, b);
    if (saturation < 0.18 || lightness < 0.18 || lightness > 0.88) continue;

    const bin = bins[Math.min(bins.length - 1, Math.floor(hue / (360 / bins.length)))];
    const weight = saturation * (1 - Math.abs(lightness - 0.54));
    bin.weight += weight;
    bin.r += r * weight;
    bin.g += g * weight;
    bin.b += b * weight;
  }

  const selected = bins.sort((a, b) => b.weight - a.weight)[0];
  if (!selected || selected.weight <= 0) return "#22d3ee";

  const r = selected.r / selected.weight;
  const g = selected.g / selected.weight;
  const b = selected.b / selected.weight;
  const [hue] = rgbToHsl(r, g, b);
  const accentHue = (hue + 150) % 360;
  const [accentR, accentG, accentB] = hslToRgb(accentHue, 0.82, 0.56);
  return rgbToHex(accentR, accentG, accentB);
}

function chooseContextEmojis(context: string | undefined): string[] {
  const text = (context ?? "").toLowerCase();
  const packs: Array<{ terms: string[]; emojis: string[] }> = [
    { terms: ["skate", "skateboard", "fall", "fail", "cassetada", "cassetadas"], emojis: ["😳", "🛹", "💥"] },
    { terms: ["ai", "artificial intelligence", "tech", "software", "app", "gadget"], emojis: ["🤖", "👀", "⚡"] },
    { terms: ["money", "business", "finance", "revenue", "startup", "creator economy"], emojis: ["💸", "📈", "👀"] },
    { terms: ["food", "recipe", "restaurant", "cook", "kitchen"], emojis: ["😋", "🔥", "👀"] },
    { terms: ["game", "gaming", "stream", "roblox", "minecraft"], emojis: ["🎮", "🔥", "👀"] },
    { terms: ["music", "song", "concert", "artist"], emojis: ["🎵", "🔥", "👀"] },
  ];

  return packs.find((pack) => pack.terms.some((term) => text.includes(term)))?.emojis ?? ["👀", "🔥", "⚡"];
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

async function buildEmojiComposites(effectEmojis: string[], width: number, height: number): Promise<OverlayOptions[]> {
  const layout = emojiLayout(effectEmojis.length);
  const baseSize = Math.round(width * 0.095);
  const composites: OverlayOptions[] = [];
  for (const [index, emoji] of effectEmojis.slice(0, layout.length).entries()) {
    const item = layout[index];
    const input = await buildEmojiStickerBuffer(emoji, Math.round(baseSize * item.scale), item.rotation);
    const metadata = await sharp(input).metadata();
    const stickerWidth = metadata.width ?? baseSize;
    const stickerHeight = metadata.height ?? baseSize;
    composites.push({
      input,
      left: Math.round(width * item.x - stickerWidth / 2),
      top: Math.round(height * item.y - stickerHeight / 2),
      blend: "over",
    });
  }
  return composites;
}

function emojiLayout(count: number): Array<{ x: number; y: number; rotation: number; scale: number }> {
  const layouts = [
    [{ x: 0.86, y: 0.78, rotation: -8, scale: 1.12 }],
    [
      { x: 0.82, y: 0.74, rotation: -10, scale: 1.0 },
      { x: 0.91, y: 0.83, rotation: 8, scale: 1.08 },
    ],
    [
      { x: 0.79, y: 0.74, rotation: -11, scale: 0.96 },
      { x: 0.89, y: 0.78, rotation: 7, scale: 1.1 },
      { x: 0.82, y: 0.88, rotation: 12, scale: 0.92 },
    ],
    [
      { x: 0.78, y: 0.73, rotation: -12, scale: 0.9 },
      { x: 0.88, y: 0.74, rotation: 8, scale: 1.02 },
      { x: 0.93, y: 0.86, rotation: -5, scale: 0.9 },
      { x: 0.81, y: 0.89, rotation: 13, scale: 0.84 },
    ],
  ];
  return layouts[Math.min(Math.max(count, 1), layouts.length) - 1];
}

async function buildEmojiStickerBuffer(emoji: string, size: number, rotation: number): Promise<Buffer> {
  const svg = await loadNotoEmojiSvg(emoji);
  const padding = Math.round(size * 0.28);
  const canvas = size + padding * 2;
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const stickerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">
  <defs>
    <filter id="emojiShadow" x="-45%" y="-45%" width="190%" height="190%">
      <feDropShadow dx="0" dy="${Math.max(5, Math.round(size * 0.08))}" stdDeviation="${Math.max(5, Math.round(size * 0.08))}" flood-color="#000000" flood-opacity="0.48"/>
    </filter>
  </defs>
  <image href="${dataUri}" x="${padding}" y="${padding}" width="${size}" height="${size}" filter="url(#emojiShadow)"/>
</svg>`;
  const sticker = await sharp(Buffer.from(stickerSvg)).png().toBuffer();
  return sharp(sticker)
    .rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 8 })
    .toBuffer();
}

async function loadNotoEmojiSvg(emoji: string): Promise<string> {
  for (const assetName of emojiAssetNameCandidates(emoji)) {
    const cached = emojiSvgCache.get(assetName);
    if (cached) return cached;

    const cachePath = resolve(process.cwd(), "data/cache/noto-emoji", `${assetName}.svg`);
    try {
      const svg = await readFile(cachePath, "utf8");
      emojiSvgCache.set(assetName, svg);
      return svg;
    } catch {
      const svg = await fetchNotoEmojiSvg(assetName);
      if (svg) {
        await mkdir(resolve(process.cwd(), "data/cache/noto-emoji"), { recursive: true });
        await writeFile(cachePath, svg, "utf8");
        emojiSvgCache.set(assetName, svg);
        return svg;
      }
    }
  }

  throw new Error(`Could not load a Noto color emoji asset for ${emoji}`);
}

async function fetchNotoEmojiSvg(assetName: string): Promise<string | undefined> {
  const url = `https://raw.githubusercontent.com/googlefonts/noto-emoji/${NOTO_EMOJI_REF}/svg/${assetName}.svg`;
  const response = await fetch(url);
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Failed to fetch Noto emoji asset ${assetName}: HTTP ${response.status}`);
  }
  return response.text();
}

function emojiAssetNameCandidates(emoji: string): string[] {
  const codePoints = Array.from(emoji.trim()).map((char) => char.codePointAt(0)?.toString(16)).filter(Boolean);
  const withoutVariation = codePoints.filter((codePoint) => codePoint !== "fe0f" && codePoint !== "fe0e");
  const candidates = [withoutVariation, codePoints]
    .filter((parts) => parts.length > 0)
    .map((parts) => `emoji_u${parts.join("_")}`);
  return Array.from(new Set(candidates));
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
  for (const key of ["autoFrame", "autoAccent", "autoEmojis"] as const) {
    const value = style[key];
    if (value !== undefined && typeof value !== "boolean") {
      errors.push(`${label}.${key} must be a boolean`);
    }
  }
  if (style.candidateTimestamps !== undefined) {
    if (!Array.isArray(style.candidateTimestamps) || style.candidateTimestamps.length === 0) {
      errors.push(`${label}.candidateTimestamps must contain at least one timestamp`);
    } else {
      style.candidateTimestamps.forEach((timestamp, index) => {
        if (typeof timestamp !== "string" || timestamp.trim().length === 0) {
          errors.push(`${label}.candidateTimestamps[${index}] must be a non-empty string`);
        }
      });
    }
  }
  if (style.accent !== undefined && !isHexColor(style.accent)) {
    errors.push(`${label}.accent must be a hex color`);
  }
  if (style.textColor !== undefined && !isHexColor(style.textColor)) {
    errors.push(`${label}.textColor must be a hex color`);
  }
  if (style.gradientOpacity !== undefined && !isUnit(style.gradientOpacity)) {
    errors.push(`${label}.gradientOpacity must be between 0 and 1`);
  }
  if (style.effectEmojis !== undefined) {
    if (!Array.isArray(style.effectEmojis)) {
      errors.push(`${label}.effectEmojis must be an array`);
    } else if (style.effectEmojis.length > 4) {
      errors.push(`${label}.effectEmojis supports up to 4 emojis`);
    } else {
      style.effectEmojis.forEach((emoji, index) => {
        if (typeof emoji !== "string" || emoji.trim().length === 0) {
          errors.push(`${label}.effectEmojis[${index}] must be a non-empty string`);
        }
      });
    }
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
  const effectEmojis = variant.effectEmojis ?? defaults?.effectEmojis ?? [];
  const candidateTimestamps = variant.candidateTimestamps ?? defaults?.candidateTimestamps ?? DEFAULT_CANDIDATE_TIMESTAMPS;
  const context = [defaults?.context, variant.context, variant.id, videoPath].filter(Boolean).join(" ");
  return {
    videoPath,
    timestamp: variant.timestamp ?? defaults?.timestamp ?? candidateTimestamps[0] ?? "00:00:01",
    autoFrame: variant.autoFrame ?? defaults?.autoFrame ?? false,
    candidateTimestamps: candidateTimestamps.map((timestamp) => timestamp.trim()).filter(Boolean),
    autoAccent: variant.autoAccent ?? defaults?.autoAccent ?? false,
    autoEmojis: variant.autoEmojis ?? defaults?.autoEmojis ?? false,
    context: context.length > 0 ? context : undefined,
    effectText: effectText?.trim() ? effectText.trim() : undefined,
    effectEmojis: effectEmojis.map((emoji) => emoji.trim()).filter(Boolean).slice(0, 4),
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

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function lumaOf(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function saturationOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function scoreEdgeEnergy(luminance: number[], width: number, height: number): number {
  let total = 0;
  let count = 0;
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const current = luminance[y * width + x] ?? 0;
      const right = luminance[y * width + x + 1] ?? current;
      const down = luminance[(y + 1) * width + x] ?? current;
      total += Math.abs(current - right) + Math.abs(current - down);
      count += 2;
    }
  }
  return clamp((total / Math.max(1, count)) * 3.4);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
  if (max === green) hue = (blue - red) / delta + 2;
  if (max === blue) hue = (red - green) / delta + 4;
  return [hue * 60, saturation, lightness];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = h / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  const [r1, g1, b1] =
    segment < 1
      ? [chroma, x, 0]
      : segment < 2
        ? [x, chroma, 0]
        : segment < 3
          ? [0, chroma, x]
          : segment < 4
            ? [0, x, chroma]
            : segment < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = l - chroma / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$/.test(value);
}

function isUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}
