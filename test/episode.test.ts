import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildEpisodePublishQueue, buildThumbnailConfig, createEpisodeDraft, loadEpisodeConfig } from "../src/episode.js";
import { getFfmpegPath } from "../src/ffmpeg.js";

test("loadEpisodeConfig validates the example episode manifest", async () => {
  const config = await loadEpisodeConfig("examples/episode.json");

  assert.equal(config.id, "trend-001");
  assert.equal(config.shorts.length, 2);
  assert.equal(config.thumbnails?.variants.length, 2);
});

test("buildThumbnailConfig applies episode defaults for automation", async () => {
  const config = await loadEpisodeConfig("examples/episode.json");
  const thumbnails = buildThumbnailConfig(config);

  assert.equal(thumbnails.defaults?.videoPath, config.sourcePath);
  assert.equal(thumbnails.defaults?.autoFrame, true);
  assert.equal(thumbnails.defaults?.autoAccent, true);
  assert.equal(thumbnails.defaults?.autoEmojis, true);
});

test("buildEpisodePublishQueue materializes Shorts upload items", async () => {
  const config = await loadEpisodeConfig("examples/episode.json");
  const queue = buildEpisodePublishQueue(config, {
    shorts: [
      {
        id: "hook-001",
        title: "The hook everyone replayed",
        outputPath: "data/episodes/trend-001/shorts/hook-001.mp4",
        start: "00:00:08",
        duration: "00:00:32",
        sourceOrigin: "likely_original_channel",
        editorialLift: "low",
      },
    ],
  });

  assert.equal(queue.defaultPrivacyStatus, "private");
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0]?.title, "The hook everyone replayed #Shorts");
  assert.equal(queue.items[0]?.approvedBy, "human-editor-name");
});

test("createEpisodeDraft proposes a production-ready episode manifest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ytfun-episode-draft-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "synthetic-source.mp4");
  // Self-contained fixture: 60 tiny frames and a generated tone, with no source footage.
  const fixture = spawnSync(getFfmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "color=c=navy:s=64x112:r=1:d=60",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=60",
    "-map", "0:v:0", "-map", "1:a:0", "-t", "60",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "35",
    "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "16k",
    sourcePath,
  ], { encoding: "utf8", timeout: 30_000 });
  assert.ifError(fixture.error);
  assert.equal(fixture.status, 0, `Synthetic fixture generation failed: ${fixture.stderr}`);

  const draft = createEpisodeDraft({
    sourcePath,
    id: "draft-smoke",
    title: "Draft Smoke",
    shortsCount: 2,
    shortDurationSeconds: 10,
  });

  assert.equal(draft.id, "draft-smoke");
  assert.equal(draft.sourcePath, sourcePath);
  assert.equal(draft.shorts.length, 2);
  assert.equal(draft.shorts[0]?.start, "00:00:00");
  assert.equal(draft.shorts[1]?.start, "00:00:50");
  assert.deepEqual(draft.shorts.map((short) => short.duration), ["00:00:10", "00:00:10"]);
  assert.equal(draft.thumbnails?.defaults?.autoFrame, true);
  assert.equal(draft.publish?.defaultPrivacyStatus, "private");
});
