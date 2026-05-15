import { createReadStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { readJsonFile, writeJsonFile } from "./io.js";
import type { YouTubePrivacyStatus, YouTubePublishItem, YouTubePublishQueue, YouTubePublishResult } from "./types.js";

const youtubeUploadScope = "https://www.googleapis.com/auth/youtube.upload";

interface OAuthClientSecret {
  installed?: OAuthClientDetails;
  web?: OAuthClientDetails;
}

interface OAuthClientDetails {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

interface StoredToken {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

export async function loadYouTubePublishQueue(path: string): Promise<YouTubePublishQueue> {
  const queue = await readJsonFile<YouTubePublishQueue>(path);
  validatePublishQueue(queue);
  return queue;
}

export async function authenticateYouTubeUpload(options: {
  clientSecretPath: string;
  tokenPath: string;
  redirectUri?: string;
  port?: number;
}): Promise<void> {
  const port = options.port ?? 53682;
  const redirectUri = options.redirectUri ?? `http://127.0.0.1:${port}/oauth2callback`;
  const auth = await createOAuthClient(options.clientSecretPath, redirectUri);
  const authUrl = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [youtubeUploadScope],
  });

  await mkdir(dirname(options.tokenPath), { recursive: true });
  await waitForOAuthCallback(auth, authUrl, redirectUri, options.tokenPath);
}

export async function publishYouTubeQueue(options: {
  queuePath: string;
  clientSecretPath: string;
  tokenPath: string;
  outPath: string;
  execute: boolean;
  allowPublic: boolean;
  redirectUri?: string;
}): Promise<YouTubePublishResult[]> {
  const queue = await loadYouTubePublishQueue(options.queuePath);
  const uploadItems = queue.items.map((item) => materializeItem(queue, item));
  await validateUploadItems(uploadItems, options.allowPublic);

  if (!options.execute) {
    const dryRunResults = uploadItems.map((item) => toResult(item, false));
    await writeJsonFile(options.outPath, dryRunResults);
    return dryRunResults;
  }

  const auth = await createAuthenticatedClient(options.clientSecretPath, options.tokenPath, options.redirectUri);
  const youtube = google.youtube({ version: "v3", auth });
  const results: YouTubePublishResult[] = [];

  for (const item of uploadItems) {
    const response = await youtube.videos.insert({
      part: ["snippet", "status"],
      notifySubscribers: false,
      requestBody: {
        snippet: {
          title: item.title,
          description: item.description,
          tags: item.tags,
          categoryId: item.categoryId,
        },
        status: {
          privacyStatus: item.privacyStatus,
          selfDeclaredMadeForKids: item.madeForKids,
          containsSyntheticMedia: item.containsSyntheticMedia,
        } as Record<string, unknown>,
      },
      media: {
        mimeType: "video/mp4",
        body: createReadStream(resolve(process.cwd(), item.videoPath)),
      },
    });

    const videoId = response.data.id ?? undefined;
    results.push({
      ...toResult(item, true),
      videoId,
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined,
    });
  }

  await writeJsonFile(options.outPath, results);
  return results;
}

function materializeItem(queue: YouTubePublishQueue, item: YouTubePublishItem): Required<YouTubePublishItem> {
  const defaultTags = queue.defaults?.tags ?? [];
  const tags = [...new Set([...defaultTags, ...(item.tags ?? [])])];
  const suffix = queue.defaults?.descriptionSuffix ?? "";
  const description = `${item.description ?? ""}${suffix ? `\n\n${suffix}` : ""}`.trim();

  return {
    id: item.id,
    videoPath: item.videoPath,
    title: item.title,
    description,
    tags,
    categoryId: item.categoryId ?? queue.defaultCategoryId ?? "24",
    privacyStatus: item.privacyStatus ?? queue.defaultPrivacyStatus ?? "private",
    madeForKids: item.madeForKids ?? queue.defaults?.madeForKids ?? false,
    containsSyntheticMedia: item.containsSyntheticMedia ?? false,
    approvedBy: item.approvedBy ?? "",
  };
}

async function validateUploadItems(items: Array<Required<YouTubePublishItem>>, allowPublic: boolean): Promise<void> {
  const errors: string[] = [];
  for (const item of items) {
    if (!item.id) errors.push("item id is required");
    if (!item.videoPath) errors.push(`${item.id}: videoPath is required`);
    if (!item.title) errors.push(`${item.id}: title is required`);
    if (item.title.length > 100) errors.push(`${item.id}: title must be 100 characters or fewer`);
    if (!["private", "unlisted", "public"].includes(item.privacyStatus)) {
      errors.push(`${item.id}: privacyStatus must be private, unlisted, or public`);
    }
    if (item.privacyStatus === "public" && !allowPublic) {
      errors.push(`${item.id}: public uploads require --allow-public`);
    }
    if (!item.approvedBy) {
      errors.push(`${item.id}: approvedBy is required before upload`);
    }
    try {
      await access(resolve(process.cwd(), item.videoPath));
    } catch {
      errors.push(`${item.id}: video file does not exist at ${item.videoPath}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid YouTube publish queue:\n- ${errors.join("\n- ")}`);
  }
}

function validatePublishQueue(queue: YouTubePublishQueue): void {
  const errors: string[] = [];
  if (!Array.isArray(queue.items) || queue.items.length === 0) {
    errors.push("items must contain at least one upload item");
  }
  for (const [index, item] of (queue.items ?? []).entries()) {
    if (!item.id) errors.push(`items[${index}].id is required`);
    if (!item.videoPath) errors.push(`items[${index}].videoPath is required`);
    if (!item.title) errors.push(`items[${index}].title is required`);
  }
  if (errors.length > 0) {
    throw new Error(`Invalid YouTube publish queue:\n- ${errors.join("\n- ")}`);
  }
}

async function createAuthenticatedClient(
  clientSecretPath: string,
  tokenPath: string,
  redirectUri?: string,
): Promise<OAuth2Client> {
  const auth = await createOAuthClient(clientSecretPath, redirectUri);
  const token = JSON.parse(await readFile(tokenPath, "utf8")) as StoredToken;
  auth.setCredentials(token);
  return auth;
}

async function createOAuthClient(clientSecretPath: string, redirectUri?: string): Promise<OAuth2Client> {
  const secret = await readJsonFile<OAuthClientSecret>(clientSecretPath);
  const details = secret.installed ?? secret.web;
  if (!details?.client_id || !details.client_secret) {
    throw new Error("OAuth client secret must contain installed or web client_id/client_secret");
  }
  const resolvedRedirectUri = redirectUri ?? details.redirect_uris?.[0] ?? "http://127.0.0.1:53682/oauth2callback";
  return new google.auth.OAuth2(details.client_id, details.client_secret, resolvedRedirectUri);
}

async function waitForOAuthCallback(
  auth: OAuth2Client,
  authUrl: string,
  redirectUri: string,
  tokenPath: string,
): Promise<void> {
  const url = new URL(redirectUri);
  const port = Number(url.port || 80);
  const path = url.pathname;

  console.log("Open this URL to authorize YouTube uploads:");
  console.log(authUrl);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const server = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? "/", redirectUri);
        if (requestUrl.pathname !== path) {
          response.writeHead(404);
          response.end("Not found");
          return;
        }
        const code = requestUrl.searchParams.get("code");
        if (!code) {
          throw new Error("OAuth callback did not include a code");
        }
        const { tokens } = await auth.getToken(code);
        await writeFile(tokenPath, `${JSON.stringify(tokens, null, 2)}\n`, "utf8");
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("YouTube upload authorization saved. You can close this tab.");
        server.close();
        resolvePromise();
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end((error as Error).message);
        server.close();
        rejectPromise(error);
      }
    });
    server.listen(port, url.hostname, () => {
      console.log(`Waiting for OAuth callback on ${redirectUri}`);
    });
  });
}

function toResult(item: Required<YouTubePublishItem>, uploaded: boolean): YouTubePublishResult {
  return {
    id: item.id,
    videoPath: item.videoPath,
    title: item.title,
    privacyStatus: item.privacyStatus as YouTubePrivacyStatus,
    uploaded,
  };
}
