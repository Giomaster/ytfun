import assert from "node:assert/strict";
import test from "node:test";
import { loadYouTubePublishQueue } from "../src/youtubePublish.js";

test("loadYouTubePublishQueue validates the example queue", async () => {
  const queue = await loadYouTubePublishQueue("examples/youtube-publish-queue.json");

  assert.equal(queue.defaultPrivacyStatus, "private");
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0]?.approvedBy, "human-editor-name");
});
