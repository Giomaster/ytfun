import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { episodeAssetHash, episodeReviewHash, validateEpisodeDerivation, normalizeProjectCadence } from './domain.mjs';
import { YouTubeAuth, YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE } from './oauth.mjs';
import { FacebookPageVideo, FacebookReels, safeFacebookVideoPermalink, validateFacebookPageVideo, validateFacebookReel } from './facebook.mjs';
import { distributionCapabilities, publicationPackage } from './distribution.mjs';
import { assertYouTubeConnected, youtubeApiData, youtubeBlocked } from './youtube-data-policy.mjs';
import { TikTokWeb } from './tiktok-web.mjs';
import { privateSessionFile } from './tiktok-session.mjs';
import { approvalReviewIsValid } from './review-policy.mjs';
import { TikTokZernio, validateTikTokZernioAttestation, validateTikTokZernioRender } from './tiktok-zernio.mjs';
import { sanitizeTikTokZernioAttestation } from './tiktok-zernio-attestation.mjs';
import { YouTubeZernio, safeZernioYouTubePermalink } from './youtube-zernio.mjs';

const DAY_MS = 86_400_000;
const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
const GOOGLE_API = 'https://www.googleapis.com';
const RESERVED_STATUSES = new Set(['reserved', 'uploading', 'sending', 'unknown', 'processing', 'uploaded', 'scheduled', 'published']);

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function verifyDeliveryClaim(state, deliveryId, plan, { privacy, madeForKids } = {}) {
  if (deliveryId === undefined) return;
  const delivery = state.deliveries?.find(item => item.id === deliveryId && item.status === 'running');
  if (plan.platform === 'youtube' && plan.deliveryMode !== 'zernio') {
    assertYouTubeConnected(state, { YTFUN_YOUTUBE_GRANT_ID: plan.youtubeGrantId ?? 'legacy' });
    if ((delivery?.apiData?.grantId ?? 'legacy') !== (plan.youtubeGrantId ?? 'legacy')) throw new Error('Delivery claim belongs to another YouTube consent generation.');
  }
  if (!delivery || delivery.episodeId !== plan.episodeId || delivery.platform !== plan.platform ||
      delivery.accountId !== plan.accountId || delivery.reviewHash !== plan.reviewHash ||
      delivery.renderSha256 !== plan.render.sha256 || delivery.privacy !== privacy ||
      (plan.platform === 'youtube' && delivery.madeForKids !== madeForKids)) throw new Error('Delivery claim no longer matches this exact publication.');
  if (delivery.mode !== (plan.deliveryMode ?? (['youtube', 'facebook'].includes(plan.platform) ? 'official_api' : 'creator_export')) ||
      (plan.deliveryMode === 'zernio' && (delivery.providerAccountId !== plan.providerAccountId || delivery.bindingSha256 !== plan.bindingSha256))) {
    throw new Error('Delivery provider or account binding changed; explicitly migrate an unstarted claim.');
  }
}

function providerBinding(env, platform) {
  try { return JSON.parse(env[`ZERNIO_${platform.toUpperCase()}_BINDING_JSON`] ?? 'null'); }
  catch { return null; }
}

function tiktokConsentPermitted(consent, renderSha256, env, readiness) {
  if (!consent || !validateTikTokZernioAttestation(consent.attestation, renderSha256, { env })) return false;
  if (env.ZERNIO_TIKTOK_ACCOUNT_ID !== readiness.providerAccountId || providerBinding(env, 'tiktok')?.evidenceSha256 !== readiness.bindingSha256) return false;
  if (consent.attestation.previewWitness === 'authorized_agent' && readiness.standingAuthoritySha256 !== consent.attestation.authorityEvidenceSha256) return false;
  // Historical explicit-owner records predate provider bindings; delegated records never do.
  if (consent.providerAccountId === undefined && consent.bindingSha256 === undefined) return consent.attestation.previewWitness === 'owner';
  return consent.providerAccountId === readiness.providerAccountId && consent.bindingSha256 === readiness.bindingSha256;
}

function publicEnabled(env) {
  return env.YTFUN_YOUTUBE_PUBLIC_ENABLED === 'true' && env.YTFUN_YOUTUBE_AUDIT_CONFIRMED === 'true';
}

function maxFileBytes(env) {
  const configured = Number(env.YTFUN_MAX_UPLOAD_BYTES ?? DEFAULT_MAX_BYTES);
  if (!Number.isSafeInteger(configured) || configured <= 0 || configured > DEFAULT_MAX_BYTES) {
    throw new Error('YTFUN_MAX_UPLOAD_BYTES must be a positive integer no greater than 250 MiB.');
  }
  return configured;
}

async function rejectMediaSymlinks(root, relativePath) {
  let current = root;
  const parts = relativePath.split(path.sep);
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i] || parts[i] === '.' || parts[i] === '..') throw new Error('Media requires a canonical path within studio storage.');
    current = path.join(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory())) throw new Error('Facebook media paths must not contain symbolic links.');
  }
}

async function verifiedFile(directory, relativePath, expectedHash, maxBytes, { noSymlinks = false } = {}) {
  if (!nonempty(relativePath) || path.isAbsolute(relativePath) || !/^[a-f0-9]{64}$/i.test(expectedHash ?? '')) {
    throw new Error('Media requires a relative path and a SHA-256 fingerprint.');
  }
  const root = await realpath(directory);
  if (noSymlinks) await rejectMediaSymlinks(root, relativePath);
  const file = await realpath(path.resolve(root, relativePath));
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Media must remain inside the studio directory.');
  }
  const info = await stat(file);
  if (!info.isFile() || info.size < 1 || info.size > maxBytes) {
    throw new Error('Media must be a nonempty regular file within the upload size limit.');
  }
  const hash = createHash('sha256');
  let bytesRead = 0;
  for await (const chunk of createReadStream(file)) {
    bytesRead += chunk.length;
    if (bytesRead > maxBytes) throw new Error('Media exceeded the upload size limit while reading.');
    hash.update(chunk);
  }
  if (hash.digest('hex') !== expectedHash.toLowerCase()) throw new Error('Media fingerprint changed after review.');
  return { absolutePath: file, relativePath: relative, sizeBytes: info.size, device: info.dev, inode: info.ino };
}

async function facebookMediaBody(directory, file, expectedHash, maxBytes) {
  const root = await realpath(directory);
  await rejectMediaSymlinks(root, file.relativePath);
  const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== file.device || info.ino !== file.inode || info.size !== file.sizeBytes || info.size > maxBytes) {
      throw new Error('Facebook render changed while preparing the upload.');
    }
    // Recheck directory components after acquiring the descriptor; all bytes
    // subsequently come from that exact open regular file, never another path.
    await rejectMediaSymlinks(root, file.relativePath);
    if (await realpath(file.absolutePath) !== file.absolutePath) throw new Error('Facebook media path changed while preparing the upload.');
    const chunks = [];
    let length = 0;
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      length += chunk.length;
      if (length > maxBytes) throw new Error('Facebook media exceeded its upload size limit.');
      hash.update(chunk);
      chunks.push(chunk);
    }
    if (length !== file.sizeBytes || hash.digest('hex') !== expectedHash.toLowerCase()) throw new Error('Facebook render changed after review.');
    return Buffer.concat(chunks, length);
  } finally { await handle.close(); }
}

async function boundedMediaBody(filename, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of createReadStream(filename)) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('Media exceeded the upload size limit while reading.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function metadataFor(episode) {
  const hashtags = episode.metadata?.hashtags ?? [];
  const tags = episode.metadata?.tags ?? hashtags.map((tag) => typeof tag === 'string' ? tag.replace(/^#/, '') : tag);
  if (!Array.isArray(hashtags) || !hashtags.every(nonempty) || !Array.isArray(tags) || !tags.every(nonempty)) {
    throw new Error('Metadata hashtags and tags must be arrays of nonempty strings.');
  }
  const description = episode.metadata?.description ?? '';
  if (!nonempty(episode.title) || episode.title.length > 100 || /[<>]/.test(episode.title)) {
    throw new Error('YouTube title must contain 1 to 100 characters without angle brackets.');
  }
  if (typeof description !== 'string') throw new Error('Description must be a string.');
  const hashtagText = hashtags.map((tag) => tag.startsWith('#') ? tag : `#${tag}`).join(' ');
  const fullDescription = [description, hashtagText].filter(nonempty).join('\n\n');
  if (fullDescription.length > 5000 || Buffer.byteLength(fullDescription, 'utf8') > 5000 || /[<>]/.test(fullDescription)) {
    throw new Error('YouTube description, including hashtags, exceeds its limit or contains angle brackets.');
  }
  const tagCost = tags.reduce((total, tag) => total + tag.length + (/\s/.test(tag) ? 2 : 0), Math.max(0, tags.length - 1));
  if (tagCost > 500) throw new Error('YouTube tags exceed the 500-character limit.');
  return { title: episode.title, description: fullDescription, tags, hashtags };
}

function cadenceIssues(state, project, platform, accountId, effectiveAt, { waiveFrequency = false } = {}) {
  let cadence;
  try { cadence = normalizeProjectCadence(project.cadence, { defaults: true }); }
  catch { return ['Project cadence requires nonnegative finite spacing and a positive integer count cap or explicit null.']; }
  const candidate = Date.parse(effectiveAt);
  const peers = state.publications.filter((entry) => entry.platform === platform && entry.accountId === accountId && RESERVED_STATUSES.has(entry.status));
  if (peers.some((entry) => !Number.isFinite(Date.parse(entry.effectiveAt ?? entry.createdAt)))) {
    return ['A channel publication has an invalid reservation time and requires reconciliation.'];
  }
  // Enforce the stricter policy of each involved project across their shared channel.
  let limits;
  try { limits = [cadence, ...peers.map(entry => normalizeProjectCadence(state.projects.find(item => item.id === entry.projectId)?.cadence, { defaults: true }))]; }
  catch { return ['A shared-channel project has an invalid cadence policy and requires reconciliation.']; }
  const channelMinHours = Math.max(...limits.map(limit => limit.minHoursBetweenPosts));
  const channelMaxPosts = Math.min(...limits.map(limit => limit.maxPostsPerRollingDay === null ? Infinity : limit.maxPostsPerRollingDay));
  const times = peers.map((entry) => Date.parse(entry.effectiveAt ?? entry.createdAt));
  const reasons = [];
  if (!waiveFrequency && times.some((time) => Math.abs(time - candidate) < channelMinHours * 3_600_000)) {
    reasons.push(`Channel cadence requires at least ${channelMinHours} hours between reserved or completed uploads.`);
  }
  const nearby = times.filter((time) => Math.abs(time - candidate) < DAY_MS);
  const windowEnds = [candidate, ...nearby.filter((time) => time >= candidate)];
  if (!waiveFrequency && windowEnds.some((end) => nearby.filter((time) => time <= end && time > end - DAY_MS).length + 1 > channelMaxPosts)) {
    reasons.push(`Channel cadence permits at most ${channelMaxPosts} upload(s) in any rolling 24 hours.`);
  }
  return reasons;
}

function facebookCadenceException(state, { cadenceExceptionId, deliveryId, episode, reviewHash, accountId, platform, privacy }, now) {
  if (cadenceExceptionId === undefined) return null;
  const exception = state.facebookCadenceExceptions?.find(item => item.id === cadenceExceptionId);
  const delivery = state.deliveries?.find(item => item.id === deliveryId);
  if (platform !== 'facebook' || privacy !== 'public' || !exception || exception.status !== 'authorized' ||
      exception.platform !== platform || exception.privacy !== privacy || exception.accountId !== accountId ||
      exception.deliveryId !== deliveryId || exception.episodeId !== episode.id || exception.reviewHash !== reviewHash ||
      exception.renderSha256 !== episode.render?.sha256 || !Number.isFinite(Date.parse(exception.expiresAt)) ||
      Date.parse(exception.expiresAt) <= now || !delivery || !['queued', 'running'].includes(delivery.status) ||
      delivery.cadenceExceptionId !== exception.id || delivery.platform !== platform || delivery.privacy !== privacy ||
      delivery.accountId !== accountId || delivery.episodeId !== episode.id || delivery.reviewHash !== reviewHash ||
      delivery.renderSha256 !== episode.render?.sha256) throw new Error('Facebook cadence exception is expired, consumed or does not match this exact public delivery.');
  const peers = state.publications.filter(item => item.platform === platform && item.accountId === accountId && RESERVED_STATUSES.has(item.status));
  if (peers.some(item => item.status !== 'published') ||
      peers.some(item => item.episodeId === episode.id || item.renderSha256 === episode.render?.sha256) ||
      JSON.stringify(peers.map(item => item.id).sort()) !== JSON.stringify(exception.priorPublicationIds)) {
    throw new Error('Facebook cadence exception requires unchanged, resolved publication receipts and distinct media.');
  }
  return exception;
}

function safeSessionUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('YouTube returned an invalid upload session.'); }
  if (url.protocol !== 'https:' || !['www.googleapis.com', 'youtube.googleapis.com'].includes(url.hostname) ||
      url.username || url.password || (url.port && url.port !== '443') || url.pathname !== '/upload/youtube/v3/videos' || url.hash) {
    throw new Error('YouTube returned an upload session outside the Google allowlist.');
  }
  return url.href;
}

async function responseJson(response) {
  try { return await response.json(); } catch { return null; }
}

export class Publisher {
  constructor(store, { env = process.env, fetchImpl = fetch, youtubeAuth, facebook, facebookPageVideo, tiktok, tiktokZernio, youtubeZernio } = {}) {
    this.store = store;
    this.env = env;
    this.youtubeGrantId = env.YTFUN_YOUTUBE_GRANT_ID || 'legacy';
    this.fetch = fetchImpl;
    this.youtubeAuth = youtubeAuth ?? new YouTubeAuth({ env, fetchImpl });
    this.facebook = facebook ?? new FacebookReels({ env, fetchImpl });
    this.facebookPageVideo = facebookPageVideo ?? new FacebookPageVideo({ env, fetchImpl });
    this.tiktok = tiktok ?? new TikTokWeb({ env, fetchImpl });
    this.tiktokZernio = tiktokZernio ?? new TikTokZernio({ env, fetchImpl, binding: providerBinding(env, 'tiktok') });
    this.youtubeZernio = youtubeZernio ?? new YouTubeZernio({ env, fetchImpl, binding: providerBinding(env, 'youtube'),
      verifyPublishedVideo: args => this.verifyZernioYouTubeVideo(args) });
  }

  zernioSelected(platform) { return ['tiktok', 'youtube'].includes(platform) && this.env[`YTFUN_${platform.toUpperCase()}_ZERNIO_PUBLISH_ENABLED`] === 'true'; }

  zernioAdapter(platform) { return platform === 'tiktok' ? this.tiktokZernio : this.youtubeZernio; }

  capabilities() {
    return { platforms: distributionCapabilities(this.env), youtubeAuth: this.youtubeAuth.readiness(), facebook: this.facebook.readiness(), facebookPageVideo: this.facebookPageVideo.readiness(), tiktokSession: this.tiktok.readiness(), tiktokZernio: this.tiktokZernio.readiness(), youtubeZernio: this.youtubeZernio.readiness() };
  }

  async plan(state, { episodeId, platform, privacy = 'private', publishAt, cadenceExceptionId, deliveryId }, now = Date.now()) {
    if (!['youtube', 'facebook', 'tiktok', 'kwai'].includes(platform)) throw new Error('Platform must be youtube, facebook, tiktok, or kwai.');
    if (!['private', 'unlisted', 'public'].includes(privacy)) throw new Error('Privacy must be private, unlisted, or public.');
    const episode = state.episodes.find((item) => item.id === episodeId);
    if (!episode) throw new Error('Episode not found.');
    const project = state.projects.find((item) => item.id === episode.projectId);
    if (!project) throw new Error('Episode project not found.');
    const reasons = [];
    const zernio = this.zernioSelected(platform);
    const providerReadiness = zernio ? this.zernioAdapter(platform).readiness() : null;
    if (platform === 'youtube' && !zernio && youtubeBlocked(state, { YTFUN_YOUTUBE_GRANT_ID: this.youtubeGrantId })) reasons.push('YouTube is disconnected; obtain fresh consent and restart the MCP.');
    if (project.status !== 'active') reasons.push('The episode project must be active before publishing or exporting.');
    if (project.mode === 'factual' && (!Array.isArray(episode.factualSources) || episode.factualSources.length === 0)) {
      reasons.push('Factual content requires claim-specific sources before publishing.');
    }
    const reviewHash = episodeReviewHash(episode);
    const review = episode.approval?.review;
    if (episode.approval?.reviewHash !== reviewHash || !episode.approval?.approvedAt ||
        !approvalReviewIsValid(review, { env: this.env, render: episode.render })) {
      reasons.push('Episode requires a current editorial approval of originality, facts, and the finished render.');
    }
    if (episode.approval?.assetReviewHash !== episodeAssetHash(episode, state.assets)) {
      reasons.push('Generated asset fingerprints or license evidence changed after editorial review.');
    }
    try { await validateEpisodeDerivation(state, episode, this.store.directory); }
    catch { reasons.push('Derived source lineage is missing, invalid or changed; re-review the original source and this short before delivery.'); }
    if (!nonempty(episode.originalAngle)) reasons.push('Episode requires its own original creative angle.');
    if (episode.render?.synthetic !== true || !Number.isFinite(episode.render?.durationSeconds) || episode.render.durationSeconds <= 0) {
      reasons.push('Episode requires a completed synthetic render with a valid duration.');
    }
    let render;
    try {
      render = await verifiedFile(this.store.directory, episode.render?.path, episode.render?.sha256, maxFileBytes(this.env), { noSymlinks: zernio || ['facebook', 'tiktok'].includes(platform) });
      if (path.extname(render.absolutePath).toLowerCase() !== '.mp4') reasons.push('Publishing requires an MP4 render.');
    } catch {
      reasons.push('Render is missing, changed, outside studio storage, or exceeds the upload limit.');
    }
    const mappings = episode.render?.sceneAssets;
    const scenes = episode.scenes ?? [];
    const silent = episode.audioMode === 'silent';
    if (silent && (episode.render?.audioMode !== 'silent' || episode.render?.hasAudio !== false ||
        ['captionsPath', 'captionsSha256', 'captionsTiming'].some(key => episode.render?.[key] !== undefined) ||
        (Array.isArray(mappings) && mappings.some(mapping => mapping.audioAssetId !== undefined)))) reasons.push('Silent publication requires a reviewed render with zero audio and no captions.');
    if (!silent && episode.render?.audioMode === 'silent') reasons.push('Render audio mode does not match the episode.');
    if (episode.audioMode === 'nonverbal' && (episode.render?.audioMode !== 'nonverbal' || episode.render?.hasAudio !== true ||
        ['captionsPath', 'captionsSha256', 'captionsTiming'].some(key => episode.render?.[key] !== undefined))) reasons.push('Nonverbal publication requires original audio and no narration captions.');
    if (!Array.isArray(mappings) || !Array.isArray(scenes) || scenes.length === 0 || mappings.length !== scenes.length ||
        new Set(mappings?.map((mapping) => mapping.sceneId)).size !== scenes.length) {
      reasons.push('Render must map every scene to its generated visual and audio assets.');
    } else {
      for (const scene of scenes) {
        const mapping = mappings.find((item) => item.sceneId === scene.id);
        const assets = [[mapping?.visualAssetId, ['image', 'video']], ...(!silent ? [[mapping?.audioAssetId, ['audio']]] : [])];
        for (const [assetId, allowedKinds] of assets) {
          const asset = state.assets.find((item) => item.id === assetId);
          if (asset?.qualityReview?.decision === 'rejected') {
            reasons.push('A render source asset was rejected by quality review; replace it explicitly and review a new render before publication or export.');
            continue;
          }
          const license = asset?.provenance?.commercialLicense;
          let validLicense = false;
          try { validLicense = ['https:', 'http:'].includes(new URL(license?.url).protocol); } catch { /* Invalid evidence URL. */ }
          if (!asset || asset.episodeId !== episode.id || asset.sceneId !== scene.id || !allowedKinds.includes(asset.kind) ||
              asset.synthetic !== true || !nonempty(asset.provenance?.provider) || !nonempty(asset.provenance?.model) ||
              !validLicense || !nonempty(license?.notes ?? license?.evidence)) {
            reasons.push('Every scene requires original generated assets with provider, model, and commercial-license evidence.');
            continue;
          }
          try { await verifiedFile(this.store.directory, asset.path, asset.sha256, maxFileBytes(this.env), { noSymlinks: platform === 'facebook' }); }
          catch { reasons.push('A scene asset is missing, changed, or outside studio storage.'); }
        }
      }
    }
    let metadata;
    try { metadata = metadataFor(episode); } catch (error) { reasons.push(error.message); }
    let effectiveAt = new Date(now).toISOString();
    if (publishAt !== undefined) {
      const scheduled = Date.parse(publishAt);
      if (platform !== 'youtube' || privacy === 'unlisted' || !Number.isFinite(scheduled) || scheduled <= now) {
        reasons.push('publishAt requires a future YouTube public-release schedule and cannot use unlisted privacy.');
      } else effectiveAt = new Date(scheduled).toISOString();
    }
    const accountId = { youtube: this.env.YOUTUBE_CHANNEL_ID, facebook: this.env.FACEBOOK_PAGE_ID, tiktok: this.env.TIKTOK_ACCOUNT_ID, kwai: this.env.KWAI_ACCOUNT_ID }[platform] ?? null;
    const existing = state.publications.find((item) => item.episodeId === episode.id && item.platform === platform && RESERVED_STATUSES.has(item.status));
    if (existing) reasons.push('This reviewed episode already has an upload or reservation; reconcile its existing publication.');
    const ordinaryCadence = cadenceIssues(state, project, platform, accountId, effectiveAt);
    let exception;
    try { exception = facebookCadenceException(state, { cadenceExceptionId, deliveryId, episode, reviewHash, accountId, platform, privacy }, now); }
    catch (error) { reasons.push(error.message); }
    const cadence = exception ? cadenceIssues(state, project, platform, accountId, effectiveAt, { waiveFrequency: true }) : ordinaryCadence;
    if (platform === 'youtube') {
      if (!nonempty(accountId)) reasons.push('YOUTUBE_CHANNEL_ID must identify the intended channel.');
      if (!zernio && !this.youtubeAuth.readiness().ready) reasons.push('YouTube requires OAuth credentials with youtube.upload and youtube.readonly scopes.');
      if (!zernio && (privacy !== 'private' || publishAt !== undefined) && !publicEnabled(this.env)) {
        reasons.push('External visibility requires confirmed YouTube API audit and explicit public publishing enablement.');
      }
      reasons.push(...cadence);
    }
    const facebookVideoKind = episode.format === 'long' ? 'page_video' : 'reel';
    if (platform === 'facebook') {
      if (episode.format !== undefined && !['long', 'short'].includes(episode.format)) reasons.push('Facebook requires an explicit valid long or short episode format.');
      if (privacy !== 'public') reasons.push('Facebook Page publishing requires explicitly selected public visibility.');
      const adapter = facebookVideoKind === 'page_video' ? this.facebookPageVideo : this.facebook;
      const validate = facebookVideoKind === 'page_video' ? validateFacebookPageVideo : validateFacebookReel;
      const readiness = adapter.readiness();
      if (readiness.accountId !== undefined && readiness.accountId !== accountId) reasons.push('Facebook configuration changed; restart the publisher with the intended Page authorization.');
      reasons.push(...readiness.reasons, ...cadence, ...validate(episode.render ?? {}).reasons);
    }
    const tiktokSessionPost = platform === 'tiktok' && privacy === 'public';
    if (tiktokSessionPost && !zernio) {
      const readiness = this.tiktok.readiness();
      if (readiness.accountId !== accountId) reasons.push('TikTok account configuration changed.');
      reasons.push(...readiness.reasons, ...cadence);
      if (!Number.isFinite(episode.render?.durationSeconds) || episode.render.durationSeconds < 1 || episode.render.durationSeconds > 180 ||
          !Number.isInteger(episode.render.width) || !Number.isInteger(episode.render.height) || episode.render.width < 256 || episode.render.height < 256 ||
          render?.sizeBytes > 8 * 1024 * 1024) reasons.push('The experimental TikTok route currently supports reviewed clips up to 180 seconds and 8 MiB with explicit dimensions.');
    }
    if (zernio) {
      if (privacy !== 'public' || publishAt !== undefined) reasons.push('Zernio requires immediate public publication; due times remain in the local queue.');
      if (providerReadiness.accountId !== accountId) reasons.push('Zernio native account binding changed.');
      reasons.push(...providerReadiness.reasons, ...(platform === 'tiktok' ? cadence : []));
      if (platform === 'tiktok') {
        reasons.push(...validateTikTokZernioRender({ ...episode.render, format: 'mp4', sizeBytes: render?.sizeBytes }).reasons);
        const consent = state.zernioConsents?.find(item => item.episodeId === episode.id && item.accountId === accountId && item.reviewHash === reviewHash && item.renderSha256 === episode.render?.sha256);
        if (!tiktokConsentPermitted(consent, episode.render?.sha256, this.env, providerReadiness)) reasons.push('Zernio requires an actual preview and owner-authorized consent for this exact TikTok render and account binding.');
      } else if (episode.render?.durationSeconds < 1 || episode.render?.durationSeconds > providerReadiness.maxDurationSeconds) reasons.push('YouTube Zernio video duration exceeds the configured adapter profile.');
    }
    const caption = metadata ? [metadata.title, metadata.description].filter(nonempty).join('\n\n') : '';
    if (platform === 'facebook' && caption.length > 5000) reasons.push('Facebook caption exceeds the studio 5000-character limit.');
    if (platform === 'tiktok' && caption.length > 2200) reasons.push('TikTok caption exceeds 2200 UTF-16 code units.');
    return {
      episodeId: episode.id, projectId: project.id, platform, accountId, reviewHash, privacy,
      ...(platform === 'youtube' && !zernio ? { youtubeGrantId: this.youtubeGrantId } : {}),
      ...(platform === 'facebook' ? { facebookVideoKind } : {}),
      uploadPrivacy: publishAt === undefined ? privacy : 'private', effectiveAt,
      ...(publishAt !== undefined ? { publishAt: effectiveAt } : {}),
      ready: reasons.length === 0 && (['youtube', 'facebook'].includes(platform) || tiktokSessionPost), readyToExport: reasons.length === 0 && ['tiktok', 'kwai'].includes(platform) && !tiktokSessionPost,
      reasons: [...new Set(reasons)], cadence: { warnings: cadence,
        ...(exception ? { exceptionId: exception.id, waivedWarnings: ordinaryCadence.filter(reason => !cadence.includes(reason)) } : {}) }, disclosure: { synthetic: true },
      capabilities: { directPost: ['youtube', 'facebook'].includes(platform) || tiktokSessionPost, requiresCreatorPublishing: ['tiktok', 'kwai'].includes(platform) && !tiktokSessionPost },
      ...(zernio ? { deliveryMode: 'zernio', providerAccountId: providerReadiness.providerAccountId, bindingSha256: providerReadiness.bindingSha256 ?? providerBinding(this.env, platform)?.evidenceSha256 } : tiktokSessionPost ? { deliveryMode: 'experimental_session_rest' } : {}),
      ...(render ? { render: { path: render.relativePath, sha256: episode.render.sha256, sizeBytes: render.sizeBytes, durationSeconds: episode.render.durationSeconds,
        ...(tiktokSessionPost ? { width: episode.render.width, height: episode.render.height } : {}) } } : {}),
      ...(metadata ? { metadata, caption } : {}), ...(existing ? { publication: existing } : {}),
    };
  }

  async preflight(args, { now = Date.now() } = {}) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Publication planning requires a valid clock.');
    return this.plan(await this.store.read(), args, now);
  }

  /** Trusted operator attestation, scoped to one public Facebook delivery and one dispatch. */
  async authorizeFacebookCadenceException({ deliveryId, expectedReviewHash, accountId, cycleId, authorizedBy, authorityReference, reason, expiresAt }) {
    for (const [name, value] of Object.entries({ deliveryId, accountId, cycleId, authorizedBy, authorityReference, reason })) {
      if (!nonempty(value) || value.length > (name === 'authorityReference' ? 2048 : 1000)) throw new Error(`Cadence exception requires bounded ${name} evidence.`);
    }
    if (!/^[a-f0-9]{64}$/.test(expectedReviewHash ?? '') || accountId !== this.env.FACEBOOK_PAGE_ID) throw new Error('Cadence exception requires the configured Facebook Page and exact review fingerprint.');
    const now = Date.now();
    const expiration = Date.parse(expiresAt);
    if (typeof expiresAt !== 'string' || !Number.isFinite(expiration) || new Date(expiration).toISOString() !== expiresAt ||
        expiration <= now || expiration > now + 3_600_000) throw new Error('Cadence exception must expire within one hour using canonical ISO UTC.');
    return this.store.transaction(async state => {
      const delivery = state.deliveries?.find(item => item.id === deliveryId);
      if (!delivery || delivery.status !== 'queued' || delivery.platform !== 'facebook' || delivery.privacy !== 'public' ||
          delivery.accountId !== accountId || delivery.reviewHash !== expectedReviewHash) throw new Error('Cadence exception requires an unstarted, exact public Facebook delivery.');
      if (state.deliveries.some(item => item.status === 'running')) throw new Error('Reconcile the running delivery before authorizing a cadence exception.');
      const previous = state.facebookCadenceExceptions?.find(item => item.accountId === accountId && item.deliveryId === deliveryId);
      if (previous) {
        if (previous.cycleId !== cycleId || previous.reviewHash !== expectedReviewHash || previous.renderSha256 !== delivery.renderSha256 ||
            previous.status !== 'authorized' || Date.parse(previous.expiresAt) <= Date.now()) throw new Error('This delivery already has a different, expired or consumed cadence exception.');
        return { duplicate: true, exception: previous, delivery };
      }
      if (delivery.cadenceExceptionId) throw new Error('This delivery already has an exception; reconcile it without renewing the authorization.');
      const plan = await this.plan(state, { episodeId: delivery.episodeId, platform: 'facebook', privacy: 'public' });
      const project = state.projects.find(item => item.id === plan.projectId);
      const structuralCadence = cadenceIssues(state, project, 'facebook', accountId, plan.effectiveAt, { waiveFrequency: true });
      const frequencyReasons = plan.cadence.warnings.filter(item => !structuralCadence.includes(item));
      const remainingReasons = plan.reasons.filter(item => !frequencyReasons.includes(item));
      if (remainingReasons.length || plan.publication || plan.accountId !== accountId || plan.reviewHash !== expectedReviewHash || plan.render?.sha256 !== delivery.renderSha256) {
        throw new Error(remainingReasons.join(' ') || 'Cadence exception media or account no longer matches the queued delivery.');
      }
      const peers = state.publications.filter(item => item.platform === 'facebook' && item.accountId === accountId && RESERVED_STATUSES.has(item.status));
      if (peers.some(item => item.status !== 'published') || peers.some(item => item.renderSha256 === delivery.renderSha256)) throw new Error('Reconcile existing Facebook reservations or duplicate media before authorizing an exception.');
      const createdAt = new Date().toISOString();
      if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error('Cadence exception expired before authorization could be recorded.');
      const exception = { id: randomUUID(), platform: 'facebook', privacy: 'public', accountId, cycleId,
        deliveryId, episodeId: delivery.episodeId, projectId: plan.projectId, reviewHash: expectedReviewHash, renderSha256: delivery.renderSha256,
        authorizedBy: authorizedBy.trim(), authorityReference: authorityReference.trim(), reason: reason.trim(), createdAt, expiresAt,
        priorPublicationIds: peers.map(item => item.id).sort(), waivedFrequencyReasons: frequencyReasons, status: 'authorized' };
      state.facebookCadenceExceptions ??= [];
      state.facebookCadenceExceptions.push(exception);
      delivery.cadenceExceptionHistory ??= [];
      delivery.cadenceExceptionHistory.push({ previousDueAt: delivery.dueAt, changedAt: createdAt, exceptionId: exception.id, reason: exception.reason });
      delivery.cadenceExceptionId = exception.id;
      delivery.dueAt = createdAt;
      delivery.updatedAt = createdAt;
      return { exception, delivery };
    });
  }

  async updatePublication(id, changes) {
    // Only retry a contended local commit; never repeat a remote upload request.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.store.transaction((state) => {
          const record = state.publications.find((item) => item.id === id);
          if (!record) throw new Error('Publication reservation not found.');
          // A late provider response must not recreate deleted API/user data.
          if (record.platform === 'youtube' && record.localOnly) return record;
          if (record.platform === 'youtube' && record.route !== 'zernio' && youtubeBlocked(state, { YTFUN_YOUTUBE_GRANT_ID: this.youtubeGrantId })) return record;
          if (record.platform === 'youtube' && record.route !== 'zernio' && (record.apiData?.grantId ?? 'legacy') !== this.youtubeGrantId) throw new Error('The publication belongs to another YouTube grant; a stale worker cannot replace its receipt.');
          Object.assign(record, changes, { updatedAt: new Date().toISOString() });
          const episode = state.episodes.find((item) => item.id === record.episodeId);
          if (episode && ['youtube', 'facebook', 'tiktok'].includes(record.platform) && record.status !== 'exported') {
            episode.status = record.status === 'unknown' ? 'publishing' : record.status === 'failed' ? 'approved' : record.status;
          }
          return record;
        });
      } catch (error) {
        if (error.code !== 'STUDIO_BUSY' || attempt >= 19) throw error;
        await delay(50);
      }
    }
  }

  /** Record a true preview by the owner or an explicitly authorized delegate; never infer playback. */
  async recordTikTokZernioConsent({ episodeId, expectedReviewHash, attestation, interactionSettings }) {
    if (!['allow_comment', 'allow_duet', 'allow_stitch'].every(key => typeof interactionSettings?.[key] === 'boolean')) throw new Error('Explicit TikTok interaction selections are required.');
    return this.store.transaction(async state => {
      const readiness = this.tiktokZernio.readiness();
      const episode = state.episodes.find(item => item.id === episodeId);
      if (!this.zernioSelected('tiktok') || !readiness.ready || readiness.accountId !== this.env.TIKTOK_ACCOUNT_ID ||
          readiness.providerAccountId !== this.env.ZERNIO_TIKTOK_ACCOUNT_ID || readiness.bindingSha256 !== providerBinding(this.env, 'tiktok')?.evidenceSha256 ||
          !/^[a-f0-9]{24}$/.test(readiness.providerAccountId ?? '') || !/^[a-f0-9]{64}$/.test(readiness.bindingSha256 ?? '') ||
          !episode || episodeReviewHash(episode) !== expectedReviewHash || episode.approval?.reviewHash !== expectedReviewHash ||
          !validateTikTokZernioAttestation(attestation, episode.render?.sha256, { env: this.env }) ||
          attestation.previewWitness === 'authorized_agent' && readiness.standingAuthoritySha256 !== attestation.authorityEvidenceSha256) throw new Error('Actual authorized preview and consent must match this exact reviewed media and configured account.');
      if (state.publications.some(item => item.episodeId === episodeId && item.platform === 'tiktok' && RESERVED_STATUSES.has(item.status))) throw new Error('An existing TikTok reservation must be reconciled without replacing its preview or consent.');
      await verifiedFile(this.store.directory, episode.render.path, episode.render.sha256, maxFileBytes(this.env), { noSymlinks: true });
      state.zernioConsents ??= [];
      const record = { episodeId, reviewHash: expectedReviewHash, accountId: this.env.TIKTOK_ACCOUNT_ID,
        providerAccountId: readiness.providerAccountId, bindingSha256: readiness.bindingSha256,
        renderSha256: episode.render.sha256, attestation: sanitizeTikTokZernioAttestation(attestation),
        interactionSettings: Object.fromEntries(['allow_comment', 'allow_duet', 'allow_stitch'].map(key => [key, interactionSettings[key]])) };
      const prior = state.zernioConsents.find(item => item.episodeId === episodeId && item.accountId === record.accountId && item.renderSha256 === record.renderSha256 && item.reviewHash === expectedReviewHash);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(record)) throw new Error('An existing provider consent cannot be silently replaced.');
        return prior;
      }
      state.zernioConsents.push(record);
      return record;
    });
  }

  async verifyZernioYouTubeVideo({ videoId, channelId }) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId ?? '') || channelId !== this.env.YOUTUBE_CHANNEL_ID) throw new Error('Exact YouTube video and intended channel are required.');
    const token = await this.youtubeAuth.getAccessToken({ requiredScopes: [YOUTUBE_READONLY_SCOPE] });
    const response = await this.fetch(`${GOOGLE_API}/youtube/v3/videos?part=snippet,status&id=${videoId}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const item = (await responseJson(response))?.items?.find(entry => entry.id === videoId);
    return { confirmed: response.ok && item?.snippet?.channelId === channelId && item?.status?.privacyStatus === 'public' && item?.status?.uploadStatus === 'processed',
      videoId, channelId: item?.snippet?.channelId ?? null, privacyStatus: item?.status?.privacyStatus ?? null, uploadStatus: item?.status?.uploadStatus ?? null };
  }

  async zernioReceipt(publicationId, receipt) {
    return this.store.transaction(state => {
      const item = state.publications.find(p => p.id === publicationId && p.route === 'zernio');
      if (!item || receipt?.route !== 'zernio' || receipt.publicationId !== item.id || receipt.accountId !== item.accountId ||
          receipt.providerAccountId !== item.providerAccountId || receipt.renderSha256 !== item.renderSha256) throw new Error('Zernio receipt does not match the exact reserved publication.');
      if (item.providerPostId && receipt.providerPostId && item.providerPostId !== receipt.providerPostId) throw new Error('Provider post receipt changed.');
      if (receipt.providerPostId !== undefined && !/^[a-f0-9]{24}$/.test(receipt.providerPostId)) throw new Error('Invalid provider post ID.');
      const published = receipt.status === 'published' && receipt.confirmed === true && receipt.privacy === 'public' && Number.isFinite(Date.parse(receipt.publishedAt));
      const expectedUrl = item.platform === 'youtube' ? safeZernioYouTubePermalink(receipt.url, receipt.videoId) : `https://www.tiktok.com/@${this.env.TIKTOK_ACCOUNT_HANDLE}/video/${receipt.postId}`;
      if (published && (!expectedUrl || receipt.url !== expectedUrl || (item.platform === 'youtube' ? !/^[A-Za-z0-9_-]{11}$/.test(receipt.videoId ?? '') || receipt.nativeVisibilityVerified !== true : !/^[1-9]\d{0,63}$/.test(receipt.postId ?? '')))) throw new Error('Invalid confirmed public URL.');
      // Store only bounded identifiers and states; never storage URLs or raw provider bodies.
      if (item.status !== 'published') item.status = published ? 'published' : ['uploading', 'uploaded', 'processing', 'unknown', 'failed'].includes(receipt.status) ? receipt.status : 'unknown';
      if (receipt.providerPostId) item.providerPostId = receipt.providerPostId;
      if (typeof receipt.phase === 'string' && /^[a-z-]{1,32}$/.test(receipt.phase)) item.providerPhase = receipt.phase;
      const safeCode = typeof receipt.code === 'string' && /^(?:TIKTOK_)?ZERNIO_[A-Z0-9_]{1,80}$/.test(receipt.code) ? receipt.code : undefined;
      const safeHttp = receipt.httpStatus === null || Number.isInteger(receipt.httpStatus) && receipt.httpStatus >= 100 && receipt.httpStatus <= 599;
      if (safeCode !== undefined) item.providerCode = safeCode;
      if (safeHttp) item.httpStatus = receipt.httpStatus;
      if (safeCode !== undefined || safeHttp) {
        const diagnostic = { phase: item.providerPhase ?? 'unknown', ...(safeCode !== undefined ? { code: safeCode } : {}),
          ...(safeHttp ? { httpStatus: receipt.httpStatus } : {}) };
        const previous = item.phaseDiagnostics?.at(-1);
        if (!previous || previous.phase !== diagnostic.phase || previous.code !== diagnostic.code || previous.httpStatus !== diagnostic.httpStatus) {
          item.phaseDiagnostics ??= [];
          item.phaseDiagnostics.push({ ...diagnostic, observedAt: new Date().toISOString() });
          if (item.phaseDiagnostics.length > 64) item.phaseDiagnostics.splice(0, item.phaseDiagnostics.length - 64);
        }
      }
      if (published) Object.assign(item, { url: receipt.url, publishedAt: receipt.publishedAt, effectiveAt: receipt.publishedAt,
        providerPrivacyStatus: 'public', verifiedAt: new Date().toISOString(), error: null,
        ...(item.platform === 'youtube' ? { videoId: receipt.videoId } : { postId: receipt.postId }) });
      if (item.status === 'unknown') item.error = 'Zernio outcome requires GET-only reconciliation; never repeat the mutation automatically.';
      item.updatedAt = new Date().toISOString();
      const episode = state.episodes.find(e => e.id === item.episodeId);
      if (episode) episode.status = item.status === 'unknown' ? 'publishing' : item.status === 'failed' ? 'approved' : item.status;
      return item;
    });
  }

  async publishZernio({ episodeId, platform, privacy, publishAt, expectedReviewHash, madeForKids, execute = false, deliveryId }) {
    if (!this.zernioSelected(platform) || privacy !== 'public' || publishAt !== undefined || typeof execute !== 'boolean' ||
        (platform === 'youtube' && typeof madeForKids !== 'boolean')) throw new Error('Zernio requires the selected public route and explicit audience/execute choices.');
    const initial = await this.preflight({ episodeId, platform, privacy });
    if (expectedReviewHash !== initial.reviewHash) throw new Error('Reviewed media changed.');
    if (!execute) return { ...initial, execute: false };
    if (initial.publication) return { duplicate: true, publication: initial.publication };
    if (!initial.ready) throw new Error(initial.reasons.join(' '));
    const adapter = this.zernioAdapter(platform);
    const identity = await adapter.verifyAccount();
    if (identity.accountId !== initial.accountId || identity.providerAccountId !== initial.providerAccountId || !Number.isFinite(identity.maxDurationSeconds) || initial.render.durationSeconds > identity.maxDurationSeconds) throw new Error('Zernio account identity or duration is not permitted.');
    let media, consent;
    const reserved = await this.store.transaction(async state => {
      const plan = await this.plan(state, { episodeId, platform, privacy });
      if (plan.publication) return { duplicate: true, publication: plan.publication };
      if (!plan.ready || plan.reviewHash !== expectedReviewHash || plan.accountId !== identity.accountId || plan.providerAccountId !== identity.providerAccountId) throw new Error('Zernio reviewed identity or cadence changed.');
      verifyDeliveryClaim(state, deliveryId, plan, { privacy, madeForKids });
      if (platform === 'tiktok') {
        consent = state.zernioConsents?.find(item => item.episodeId === episodeId && item.accountId === plan.accountId && item.reviewHash === expectedReviewHash && item.renderSha256 === plan.render.sha256);
        if (!tiktokConsentPermitted(consent, plan.render.sha256, this.env, adapter.readiness())) throw new Error('Zernio requires an actual authorized preview and consent for this final TikTok media and account binding.');
      }
      const file = await verifiedFile(this.store.directory, plan.render.path, plan.render.sha256, maxFileBytes(this.env), { noSymlinks: true });
      media = await facebookMediaBody(this.store.directory, file, plan.render.sha256, maxFileBytes(this.env));
      const publication = { id: randomUUID(), episodeId, projectId: plan.projectId, platform, accountId: plan.accountId,
        providerAccountId: plan.providerAccountId, bindingSha256: plan.bindingSha256, reviewHash: plan.reviewHash,
        renderSha256: plan.render.sha256, route: 'zernio', privacy: 'public', status: 'uploading',
        effectiveAt: plan.effectiveAt, createdAt: new Date().toISOString(), ...(platform === 'youtube' ? { madeForKids } : {}),
        ...(platform === 'tiktok' ? { consentEvidence: sanitizeTikTokZernioAttestation(consent.attestation) } : {}), ...(deliveryId ? { deliveryId } : {}) };
      state.publications.push(publication);
      state.episodes.find(e => e.id === episodeId).status = 'publishing';
      return { publication, plan };
    });
    if (reserved.duplicate) return reserved;
    const { publication, plan } = reserved;
    try {
      const receipt = await adapter.upload({ media, caption: platform === 'youtube' ? plan.metadata.description : plan.caption,
        title: plan.metadata.title, tags: plan.metadata.tags, madeForKids, render: { ...plan.render, format: 'mp4' }, publicationId: publication.id,
        ...(platform === 'tiktok' ? { attestation: consent.attestation, interactionSettings: consent.interactionSettings } : {}),
        onReceipt: r => this.zernioReceipt(publication.id, r) });
      return { publication: await this.zernioReceipt(publication.id, receipt) };
    } catch {
      return { publication: await this.updatePublication(publication.id, { status: 'unknown', error: 'Zernio outcome requires GET-only reconciliation; no automatic retry.' }) };
    }
  }

  async syncZernio({ publicationId }) {
    const publication = (await this.store.read()).publications.find(p => p.id === publicationId && p.route === 'zernio');
    if (!publication?.providerPostId || !['youtube', 'tiktok'].includes(publication.platform)) throw new Error('Original Zernio provider post receipt is required; no mutation is retried.');
    const adapter = this.zernioAdapter(publication.platform), readiness = adapter.readiness();
    if (readiness.accountId !== publication.accountId || readiness.providerAccountId !== publication.providerAccountId ||
        providerBinding(this.env, publication.platform)?.evidenceSha256 !== publication.bindingSha256) throw new Error('Reconcile with the original provider account binding.');
    const receipt = await adapter.status({ providerPostId: publication.providerPostId, publicationId: publication.id, renderSha256: publication.renderSha256,
      ...(publication.postId ? { postId: publication.postId } : {}) });
    return { verified: receipt.confirmed === true && receipt.status === 'published', publication: await this.zernioReceipt(publication.id, receipt) };
  }

  async publishYouTube({ episodeId, privacy = 'private', publishAt, expectedReviewHash, madeForKids, execute = false, deliveryId }) {
    if (this.zernioSelected('youtube')) return this.publishZernio({ episodeId, platform: 'youtube', privacy, publishAt, expectedReviewHash, madeForKids, execute, deliveryId });
    if (typeof madeForKids !== 'boolean') throw new Error('madeForKids must be explicitly selected as a boolean.');
    if (typeof execute !== 'boolean') throw new Error('execute must be a boolean.');
    const initial = await this.preflight({ episodeId, platform: 'youtube', privacy, publishAt });
    if (!nonempty(expectedReviewHash) || expectedReviewHash !== initial.reviewHash) throw new Error('Expected review fingerprint does not match the current episode.');
    if (!execute) return { ...initial, execute: false, madeForKids };
    if (initial.publication) return { duplicate: true, publication: initial.publication };
    if (!initial.ready) throw new Error(initial.reasons.join(' '));
    const accessToken = await this.youtubeAuth.getAccessToken({ requiredScopes: [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE] });
    let channelResponse;
    try {
      channelResponse = await this.fetch(`${GOOGLE_API}/youtube/v3/channels?part=id&mine=true`, {
        headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new Error('Could not verify the authorized YouTube channel.'); }
    const channels = await responseJson(channelResponse);
    if (!channelResponse.ok || !Array.isArray(channels?.items) || !channels.items.some((item) => item.id === this.env.YOUTUBE_CHANNEL_ID)) {
      throw new Error('YouTube channel verification failed; check the intended channel and OAuth youtube.readonly scope.');
    }
    let uploadBody;
    const reserved = await this.store.transaction(async (state) => {
      const plan = await this.plan(state, { episodeId, platform: 'youtube', privacy, publishAt });
      if (plan.reviewHash !== expectedReviewHash) throw new Error('Episode changed after publication was requested.');
      if (plan.publication) return { duplicate: true, publication: plan.publication };
      if (!plan.ready) throw new Error(plan.reasons.join(' '));
      verifyDeliveryClaim(state, deliveryId, plan, { privacy, madeForKids });
      const file = await verifiedFile(this.store.directory, plan.render.path, plan.render.sha256, maxFileBytes(this.env));
      const body = await boundedMediaBody(file.absolutePath, maxFileBytes(this.env));
      if (body.length > maxFileBytes(this.env) || createHash('sha256').update(body).digest('hex') !== plan.render.sha256.toLowerCase()) {
        throw new Error('Render changed while preparing the upload.');
      }
      const publication = {
        id: randomUUID(), episodeId, projectId: plan.projectId, platform: 'youtube', accountId: plan.accountId,
        reviewHash: plan.reviewHash, renderSha256: plan.render.sha256, status: 'uploading',
        effectiveAt: plan.effectiveAt, createdAt: new Date().toISOString(), privacy, madeForKids,
        apiData: youtubeApiData({ authorized: true, grantId: this.youtubeGrantId }),
        ...(publishAt !== undefined ? { publishAt: plan.effectiveAt } : {}),
        ...(deliveryId ? { deliveryId } : {}),
      };
      state.publications.push(publication);
      state.episodes.find((item) => item.id === episodeId).status = 'publishing';
      // StudioStore results are JSON-cloned, so media bytes stay outside its result.
      uploadBody = body;
      return { publication, plan };
    });
    if (reserved.duplicate) return reserved;
    const { publication, plan } = reserved;
    const body = uploadBody;
    const authHeaders = { Authorization: `Bearer ${accessToken}` };
    try {
      const init = await this.fetch(`${GOOGLE_API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { ...authHeaders, 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(body.length) },
        body: JSON.stringify({
          snippet: { title: plan.metadata.title, description: plan.metadata.description, tags: plan.metadata.tags, categoryId: '24' },
          status: { privacyStatus: plan.uploadPrivacy, selfDeclaredMadeForKids: madeForKids, containsSyntheticMedia: true,
            ...(publishAt !== undefined ? { publishAt: plan.publishAt } : {}) },
        }),
      });
      if (!init.ok) {
        const status = init.status >= 400 && init.status < 500 && init.status !== 429 ? 'failed' : 'unknown';
        return { publication: await this.updatePublication(publication.id, { status, error: 'YouTube rejected or could not confirm upload initialization.' }) };
      }
      const session = safeSessionUrl(init.headers.get('location'));
      const uploaded = await this.fetch(session, {
        method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(180_000), headers: { ...authHeaders, 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) }, body,
      });
      const resource = await responseJson(uploaded);
      if (!uploaded.ok || !nonempty(resource?.id)) {
        return { publication: await this.updatePublication(publication.id, { status: 'unknown', error: 'YouTube did not confirm a completed upload; manual reconciliation is required.' }) };
      }
      const returnedStatus = resource.status ?? {};
      let status = 'uploaded';
      if (['failed', 'rejected'].includes(returnedStatus.uploadStatus)) status = 'failed';
      else if (returnedStatus.privacyStatus === 'public' && returnedStatus.uploadStatus === 'processed') status = 'published';
      else if (publishAt !== undefined && returnedStatus.privacyStatus === 'private' &&
               Date.parse(returnedStatus.publishAt) === Date.parse(plan.publishAt) && Date.parse(plan.publishAt) > Date.now()) status = 'scheduled';
      return { publication: await this.updatePublication(publication.id, {
        apiData: youtubeApiData({ authorized: true, grantId: this.youtubeGrantId }),
        status, videoId: resource.id, providerPrivacyStatus: returnedStatus.privacyStatus ?? null,
        providerUploadStatus: returnedStatus.uploadStatus ?? null,
        ...(status === 'published' ? { publishedAt: new Date().toISOString(), url: `https://www.youtube.com/watch?v=${encodeURIComponent(resource.id)}` } : {}),
        ...(status === 'scheduled' ? { scheduledAt: plan.publishAt } : {}),
      }) };
    } catch {
      return { publication: await this.updatePublication(publication.id, {
        status: 'unknown', error: 'Upload outcome is unknown; reconcile the channel before any retry.',
      }) };
    }
  }

  async syncPublication({ publicationId }) {
    const state = await this.store.read();
    const publication = state.publications.find(item => item.id === publicationId && item.platform === 'youtube');
    if (publication?.route === 'zernio') return (await this.syncZernio({ publicationId })).publication;
    if (publication && (publication.apiData?.grantId ?? 'legacy') !== this.youtubeGrantId) throw new Error('Use the original YouTube grant to verify this receipt; another generation cannot replace its data.');
    if (!publication?.videoId) throw new Error('A confirmed YouTube video ID is required; unknown uploads without receipts require operator reconciliation.');
    if (!this.youtubeAuth.readiness().ready || publication.accountId !== this.env.YOUTUBE_CHANNEL_ID) throw new Error('Use the original channel and valid OAuth token to verify this publication.');
    const accessToken = await this.youtubeAuth.getAccessToken({ requiredScopes: [YOUTUBE_READONLY_SCOPE] });
    const url = new URL(`${GOOGLE_API}/youtube/v3/videos`);
    url.search = new URLSearchParams({ part: 'snippet,status', id: publication.videoId }).toString();
    let response;
    try { response = await this.fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error('Could not verify the YouTube publication; existing state is preserved.'); }
    const resource = (await responseJson(response))?.items?.find(item => item.id === publication.videoId);
    if (!response.ok || !resource || resource.snippet?.channelId !== publication.accountId) throw new Error('YouTube did not confirm an owned video; existing state is preserved.');
    const status = resource.status ?? {};
    let confirmed = 'uploaded';
    if (['failed', 'rejected'].includes(status.uploadStatus)) confirmed = 'failed';
    else if (status.uploadStatus === 'processed' && status.privacyStatus === 'public') confirmed = 'published';
    else if (status.privacyStatus === 'private' && Date.parse(status.publishAt) > Date.now()) confirmed = 'scheduled';
    return this.updatePublication(publication.id, {
      apiData: youtubeApiData({ authorized: true, grantId: this.youtubeGrantId }),
      status: confirmed, providerPrivacyStatus: status.privacyStatus ?? null, providerUploadStatus: status.uploadStatus ?? null, verifiedAt: new Date().toISOString(),
      ...(confirmed === 'published' ? { publishedAt: publication.publishedAt ?? new Date().toISOString(), url: `https://www.youtube.com/watch?v=${encodeURIComponent(publication.videoId)}` } : {}),
      ...(confirmed === 'scheduled' ? { scheduledAt: status.publishAt } : {}),
    });
  }

  async exportTikTok({ episodeId, expectedReviewHash }) {
    return this.exportPackage({ episodeId, expectedReviewHash, platform: 'tiktok' });
  }

  async publishTikTok({ episodeId, expectedReviewHash, privacy, execute = false, deliveryId }) {
    if (this.zernioSelected('tiktok')) return this.publishZernio({ episodeId, platform: 'tiktok', privacy, expectedReviewHash, execute, deliveryId });
    if (privacy !== 'public' || typeof execute !== 'boolean') throw new Error('TikTok REST publishing requires public visibility and an explicit execute flag.');
    const initial = await this.preflight({ episodeId, platform: 'tiktok', privacy });
    if (!nonempty(expectedReviewHash) || initial.reviewHash !== expectedReviewHash) throw new Error('TikTok reviewed fingerprint changed.');
    if (!execute) return { ...initial, execute: false };
    if (initial.publication) return { duplicate: true, publication: initial.publication };
    if (!initial.ready) throw new Error(initial.reasons.join(' '));
    const identity = await this.tiktok.verifyAccount();
    if (identity.accountId !== initial.accountId || !Number.isFinite(identity.maxDurationSeconds) || initial.render.durationSeconds > identity.maxDurationSeconds) throw new Error('TikTok account or supported duration was not confirmed.');
    let media;
    const reserved = await this.store.transaction(async state => {
      const plan = await this.plan(state, { episodeId, platform: 'tiktok', privacy });
      if (plan.reviewHash !== expectedReviewHash || plan.accountId !== identity.accountId) throw new Error('TikTok reviewed identity changed.');
      if (plan.publication) return { duplicate: true, publication: plan.publication };
      if (!plan.ready) throw new Error(plan.reasons.join(' '));
      verifyDeliveryClaim(state, deliveryId, plan, { privacy });
      const file = await verifiedFile(this.store.directory, plan.render.path, plan.render.sha256, 8 * 1024 * 1024, { noSymlinks: true });
      media = await facebookMediaBody(this.store.directory, file, plan.render.sha256, 8 * 1024 * 1024);
      const publication = { id: randomUUID(), episodeId, projectId: plan.projectId, platform: 'tiktok', accountId: plan.accountId,
        reviewHash: plan.reviewHash, renderSha256: plan.render.sha256, status: 'uploading', privacy, route: 'experimental_session_rest',
        effectiveAt: plan.effectiveAt, createdAt: new Date().toISOString(), ...(deliveryId ? { deliveryId } : {}) };
      state.publications.push(publication);
      return { publication, plan };
    });
    if (reserved.duplicate) return reserved;
    const { publication, plan } = reserved;
    try {
      const receipt = await this.tiktok.upload({ media, caption: plan.caption, render: plan.render, onReceipt: async r => {
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(r.creationId ?? '') || !['uploading', 'uploaded'].includes(r.status) ||
            !['project-create', 'allocation', 'transfer', 'commit', 'post'].includes(r.phase)) throw new Error('TikTok phase receipt invalid.');
        await this.updatePublication(publication.id, { status: r.status, creationId: r.creationId,
          ...(r.videoId ? { videoId: r.videoId } : {}), providerPhase: r.phase });
      } });
      const status = ['processing', 'unknown'].includes(receipt?.status) ? receipt.status : 'unknown';
      return { publication: await this.updatePublication(publication.id, { status, providerPhase: receipt?.phase ?? 'unknown',
        ...(receipt?.creationId ? { creationId: receipt.creationId } : {}), ...(receipt?.videoId ? { videoId: receipt.videoId } : {}),
        ...(receipt?.postId ? { postId: receipt.postId } : {}), ...(receipt?.projectId ? { providerProjectId: receipt.projectId } : {}),
        ...(Number.isInteger(receipt?.httpStatus) ? { httpStatus: receipt.httpStatus } : {}),
        ...(Number.isSafeInteger(receipt?.applicationCode) ? { applicationCode: receipt.applicationCode } : {}),
        ...(receipt?.code && /^TIKTOK_[A-Z_]+$/.test(receipt.code) ? { providerCode: receipt.code } : {}),
        ...(status === 'unknown' ? { error: 'TikTok outcome requires reconciliation. Never repeat the post automatically.' } : {}) }) };
    } catch {
      return { publication: await this.updatePublication(publication.id, { status: 'unknown', error: 'TikTok outcome requires reconciliation. Never repeat the post automatically.' }) };
    }
  }

  async syncTikTok({ publicationId }) {
    const found = (await this.store.read()).publications.find(p => p.id === publicationId);
    if (found?.platform === 'tiktok' && found.route === 'zernio') return this.syncZernio({ publicationId });
    const publication = (await this.store.read()).publications.find(p => p.id === publicationId && p.platform === 'tiktok' && p.route === 'experimental_session_rest');
    if (!publication?.creationId || publication.accountId !== this.env.TIKTOK_ACCOUNT_ID) throw new Error('The original TikTok account and REST receipt are required.');
    const receipt = await this.tiktok.status({ creationId: publication.creationId, projectId: publication.providerProjectId, postId: publication.postId, videoId: publication.videoId });
    if (receipt.status !== 'published' || receipt.confirmed !== true || receipt.privacy !== 'public' || !/^[1-9]\d{0,63}$/.test(receipt.postId ?? '') ||
        receipt.url !== `https://www.tiktok.com/@${this.env.TIKTOK_ACCOUNT_HANDLE}/video/${receipt.postId}` || !Number.isFinite(Date.parse(receipt.publishedAt))) return { publication, verified: false, diagnostic: receipt };
    return { verified: true, publication: await this.updatePublication(publication.id, { status: 'published', postId: receipt.postId, url: receipt.url,
      providerPrivacyStatus: 'public', verifiedAt: new Date().toISOString(), publishedAt: receipt.publishedAt, effectiveAt: receipt.publishedAt,
      syntheticDisclosureConfirmed: receipt.syntheticDisclosureConfirmed === true, publicVerifiedWithoutCookies: receipt.verifiedWithoutCookies === true, error: null }) };
  }

  async resumeTikTokAllocation({ publicationId, expectedReviewHash, allocationPath, allocationSha256, observedBy, evidence }) {
    if (this.zernioSelected('tiktok')) throw new Error('Keep the original session attempt intact; recovery mutations require its original route and explicit maintenance.');
    // Narrow operator recovery: the adapter's own target guard rejected before
    // transfer/commit/post. This is never a retry of an uncertain remote mutation.
    if (!nonempty(observedBy) || !nonempty(evidence) || !/^[a-f0-9]{64}$/.test(allocationSha256 ?? '')) throw new Error('Observed allocation recovery evidence is required.');
    const privateRoot = path.join(path.dirname(this.env.TIKTOK_SESSION_FILE ?? ''), 'attempts') + path.sep;
    if (typeof allocationPath !== 'string' || !allocationPath.startsWith(privateRoot)) throw new Error('Use the original private captured allocation.');
    const allocation = await privateSessionFile(allocationPath);
    if (createHash('sha256').update(JSON.stringify(allocation)).digest('hex') !== allocationSha256 ||
        allocation.ResponseMetadata?.Action !== 'ApplyUploadInner' || allocation.ResponseMetadata?.Region !== 'ap-singapore-1' || !allocation.ResponseMetadata?.RequestId) throw new Error('Captured allocation fingerprint or origin changed.');
    const identity = await this.tiktok.verifyAccount();
    let media;
    const reserved = await this.store.transaction(async state => {
      const publication = state.publications.find(p => p.id === publicationId);
      if (publication?.platform !== 'tiktok' || publication.route !== 'experimental_session_rest' || publication.accountId !== identity.accountId ||
          publication.accountId !== this.env.TIKTOK_ACCOUNT_ID || publication.status !== 'unknown' || publication.providerPhase !== 'allocation' ||
          publication.providerCode !== 'TIKTOK_STORAGE_TARGET_NOT_CONFIRMED' || publication.reviewHash !== expectedReviewHash || !publication.creationId) throw new Error('This TikTok attempt is not a locally rejected, untransferred allocation.');
      const withoutOwnReservation = { ...state, publications: state.publications.filter(p => p.id !== publicationId) };
      const plan = await this.plan(withoutOwnReservation, { episodeId: publication.episodeId, platform: 'tiktok', privacy: 'public' });
      if (!plan.ready || plan.reviewHash !== expectedReviewHash || plan.render.sha256 !== publication.renderSha256 || !Number.isFinite(identity.maxDurationSeconds) || plan.render.durationSeconds > identity.maxDurationSeconds) throw new Error('TikTok allocation recovery no longer matches review, account or cadence.');
      const file = await verifiedFile(this.store.directory, plan.render.path, plan.render.sha256, 8 * 1024 * 1024, { noSymlinks: true });
      media = await facebookMediaBody(this.store.directory, file, plan.render.sha256, 8 * 1024 * 1024);
      publication.recoveries ??= [];
      publication.recoveries.push({ at: new Date().toISOString(), observedBy, evidence, allocationPath, allocationSha256,
        allocationRequestId: allocation.ResponseMetadata.RequestId, previousStatus: publication.status, previousPhase: publication.providerPhase, previousCode: publication.providerCode });
      publication.status = 'uploading'; publication.providerCode = null;
      return { publication, plan };
    });
    const receipt = await this.tiktok.upload({ media, caption: reserved.plan.caption, render: reserved.plan.render,
      prepared: { creationId: reserved.publication.creationId, allocation },
      onReceipt: async r => this.updatePublication(publicationId, { status: r.status, providerPhase: r.phase, ...(r.videoId ? { videoId: r.videoId } : {}) }),
    });
    return { publication: await this.updatePublication(publicationId, { status: ['processing', 'unknown'].includes(receipt?.status) ? receipt.status : 'unknown',
      providerPhase: receipt?.phase ?? 'unknown', ...(receipt?.videoId ? { videoId: receipt.videoId } : {}),
      ...(receipt?.postId ? { postId: receipt.postId } : {}), ...(receipt?.projectId ? { providerProjectId: receipt.projectId } : {}),
      ...(Number.isInteger(receipt?.httpStatus) ? { httpStatus: receipt.httpStatus } : {}),
      ...(Number.isSafeInteger(receipt?.applicationCode) ? { applicationCode: receipt.applicationCode } : {}),
      ...(receipt?.code && /^TIKTOK_[A-Z_]+$/.test(receipt.code) ? { providerCode: receipt.code } : {}) }) };
  }

  async publishFacebook({ episodeId, expectedReviewHash, privacy, execute = false, deliveryId, cadenceExceptionId }) {
    if (privacy !== 'public') throw new Error('Facebook Page publishing requires explicit public visibility.');
    if (typeof execute !== 'boolean') throw new Error('execute must be a boolean.');
    const initial = await this.preflight({ episodeId, platform: 'facebook', privacy, deliveryId, cadenceExceptionId });
    if (!nonempty(expectedReviewHash) || expectedReviewHash !== initial.reviewHash) throw new Error('Expected review fingerprint does not match the current episode.');
    if (!execute) return { ...initial, execute: false };
    if (initial.publication) return { duplicate: true, publication: initial.publication };
    if (!initial.ready) throw new Error(initial.reasons.join(' '));
    const adapter = initial.facebookVideoKind === 'page_video' ? this.facebookPageVideo : this.facebook;
    await adapter.verifyAccount();
    let media;
    const reservation = await this.store.transaction(async state => {
      const plan = await this.plan(state, { episodeId, platform: 'facebook', privacy, deliveryId, cadenceExceptionId });
      if (plan.reviewHash !== expectedReviewHash) throw new Error('Episode changed after publication was requested.');
      if (plan.facebookVideoKind !== initial.facebookVideoKind) throw new Error('Facebook upload route changed after publication was requested.');
      if (plan.publication) return { duplicate: true, publication: plan.publication };
      if (!plan.ready) throw new Error(plan.reasons.join(' '));
      verifyDeliveryClaim(state, deliveryId, plan, { privacy });
      const file = await verifiedFile(this.store.directory, plan.render.path, plan.render.sha256, maxFileBytes(this.env), { noSymlinks: true });
      media = await facebookMediaBody(this.store.directory, file, plan.render.sha256, maxFileBytes(this.env));
      if (createHash('sha256').update(media).digest('hex') !== plan.render.sha256.toLowerCase()) throw new Error('Render changed while preparing the upload.');
      const publication = { id: randomUUID(), episodeId, projectId: plan.projectId, platform: 'facebook', facebookVideoKind: plan.facebookVideoKind, accountId: plan.accountId, reviewHash: plan.reviewHash, renderSha256: plan.render.sha256, status: 'uploading', privacy, effectiveAt: plan.effectiveAt, createdAt: new Date().toISOString(), ...(deliveryId ? { deliveryId } : {}) };
      if (cadenceExceptionId !== undefined) {
        const exception = facebookCadenceException(state, { cadenceExceptionId, deliveryId, episode: state.episodes.find(item => item.id === episodeId),
          reviewHash: plan.reviewHash, accountId: plan.accountId, platform: 'facebook', privacy }, Date.now());
        Object.assign(exception, { status: 'consumed', publicationId: publication.id, consumedAt: publication.createdAt });
        publication.cadenceExceptionId = exception.id;
      }
      state.publications.push(publication);
      state.episodes.find(item => item.id === episodeId).status = 'publishing';
      return { publication, plan };
    });
    if (reservation.duplicate) return reservation;
    const { publication, plan } = reservation;
    try {
      const receipt = await adapter.upload({ media, caption: plan.caption, title: plan.metadata.title, synthetic: true, onReceipt: async ({ videoId, status, phase }) => {
        if (!/^\d+$/.test(videoId ?? '')) throw new Error('Facebook returned an invalid receipt.');
        if (!['unknown', 'uploaded', 'processing'].includes(status) || !['start', 'transfer', 'finish'].includes(phase)) throw new Error('Facebook returned an invalid upload phase.');
        await this.updatePublication(publication.id, { videoId, status, providerPhase: phase });
      } });
      let status = ['uploaded', 'processing', 'published', 'unknown', 'failed'].includes(receipt?.status) ? receipt.status : 'unknown';
      const videoId = /^\d+$/.test(receipt?.videoId ?? '') ? receipt.videoId : undefined;
      if (status === 'published' && (!videoId || receipt.confirmed !== true)) status = 'unknown';
      const url = plan.facebookVideoKind === 'page_video' ? safeFacebookVideoPermalink(receipt?.url, videoId) :
        videoId ? `https://www.facebook.com/reel/${videoId}` : null;
      if (status === 'published' && !url) status = 'unknown';
      if (status === 'unknown' && receipt?.phase === 'status') {
        const stored = (await this.store.read()).publications.find(item => item.id === publication.id);
        if (['uploaded', 'processing'].includes(stored?.status)) status = stored.status;
      }
      return { publication: await this.updatePublication(publication.id, { status, ...(videoId ? { videoId } : {}), ...(status === 'published' && videoId ? { publishedAt: new Date().toISOString(), url } : {}), ...(status === 'unknown' ? { error: 'Facebook upload outcome requires reconciliation; do not repeat it.' } : {}) }) };
    } catch {
      return { publication: await this.updatePublication(publication.id, { status: 'unknown', error: 'Facebook upload outcome is unknown; reconcile before any retry.' }) };
    }
  }

  async syncFacebook({ publicationId }) {
    const state = await this.store.read();
    const publication = state.publications.find(item => item.id === publicationId && item.platform === 'facebook');
    if (!publication?.videoId || publication.accountId !== this.env.FACEBOOK_PAGE_ID) throw new Error('A receipt and the original Facebook Page are required for reconciliation.');
    const kind = publication.facebookVideoKind ?? 'reel';
    if (!['reel', 'page_video'].includes(kind)) throw new Error('Facebook publication has an unrecognized upload route; preserve its receipt.');
    const adapter = kind === 'page_video' ? this.facebookPageVideo : this.facebook;
    const receipt = await adapter.status({ videoId: publication.videoId });
    const url = kind === 'page_video' ? safeFacebookVideoPermalink(receipt?.url, publication.videoId) : `https://www.facebook.com/reel/${publication.videoId}`;
    if (receipt?.status === 'published' && (receipt.confirmed !== true || !url)) return { publication, verified: false, reason: 'Facebook has not confirmed public visibility and a safe permalink; existing state is preserved.' };
    if (!['uploaded', 'processing', 'published', 'failed'].includes(receipt?.status)) return { publication, verified: false, reason: 'Facebook has not confirmed the owned publication; existing state is preserved.' };
    return { verified: true, publication: await this.updatePublication(publication.id, { status: receipt.status, verifiedAt: new Date().toISOString(), ...(receipt.status === 'published' ? { publishedAt: publication.publishedAt ?? new Date().toISOString(), url } : {}) }) };
  }

  async exportPackage({ episodeId, expectedReviewHash, platform, deliveryId }) {
    if (!['tiktok', 'kwai'].includes(platform)) throw new Error('Export platform must be tiktok or kwai.');
    return this.store.transaction(async (state) => {
      const plan = await this.plan(state, { episodeId, platform, privacy: 'private' });
      if (!nonempty(expectedReviewHash) || expectedReviewHash !== plan.reviewHash) throw new Error('Expected review fingerprint does not match the current episode.');
      if (!plan.readyToExport) throw new Error(plan.reasons.join(' '));
      verifyDeliveryClaim(state, deliveryId, plan, { privacy: 'private' });
      const existing = state.publications.find((item) => item.episodeId === episodeId && item.platform === platform &&
        item.reviewHash === plan.reviewHash && item.status === 'exported');
      if (existing) return { duplicate: true, publication: existing };
      const episode = state.episodes.find((item) => item.id === episodeId);
      const id = randomUUID();
      const exportDirectory = path.join(this.store.directory, 'exports');
      await mkdir(exportDirectory, { recursive: true });
      const root = await realpath(this.store.directory);
      const exportRoot = await realpath(exportDirectory);
      if (path.relative(root, exportRoot) !== 'exports') throw new Error('Export directory must remain inside studio storage.');
      const exportPath = path.join('exports', `${platform}-${id}.json`);
      const destination = path.join(root, exportPath);
      const packageData = structuredClone(publicationPackage({ platform, plan, episode, createdAt: new Date().toISOString(), env: this.env }));
      if (episode.render.captionsPath) {
        const captionsPath = episode.render.captionsPath;
        if (typeof captionsPath !== 'string' || path.isAbsolute(captionsPath)) throw new Error('Subtitles require a path within studio storage.');
        const filename = await realpath(path.resolve(root, captionsPath));
        const relative = path.relative(root, filename);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.extname(filename) !== '.srt') {
          throw new Error('Subtitles require an SRT file within studio storage.');
        }
        const subtitles = await boundedMediaBody(filename, 1024 * 1024);
        const subtitleHash = createHash('sha256').update(subtitles).digest('hex');
        if (subtitleHash !== episode.render.captionsSha256) throw new Error('Subtitles changed after the reviewed render.');
        packageData.captions = { path: relative, sha256: subtitleHash };
        packageData.captionsPath = relative;
      }
      const temporary = `${destination}.tmp`;
      await writeFile(temporary, `${JSON.stringify(packageData, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
      const publication = {
        id, episodeId, projectId: plan.projectId, platform, accountId: plan.accountId,
        reviewHash: plan.reviewHash, renderSha256: plan.render.sha256, status: 'exported', exportPath,
        createdAt: packageData.createdAt,
        ...(deliveryId ? { deliveryId } : {}),
      };
      state.publications.push(publication);
      return { publication, package: packageData };
    });
  }
}
