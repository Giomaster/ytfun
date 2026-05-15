import type { CandidateVideo, DiscoveryOutput, ScopeConfig, ShortlistOutput, TopicConfig } from "./types.js";
import { ageHours } from "./time.js";
import { scoreQuality } from "./scoring.js";
import { classifySourceOrigin } from "./sourceOrigin.js";

export function buildDiscoveryOutput(config: ScopeConfig, candidates: CandidateVideo[]): DiscoveryOutput {
  return {
    projectName: config.projectName,
    generatedAt: new Date().toISOString(),
    source: "youtube-data-api",
    candidates,
  };
}

export function buildShortlist(config: ScopeConfig, discoveries: DiscoveryOutput): ShortlistOutput {
  const topicById = new Map(config.topics.map((topic) => [topic.id, topic]));
  const candidates = discoveries.candidates
    .map((candidate) => scoreCandidate(candidate, topicById.get(candidate.topicId), config))
    .filter((candidate) => passesTopicFilters(candidate, topicById.get(candidate.topicId)))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 20);

  return {
    projectName: discoveries.projectName,
    generatedAt: new Date().toISOString(),
    candidates,
  };
}

export function draftScript(shortlist: ShortlistOutput): string {
  const lines: string[] = [];
  lines.push(`# ${shortlist.projectName} script draft`);
  lines.push("");
  lines.push("## Editorial thesis");
  lines.push("");
  lines.push("State the original argument of this video before selecting any clips.");
  lines.push("");
  lines.push("## Structure");
  lines.push("");

  shortlist.candidates.forEach((candidate, index) => {
    const duration = candidate.durationSeconds ? `${candidate.durationSeconds}s` : "unknown duration";
    const views = candidate.views?.toLocaleString("en-US") ?? "unknown views";
    const reasons = candidate.scoreReasons?.join("; ") ?? "selected by score";
    const quality = candidate.quality;
    const sourceOrigin = candidate.sourceOrigin;
    lines.push(`### ${index + 1}. ${candidate.title}`);
    lines.push("");
    lines.push(`- Source: ${candidate.url}`);
    lines.push(`- Channel: ${candidate.channelTitle}`);
    lines.push(`- Topic: ${candidate.topicName}`);
    lines.push(`- Metadata: ${views}, ${duration}, license=${candidate.license ?? "unknown"}`);
    if (quality) {
      lines.push(
        `- Verdict: ${quality.verdict} | final=${quality.finalScore}/100 | trend=${quality.trendScore}/100 | readyToEdit=${quality.readyToEditScore}/100 | complexity=${quality.productionComplexityScore}/100 | revenue=${quality.revenuePotentialScore}/100`,
      );
    }
    if (sourceOrigin) {
      lines.push(
        `- Source origin: ${sourceOrigin.classification} | provenanceRisk=${sourceOrigin.provenanceRisk} | confidence=${Math.round(sourceOrigin.confidence * 100)}%`,
      );
    }
    lines.push(`- Why it matters: ${reasons}`);
    lines.push("- Planned use: describe the specific claim this clip will illustrate.");
    lines.push("- Commentary beat: add original narration, critique, context, or comparison here.");
    lines.push("- Rights note: add permission, license evidence, or fair-use review before editing.");
    lines.push("");
  });

  lines.push("## Closing");
  lines.push("");
  lines.push("Synthesize the trend and add an original takeaway. Do not end as a raw compilation.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function scoreCandidate(
  candidate: CandidateVideo,
  topic: TopicConfig | undefined,
  config: ScopeConfig,
): CandidateVideo {
  const views = candidate.views ?? 0;
  const velocity = views / ageHours(candidate.publishedAt);
  const sourceOrigin = classifySourceOrigin(candidate);
  const quality = scoreQuality(candidate, topic, config, sourceOrigin);
  const reasons: string[] = [];
  const complianceSignals: string[] = [];

  if (candidate.license === "creativeCommon") {
    complianceSignals.push("creative-commons-license");
  }

  if (topic?.requiredTerms?.some((term) => textBlob(candidate).includes(term.toLowerCase()))) {
    reasons.push("matches required topic terms");
  }

  if (candidate.durationSeconds && candidate.durationSeconds <= 90) {
    reasons.push("short-form friendly duration");
  }

  if (views > 0) reasons.push(`${views.toLocaleString("en-US")} views`);
  reasons.push(`${Math.round(velocity).toLocaleString("en-US")} views/hour estimated`);

  if (!candidate.license || candidate.license === "youtube") {
    complianceSignals.push("rights-review-required");
  }

  return {
    ...candidate,
    score: quality.finalScore,
    scoreReasons: [...reasons, ...quality.reasons],
    quality,
    sourceOrigin,
    complianceSignals: [...new Set([...complianceSignals, ...quality.risks])],
  };
}

function passesTopicFilters(candidate: CandidateVideo, topic: TopicConfig | undefined): boolean {
  if (!topic) return false;
  const text = textBlob(candidate);
  const views = candidate.views ?? 0;
  const velocity = views / ageHours(candidate.publishedAt);

  if (topic.minViews !== undefined && views < topic.minViews) return false;
  if (topic.minViewVelocityPerHour !== undefined && velocity < topic.minViewVelocityPerHour) return false;
  if (topic.requiredTerms?.length && !topic.requiredTerms.every((term) => text.includes(term.toLowerCase()))) {
    return false;
  }
  if (topic.excludedTerms?.some((term) => text.includes(term.toLowerCase()))) {
    return false;
  }
  return true;
}

function textBlob(candidate: CandidateVideo): string {
  return `${candidate.title} ${candidate.description} ${candidate.channelTitle}`.toLowerCase();
}
