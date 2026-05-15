import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ffmpegStatic = require("ffmpeg-static") as string | null;

export function getFfmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (ffmpegStatic) return ffmpegStatic;
  return "ffmpeg";
}

export function assertFfmpegAvailable(): string {
  const ffmpegPath = getFfmpegPath();
  const result = spawnSync(ffmpegPath, ["-version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`ffmpeg is required but was not available at ${ffmpegPath}`);
  }
  return ffmpegPath;
}
