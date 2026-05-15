import type { CandidateVideo, SourceOriginAnalysis } from "./types.js";

const aggregationTerms = [
  "compilation",
  "compilado",
  "best moments",
  "viral clips",
  "funny clips",
  "fails",
  "cassetadas",
  "caught on camera",
  "camera footage",
  "from the internet",
  "around the web",
  "reupload",
  "reposted",
];

const creditTerms = [
  "credit",
  "credits",
  "via",
  "source",
  "submitted by",
  "send your clips",
  "dm for credit",
  "used with permission",
  "licensed",
  "licenciado",
];

const commentaryTerms = [
  "reaction",
  "reacts",
  "commentary",
  "analysis",
  "explained",
  "review",
  "critique",
  "breakdown",
  "ranking",
  "top",
];

const originalTerms = [
  "i made",
  "we made",
  "we filmed",
  "my video",
  "our video",
  "behind the scenes",
  "original",
  "official",
];

const aggregatorChannelTerms = ["fails", "viral", "clips", "compilation", "cassetadas", "memes", "daily dose"];

export function classifySourceOrigin(candidate: CandidateVideo): SourceOriginAnalysis {
  const text = textBlob(candidate);
  const channel = candidate.channelTitle.toLowerCase();
  const signals: string[] = [];
  const notes: string[] = [];

  const aggregationMatches = matches(text, aggregationTerms);
  const creditMatches = matches(text, creditTerms);
  const commentaryMatches = matches(text, commentaryTerms);
  const originalMatches = matches(text, originalTerms);
  const aggregatorChannelMatches = matches(channel, aggregatorChannelTerms);

  pushSignals(signals, "aggregation", aggregationMatches);
  pushSignals(signals, "credit", creditMatches);
  pushSignals(signals, "commentary", commentaryMatches);
  pushSignals(signals, "original", originalMatches);
  pushSignals(signals, "channel-aggregation", aggregatorChannelMatches);

  if (candidate.license === "creativeCommon") {
    signals.push("youtube-license:creativeCommon");
    notes.push("API metadata reports a Creative Commons license; still verify exact license fit before reuse.");
    return {
      classification: "likely_licensed_or_permissioned",
      provenanceRisk: "low",
      confidence: 0.76,
      signals,
      notes,
      requiresHumanReview: true,
    };
  }

  if (creditMatches.some((term) => term.includes("permission") || term.includes("licensed") || term.includes("licenciado"))) {
    notes.push("Metadata claims permission or licensing; collect the permission evidence before editing.");
    return {
      classification: "likely_licensed_or_permissioned",
      provenanceRisk: "medium",
      confidence: 0.72,
      signals,
      notes,
      requiresHumanReview: true,
    };
  }

  if (aggregationMatches.length > 0 || aggregatorChannelMatches.length >= 2) {
    const hasCredit = creditMatches.length > 0;
    notes.push(hasCredit ? "Looks like UGC or found footage with attribution signals." : "Looks like found-footage aggregation without obvious source evidence.");
    return {
      classification: hasCredit ? "likely_ugc_with_credit" : "likely_found_footage_aggregation",
      provenanceRisk: hasCredit ? "medium" : "high",
      confidence: clampConfidence(0.58 + aggregationMatches.length * 0.06 + aggregatorChannelMatches.length * 0.04),
      signals,
      notes,
      requiresHumanReview: true,
    };
  }

  if (commentaryMatches.length > 0) {
    notes.push("Looks commentary-led or transformative from metadata; verify the actual edit and clip purpose.");
    return {
      classification: "likely_transformative_commentary",
      provenanceRisk: "medium",
      confidence: clampConfidence(0.52 + commentaryMatches.length * 0.07),
      signals,
      notes,
      requiresHumanReview: true,
    };
  }

  if (originalMatches.length > 0) {
    notes.push("Metadata suggests channel-owned or official material, but this is only a signal.");
    return {
      classification: "likely_original_channel",
      provenanceRisk: "low",
      confidence: clampConfidence(0.5 + originalMatches.length * 0.08),
      signals,
      notes,
      requiresHumanReview: false,
    };
  }

  notes.push("Origin cannot be inferred from metadata alone.");
  return {
    classification: "unknown",
    provenanceRisk: "medium",
    confidence: 0.35,
    signals,
    notes,
    requiresHumanReview: true,
  };
}

function textBlob(candidate: CandidateVideo): string {
  return `${candidate.title} ${candidate.description} ${candidate.channelTitle}`.toLowerCase();
}

function matches(text: string, terms: string[]): string[] {
  return terms.filter((term) => text.includes(term));
}

function pushSignals(signals: string[], label: string, terms: string[]): void {
  for (const term of terms) {
    signals.push(`${label}:${term}`);
  }
}

function clampConfidence(value: number): number {
  return Math.min(0.94, Math.max(0.1, Number(value.toFixed(2))));
}
