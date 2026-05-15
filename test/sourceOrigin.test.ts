import assert from "node:assert/strict";
import test from "node:test";
import { classifySourceOrigin } from "../src/sourceOrigin.js";
import type { CandidateVideo } from "../src/types.js";

test("classifySourceOrigin identifies likely found-footage aggregations", () => {
  const result = classifySourceOrigin(
    makeCandidate({
      title: "Best viral fails compilation caught on camera",
      description: "Funny clips from around the web.",
      channelTitle: "Daily Viral Fails Clips",
    }),
  );

  assert.equal(result.classification, "likely_found_footage_aggregation");
  assert.equal(result.provenanceRisk, "high");
});

test("classifySourceOrigin identifies permission signals", () => {
  const result = classifySourceOrigin(
    makeCandidate({
      title: "Creator sends us a wild scooter fail",
      description: "Used with permission from the original creator.",
    }),
  );

  assert.equal(result.classification, "likely_licensed_or_permissioned");
  assert.equal(result.requiresHumanReview, true);
});

function makeCandidate(overrides: Partial<CandidateVideo> = {}): CandidateVideo {
  return {
    id: "video-1",
    url: "https://www.youtube.com/watch?v=video-1",
    title: "Original video",
    description: "Our video filmed in studio.",
    channelId: "channel-1",
    channelTitle: "Studio Channel",
    publishedAt: new Date().toISOString(),
    query: "fails",
    topicId: "fails",
    topicName: "Fails",
    thumbnails: {},
    license: "youtube",
    ...overrides,
  };
}
