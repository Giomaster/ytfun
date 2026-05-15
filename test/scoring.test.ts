import assert from "node:assert/strict";
import test from "node:test";
import { scoreQuality } from "../src/scoring.js";
import type { CandidateVideo, ScopeConfig, TopicConfig } from "../src/types.js";

const scope: ScopeConfig = {
  projectName: "test",
  topics: [],
};

const topic: TopicConfig = {
  id: "ai-tools",
  name: "AI tools",
  queries: ["ai tool"],
  requiredTerms: ["ai"],
  revenueTier: "premium",
  productionComplexity: "simple",
};

test("scoreQuality greenlights strong, simple, monetizable candidates", () => {
  const quality = scoreQuality(makeCandidate(), topic, scope);

  assert.equal(quality.verdict, "greenlight");
  assert.ok(quality.trendScore >= 70);
  assert.ok(quality.readyToEditScore >= 70);
  assert.ok(quality.productionComplexityScore <= 40);
  assert.ok(quality.revenuePotentialScore >= 80);
});

test("scoreQuality blocks hard greenlight when demonetization risk terms appear", () => {
  const quality = scoreQuality(
    makeCandidate({
      title: "AI tool leak turns into creator drama fight",
      description: "Pirated setup and violent debate around an app.",
      license: "youtube",
    }),
    topic,
    scope,
  );

  assert.notEqual(quality.verdict, "greenlight");
  assert.ok(quality.risks.some((risk) => risk.startsWith("demonetization-risk-terms")));
});

test("scoreQuality treats original animation as high production complexity", () => {
  const quality = scoreQuality(
    makeCandidate({
      title: "AI character animation rendered in blender",
      description: "Original animation with 3d animation, vfx breakdown, and cinematic render work.",
      durationSeconds: 180,
    }),
    topic,
    scope,
  );

  assert.ok(quality.productionComplexityScore >= 70);
  assert.ok(quality.productionEaseScore <= 30);
  assert.ok(quality.editorialLiftScore >= 70);
});

test("scoreQuality treats edited commentary clips as production-friendly", () => {
  const quality = scoreQuality(
    makeCandidate({
      title: "AI app reaction commentary shorts recap",
      description: "Voiceover, screen recording, and podcast clip edit for creator workflow.",
      durationSeconds: 65,
    }),
    topic,
    scope,
  );

  assert.ok(quality.productionComplexityScore <= 30);
  assert.ok(quality.readyToEditScore >= 80);
});

test("scoreQuality rewards low-cooking source formats as ready to edit", () => {
  const quality = scoreQuality(
    makeCandidate({
      title: "Caught on camera AI booth moment raw clip",
      description: "Shorts recap with voiceover. Submitted by creator and used with permission.",
      durationSeconds: 42,
    }),
    topic,
    scope,
  );

  assert.ok(quality.editorialLiftScore <= 25);
  assert.ok(quality.readyToEditScore >= 75);
});

function makeCandidate(overrides: Partial<CandidateVideo> = {}): CandidateVideo {
  return {
    id: "video-1",
    url: "https://www.youtube.com/watch?v=video-1",
    title: "AI productivity app review shorts recap",
    description: "Creator workflow tool setup for small business.",
    channelId: "channel-1",
    channelTitle: "Tech Creator",
    publishedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    query: "ai tool",
    topicId: "ai-tools",
    topicName: "AI tools",
    thumbnails: {},
    durationSeconds: 60,
    views: 1_000_000,
    likes: 70_000,
    comments: 6_000,
    license: "creativeCommon",
    ...overrides,
  };
}
