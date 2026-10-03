const GRAPH_ORIGIN = 'https://graph.facebook.com';
const VIDEO_ORIGIN = 'https://graph-video.facebook.com';
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_TRANSFER_CHUNKS = 512;
const MAX_UPLOAD_MS = 20 * 60 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const PHASE_STATUSES = new Set(['not_started', 'in_progress', 'complete', 'error']);
const VIDEO_STATUSES = new Set(['uploading', 'processing', 'ready', 'error']);
const validId = (value) => typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value);
const validVersion = (value) => typeof value === 'string' && /^v[1-9]\d{1,2}\.0$/.test(value);
const validToken = (value) => typeof value === 'string' && value.length >= 8 && value.length <= 8192 && !/\s/.test(value);

// This intentionally uses the narrower profile in Meta's accessible Reels
// collection, rather than assuming that newer UI limits apply to the API.
export function validateFacebookReel({ durationSeconds, width, height, framesPerSecond, format } = {}) {
  const reasons = [];
  if (!Number.isFinite(durationSeconds) || durationSeconds < 4 || durationSeconds > 60) {
    reasons.push('Facebook delivery currently supports the verified conservative profile of 4 to 60 seconds.');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 540 || height < 960 || width * 16 !== height * 9) {
    reasons.push('Facebook Reels require a vertical 9:16 render of at least 540 by 960 pixels.');
  }
  if (!Number.isFinite(framesPerSecond) || framesPerSecond < 23) reasons.push('Facebook Reels require at least 23 frames per second.');
  if (format !== 'mp4') reasons.push('This Facebook adapter supports reviewed MP4 renders.');
  return { ready: reasons.length === 0, reasons };
}

// These are studio limits, not a claim about Meta's current maximum duration.
// The general Page Video edge has its own upload workflow; never extend Reels
// based solely on the consumer product's all-videos-as-Reels announcement.
export function validateFacebookPageVideo(render = {}) {
  const profile = validateFacebookReel({ ...render, durationSeconds: 4 });
  const reasons = [...profile.reasons];
  if (!Number.isFinite(render.durationSeconds) || render.durationSeconds < 4 || render.durationSeconds > 900) {
    reasons.push('Facebook Page Video delivery supports reviewed long-format MP4s from 4 to 900 seconds within the studio operational limit.');
  }
  return { ready: reasons.length === 0, reasons };
}

export function safeFacebookVideoPermalink(value, videoId) {
  if (!validId(videoId)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || !['www.facebook.com', 'facebook.com'].includes(url.hostname) ||
      (url.port && url.port !== '443') || url.username || url.password || url.hash) return null;
  const videoPath = new RegExp(`^/(?:[a-zA-Z0-9._-]+/videos|reel)/${videoId}/?$`);
  if (videoPath.test(url.pathname) && !url.search) return url.href;
  if (/^\/watch\/?$/.test(url.pathname) && url.search === `?v=${videoId}`) return url.href;
  return null;
}

function uploadLimit(env) {
  const value = Number(env.YTFUN_MAX_UPLOAD_BYTES ?? MAX_UPLOAD_BYTES);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_UPLOAD_BYTES ? value : null;
}

function configurationIssues(env) {
  const reasons = [];
  if (!validId(env.FACEBOOK_PAGE_ID)) reasons.push('FACEBOOK_PAGE_ID must identify the intended Facebook Page with a numeric ID.');
  if (!validToken(env.FACEBOOK_PAGE_ACCESS_TOKEN)) reasons.push('Facebook requires a validly shaped Page OAuth token in FACEBOOK_PAGE_ACCESS_TOKEN.');
  if (!validVersion(env.FACEBOOK_GRAPH_API_VERSION)) reasons.push('FACEBOOK_GRAPH_API_VERSION must explicitly pin a supported Graph version such as v26.0.');
  if (uploadLimit(env) === null) reasons.push('YTFUN_MAX_UPLOAD_BYTES must be a positive integer no greater than 250 MiB.');
  return reasons;
}

function safeUploadUrl(raw, version, videoId) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'rupload.facebook.com' ||
      (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash ||
      url.pathname !== `/video-upload/${version}/${videoId}`) return null;
  return url.href;
}

async function boundedJson(response) {
  const declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const json = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

function receipt(videoId, status, phase, extra = {}) {
  return { ...(validId(videoId) ? { videoId } : {}), status, phase, confirmed: false, ...extra };
}

async function requestFacebook(fetchImpl, config, url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Facebook request deadline exceeded.')); }, timeoutMs);
    timer.unref?.();
  });
  const operation = async () => {
    const response = await fetchImpl(url, {
      method, headers: { Authorization: `Bearer ${config.token}`, ...headers },
      ...(body !== undefined ? { body } : {}), redirect: 'error', signal: controller.signal,
    });
    if (response.redirected || !Number.isInteger(response.status)) return { ok: false, httpStatus: null };
    if (!response.ok) {
      // Provider errors may echo credentials; never consume or expose them.
      void response.body?.cancel().catch(() => {});
      return { ok: false, httpStatus: response.status };
    }
    const data = await boundedJson(response);
    return { ok: data !== null, httpStatus: response.status, data };
  };
  try { return await Promise.race([operation(), deadline]); }
  catch { return { ok: false, httpStatus: null }; }
  finally { clearTimeout(timer); }
}

export class FacebookReels {
  #env;
  #fetch;

  constructor({ env = process.env, fetchImpl = fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('Facebook requires a fetch implementation.');
    this.#env = { ...env };
    this.#fetch = fetchImpl;
  }

  readiness() {
    const reasons = configurationIssues(this.#env);
    if (this.#env.YTFUN_FACEBOOK_PUBLISH_ENABLED !== 'true') reasons.push('Facebook public publishing must be explicitly enabled with YTFUN_FACEBOOK_PUBLISH_ENABLED=true.');
    if (this.#env.YTFUN_FACEBOOK_APP_REVIEW_CONFIRMED !== 'true') reasons.push('Confirm the Meta app permissions and review/access requirements with YTFUN_FACEBOOK_APP_REVIEW_CONFIRMED=true.');
    return {
      platform: 'facebook', directPostImplemented: true, ready: reasons.length === 0, reasons,
      accountId: validId(this.#env.FACEBOOK_PAGE_ID) ? this.#env.FACEBOOK_PAGE_ID : null,
      remoteAuthorizationVerified: false, syntheticDisclosureSupported: true,
      supportedStates: ['PUBLISHED'], maxBytes: uploadLimit(this.#env),
    };
  }

  #configuration() {
    const reasons = configurationIssues(this.#env);
    if (reasons.length) throw new Error(reasons.join(' '));
    return { pageId: this.#env.FACEBOOK_PAGE_ID, version: this.#env.FACEBOOK_GRAPH_API_VERSION, token: this.#env.FACEBOOK_PAGE_ACCESS_TOKEN };
  }

  async #request(config, url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
    return requestFacebook(this.#fetch, config, url, { method, headers, body, timeoutMs });
  }

  async verifyAccount() {
    const config = this.#configuration();
    const result = await this.#request(config, `${GRAPH_ORIGIN}/${config.version}/me?fields=id`);
    if (!result.ok || result.data?.id !== config.pageId) {
      throw new Error('Facebook Page verification failed; the OAuth token must act as the explicitly configured Page.');
    }
    return { accountId: config.pageId, verified: true };
  }

  async upload({ media, caption, synthetic, onReceipt } = {}) {
    if (!Buffer.isBuffer(media) || media.length < 1 || media.length > (uploadLimit(this.#env) ?? 0)) {
      throw new Error('Facebook media must be a nonempty Buffer within the configured upload size limit.');
    }
    if (typeof caption !== 'string' || !caption.trim() || caption.length > 5000 || Buffer.byteLength(caption, 'utf8') > 20_000) {
      throw new Error('Facebook caption must contain 1 to 5000 characters within the studio byte limit.');
    }
    if (synthetic !== true) throw new Error('Facebook delivery requires explicit synthetic=true and AI disclosure.');
    if (onReceipt !== undefined && typeof onReceipt !== 'function') throw new Error('onReceipt must be an async-compatible callback.');
    const readiness = this.readiness();
    if (!readiness.ready) throw new Error(readiness.reasons.join(' '));
    await this.verifyAccount();
    const config = this.#configuration();
    const endpoint = `${GRAPH_ORIGIN}/${config.version}/${config.pageId}/video_reels`;
    const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
    let videoId;
    let phase = 'start';
    let publishingRequested = false;
    try {
      const started = await this.#request(config, endpoint, {
        method: 'POST', headers: formHeaders, body: new URLSearchParams({ upload_phase: 'start' }).toString(),
      });
      if (!started.ok || !validId(started.data?.video_id)) {
        const definitiveRejection = !started.ok && started.httpStatus >= 400 && started.httpStatus < 500 && ![408, 429].includes(started.httpStatus);
        return receipt(null, definitiveRejection ? 'failed' : 'unknown', phase, { error: 'Facebook did not confirm upload initialization; reconcile before any retry.' });
      }
      videoId = started.data.video_id;
      // Persist the identifier before any transfer or finish request. The upload
      // URL remains private to the adapter and is never placed in the ledger.
      await onReceipt?.(receipt(videoId, 'unknown', phase));
      const uploadUrl = safeUploadUrl(started.data.upload_url, config.version, videoId);
      if (!uploadUrl) return receipt(videoId, 'unknown', phase, { error: 'Facebook returned an upload session outside the exact official upload allowlist.' });
      phase = 'transfer';
      const transferred = await this.#request(config, uploadUrl, {
        method: 'POST', timeoutMs: 180_000,
        headers: { Authorization: `OAuth ${config.token}`, offset: '0', file_size: String(media.length), 'Content-Type': 'application/octet-stream' },
        body: media,
      });
      if (!transferred.ok || transferred.data?.success !== true) {
        return receipt(videoId, 'unknown', phase, { error: 'Facebook did not confirm the media transfer; reconcile this video ID before any retry.' });
      }
      await onReceipt?.(receipt(videoId, 'uploaded', phase, { confirmed: true }));
      phase = 'finish';
      publishingRequested = true;
      const finished = await this.#request(config, endpoint, {
        method: 'POST', headers: formHeaders,
        body: new URLSearchParams({ upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: caption, is_ai_generated: 'true' }).toString(),
      });
      if (!finished.ok || finished.data?.success !== true) {
        return receipt(videoId, 'unknown', phase, { publishingRequested, syntheticDisclosureRequested: true, error: 'Facebook did not confirm publication submission; reconcile this video ID before any retry.' });
      }
      await onReceipt?.(receipt(videoId, 'processing', phase, { publishingRequested, syntheticDisclosureRequested: true }));
      const observed = await this.status({ videoId });
      return { ...observed, publishingRequested, syntheticDisclosureRequested: true };
    } catch {
      return receipt(videoId, 'unknown', phase, {
        publishingRequested,
        ...(publishingRequested ? { syntheticDisclosureRequested: true } : {}),
        error: 'Facebook outcome or receipt persistence is uncertain; reconcile before any retry.',
      });
    }
  }

  async status({ videoId } = {}) {
    if (!validId(videoId)) throw new Error('A numeric Facebook video ID is required for reconciliation.');
    await this.verifyAccount();
    const config = this.#configuration();
    const result = await this.#request(config, `${GRAPH_ORIGIN}/${config.version}/${videoId}?fields=id,status,from,published`);
    if (!result.ok || result.data?.id !== videoId || result.data?.from?.id !== config.pageId || !result.data?.status) {
      return receipt(videoId, 'unknown', 'status', { error: 'Facebook did not confirm an owned video and its processing status; preserve the existing publication state.' });
    }
    const source = result.data.status;
    const phases = {
      uploadingPhase: PHASE_STATUSES.has(source.uploading_phase?.status) ? source.uploading_phase.status : null,
      processingPhase: PHASE_STATUSES.has(source.processing_phase?.status) ? source.processing_phase.status : null,
      publishingPhase: PHASE_STATUSES.has(source.publishing_phase?.status) ? source.publishing_phase.status : null,
      providerVideoStatus: VIDEO_STATUSES.has(source.video_status) ? source.video_status : null,
    };
    let status = 'unknown';
    if (Object.values(phases).includes('error')) status = 'failed';
    else if (phases.uploadingPhase === 'complete' && phases.processingPhase === 'complete' &&
             phases.publishingPhase === 'complete' && result.data.published === true) status = 'published';
    else if (phases.uploadingPhase === 'in_progress' || phases.processingPhase === 'in_progress' ||
             phases.publishingPhase === 'in_progress' || phases.providerVideoStatus === 'processing') status = 'processing';
    else if (phases.uploadingPhase === 'complete' && ['not_started', 'complete'].includes(phases.processingPhase) &&
             phases.publishingPhase === 'not_started') status = 'uploaded';
    return receipt(videoId, status, 'status', {
      ...phases, confirmed: status !== 'unknown', verifiedAt: new Date().toISOString(),
      ...(status === 'unknown' ? { error: 'Facebook returned unrecognized or incomplete publication phases; preserve the existing state.' } : {}),
    });
  }
}

/** General organic Page Video upload. It never uses the Reels upload edge. */
export class FacebookPageVideo extends FacebookReels {
  #env;
  #fetch;

  constructor({ env = process.env, fetchImpl = fetch } = {}) {
    super({ env, fetchImpl });
    this.#env = { ...env };
    this.#fetch = fetchImpl;
  }

  readiness() {
    return { ...super.readiness(), videoKind: 'page_video', maxChunkBytes: MAX_CHUNK_BYTES,
      studioMaxDurationSeconds: 900, providerDurationLimitVerified: false };
  }

  #configuration() {
    const reasons = configurationIssues(this.#env);
    if (reasons.length) throw new Error(reasons.join(' '));
    return { pageId: this.#env.FACEBOOK_PAGE_ID, version: this.#env.FACEBOOK_GRAPH_API_VERSION, token: this.#env.FACEBOOK_PAGE_ACCESS_TOKEN };
  }

  async upload({ media, caption, title, synthetic, onReceipt } = {}) {
    if (!Buffer.isBuffer(media) || media.length < 1 || media.length > (uploadLimit(this.#env) ?? 0)) {
      throw new Error('Facebook media must be a nonempty Buffer within the configured upload size limit.');
    }
    if (typeof caption !== 'string' || !caption.trim() || caption.length > 5000 || Buffer.byteLength(caption, 'utf8') > 20_000) {
      throw new Error('Facebook caption must contain 1 to 5000 characters within the studio byte limit.');
    }
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 100)) {
      throw new Error('Facebook Page Video title must contain 1 to 100 characters when supplied.');
    }
    if (synthetic !== true) throw new Error('Facebook delivery requires explicit synthetic=true and AI disclosure.');
    if (typeof onReceipt !== 'function') throw new Error('Facebook Page Video upload requires a durable onReceipt callback.');
    const readiness = this.readiness();
    if (!readiness.ready) throw new Error(readiness.reasons.join(' '));
    await this.verifyAccount();
    const config = this.#configuration();
    const endpoint = `${VIDEO_ORIGIN}/${config.version}/${config.pageId}/videos`;
    const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const deadlineAt = Date.now() + MAX_UPLOAD_MS;
    const request = (options) => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new Error('Facebook Page Video upload deadline exceeded.');
      return requestFacebook(this.#fetch, config, endpoint, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 30_000, remaining) });
    };
    let videoId;
    let phase = 'start';
    let publishingRequested = false;
    try {
      const started = await request({ method: 'POST', headers: formHeaders,
        body: new URLSearchParams({ upload_phase: 'start', file_size: String(media.length) }).toString() });
      if (!started.ok || !validId(started.data?.video_id)) {
        const rejected = !started.ok && started.httpStatus >= 400 && started.httpStatus < 500 && ![408, 429].includes(started.httpStatus);
        return receipt(null, rejected ? 'failed' : 'unknown', phase, { error: 'Facebook did not confirm Page Video initialization; reconcile before any retry.' });
      }
      videoId = started.data.video_id;
      // The provider session never leaves this adapter. The video ID must reach
      // durable storage before a transfer; failed storage stops all mutations.
      await onReceipt(receipt(videoId, 'unknown', phase));
      const sessionId = started.data.upload_session_id;
      const offset = (value) => typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) :
        Number.isSafeInteger(value) && value >= 0 ? value : NaN;
      let start = offset(started.data.start_offset);
      let end = offset(started.data.end_offset);
      const validRange = () => Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
        start >= 0 && end > start && end <= media.length && end - start <= MAX_CHUNK_BYTES;
      if (!validId(sessionId) || start !== 0 || !validRange()) {
        return receipt(videoId, 'unknown', phase, { error: 'Facebook returned an invalid or oversized Page Video transfer range; no media was sent.' });
      }
      phase = 'transfer';
      let chunks = 0;
      while (start < media.length) {
        if (!validRange() || ++chunks > MAX_TRANSFER_CHUNKS) {
          return receipt(videoId, 'unknown', phase, { error: 'Facebook transfer exceeded the bounded chunk profile; reconcile the existing video ID.' });
        }
        const expectedNext = end;
        const form = new FormData();
        form.set('upload_phase', 'transfer');
        form.set('upload_session_id', sessionId);
        form.set('start_offset', String(start));
        form.set('video_file_chunk', new Blob([media.subarray(start, end)], { type: 'video/mp4' }), 'video.mp4');
        const transferred = await request({ method: 'POST', body: form, timeoutMs: 180_000 });
        if (!transferred.ok) {
          return receipt(videoId, 'unknown', phase, { error: 'Facebook did not confirm a Page Video chunk; do not resend or restart automatically.' });
        }
        start = offset(transferred.data?.start_offset);
        end = offset(transferred.data?.end_offset);
        if (start !== expectedNext || !Number.isSafeInteger(end) ||
            (start === media.length ? end !== media.length : !validRange())) {
          return receipt(videoId, 'unknown', phase, { error: 'Facebook did not confirm contiguous Page Video transfer progress; reconcile the existing video ID.' });
        }
      }
      await onReceipt(receipt(videoId, 'uploaded', phase, { confirmed: true }));
      phase = 'finish';
      publishingRequested = true;
      const finished = await request({ method: 'POST', headers: formHeaders,
        body: new URLSearchParams({ upload_phase: 'finish', upload_session_id: sessionId,
          description: caption, ...(title !== undefined ? { title } : {}), published: 'true', is_ai_generated: 'true' }).toString() });
      if (!finished.ok || finished.data?.success !== true) {
        return receipt(videoId, 'unknown', phase, { publishingRequested, syntheticDisclosureRequested: true,
          error: 'Facebook did not confirm Page Video publication submission; reconcile before any retry.' });
      }
      await onReceipt(receipt(videoId, 'processing', phase, { publishingRequested, syntheticDisclosureRequested: true }));
      return { ...await this.status({ videoId }), publishingRequested, syntheticDisclosureRequested: true };
    } catch {
      return receipt(videoId, 'unknown', phase, { publishingRequested,
        ...(publishingRequested ? { syntheticDisclosureRequested: true } : {}),
        error: 'Facebook Page Video outcome or receipt persistence is uncertain; reconcile before any retry.' });
    }
  }

  async status({ videoId } = {}) {
    if (!validId(videoId)) throw new Error('A numeric Facebook video ID is required for reconciliation.');
    await this.verifyAccount();
    const config = this.#configuration();
    const result = await requestFacebook(this.#fetch, config,
      `${GRAPH_ORIGIN}/${config.version}/${videoId}?fields=id,status,from,published,permalink_url`);
    if (!result.ok || result.data?.id !== videoId || result.data?.from?.id !== config.pageId || !result.data?.status) {
      return receipt(videoId, 'unknown', 'status', { error: 'Facebook did not confirm an owned Page Video; preserve the existing publication state.' });
    }
    const source = result.data.status;
    const phases = {
      uploadingPhase: PHASE_STATUSES.has(source.uploading_phase?.status) ? source.uploading_phase.status : null,
      processingPhase: PHASE_STATUSES.has(source.processing_phase?.status) ? source.processing_phase.status : null,
      publishingPhase: PHASE_STATUSES.has(source.publishing_phase?.status) ? source.publishing_phase.status : null,
      providerVideoStatus: VIDEO_STATUSES.has(source.video_status) ? source.video_status : null,
    };
    const url = safeFacebookVideoPermalink(result.data.permalink_url, videoId);
    const invalidPhase = ['uploading_phase', 'processing_phase', 'publishing_phase'].some(key =>
      source[key] !== undefined && !PHASE_STATUSES.has(source[key]?.status));
    let status = 'unknown';
    if (Object.values(phases).includes('error')) status = 'failed';
    else if (invalidPhase) status = 'unknown';
    else if (Object.values(phases).includes('in_progress') || ['uploading', 'processing'].includes(phases.providerVideoStatus)) status = 'processing';
    else if (phases.providerVideoStatus === 'ready' && result.data.published === true && url) status = 'published';
    else if (phases.providerVideoStatus === 'ready' && result.data.published === false) status = 'uploaded';
    return receipt(videoId, status, 'status', { ...phases, confirmed: status !== 'unknown', verifiedAt: new Date().toISOString(),
      ...(status === 'published' ? { url } : {}),
      ...(status === 'unknown' ? { error: 'Facebook has not confirmed processing, public visibility and a safe permalink; preserve the existing state.' } : {}),
    });
  }
}
