import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { EditPlan, RightsManifest } from "./types.js";
import { auditRightsManifest } from "./compliance.js";
import { assertFfmpegAvailable } from "./ffmpeg.js";

export function buildEditPlan(manifest: RightsManifest, outputPath: string): EditPlan {
  return {
    projectTitle: manifest.projectTitle,
    generatedAt: new Date().toISOString(),
    outputPath,
    clips: manifest.assets.map((asset) => ({
      id: asset.id,
      localPath: asset.localPath,
      start: asset.start,
      duration: asset.duration,
      editorialPurpose: asset.editorialPurpose,
    })),
  };
}

export async function compileManifest(manifest: RightsManifest, outputPath: string): Promise<EditPlan> {
  const audit = await auditRightsManifest(manifest, { checkFiles: true });
  if (!audit.ok) {
    throw new Error(`Rights manifest failed audit:\n- ${audit.errors.join("\n- ")}`);
  }

  const plan = buildEditPlan(manifest, outputPath);
  await runFfmpeg(plan, assertFfmpegAvailable());
  return plan;
}

async function runFfmpeg(plan: EditPlan, ffmpegPath: string): Promise<void> {
  await mkdir(dirname(plan.outputPath), { recursive: true });

  const tempDir = resolve(process.cwd(), "tmp", safeName(plan.projectTitle));
  await mkdir(tempDir, { recursive: true });

  const normalizedClips: string[] = [];
  for (const [index, clip] of plan.clips.entries()) {
    const normalized = resolve(tempDir, `${String(index).padStart(3, "0")}-${safeName(clip.id)}.mp4`);
    const trim = spawnSync(
      ffmpegPath,
      [
        "-y",
        "-ss",
        clip.start,
        "-t",
        clip.duration,
        "-i",
        resolve(process.cwd(), clip.localPath),
        "-vf",
        "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1",
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        normalized,
      ],
      { encoding: "utf8" },
    );
    if (trim.status !== 0) {
      throw new Error(`ffmpeg failed while preparing ${clip.id}:\n${trim.stderr}`);
    }
    normalizedClips.push(normalized);
  }

  const concatFile = resolve(tempDir, "concat.txt");
  await writeFile(concatFile, normalizedClips.map((clip) => `file '${clip.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");

  const concat = spawnSync(
    ffmpegPath,
    ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", resolve(process.cwd(), plan.outputPath)],
    { encoding: "utf8" },
  );
  if (concat.status !== 0) {
    throw new Error(`ffmpeg failed while concatenating clips:\n${concat.stderr}`);
  }
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "clip";
}
