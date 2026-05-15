import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveYouTubePublishQueue, loadYouTubePublishQueue } from "../src/youtubePublish.js";

test("loadYouTubePublishQueue validates the example queue", async () => {
  const queue = await loadYouTubePublishQueue("examples/youtube-publish-queue.json");

  assert.equal(queue.defaultPrivacyStatus, "private");
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0]?.approvedBy, "human-editor-name");
});

test("approveYouTubePublishQueue marks all items as reviewed", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ytfun-approve-test-"));
  const outPath = join(tempDir, "approved.json");
  try {
    const queue = await approveYouTubePublishQueue({
      queuePath: "examples/youtube-publish-queue.json",
      outPath,
      approvedBy: "qa-editor",
      privacyStatus: "unlisted",
      allowPublic: false,
    });

    assert.equal(queue.defaultPrivacyStatus, "unlisted");
    assert.equal(queue.items[0]?.privacyStatus, "unlisted");
    assert.equal(queue.items[0]?.approvedBy, "qa-editor");

    const reloaded = await loadYouTubePublishQueue(outPath);
    assert.equal(reloaded.items[0]?.approvedBy, "qa-editor");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
