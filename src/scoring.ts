import type {
  CandidateQualityScore,
  CandidateVideo,
  ScopeConfig,
  ScoringConfig,
  SourceOriginAnalysis,
  TopicConfig,
} from "./types.js";
import { ageHours } from "./time.js";
import { classifySourceOrigin } from "./sourceOrigin.js";

type ResolvedScoringConfig = {
  weights: {
    trend: number;
    revenue: number;
    productionEase: number;
  };
  verdictThresholds: {
    greenlight: number;
    review: number;
  };
  production: {
    simpleMaxDurationSeconds: number;
    complexMinDurationSeconds: number;
    highComplexityKeywords: string[];
    complexityKeywords: string[];
    easyFormatKeywords: string[];
    lowLiftKeywords: string[];
    highLiftKeywords: string[];
  };
  revenue: {
    highValueTerms: string[];
    lowValueTerms: string[];
    demonetizationRiskTerms: string[];
    sponsorFitTerms: string[];
  };
};

const defaultScoring: ResolvedScoringConfig = {
  weights: {
    trend: 0.45,
    revenue: 0.35,
    productionEase: 0.2,
  },
  verdictThresholds: {
    greenlight: 75,
    review: 55,
  },
  production: {
    simpleMaxDurationSeconds: 90,
    complexMinDurationSeconds: 600,
    highComplexityKeywords: [
      "original animation",
      "animated series",
      "3d animation",
      "motion capture",
      "character animation",
      "vfx breakdown",
      "cinematic animation",
      "rendered in blender",
    ],
    complexityKeywords: [
      "documentary",
      "investigation",
      "cinematic",
      "animation",
      "animated",
      "vfx",
      "3d",
      "blender",
      "after effects",
      "tutorial",
      "experiment",
      "challenge",
    ],
    easyFormatKeywords: [
      "reaction",
      "commentary",
      "ranking",
      "top",
      "shorts",
      "clip",
      "clips",
      "recap",
      "voiceover",
      "podcast clip",
      "interview clip",
      "screen recording",
      "stitch",
      "duet",
    ],
    lowLiftKeywords: [
      "raw clip",
      "uncut",
      "caught on camera",
      "cctv",
      "dashcam",
      "highlight",
      "highlights",
      "clip",
      "clips",
      "shorts",
      "recap",
      "compilation",
      "reaction",
      "commentary",
      "voiceover",
      "podcast clip",
      "interview clip",
      "screen recording",
      "submitted by",
      "used with permission",
    ],
    highLiftKeywords: [
      "from scratch",
      "original animation",
      "animated series",
      "3d animation",
      "cinematic",
      "documentary",
      "deep dive",
      "investigation",
      "scripted",
      "short film",
      "vfx",
      "motion capture",
      "experiment",
      "challenge",
      "tutorial",
    ],
  },
  revenue: {
    highValueTerms: [
      "ai",
      "software",
      "business",
      "finance",
      "career",
      "education",
      "productivity",
      "marketing",
      "startup",
      "gadget",
      "tech",
    ],
    lowValueTerms: ["meme", "prank", "gossip", "drama", "fail", "rage", "beef"],
    demonetizationRiskTerms: [
      "adult",
      "crash",
      "drug",
      "fight",
      "gambling",
      "hate",
      "leak",
      "pirated",
      "sex",
      "violence",
      "weapon",
      "war",
    ],
    sponsorFitTerms: ["app", "tool", "course", "creator", "saas", "workflow", "review", "setup"],
  },
};

export function scoreQuality(
  candidate: CandidateVideo,
  topic: TopicConfig | undefined,
  config: ScopeConfig,
  sourceOrigin: SourceOriginAnalysis = classifySourceOrigin(candidate),
): CandidateQualityScore {
  const scoring = mergeScoringConfig(config.scoring);
  const trendScore = scoreTrend(candidate, topic);
  const formatComplexityScore = scoreFormatComplexity(candidate, topic, scoring);
  const editorialLiftScore = scoreEditorialLift(candidate, sourceOrigin, scoring);
  const readyToEditScore = clamp(100 - editorialLiftScore);
  const productionComplexityScore = clamp(formatComplexityScore * 0.65 + editorialLiftScore * 0.35);
  const productionEaseScore = clamp(100 - productionComplexityScore);
  const revenuePotentialScore = scoreRevenuePotential(candidate, topic, scoring);
  const weights = normalizeWeights(scoring.weights);
  const finalScore =
    trendScore * weights.trend + revenuePotentialScore * weights.revenue + productionEaseScore * weights.productionEase;
  const risks = collectRisks(candidate, scoring, sourceOrigin);
  const verdict = chooseVerdict(finalScore, risks, scoring);

  return {
    trendScore: roundScore(trendScore),
    editorialLiftScore: roundScore(editorialLiftScore),
    readyToEditScore: roundScore(readyToEditScore),
    productionComplexityScore: roundScore(productionComplexityScore),
    productionEaseScore: roundScore(productionEaseScore),
    revenuePotentialScore: roundScore(revenuePotentialScore),
    finalScore: roundScore(finalScore),
    verdict,
    reasons: buildReasons(candidate, topic, {
      trendScore,
      editorialLiftScore,
      readyToEditScore,
      productionComplexityScore,
      revenuePotentialScore,
      finalScore,
    }),
    risks,
  };
}

function scoreTrend(candidate: CandidateVideo, topic: TopicConfig | undefined): number {
  const views = candidate.views ?? 0;
  const velocity = views / ageHours(candidate.publishedAt);
  const engagementRate = views > 0 ? ((candidate.likes ?? 0) + (candidate.comments ?? 0) * 2) / views : 0;
  const freshness = clamp(100 - ageHours(candidate.publishedAt) / 2);
  const topicMatch = topicMatches(candidate, topic) ? 100 : 45;

  return (
    boundedLogScore(views, 1_000, 10_000_000) * 0.3 +
    boundedLogScore(velocity, 10, 100_000) * 0.4 +
    boundedLinearScore(engagementRate, 0.005, 0.12) * 0.15 +
    freshness * 0.1 +
    topicMatch * 0.05
  );
}

function scoreFormatComplexity(
  candidate: CandidateVideo,
  topic: TopicConfig | undefined,
  scoring: ResolvedScoringConfig,
): number {
  const text = textBlob(candidate);
  let complexity = 45;

  if (topic?.productionComplexity === "simple") complexity -= 15;
  if (topic?.productionComplexity === "complex") complexity += 20;

  const duration = candidate.durationSeconds;
  if (duration !== undefined) {
    if (duration <= scoring.production.simpleMaxDurationSeconds) complexity -= 15;
    if (duration >= scoring.production.complexMinDurationSeconds) complexity += 20;
    if (duration >= scoring.production.complexMinDurationSeconds * 2) complexity += 10;
  }

  complexity += matchingTerms(text, scoring.production.highComplexityKeywords).length * 20;
  complexity += matchingTerms(text, scoring.production.complexityKeywords).length * 9;
  complexity -= matchingTerms(text, scoring.production.easyFormatKeywords).length * 7;

  if (candidate.license === "creativeCommon") complexity -= 8;
  if (!candidate.license || candidate.license === "youtube") complexity += 8;

  return clamp(complexity);
}

function scoreEditorialLift(
  candidate: CandidateVideo,
  sourceOrigin: SourceOriginAnalysis,
  scoring: ResolvedScoringConfig,
): number {
  const text = textBlob(candidate);
  let lift = 50;

  const duration = candidate.durationSeconds;
  if (duration !== undefined) {
    if (duration <= 60) lift -= 12;
    else if (duration <= scoring.production.simpleMaxDurationSeconds) lift -= 8;
    if (duration >= scoring.production.complexMinDurationSeconds) lift += 15;
    if (duration >= scoring.production.complexMinDurationSeconds * 2) lift += 10;
  }

  lift -= matchingTerms(text, scoring.production.lowLiftKeywords).length * 7;
  lift += matchingTerms(text, scoring.production.highLiftKeywords).length * 10;

  switch (sourceOrigin.classification) {
    case "likely_licensed_or_permissioned":
    case "likely_original_channel":
      lift -= 10;
      break;
    case "likely_ugc_with_credit":
    case "likely_transformative_commentary":
      lift -= 7;
      break;
    case "likely_found_footage_aggregation":
      lift -= 4;
      break;
    case "unknown":
      lift += 8;
      break;
  }

  if (sourceOrigin.provenanceRisk === "high") lift += 6;
  if (sourceOrigin.provenanceRisk === "medium") lift += 3;
  if (candidate.license === "creativeCommon") lift -= 8;

  return clamp(lift);
}

function scoreRevenuePotential(
  candidate: CandidateVideo,
  topic: TopicConfig | undefined,
  scoring: ResolvedScoringConfig,
): number {
  const text = textBlob(candidate);
  let revenue = 45;

  revenue += tierBoost(topic?.revenueTier);
  revenue += matchingTerms(text, scoring.revenue.highValueTerms).length * 8;
  revenue += matchingTerms(text, scoring.revenue.sponsorFitTerms).length * 5;
  revenue -= matchingTerms(text, scoring.revenue.lowValueTerms).length * 7;
  revenue -= matchingTerms(text, scoring.revenue.demonetizationRiskTerms).length * 14;

  const views = candidate.views ?? 0;
  const velocity = views / ageHours(candidate.publishedAt);
  revenue += boundedLogScore(views, 10_000, 5_000_000) * 0.18;
  revenue += boundedLogScore(velocity, 50, 50_000) * 0.12;

  if (candidate.license === "creativeCommon") revenue += 5;
  if (!candidate.license || candidate.license === "youtube") revenue -= 5;

  return clamp(revenue);
}

function buildReasons(
  candidate: CandidateVideo,
  topic: TopicConfig | undefined,
  scores: {
    trendScore: number;
    editorialLiftScore: number;
    readyToEditScore: number;
    productionComplexityScore: number;
    revenuePotentialScore: number;
    finalScore: number;
  },
): string[] {
  const views = candidate.views ?? 0;
  const velocity = views / ageHours(candidate.publishedAt);
  const reasons = [
    `trend=${roundScore(scores.trendScore)}/100 from ${views.toLocaleString("en-US")} views and ${Math.round(velocity).toLocaleString("en-US")} views/hour`,
    `editorialLift=${roundScore(scores.editorialLiftScore)}/100 where lower means less cooking needed`,
    `readyToEdit=${roundScore(scores.readyToEditScore)}/100 from format, duration, and provenance signals`,
    `complexity=${roundScore(scores.productionComplexityScore)}/100 where lower is easier to produce`,
    `revenue=${roundScore(scores.revenuePotentialScore)}/100 from niche fit, brand-safety, and sponsor signals`,
    `final=${roundScore(scores.finalScore)}/100 weighted opportunity score`,
  ];

  if (topic?.revenueTier) reasons.push(`topic revenue tier=${topic.revenueTier}`);
  if (topic?.productionComplexity) reasons.push(`topic production complexity=${topic.productionComplexity}`);
  return reasons;
}

function collectRisks(candidate: CandidateVideo, scoring: ResolvedScoringConfig, sourceOrigin: SourceOriginAnalysis): string[] {
  const text = textBlob(candidate);
  const risks: string[] = [];
  const riskyTerms = matchingTerms(text, scoring.revenue.demonetizationRiskTerms);

  if (riskyTerms.length > 0) {
    risks.push(`demonetization-risk-terms:${riskyTerms.join(",")}`);
  }
  if (!candidate.license || candidate.license === "youtube") {
    risks.push("rights-review-required");
  }
  risks.push(`source-origin:${sourceOrigin.classification}`);
  risks.push(`provenance-risk:${sourceOrigin.provenanceRisk}`);
  if ((candidate.views ?? 0) === 0) {
    risks.push("missing-view-statistics");
  }
  return risks;
}

function chooseVerdict(finalScore: number, risks: string[], scoring: ResolvedScoringConfig): CandidateQualityScore["verdict"] {
  const hasHardRisk = risks.some((risk) => risk.startsWith("demonetization-risk-terms"));
  if (finalScore >= scoring.verdictThresholds.greenlight && !hasHardRisk) return "greenlight";
  if (finalScore >= scoring.verdictThresholds.review) return "review";
  return "skip";
}

function mergeScoringConfig(config: ScoringConfig | undefined): ResolvedScoringConfig {
  return {
    weights: { ...defaultScoring.weights, ...config?.weights },
    verdictThresholds: { ...defaultScoring.verdictThresholds, ...config?.verdictThresholds },
    production: { ...defaultScoring.production, ...config?.production },
    revenue: { ...defaultScoring.revenue, ...config?.revenue },
  };
}

function normalizeWeights(weights: ResolvedScoringConfig["weights"]): ResolvedScoringConfig["weights"] {
  const total = weights.trend + weights.revenue + weights.productionEase;
  if (total <= 0) return defaultScoring.weights;
  return {
    trend: weights.trend / total,
    revenue: weights.revenue / total,
    productionEase: weights.productionEase / total,
  };
}

function topicMatches(candidate: CandidateVideo, topic: TopicConfig | undefined): boolean {
  if (!topic?.requiredTerms?.length) return true;
  const text = textBlob(candidate);
  return topic.requiredTerms.every((term) => text.includes(term.toLowerCase()));
}

function tierBoost(tier: TopicConfig["revenueTier"]): number {
  switch (tier) {
    case "premium":
      return 28;
    case "high":
      return 20;
    case "medium":
      return 10;
    case "low":
      return -8;
    default:
      return 0;
  }
}

function matchingTerms(text: string, terms: string[]): string[] {
  return terms.filter((term) => text.includes(term.toLowerCase()));
}

function textBlob(candidate: CandidateVideo): string {
  return `${candidate.title} ${candidate.description} ${candidate.channelTitle}`.toLowerCase();
}

function boundedLogScore(value: number, floor: number, ceiling: number): number {
  if (value <= floor) return 0;
  if (value >= ceiling) return 100;
  const min = Math.log10(floor + 1);
  const max = Math.log10(ceiling + 1);
  const actual = Math.log10(value + 1);
  return clamp(((actual - min) / (max - min)) * 100);
}

function boundedLinearScore(value: number, floor: number, ceiling: number): number {
  if (value <= floor) return 0;
  if (value >= ceiling) return 100;
  return clamp(((value - floor) / (ceiling - floor)) * 100);
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function roundScore(value: number): number {
  return Number(value.toFixed(1));
}
