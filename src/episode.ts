import { spawnSync } from "node:child_process";
import { basename, extname, resolve } from "node:path";
import { createFirstPartyShorts } from "./firstPartyShorts.js";
import { assertFfmpegAvailable } from "./ffmpeg.js";
import { readJsonFile, writeJsonFile, writeTextFile } from "./io.js";
import { renderThumbnails, type ThumbnailConfig } from "./thumbnails.js";
import type {
  FirstPartyShortCut,
  FirstPartyShortsConfig,
  FirstPartyShortsOutput,
  ShortsVisualMode,
  YouTubePrivacyStatus,
  YouTubePublishItem,
  YouTubePublishQueue,
} from "./types.js";

export interface EpisodeConfig {
  id: string;
  title: string;
  sourcePath: string;
  sourceUrl?: string;
  originalVideoId?: string;
  channelName?: string;
  visualMode?: ShortsVisualMode;
  outputDir?: string;
  context?: string;
  shorts: FirstPartyShortCut[];
  thumbnails?: ThumbnailConfig;
  publish?: EpisodePublishConfig;
}

export interface EpisodePublishConfig {
  approvedBy?: string;
  includeSourceVideo?: boolean;
  includeShorts?: boolean;
  defaultPrivacyStatus?: YouTubePrivacyStatus;
  defaultCategoryId?: string;
  defaults?: YouTubePublishQueue["defaults"];
  sourceVideo?: Partial<YouTubePublishItem>;
  shorts?: Array<Partial<YouTubePublishItem> & { id: string }>;
}

export interface EpisodeOutput {
  id: string;
  title: string;
  generatedAt: string;
  outputDir: string;
  sourcePath: string;
  shortsConfigPath: string;
  shortsOutputPath: string;
  rightsManifestPath: string;
  thumbnailConfigPath: string;
  thumbnailOutputPath: string;
  publishQueuePath: string;
  reportPath: string;
  reviewReportPath: string;
  publishReady: boolean;
  shorts: FirstPartyShortsOutput["shorts"];
  thumbnails: Array<{
    id: string;
    path: string;
    timestamp: string;
    accent: string;
  }>;
  publishItems: Array<{
    id: string;
    videoPath: string;
    title: string;
  }>;
}

export interface EpisodeDraftOptions {
  sourcePath: string;
  id?: string;
  title?: string;
  channelName?: string;
  context?: string;
  outputDir?: string;
  shortsCount?: number;
  shortDurationSeconds?: number;
  visualMode?: ShortsVisualMode;
}

export async function loadEpisodeConfig(path: string): Promise<EpisodeConfig> {
  const config = await readJsonFile<EpisodeConfig>(path);
  validateEpisodeConfig(config);
  return config;
}

export async function runEpisode(config: EpisodeConfig, outDirOverride?: string): Promise<EpisodeOutput> {
  validateEpisodeConfig(config);
  const outputDir = outDirOverride ?? config.outputDir ?? `data/episodes/${safeName(config.id)}`;
  const shortsDir = resolve(outputDir, "shorts");
  const thumbnailsDir = resolve(outputDir, "thumbnails");

  const shortsConfig = buildShortsConfig(config);
  const shortsConfigPath = resolve(outputDir, "shorts-config.json");
  await writeJsonFile(shortsConfigPath, shortsConfig);
  const shortsResult = await createFirstPartyShorts(shortsConfig, shortsDir);

  const thumbnailConfig = buildThumbnailConfig(config);
  const thumbnailConfigPath = resolve(outputDir, "thumbnail-config.json");
  await writeJsonFile(thumbnailConfigPath, thumbnailConfig);
  const thumbnailOutput = await renderThumbnails(thumbnailConfig, thumbnailsDir);

  const publishQueue = buildEpisodePublishQueue(config, shortsResult.output);
  const publishQueuePath = resolve(outputDir, "publish-queue.json");
  await writeJsonFile(publishQueuePath, publishQueue);

  const report: EpisodeOutput = {
    id: config.id,
    title: config.title,
    generatedAt: new Date().toISOString(),
    outputDir: relativeToCwd(resolve(outputDir)),
    sourcePath: config.sourcePath,
    shortsConfigPath: relativeToCwd(shortsConfigPath),
    shortsOutputPath: relativeToCwd(resolve(shortsDir, "shorts-output.json")),
    rightsManifestPath: relativeToCwd(resolve(shortsDir, "rights-manifest.json")),
    thumbnailConfigPath: relativeToCwd(thumbnailConfigPath),
    thumbnailOutputPath: relativeToCwd(resolve(thumbnailsDir, "thumbnails-output.json")),
    publishQueuePath: relativeToCwd(publishQueuePath),
    reportPath: relativeToCwd(resolve(outputDir, "episode-output.json")),
    reviewReportPath: relativeToCwd(resolve(outputDir, "episode-review.md")),
    publishReady: publishQueue.items.every((item) => Boolean(item.approvedBy)),
    shorts: shortsResult.output.shorts,
    thumbnails: thumbnailOutput.files.map((file) => ({
      id: file.id,
      path: file.path,
      timestamp: file.timestamp,
      accent: file.accent,
    })),
    publishItems: publishQueue.items.map((item) => ({
      id: item.id,
      videoPath: item.videoPath,
      title: item.title,
    })),
  };

  await writeJsonFile(resolve(outputDir, "episode-output.json"), report);
  await writeTextFile(resolve(outputDir, "episode-review.md"), buildEpisodeReviewMarkdown(report));
  return report;
}

export function createEpisodeDraft(options: EpisodeDraftOptions): EpisodeConfig {
  if (!options.sourcePath) {
    throw new Error("--source is required");
  }

  const durationSeconds = inspectVideoDurationSeconds(options.sourcePath);
  const id = options.id ?? safeName(basename(options.sourcePath, extname(options.sourcePath)));
  const title = options.title ?? titleFromId(id);
  const shortsCount = clampInteger(options.shortsCount ?? 3, 1, 8);
  const shortDurationSeconds = clampInteger(options.shortDurationSeconds ?? 30, 8, 60);
  const shorts = draftShortCuts(durationSeconds, shortsCount, shortDurationSeconds);
  const candidateTimestamps = candidateTimestampsForDuration(durationSeconds);

  return {
    id,
    title,
    sourcePath: options.sourcePath,
    channelName: options.channelName ?? "Radar de Agora",
    visualMode: options.visualMode ?? "none",
    outputDir: options.outputDir ?? `data/episodes/${id}`,
    context: options.context ?? title,
    shorts,
    thumbnails: {
      format: "png",
      width: 1280,
      height: 720,
      defaults: {
        autoFrame: true,
        autoAccent: true,
        autoEmojis: true,
        candidateTimestamps,
      },
      variants: [
        { id: "auto-emojis" },
        { id: "clean-glow", autoEmojis: false },
      ],
    },
    publish: {
      approvedBy: "",
      includeShorts: true,
      defaultPrivacyStatus: "private",
      defaults: {
        descriptionSuffix: `Cut from an original ${options.channelName ?? "Radar de Agora"} episode.`,
        tags: ["shorts", "original"],
        madeForKids: false,
      },
    },
  };
}

export function buildShortsConfig(config: EpisodeConfig): FirstPartyShortsConfig {
  return {
    projectTitle: config.title,
    sourcePath: config.sourcePath,
    sourceUrl: config.sourceUrl,
    originalVideoId: config.originalVideoId,
    channelName: config.channelName,
    visualMode: config.visualMode ?? "none",
    shorts: config.shorts,
  };
}

export function buildThumbnailConfig(config: EpisodeConfig): ThumbnailConfig {
  const configured = config.thumbnails ?? {
    format: "png" as const,
    width: 1280,
    height: 720,
    variants: [{ id: "auto" }],
  };
  const defaults = configured.defaults ?? {};
  return {
    ...configured,
    format: configured.format ?? "png",
    width: configured.width ?? 1280,
    height: configured.height ?? 720,
    defaults: {
      videoPath: config.sourcePath,
      autoFrame: true,
      autoAccent: true,
      autoEmojis: true,
      context: config.context ?? config.title,
      ...defaults,
    },
    variants: configured.variants?.length ? configured.variants : [{ id: "auto" }],
  };
}

export function buildEpisodePublishQueue(
  config: EpisodeConfig,
  shortsOutput: Pick<FirstPartyShortsOutput, "shorts">,
): YouTubePublishQueue {
  const publish = config.publish ?? {};
  const approvedBy = publish.approvedBy;
  const includeSourceVideo = publish.includeSourceVideo ?? false;
  const includeShorts = publish.includeShorts ?? true;
  const defaultTags = publish.defaults?.tags ?? ["shorts", "original"];
  const items: YouTubePublishItem[] = [];

  if (includeSourceVideo) {
    items.push({
      id: `${config.id}-source`,
      videoPath: config.sourcePath,
      title: publish.sourceVideo?.title ?? config.title,
      description: publish.sourceVideo?.description ?? `Original episode: ${config.title}`,
      tags: publish.sourceVideo?.tags,
      categoryId: publish.sourceVideo?.categoryId,
      privacyStatus: publish.sourceVideo?.privacyStatus,
      madeForKids: publish.sourceVideo?.madeForKids,
      containsSyntheticMedia: publish.sourceVideo?.containsSyntheticMedia,
      approvedBy: publish.sourceVideo?.approvedBy ?? approvedBy,
    });
  }

  if (includeShorts) {
    const overrides = new Map((publish.shorts ?? []).map((item) => [item.id, item]));
    for (const short of shortsOutput.shorts) {
      const override = overrides.get(short.id);
      items.push({
        id: short.id,
        videoPath: short.outputPath,
        title: override?.title ?? `${short.title} #Shorts`,
        description: override?.description ?? `Short cut from original episode: ${config.title}`,
        tags: override?.tags,
        categoryId: override?.categoryId,
        privacyStatus: override?.privacyStatus,
        madeForKids: override?.madeForKids,
        containsSyntheticMedia: override?.containsSyntheticMedia,
        approvedBy: override?.approvedBy ?? approvedBy,
      });
    }
  }

  return {
    channelName: config.channelName,
    defaultPrivacyStatus: publish.defaultPrivacyStatus ?? "private",
    defaultCategoryId: publish.defaultCategoryId ?? "24",
    defaults: {
      descriptionSuffix: publish.defaults?.descriptionSuffix ?? `Generated from original episode: ${config.title}`,
      tags: defaultTags,
      madeForKids: publish.defaults?.madeForKids ?? false,
    },
    items,
  };
}

function buildEpisodeReviewMarkdown(output: EpisodeOutput): string {
  const lines = [
    `# ${output.title}`,
    "",
    `Generated: ${output.generatedAt}`,
    `Episode ID: ${output.id}`,
    `Source: ${output.sourcePath}`,
    "",
    "## Review Checklist",
    "",
    "- [ ] Watch every Short end-to-end.",
    "- [ ] Confirm no clipped heads, broken framing, or dead air.",
    "- [ ] Pick one thumbnail variant.",
    "- [ ] Review titles, descriptions, tags, and privacy.",
    "- [ ] Confirm rights manifest is acceptable.",
    "- [ ] Set final approval before upload.",
    "",
    "## Shorts",
    "",
    ...output.shorts.flatMap((short) => [
      `- ${short.title}`,
      `  - File: ${short.outputPath}`,
      `  - Source cut: ${short.start} for ${short.duration}`,
    ]),
    "",
    "## Thumbnails",
    "",
    ...output.thumbnails.flatMap((thumbnail) => [
      `### ${thumbnail.id}`,
      "",
      `![${thumbnail.id}](${thumbnail.path})`,
      "",
      `Timestamp: ${thumbnail.timestamp}`,
      `Accent: ${thumbnail.accent}`,
      "",
    ]),
    "## Publish Queue",
    "",
    `Publish ready: ${output.publishReady ? "yes" : "no"}`,
    `Queue: ${output.publishQueuePath}`,
    "",
    ...output.publishItems.map((item) => `- ${item.title}: ${item.videoPath}`),
    "",
    "## Manifests",
    "",
    `- Shorts output: ${output.shortsOutputPath}`,
    `- Rights manifest: ${output.rightsManifestPath}`,
    `- Thumbnail output: ${output.thumbnailOutputPath}`,
    `- JSON report: ${output.reportPath}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function validateEpisodeConfig(config: EpisodeConfig): void {
  const errors: string[] = [];
  if (!config.id) errors.push("id is required");
  if (!config.title) errors.push("title is required");
  if (!config.sourcePath) errors.push("sourcePath is required");
  if (config.visualMode && config.visualMode !== "none" && config.visualMode !== "minimal") {
    errors.push("visualMode must be none or minimal");
  }
  if (!Array.isArray(config.shorts) || config.shorts.length === 0) {
    errors.push("shorts must contain at least one cut");
  }
  for (const [index, short] of (config.shorts ?? []).entries()) {
    if (!short.id) errors.push(`shorts[${index}].id is required`);
    if (!short.title) errors.push(`shorts[${index}].title is required`);
    if (!short.start) errors.push(`shorts[${index}].start is required`);
    if (!short.duration) errors.push(`shorts[${index}].duration is required`);
  }
  if (errors.length > 0) {
    throw new Error(`Invalid episode config:\n- ${errors.join("\n- ")}`);
  }
}

function inspectVideoDurationSeconds(sourcePath: string): number {
  const ffmpegPath = assertFfmpegAvailable();
  const result = spawnSync(ffmpegPath, ["-hide_banner", "-i", resolve(process.cwd(), sourcePath)], { encoding: "utf8" });
  const details = `${result.stderr}\n${result.stdout}`;
  const match = details.match(/Duration:\s+(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) {
    throw new Error(`Could not inspect duration for ${sourcePath}`);
  }
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function draftShortCuts(durationSeconds: number, count: number, requestedDurationSeconds: number): FirstPartyShortCut[] {
  const shortDuration = Math.min(requestedDurationSeconds, Math.max(8, Math.floor(durationSeconds)));
  const maxStart = Math.max(0, durationSeconds - shortDuration);
  const spacing = count === 1 ? 0 : maxStart / (count - 1);
  return Array.from({ length: count }, (_, index) => {
    const start = Math.round(spacing * index);
    return {
      id: `short-${String(index + 1).padStart(2, "0")}`,
      title: `Short ${index + 1}`,
      start: secondsToClock(start),
      duration: secondsToClock(shortDuration),
    };
  });
}

function candidateTimestampsForDuration(durationSeconds: number): string[] {
  const safeDuration = Math.max(1, durationSeconds - 1);
  const ratios = [0.12, 0.24, 0.38, 0.52, 0.68, 0.84];
  return Array.from(new Set(ratios.map((ratio) => secondsToClock(Math.max(1, Math.round(safeDuration * ratio))))));
}

function secondsToClock(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
}

function titleFromId(id: string): string {
  return id.split(/[-_]+/g).filter(Boolean).map(capitalize).join(" ") || "Untitled Episode";
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "episode";
}

function relativeToCwd(path: string): string {
  return path.replace(`${resolve(process.cwd())}/`, "");
}
