import assert from "node:assert/strict";
import test from "node:test";
import { buildEpisodePublishQueue, buildThumbnailConfig, createEpisodeDraft, loadEpisodeConfig } from "../src/episode.js";

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

test("createEpisodeDraft proposes a production-ready episode manifest", () => {
  const draft = createEpisodeDraft({
    sourcePath: "data/cases/real-cassetadas/sources/skateboarder-falling-4759036.mp4",
    id: "draft-smoke",
    title: "Draft Smoke",
    shortsCount: 2,
    shortDurationSeconds: 10,
  });

  assert.equal(draft.id, "draft-smoke");
  assert.equal(draft.shorts.length, 2);
  assert.equal(draft.shorts[0]?.start, "00:00:00");
  assert.equal(draft.thumbnails?.defaults?.autoFrame, true);
  assert.equal(draft.publish?.defaultPrivacyStatus, "private");
});
