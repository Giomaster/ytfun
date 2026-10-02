import { createHash } from 'node:crypto';

const BASE = 'https://zernio.com/api/v1';
const MAX_BYTES = 250 * 1024 * 1024; // Buffer/transport bound, not YouTube's limit.
const MAX_RESPONSE_BYTES = 1024 * 1024;
const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const channel = value => typeof value === 'string' && /^UC[a-zA-Z0-9_-]{22}$/.test(value);
const video = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(value);
const handle = value => typeof value === 'string' && /^@?[a-zA-Z0-9._-]{3,30}$/.test(value);
const normalizeHandle = value => value.replace(/^@/, '').toLowerCase();

function maxBytes(env) {
  const value = Number(env.YTFUN_MAX_UPLOAD_BYTES ?? MAX_BYTES);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_BYTES ? value : null;
}

function validBinding(binding, env) {
  return binding && id(binding.providerAccountId) && binding.providerAccountId === env.ZERNIO_YOUTUBE_ACCOUNT_ID &&
    channel(binding.nativeAccountId) && binding.nativeAccountId === env.YOUTUBE_CHANNEL_ID &&
    handle(binding.handle) && handle(env.YOUTUBE_CHANNEL_HANDLE) &&
    normalizeHandle(binding.handle) === normalizeHandle(env.YOUTUBE_CHANNEL_HANDLE) && digest(binding.evidenceSha256) &&
    ['owner_confirmed', 'authenticated_profile'].includes(binding.source) &&
    typeof binding.verifiedAt === 'string' && Number.isFinite(Date.parse(binding.verifiedAt));
}

function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) return null;
  return url;
}

function accountMatches(account, binding) {
  if (!account || account._id !== binding.providerAccountId || account.platform !== 'youtube' ||
      account.isActive !== true || account.enabled === false || account.needsReconnection === true) return false;
  const url = httpsUrl(account.profileUrl);
  if (!url || !['youtube.com', 'www.youtube.com'].includes(url.hostname) || url.search) return false;
  const expectedChannel = `/channel/${binding.nativeAccountId}`;
  const expectedHandle = `/@${normalizeHandle(binding.handle)}`;
  return url.pathname.replace(/\/$/, '') === expectedChannel || url.pathname.replace(/\/$/, '').toLowerCase() === expectedHandle;
}

export function safeZernioYouTubePermalink(value, videoId) {
  if (!video(videoId)) return null;
  const url = httpsUrl(value);
  if (!url || !['youtube.com', 'www.youtube.com'].includes(url.hostname)) return null;
  if (url.pathname === '/watch' && url.search === `?v=${videoId}`) return `https://www.youtube.com/watch?v=${videoId}`;
  if (url.pathname === `/shorts/${videoId}` && !url.search) return `https://www.youtube.com/shorts/${videoId}`;
  return null;
}

function uploadUrls(data) {
  if (typeof data?.key !== 'string' || !/^temp\/[a-zA-Z0-9_-]+\.mp4$/.test(data.key) ||
      !Number.isInteger(data.expiresIn) || data.expiresIn < 1 || data.expiresIn > 3600) return null;
  const target = httpsUrl(data.uploadUrl);
  const publicUrl = httpsUrl(data.publicUrl);
  const objectPaths = target ? [`/${data.key}`, ...(/^\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}\//.test(target.pathname) ?
    [`/${target.pathname.split('/')[1]}/${data.key}`] : [])] : [];
  if (!target || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.r2\.cloudflarestorage\.com$/.test(target.hostname) ||
      !/^[a-f0-9]{64}$/i.test(target.searchParams.get('X-Amz-Signature') ?? '') ||
      target.searchParams.getAll('X-Amz-Signature').length !== 1 ||
      !publicUrl || publicUrl.hostname !== 'media.zernio.com' || publicUrl.search || publicUrl.pathname !== `/${data.key}` ||
      !objectPaths.includes(target.pathname)) return null;
  return { uploadUrl: target.href, publicUrl: publicUrl.href };
}

async function boundedJson(response) {
  const declared = response.headers?.get('content-length');
  if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

/** Explicitly authorized provider route. It does not change the owned Google app's audit state. */
export class YouTubeZernio {
  #env;
  #fetch;
  #binding;
  #verifyPublishedVideo;

  constructor({ env = process.env, fetchImpl = fetch, binding, verifyPublishedVideo } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('YouTube Zernio requires a fetch implementation.');
    if (verifyPublishedVideo !== undefined && typeof verifyPublishedVideo !== 'function') throw new Error('YouTube native verifier must be a function.');
    this.#env = { ...env };
    this.#fetch = fetchImpl;
    this.#binding = binding ? structuredClone(binding) : null;
    this.#verifyPublishedVideo = verifyPublishedVideo;
  }

  readiness() {
    const reasons = [];
    if (this.#env.YTFUN_YOUTUBE_ZERNIO_PUBLISH_ENABLED !== 'true') reasons.push('Enable the explicitly authorized YouTube Zernio route with YTFUN_YOUTUBE_ZERNIO_PUBLISH_ENABLED=true.');
    if (!/^sk_[a-f0-9]{64}$/.test(this.#env.ZERNIO_API_KEY ?? '')) reasons.push('Configure a private ZERNIO_API_KEY.');
    if (!validBinding(this.#binding, this.#env)) reasons.push('YouTube Zernio requires exact provider-account/channel/handle binding with recorded identity evidence.');
    if (maxBytes(this.#env) === null) reasons.push('YTFUN_MAX_UPLOAD_BYTES must be a positive integer no greater than 250 MiB.');
    if (!this.#verifyPublishedVideo) reasons.push('YouTube Zernio requires an observed native public-visibility and channel-ownership verifier.');
    return { platform: 'youtube', route: 'zernio', directPostImplemented: true, ready: reasons.length === 0, reasons,
      accountId: channel(this.#env.YOUTUBE_CHANNEL_ID) ? this.#env.YOUTUBE_CHANNEL_ID : null,
      providerAccountId: id(this.#env.ZERNIO_YOUTUBE_ACCOUNT_ID) ? this.#env.ZERNIO_YOUTUBE_ACCOUNT_ID : null,
      remoteAuthorizationVerified: false, syntheticDisclosureSupported: true, maxBytes: maxBytes(this.#env), maxDurationSeconds: 900 };
  }

  #receipt(status, phase, context = {}, extra = {}) {
    return { route: 'zernio', platform: 'youtube', status, phase, confirmed: false,
      accountId: this.#binding?.nativeAccountId, providerAccountId: this.#binding?.providerAccountId,
      handle: this.#binding?.handle, ...context, ...extra };
  }

  async #request(path, { method = 'GET', body, headers = {} } = {}) {
    try {
      const response = await this.#fetch(`${BASE}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${this.#env.ZERNIO_API_KEY}`, ...headers }, ...(body !== undefined ? { body } : {}) });
      if (response.redirected || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        await response.body?.cancel().catch(() => {});
        return { ok: false, httpStatus: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null, code: 'ZERNIO_REDIRECT_OR_STATUS_REJECTED' };
      }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return { ok: false, httpStatus: response.status, code: 'ZERNIO_HTTP_REJECTED' }; }
      const data = await boundedJson(response);
      return { ok: data !== null, httpStatus: response.status, code: data === null ? 'ZERNIO_RESPONSE_INVALID' : 'ZERNIO_HTTP_ACCEPTED', data };
    } catch { return { ok: false, httpStatus: null, code: 'ZERNIO_TRANSPORT_UNCONFIRMED' }; }
  }

  async verifyAccount() {
    const readiness = this.readiness();
    if (!readiness.ready) throw new Error(readiness.reasons.join(' '));
    const accounts = await this.#request('/accounts');
    const list = accounts.data?.accounts;
    if (!accounts.ok || !Array.isArray(list) || list.filter(item => item?._id === this.#binding.providerAccountId).length !== 1 ||
        !accountMatches(list.find(item => item?._id === this.#binding.providerAccountId), this.#binding)) {
      throw new Error('YouTube Zernio connected account did not match the recorded authorized channel identity.');
    }
    const result = await this.#request(`/accounts/${this.#binding.providerAccountId}/health`);
    const health = result.data;
    if (!result.ok || health?.accountId !== this.#binding.providerAccountId || health.platform !== 'youtube' ||
        !['healthy', 'warning'].includes(health.status) || health.tokenStatus?.valid !== true ||
        health.permissions?.canPost !== true || !Array.isArray(health.permissions?.missingRequired) ||
        health.permissions.missingRequired.length !== 0) throw new Error('YouTube Zernio health did not confirm posting permission for the connected channel.');
    return { accountId: this.#binding.nativeAccountId, providerAccountId: this.#binding.providerAccountId,
      handle: this.#binding.handle, verified: true, maxDurationSeconds: 900 };
  }

  async upload({ media, caption, title, madeForKids, render, publicationId, onReceipt, tags = [], privacy = 'public', synthetic = true } = {}) {
    if (privacy !== 'public' || synthetic !== true) throw new Error('YouTube Zernio delivery is public-only with explicit synthetic disclosure.');
    if (!Buffer.isBuffer(media) || media.length < 1 || media.length > (maxBytes(this.#env) ?? 0)) throw new Error('YouTube Zernio media must be a nonempty Buffer within the configured size limit.');
    if (!uuid(publicationId)) throw new Error('YouTube Zernio requires the stable publication UUID as the idempotency key.');
    if (typeof caption !== 'string' || !caption.trim() || caption.length > 5000 || /[<>]/.test(caption)) throw new Error('YouTube description must contain 1 to 5000 characters without angle brackets.');
    if (typeof title !== 'string' || !title.trim() || title.length > 100 || /[<>\r\n]/.test(title)) throw new Error('YouTube title must contain 1 to 100 characters on one line.');
    if (typeof madeForKids !== 'boolean') throw new Error('YouTube Zernio requires an explicit madeForKids decision.');
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 100) || tags.join(',').length > 500) throw new Error('YouTube tags exceed the supported field limits.');
    if (!Number.isFinite(render?.durationSeconds) || render.durationSeconds < 1 || render.durationSeconds > 900 || render.format !== 'mp4') throw new Error('YouTube Zernio supports MP4 renders from 1 to 900 seconds in this operational profile.');
    const renderSha256 = createHash('sha256').update(media).digest('hex');
    if (!digest(render.sha256 ?? render.renderSha256) || (render.sha256 ?? render.renderSha256) !== renderSha256) throw new Error('YouTube Zernio media did not match the exact recorded render digest.');
    if (onReceipt !== undefined && typeof onReceipt !== 'function') throw new Error('YouTube Zernio onReceipt must be a function.');
    await this.verifyAccount();
    const context = { publicationId, renderSha256 };
    const preserve = async value => { if (onReceipt) await onReceipt(value); return value; };
    let phase = 'presign';
    let providerPostId;
    let diagnostic = { code: 'ZERNIO_PRESIGN_REQUEST_PENDING', httpStatus: null };
    try {
      // A persisted intent precedes any mutation. There are no automatic POST/PUT retries.
      await preserve(this.#receipt('uploading', phase, context, diagnostic));
      const presign = await this.#request('/media/presign', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: `ai-meow-${publicationId}.mp4`, contentType: 'video/mp4', size: media.length }) });
      diagnostic = { code: presign.code, httpStatus: presign.httpStatus };
      await preserve(this.#receipt('uploading', phase, context, diagnostic));
      const urls = presign.ok ? uploadUrls(presign.data) : null;
      if (!urls) return preserve(this.#receipt('unknown', phase, context, { ...diagnostic,
        ...(presign.ok ? { code: 'ZERNIO_STORAGE_TARGET_REJECTED' } : {}), error: 'YouTube Zernio did not confirm a safe upload target; no publish request was sent.' }));
      phase = 'transfer';
      diagnostic = { code: 'ZERNIO_TRANSFER_REQUEST_PENDING', httpStatus: null };
      await preserve(this.#receipt('uploading', phase, context, diagnostic));
      let transferred;
      try {
        transferred = await this.#fetch(urls.uploadUrl, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(120_000),
          headers: { 'Content-Type': 'video/mp4' }, body: media });
      } catch { return preserve(this.#receipt('unknown', phase, context, { code: 'ZERNIO_TRANSPORT_UNCONFIRMED', httpStatus: null, error: 'YouTube Zernio media transfer was not confirmed; no publish request was sent.' })); }
      diagnostic = { httpStatus: Number.isInteger(transferred.status) && transferred.status >= 100 && transferred.status <= 599 ? transferred.status : null,
        code: transferred.redirected ? 'ZERNIO_REDIRECT_OR_STATUS_REJECTED' : transferred.ok ? 'ZERNIO_HTTP_ACCEPTED' : 'ZERNIO_HTTP_REJECTED' };
      await transferred.body?.cancel().catch(() => {});
      await preserve(this.#receipt('uploading', phase, context, diagnostic));
      if (transferred.redirected || !transferred.ok || diagnostic.httpStatus === null) return preserve(this.#receipt('unknown', phase, context, { ...diagnostic, error: 'YouTube Zernio media transfer was not confirmed; no publish request was sent.' }));
      phase = 'create-post';
      diagnostic = { code: 'ZERNIO_POST_REQUEST_PENDING', httpStatus: null };
      await preserve(this.#receipt('uploading', phase, context, diagnostic));
      const result = await this.#request('/posts', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': publicationId },
        body: JSON.stringify({ content: caption, tags, publishNow: true,
          mediaItems: [{ type: 'video', url: urls.publicUrl }],
          metadata: { ytfunPublicationId: publicationId, ytfunRenderSha256: renderSha256 },
          platforms: [{ platform: 'youtube', accountId: this.#binding.providerAccountId,
            platformSpecificData: { title, visibility: 'public', madeForKids, containsSyntheticMedia: true, categoryId: '24' } }] }) });
      const post = result.data?.post;
      diagnostic = { code: result.code, httpStatus: result.httpStatus };
      if (!result.ok || !id(post?._id)) return preserve(this.#receipt('unknown', phase, context, { ...diagnostic,
        ...(result.ok ? { code: 'ZERNIO_POST_RECEIPT_MISSING' } : {}), error: 'YouTube Zernio did not return a durable post receipt; reconcile before any further mutation.' }));
      providerPostId = post._id;
      // The provider post ID survives even a 207 or later failed GET/validation.
      await preserve(this.#receipt('processing', phase, { ...context, providerPostId }, diagnostic));
      if (!this.#postMatches(post, { providerPostId, ...context })) return preserve(this.#receipt('unknown', phase, { ...context, providerPostId }, { ...diagnostic, code: 'ZERNIO_POST_BINDING_REJECTED', error: 'YouTube Zernio returned a post that did not match the exact publication intent.' }));
      if (post.platforms[0].status === 'failed' || post.status === 'failed') return preserve(this.#receipt('failed', phase, { ...context, providerPostId }, { ...diagnostic, code: 'ZERNIO_PLATFORM_FAILURE', error: 'YouTube Zernio recorded a platform publishing failure; the provider post is retained.' }));
      return preserve(this.#receipt('processing', phase, { ...context, providerPostId }, diagnostic));
    } catch {
      return this.#receipt('unknown', phase, { ...context, ...(providerPostId ? { providerPostId } : {}) }, { ...diagnostic, code: 'ZERNIO_RECEIPT_PERSISTENCE_UNCONFIRMED', error: 'YouTube Zernio operation or receipt persistence was not confirmed; reconcile without replaying mutations.' });
    }
  }

  #postMatches(post, { providerPostId, publicationId, renderSha256 }) {
    const target = post?.platforms?.[0];
    const targetId = typeof target?.accountId === 'object' ? target.accountId?._id : target?.accountId;
    return post?._id === providerPostId && post.metadata?.ytfunPublicationId === publicationId &&
      post.metadata?.ytfunRenderSha256 === renderSha256 && Array.isArray(post.platforms) && post.platforms.length === 1 &&
      target?.platform === 'youtube' && targetId === this.#binding.providerAccountId &&
      target.platformSpecificData?.visibility === 'public' && target.platformSpecificData?.containsSyntheticMedia === true &&
      !post.scheduledFor && !target.scheduledFor && !target.removedFromPlatformAt && post.status !== 'draft' && post.status !== 'cancelled';
  }

  async status({ providerPostId, publicationId, renderSha256 } = {}) {
    if (!id(providerPostId) || !uuid(publicationId) || !digest(renderSha256)) throw new Error('YouTube Zernio reconciliation requires the exact provider post, publication UUID and render digest.');
    const context = { providerPostId, publicationId, renderSha256 };
    try { await this.verifyAccount(); }
    catch { return this.#receipt('unknown', 'status', context, { error: 'YouTube Zernio connected channel verification was unavailable.' }); }
    const result = await this.#request(`/posts/${providerPostId}`);
    const post = result.data?.post;
    if (!result.ok || !this.#postMatches(post, context)) return this.#receipt('unknown', 'status', context, { error: 'YouTube Zernio did not confirm the exact stored public publication intent.' });
    const target = post.platforms[0];
    if (target.status === 'failed' || post.status === 'failed') return this.#receipt('failed', 'status', context, { error: 'YouTube Zernio recorded a platform publishing failure; no retry was issued.' });
    if (post.status !== 'published' || target.status !== 'published') return this.#receipt('processing', 'status', context);
    const url = safeZernioYouTubePermalink(target.platformPostUrl, target.platformPostId);
    const publishedAt = target.publishedAt;
    if (!url || typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt)) || Date.parse(publishedAt) > Date.now() + 60_000) return this.#receipt('processing', 'status', context, { error: 'YouTube Zernio has not supplied the exact public link and effective publication time.' });
    let native;
    try { native = await this.#verifyPublishedVideo({ videoId: target.platformPostId, channelId: this.#binding.nativeAccountId }); }
    catch { return this.#receipt('processing', 'status', context, { videoId: target.platformPostId, error: 'YouTube native public visibility has not been observed yet.' }); }
    if (native?.confirmed !== true || native.videoId !== target.platformPostId || native.channelId !== this.#binding.nativeAccountId ||
        native.privacyStatus !== 'public' || native.uploadStatus !== 'processed') return this.#receipt('processing', 'status', context, { videoId: target.platformPostId, error: 'YouTube native status did not confirm public, processed ownership on the configured channel.' });
    return this.#receipt('published', 'status', context, { videoId: target.platformPostId, url, publishedAt,
      privacy: 'public', confirmed: true, nativeVisibilityVerified: true, syntheticDisclosureRequested: true });
  }
}
