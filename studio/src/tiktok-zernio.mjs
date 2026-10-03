import { createHash } from 'node:crypto';
import { validateTikTokZernioAttestation } from './tiktok-zernio-attestation.mjs';
export { validateTikTokZernioAttestation } from './tiktok-zernio-attestation.mjs';

const API = 'https://zernio.com/api/v1';
const MAX_BYTES = 250 * 1024 * 1024; // Studio buffer ceiling, below TikTok's 4 GB limit.
const SHA = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{24}$/;
const UID = /^[1-9]\d{0,63}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HANDLE = /^[A-Za-z0-9_.]{2,24}$/;
const TOGGLES = ['allow_comment', 'allow_duet', 'allow_stitch'];
const digest = value => createHash('sha256').update(value).digest('hex');
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > 0 && Date.parse(value) <= Date.now() + 60_000;
const accountId = value => typeof value === 'string' ? value : value?._id;

async function boundedBody(response, maxBytes) {
  const declared = response.headers?.get('content-length');
  if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    void response.body?.cancel().catch(() => {}); return null;
  }
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } catch { return null; }
  finally { reader.releaseLock(); }
}

async function boundedJson(response) {
  try {
    const value = JSON.parse(await boundedBody(response, 1024 * 1024));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** Validate the provider-issued storage origin and an exact paired key. Never persist these URLs. */
export function zernioTikTokUploadTarget(data) {
  let upload, publicUrl;
  try { upload = new URL(data?.uploadUrl); publicUrl = new URL(data?.publicUrl); } catch { return null; }
  const key = data?.key;
  const virtualBucket = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(upload.hostname);
  const singleLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.r2\.cloudflarestorage\.com$/.test(upload.hostname);
  // A virtual-hosted bucket is already in the hostname; only single-label hosts may include a bucket path.
  const storagePaths = [`/${key}`, ...(!virtualBucket && /^\/[A-Za-z0-9][A-Za-z0-9_-]{0,62}\//.test(upload.pathname) ? [`/${upload.pathname.split('/')[1]}/${key}`] : [])];
  if (typeof key !== 'string' || !/^temp\/[A-Za-z0-9][A-Za-z0-9_.-]{1,240}\.mp4$/.test(key) || key.includes('..') ||
      !Number.isInteger(data?.expiresIn) || data.expiresIn < 1 || data.expiresIn > 3600 ||
      upload.protocol !== 'https:' || (!singleLabel && !virtualBucket) ||
      upload.port || upload.username || upload.password || upload.hash || !storagePaths.includes(upload.pathname) ||
      !/^[a-f0-9]{64}$/i.test(upload.searchParams.get('X-Amz-Signature') ?? '') ||
      upload.searchParams.getAll('X-Amz-Signature').length !== 1 ||
      publicUrl.protocol !== 'https:' || publicUrl.hostname !== 'media.zernio.com' || publicUrl.port ||
      publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== `/${key}`) return null;
  return { uploadUrl: upload.href, publicUrl: publicUrl.href };
}

export function validateTikTokZernioRender(render = {}) {
  const reasons = [];
  if (!Number.isFinite(render.durationSeconds) || render.durationSeconds < 3 || render.durationSeconds > 600) reasons.push('TikTok Zernio video duration must be between 3 and 600 seconds.');
  if (!Number.isInteger(render.width) || !Number.isInteger(render.height) || render.width < 1 || render.height < 1) reasons.push('TikTok Zernio requires valid video dimensions.');
  if (render.format !== 'mp4') reasons.push('This adapter accepts MP4 renders only.');
  return { ready: reasons.length === 0, reasons };
}

function safePublicUrl(raw, handle, expectedPostId) {
  let url; try { url = new URL(raw); } catch { return null; }
  const match = url.pathname.match(/^\/@([A-Za-z0-9_.]{2,24})\/video\/([1-9]\d{0,63})\/?$/);
  if (url.protocol !== 'https:' || url.hostname !== 'www.tiktok.com' || url.port || url.username || url.password || url.search || url.hash ||
      !match || match[1] !== handle || (expectedPostId && match[2] !== expectedPostId)) return null;
  return { url: `https://www.tiktok.com/@${handle}/video/${match[2]}`, postId: match[2] };
}

/** Opt-in Zernio route; no mutation retries and no Inbox/private fallback. */
export class TikTokZernio {
  #env; #fetch; #binding;
  constructor({ env = process.env, fetchImpl = fetch, binding } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('TIKTOK_ZERNIO_FETCH_REQUIRED');
    this.#env = { ...env }; this.#fetch = fetchImpl; this.#binding = binding ? { ...binding } : null;
  }

  #issues({ publishing = false } = {}) {
    const reasons = [], e = this.#env, b = this.#binding;
    if (!/^sk_[a-f0-9]{64}$/.test(e.ZERNIO_API_KEY ?? '')) reasons.push('ZERNIO_API_KEY must be a private Zernio API key.');
    if (!OID.test(e.ZERNIO_TIKTOK_ACCOUNT_ID ?? '')) reasons.push('ZERNIO_TIKTOK_ACCOUNT_ID must identify the provider account.');
    if (!UID.test(e.TIKTOK_ACCOUNT_ID ?? '') || !HANDLE.test(e.TIKTOK_ACCOUNT_HANDLE ?? '')) reasons.push('The intended native TikTok account ID and handle are required.');
    if (!b || b.providerAccountId !== e.ZERNIO_TIKTOK_ACCOUNT_ID || b.nativeAccountId !== e.TIKTOK_ACCOUNT_ID || b.handle !== e.TIKTOK_ACCOUNT_HANDLE ||
        !SHA.test(b.evidenceSha256 ?? '') || !validTime(b.verifiedAt) || !['owner_confirmed', 'authenticated_profile'].includes(b.source)) reasons.push('Explicit evidence binding the Zernio account to the native TikTok account is required.');
    if (publishing && e.YTFUN_TIKTOK_ZERNIO_PUBLISH_ENABLED !== 'true') reasons.push('Enable YTFUN_TIKTOK_ZERNIO_PUBLISH_ENABLED=true only after connection and binding.');
    return reasons;
  }

  readiness() {
    const reasons = this.#issues({ publishing: true });
    return { platform: 'tiktok', route: 'zernio', directPostImplemented: true, ready: reasons.length === 0, reasons,
      accountId: UID.test(this.#env.TIKTOK_ACCOUNT_ID ?? '') ? this.#env.TIKTOK_ACCOUNT_ID : null,
      providerAccountId: OID.test(this.#env.ZERNIO_TIKTOK_ACCOUNT_ID ?? '') ? this.#env.ZERNIO_TIKTOK_ACCOUNT_ID : null,
      handle: HANDLE.test(this.#env.TIKTOK_ACCOUNT_HANDLE ?? '') ? this.#env.TIKTOK_ACCOUNT_HANDLE : null,
      bindingSha256: SHA.test(this.#binding?.evidenceSha256 ?? '') ? this.#binding.evidenceSha256 : null,
      standingAuthoritySha256: SHA.test(this.#env.YTFUN_TIKTOK_STANDING_AUTHORITY_SHA256 ?? '') ? this.#env.YTFUN_TIKTOK_STANDING_AUTHORITY_SHA256 : null,
      remoteAuthorizationVerified: false, syntheticDisclosureSupported: true, maxBytes: MAX_BYTES };
  }

  async #api(path, { method = 'GET', body, headers = {}, withHttpStatus = false } = {}) {
    let response;
    try {
      response = await this.#fetch(`${API}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${this.#env.ZERNIO_API_KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { const error = new Error('TIKTOK_ZERNIO_REQUEST_OUTCOME_UNCONFIRMED'); error.httpStatus = null; throw error; }
    const httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
    if (!response.ok || response.redirected || httpStatus === null) {
      void response.body?.cancel().catch(() => {});
      const error = new Error(response.redirected || httpStatus === null ? 'TIKTOK_ZERNIO_REDIRECT_OR_STATUS_REJECTED' : 'TIKTOK_ZERNIO_HTTP_REJECTED');
      error.httpStatus = httpStatus; throw error;
    }
    const data = await boundedJson(response);
    if (!data) { const error = new Error('TIKTOK_ZERNIO_RESPONSE_INVALID'); error.httpStatus = httpStatus; throw error; }
    return withHttpStatus ? { data, httpStatus } : data;
  }

  async #identity() {
    if (this.#issues().length) throw new Error('TIKTOK_ZERNIO_CONFIGURATION_REQUIRED');
    const data = await this.#api('/accounts');
    const matches = Array.isArray(data.accounts) ? data.accounts.filter(a => a?._id === this.#env.ZERNIO_TIKTOK_ACCOUNT_ID) : [];
    const account = matches.length === 1 ? matches[0] : null;
    if (!account || account.platform !== 'tiktok' || account.isActive !== true || account.enabled === false || account.needsReconnection === true ||
        account.username !== this.#env.TIKTOK_ACCOUNT_HANDLE) throw new Error('TIKTOK_ZERNIO_ACCOUNT_NOT_CONFIRMED');
    return account;
  }

  async verifyAccount() {
    const account = await this.#identity();
    const info = await this.#api(`/accounts/${account._id}/tiktok/creator-info?mediaType=video`);
    if (info.creator?.canPostMore !== true || !Array.isArray(info.privacyLevels) || !info.privacyLevels.some(v => v?.value === 'PUBLIC_TO_EVERYONE') ||
        !Number.isFinite(info.postingLimits?.maxVideoDurationSec) || info.postingLimits.maxVideoDurationSec < 3 ||
        !TOGGLES.every(k => typeof info.postingLimits?.interactionSettings?.[k]?.enabled === 'boolean')) throw new Error('TIKTOK_ZERNIO_PUBLIC_POST_NOT_AVAILABLE');
    return { accountId: this.#env.TIKTOK_ACCOUNT_ID, providerAccountId: account._id, handle: account.username,
      bindingSha256: this.#binding.evidenceSha256,
      remoteAuthorizationVerified: true, publicPostAllowed: true, maxDurationSeconds: Math.min(600, info.postingLimits.maxVideoDurationSec),
      interactionSettings: Object.fromEntries(TOGGLES.map(k => [k, { enabled: info.postingLimits.interactionSettings[k].enabled }])) };
  }

  async upload({ media, caption, render, publicationId, onReceipt, attestation, interactionSettings } = {}) {
    if (!this.readiness().ready) throw new Error('TIKTOK_ZERNIO_PUBLISH_DISABLED_OR_UNCONFIGURED');
    if (!Buffer.isBuffer(media) || media.length < 1 || media.length > MAX_BYTES || !validateTikTokZernioRender(render).ready ||
        typeof caption !== 'string' || !caption.trim() || caption.length > 2200 || !UUID.test(publicationId ?? '') || typeof onReceipt !== 'function') throw new Error('TIKTOK_ZERNIO_UPLOAD_INPUT_INVALID');
    const renderSha256 = digest(media);
    if (!validateTikTokZernioAttestation(attestation, renderSha256, { env: this.#env })) throw new Error('TIKTOK_ZERNIO_PREVIEW_AND_CONSENT_REQUIRED');
    if (!TOGGLES.every(k => typeof interactionSettings?.[k] === 'boolean')) throw new Error('TIKTOK_ZERNIO_EXPLICIT_INTERACTIONS_REQUIRED');
    const account = await this.verifyAccount();
    if (render.durationSeconds > account.maxDurationSeconds || TOGGLES.some(k => interactionSettings[k] && !account.interactionSettings[k].enabled)) throw new Error('TIKTOK_ZERNIO_CREATOR_LIMIT_EXCEEDED');
    let phase = 'presign', providerPostId;
    let diagnostic = { code: 'TIKTOK_ZERNIO_PRESIGN_REQUEST_PENDING', httpStatus: null };
    const receipt = status => ({ route: 'zernio', publicationId, providerAccountId: account.providerAccountId, accountId: account.accountId,
      handle: account.handle, renderSha256, ...(providerPostId ? { providerPostId } : {}), status, phase, confirmed: false, ...diagnostic });
    try {
      // Notify before each mutation. A persistence failure stops the next request.
      await onReceipt(receipt('uploading'));
      const presigned = await this.#api('/media/presign', { method: 'POST', withHttpStatus: true, body: { filename: `${publicationId}.mp4`, contentType: 'video/mp4', size: media.length } });
      diagnostic = { code: 'TIKTOK_ZERNIO_HTTP_ACCEPTED', httpStatus: presigned.httpStatus };
      await onReceipt(receipt('uploading'));
      const target = zernioTikTokUploadTarget(presigned.data);
      if (!target) throw new Error('TIKTOK_ZERNIO_STORAGE_TARGET_NOT_CONFIRMED');
      phase = 'transfer'; diagnostic = { code: 'TIKTOK_ZERNIO_TRANSFER_REQUEST_PENDING', httpStatus: null }; await onReceipt(receipt('uploading'));
      const transfer = await this.#fetch(target.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: media,
        redirect: 'error', signal: AbortSignal.timeout(120_000) });
      void transfer.body?.cancel().catch(() => {});
      diagnostic = { httpStatus: Number.isInteger(transfer.status) && transfer.status >= 100 && transfer.status <= 599 ? transfer.status : null,
        code: transfer.redirected ? 'TIKTOK_ZERNIO_REDIRECT_OR_STATUS_REJECTED' : transfer.ok ? 'TIKTOK_ZERNIO_HTTP_ACCEPTED' : 'TIKTOK_ZERNIO_HTTP_REJECTED' };
      await onReceipt(receipt('uploading'));
      if (!transfer.ok || transfer.redirected || diagnostic.httpStatus === null) throw new Error('TIKTOK_ZERNIO_TRANSFER_NOT_CONFIRMED');
      phase = 'post'; diagnostic = { code: 'TIKTOK_ZERNIO_POST_REQUEST_PENDING', httpStatus: null }; await onReceipt(receipt('uploaded'));
      const createdResponse = await this.#api('/posts', { method: 'POST', withHttpStatus: true, headers: { 'Idempotency-Key': publicationId }, body: {
        content: caption, mediaItems: [{ type: 'video', url: target.publicUrl }],
        platforms: [{ platform: 'tiktok', accountId: account.providerAccountId }], publishNow: true, visibility: 'public',
        tiktokSettings: { privacy_level: 'PUBLIC_TO_EVERYONE', ...Object.fromEntries(TOGGLES.map(k => [k, interactionSettings[k]])),
          content_preview_confirmed: true, express_consent_given: true, video_made_with_ai: true, draft: false, isAdsOnly: false },
        metadata: { ytfunPublicationId: publicationId, ytfunRenderSha256: renderSha256, ytfunRoute: 'tiktok_zernio' },
      } });
      const created = createdResponse.data;
      diagnostic = { code: 'TIKTOK_ZERNIO_HTTP_ACCEPTED', httpStatus: createdResponse.httpStatus };
      // Save a returned ID even when the rest of the create response is inconclusive.
      providerPostId = OID.test(created.post?._id ?? '') ? created.post._id : OID.test(created.postId ?? '') ? created.postId : undefined;
      if (!providerPostId) return { ...receipt('unknown'), code: 'TIKTOK_ZERNIO_POST_RECEIPT_MISSING' };
      await onReceipt(receipt('processing'));
      return this.status({ providerPostId, publicationId, renderSha256 });
    } catch (error) {
      const code = /^TIKTOK_ZERNIO_[A-Z_]{1,100}$/.test(error?.message ?? '') ? error.message : 'TIKTOK_ZERNIO_REQUEST_OUTCOME_UNCONFIRMED';
      return { ...receipt('unknown'), code, ...(Object.hasOwn(error ?? {}, 'httpStatus') ? {
        httpStatus: Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : null,
      } : {}) };
    }
  }

  async status({ providerPostId, publicationId, renderSha256, postId } = {}) {
    if (this.#issues().length || !OID.test(providerPostId ?? '') || !UUID.test(publicationId ?? '') || !SHA.test(renderSha256 ?? '') || (postId !== undefined && !UID.test(postId))) throw new Error('TIKTOK_ZERNIO_STATUS_BINDING_REQUIRED');
    const base = { route: 'zernio', providerPostId, publicationId, renderSha256, providerAccountId: this.#env.ZERNIO_TIKTOK_ACCOUNT_ID,
      accountId: this.#env.TIKTOK_ACCOUNT_ID, handle: this.#env.TIKTOK_ACCOUNT_HANDLE, phase: 'status', confirmed: false };
    try {
      await this.#identity();
      const data = await this.#api(`/posts/${providerPostId}`), post = data.post;
      const target = Array.isArray(post?.platforms) && post.platforms.length === 1 ? post.platforms[0] : null;
      if (post?._id !== providerPostId || post.metadata?.ytfunPublicationId !== publicationId || post.metadata?.ytfunRenderSha256 !== renderSha256 ||
          post.metadata?.ytfunRoute !== 'tiktok_zernio' || target?.platform !== 'tiktok' || accountId(target.accountId) !== this.#env.ZERNIO_TIKTOK_ACCOUNT_ID ||
          (target.removedFromPlatformAt != null) || post.visibility !== 'public') return { ...base, status: 'unknown', code: 'TIKTOK_ZERNIO_POST_BINDING_NOT_CONFIRMED' };
      if (post.status !== 'published' || target.status !== 'published') return { ...base, status: 'processing' };
      const publicLink = safePublicUrl(target.platformPostUrl, this.#env.TIKTOK_ACCOUNT_HANDLE, postId);
      if (!publicLink || !UID.test(target.platformPostId ?? '') || target.platformPostId !== publicLink.postId || !validTime(target.publishedAt)) return { ...base, status: 'processing' };
      // Public-page evidence checks native UID and actual visibility independently of provider intent.
      const response = await this.#fetch(publicLink.url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {}); return { ...base, status: 'processing' }; }
      const html = await boundedBody(response, 4 * 1024 * 1024);
      const script = html?.match(/<script\b[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
      let detail;
      try { detail = JSON.parse(script?.[1] ?? '').__DEFAULT_SCOPE__?.['webapp.video-detail']; } catch { return { ...base, status: 'processing' }; }
      const item = detail?.itemInfo?.itemStruct, createdAtMs = Number(item?.createTime) * 1000;
      if (detail?.statusCode !== 0 || item?.id !== publicLink.postId || item?.author?.id !== this.#env.TIKTOK_ACCOUNT_ID || item?.author?.uniqueId !== this.#env.TIKTOK_ACCOUNT_HANDLE ||
          item?.privateItem !== false || item?.secret !== false || item?.forFriend !== false || item?.isProhibited !== false || item?.isReviewing !== false ||
          item?.ShowAIGC !== true || item?.aigcLabelType !== '1' || !Number.isSafeInteger(createdAtMs) || createdAtMs < 1 || createdAtMs > Date.now() + 60_000) return { ...base, status: 'processing' };
      return { ...base, status: 'published', confirmed: true, privacy: 'public', postId: publicLink.postId, url: publicLink.url,
        publishedAt: new Date(createdAtMs).toISOString(), syntheticDisclosureConfirmed: true };
    } catch (error) {
      return { ...base, status: 'unknown', code: /^TIKTOK_ZERNIO_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'TIKTOK_ZERNIO_STATUS_NOT_CONFIRMED' };
    }
  }
}
