export type TopicLicense = "any" | "creativeCommon" | "youtube";

export interface ScopeConfig {
  projectName: string;
  regionCode?: string;
  language?: string;
  publishedAfterHours?: number;
  maxResultsPerQuery?: number;
  scoring?: ScoringConfig;
  compliance?: {
    maxClipSeconds?: number;
    requireHumanApproval?: boolean;
    preferCreativeCommons?: boolean;
  };
  topics: TopicConfig[];
}

export interface TopicConfig {
  id: string;
  name: string;
  queries: string[];
  requiredTerms?: string[];
  excludedTerms?: string[];
  minViews?: number;
  minViewVelocityPerHour?: number;
  license?: TopicLicense;
  revenueTier?: "low" | "medium" | "high" | "premium";
  productionComplexity?: "simple" | "standard" | "complex";
}

export interface ScoringConfig {
  weights?: {
    trend?: number;
    revenue?: number;
    productionEase?: number;
  };
  verdictThresholds?: {
    greenlight?: number;
    review?: number;
  };
  production?: {
    simpleMaxDurationSeconds?: number;
    complexMinDurationSeconds?: number;
    highComplexityKeywords?: string[];
    complexityKeywords?: string[];
    easyFormatKeywords?: string[];
    lowLiftKeywords?: string[];
    highLiftKeywords?: string[];
  };
  revenue?: {
    highValueTerms?: string[];
    lowValueTerms?: string[];
    demonetizationRiskTerms?: string[];
    sponsorFitTerms?: string[];
  };
}

export interface CandidateQualityScore {
  trendScore: number;
  editorialLiftScore: number;
  readyToEditScore: number;
  productionComplexityScore: number;
  productionEaseScore: number;
  revenuePotentialScore: number;
  finalScore: number;
  verdict: "greenlight" | "review" | "skip";
  reasons: string[];
  risks: string[];
}

export type SourceOriginClassification =
  | "likely_original_channel"
  | "likely_ugc_with_credit"
  | "likely_found_footage_aggregation"
  | "likely_licensed_or_permissioned"
  | "likely_transformative_commentary"
  | "unknown";

export interface SourceOriginAnalysis {
  classification: SourceOriginClassification;
  provenanceRisk: "low" | "medium" | "high";
  confidence: number;
  signals: string[];
  notes: string[];
  requiresHumanReview: boolean;
}

export interface CandidateVideo {
  id: string;
  url: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  query: string;
  topicId: string;
  topicName: string;
  thumbnails: Record<string, { url: string; width?: number; height?: number }>;
  durationSeconds?: number;
  views?: number;
  likes?: number;
  comments?: number;
  license?: string;
  score?: number;
  scoreReasons?: string[];
  quality?: CandidateQualityScore;
  sourceOrigin?: SourceOriginAnalysis;
  complianceSignals?: string[];
}

export interface DiscoveryOutput {
  projectName: string;
  generatedAt: string;
  source: "youtube-data-api";
  candidates: CandidateVideo[];
}

export interface ShortlistOutput {
  projectName: string;
  generatedAt: string;
  candidates: CandidateVideo[];
}

export type LicenseBasis =
  | "owned"
  | "licensed"
  | "creative_commons"
  | "permission"
  | "public_domain"
  | "fair_use_review";

export interface RightsManifest {
  projectTitle: string;
  editor?: string;
  assets: RightsAsset[];
}

export interface RightsAsset {
  id: string;
  localPath: string;
  sourceUrl?: string;
  licenseBasis: LicenseBasis;
  permissionEvidence?: string;
  fairUseRationale?: string;
  reviewedBy?: string;
  approvedBy?: string;
  start: string;
  duration: string;
  editorialPurpose: string;
}

export interface ManifestAudit {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface EditPlan {
  projectTitle: string;
  generatedAt: string;
  outputPath: string;
  clips: Array<{
    id: string;
    localPath: string;
    start: string;
    duration: string;
    editorialPurpose: string;
  }>;
}

export type ShortsVisualMode = "none" | "minimal";

export interface FirstPartyShortsConfig {
  projectTitle: string;
  sourcePath: string;
  sourceUrl?: string;
  originalVideoId?: string;
  channelName?: string;
  visualMode?: ShortsVisualMode;
  shorts: FirstPartyShortCut[];
}

export interface FirstPartyShortCut {
  id: string;
  title: string;
  start: string;
  duration: string;
  caption?: string;
}

export interface FirstPartyShortsOutput {
  projectTitle: string;
  generatedAt: string;
  sourcePath: string;
  visualMode: ShortsVisualMode;
  shorts: Array<{
    id: string;
    title: string;
    outputPath: string;
    start: string;
    duration: string;
    sourceOrigin: "likely_original_channel";
    editorialLift: "low";
  }>;
}

export type YouTubePrivacyStatus = "private" | "unlisted" | "public";

export interface YouTubePublishQueue {
  channelName?: string;
  defaultPrivacyStatus?: YouTubePrivacyStatus;
  defaultCategoryId?: string;
  defaults?: {
    descriptionSuffix?: string;
    tags?: string[];
    madeForKids?: boolean;
  };
  items: YouTubePublishItem[];
}

export interface YouTubePublishItem {
  id: string;
  videoPath: string;
  title: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: YouTubePrivacyStatus;
  madeForKids?: boolean;
  containsSyntheticMedia?: boolean;
  approvedBy?: string;
}

export interface YouTubePublishResult {
  id: string;
  videoPath: string;
  title: string;
  privacyStatus: YouTubePrivacyStatus;
  uploaded: boolean;
  videoId?: string;
  url?: string;
}
