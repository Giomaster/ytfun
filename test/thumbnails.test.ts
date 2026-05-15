import assert from "node:assert/strict";
import test from "node:test";
import { loadThumbnailConfig } from "../src/thumbnails.js";

test("loadThumbnailConfig validates the example thumbnail config", async () => {
  const config = await loadThumbnailConfig("examples/thumbnail.json");

  assert.equal(config.width, 1280);
  assert.equal(config.height, 720);
  assert.equal(config.defaults?.videoPath, "data/originals/example-original-video.mp4");
  assert.equal(config.defaults?.autoFrame, true);
  assert.equal(config.defaults?.autoAccent, true);
  assert.equal(config.defaults?.autoEmojis, true);
  assert.equal(config.variants.length, 2);
  assert.equal(config.variants[0]?.id, "auto-curiosity");
});
