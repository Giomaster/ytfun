import type { CandidateVideo, ScopeConfig, TopicConfig } from "./types.js";
import { hoursAgoIso, parseDurationToSeconds } from "./time.js";

interface SearchListResponse {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      publishedAt?: string;
      channelId?: string;
      title?: string;
      description?: string;
      channelTitle?: string;
      thumbnails?: CandidateVideo["thumbnails"];
    };
  }>;
  error?: { message?: string };
}

interface VideosListResponse {
  items?: Array<{
    id?: string;
    contentDetails?: { duration?: string };
    statistics?: {
      viewCount?: string;
      likeCount?: string;
      commentCount?: string;
    };
    status?: {
      license?: string;
    };
  }>;
  error?: { message?: string };
}

export async function discoverFromYouTube(config: ScopeConfig): Promise<CandidateVideo[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY is required for discovery. Export it before running this command.");
  }

  const candidates: CandidateVideo[] = [];
  for (const topic of config.topics) {
    for (const query of topic.queries) {
      const results = await searchVideos(apiKey, config, topic, query);
      candidates.push(...results);
    }
  }

  const unique = dedupeById(candidates);
  const enriched = await enrichVideos(apiKey, unique);
  return enriched;
}

async function searchVideos(
  apiKey: string,
  config: ScopeConfig,
  topic: TopicConfig,
  query: string,
): Promise<CandidateVideo[]> {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("order", "viewCount");
  url.searchParams.set("safeSearch", "moderate");
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(config.maxResultsPerQuery ?? 10));
  if (config.regionCode) url.searchParams.set("regionCode", config.regionCode);
  if (config.language) url.searchParams.set("relevanceLanguage", config.language);
  if (config.publishedAfterHours) {
    url.searchParams.set("publishedAfter", hoursAgoIso(config.publishedAfterHours));
  }
  if (topic.license && topic.license !== "any") {
    url.searchParams.set("videoLicense", topic.license);
  }

  const data = await fetchJson<SearchListResponse>(url);
  return (data.items ?? [])
    .filter((item) => item.id?.videoId && item.snippet)
    .map((item) => ({
      id: item.id?.videoId ?? "",
      url: `https://www.youtube.com/watch?v=${item.id?.videoId}`,
      title: item.snippet?.title ?? "",
      description: item.snippet?.description ?? "",
      channelId: item.snippet?.channelId ?? "",
      channelTitle: item.snippet?.channelTitle ?? "",
      publishedAt: item.snippet?.publishedAt ?? "",
      thumbnails: item.snippet?.thumbnails ?? {},
      query,
      topicId: topic.id,
      topicName: topic.name,
    }));
}

async function enrichVideos(apiKey: string, candidates: CandidateVideo[]): Promise<CandidateVideo[]> {
  const chunks = chunk(candidates, 50);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  for (const group of chunks) {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("part", "contentDetails,statistics,status");
    url.searchParams.set("id", group.map((candidate) => candidate.id).join(","));

    const data = await fetchJson<VideosListResponse>(url);
    for (const item of data.items ?? []) {
      if (!item.id) continue;
      const candidate = byId.get(item.id);
      if (!candidate) continue;
      candidate.durationSeconds = item.contentDetails?.duration
        ? parseDurationToSeconds(item.contentDetails.duration)
        : undefined;
      candidate.views = numberOrUndefined(item.statistics?.viewCount);
      candidate.likes = numberOrUndefined(item.statistics?.likeCount);
      candidate.comments = numberOrUndefined(item.statistics?.commentCount);
      candidate.license = item.status?.license;
    }
  }

  return candidates;
}

async function fetchJson<T extends { error?: { message?: string } }>(url: URL): Promise<T> {
  const response = await fetch(url);
  const data = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(data.error?.message ?? `YouTube API request failed with ${response.status}`);
  }
  return data;
}

function dedupeById(candidates: CandidateVideo[]): CandidateVideo[] {
  return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
}

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
