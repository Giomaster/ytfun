import { createHash, createHmac, randomUUID } from 'node:crypto';
import { TikTokSession, tiktokResponseJson } from './tiktok-session.mjs';

const GATEWAY = 'https://www.tiktok.com/top/v1';
const REGION = 'ap-singapore-1'; // Observed ApplyUploadInner ResponseMetadata, 2026-10-02.
const MAX_BYTES = 8 * 1024 * 1024; // Current small-clip integration; no implicit long-video support.
const validId = value => typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value);
const validVid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function tiktokAwsRequest({ method, params, token, body = '', now = new Date() }) {
  const url = new URL(GATEWAY);
  const query = Object.entries(params).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${encode(k)}=${encode(String(v))}`).join('&');
  url.search = query;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers = { host: url.host, 'x-amz-content-sha256': sha(body), 'x-amz-date': amzDate, 'x-amz-security-token': token.session_token };
  const keys = Object.keys(headers).sort();
  const canonical = [method, url.pathname, query, keys.map(k => `${k}:${headers[k].trim()}\n`).join(''), keys.join(';'), sha(body)].join('\n');
  const scope = `${date}/${REGION}/vod/aws4_request`;
  const key = hmac(hmac(hmac(hmac('AWS4' + token.secret_acess_key, date), REGION), 'vod'), 'aws4_request');
  const signature = hmac(key, ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n')).toString('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${token.access_key_id}/${scope}, SignedHeaders=${keys.join(';')}, Signature=${signature}`;
  return { url, method, headers, ...(method === 'POST' ? { body } : {}) };
}

export function tiktokCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

export function tiktokStorageTarget(node) {
  const info = node?.StoreInfos?.[0];
  if (!['tos-my16-up.tiktokcdn.com', 'tos-my316-up.tiktokcdn.com', 'tos-quic-awsfr.tiktokcdn.com'].includes(node?.UploadHost) ||
      typeof info?.StoreUri !== 'string' || !/^[A-Za-z0-9_/-]{1,512}$/.test(info.StoreUri) || info.StoreUri.includes('..') ||
      typeof info.Auth !== 'string' || !info.Auth || /[\r\n]/.test(info.Auth) || !validVid(node.Vid) || !node.SessionKey) throw new Error('TIKTOK_STORAGE_TARGET_NOT_CONFIRMED');
  const extraHeaders = {};
  const logical = node.UploadHeader?.['X-Logical-Part-Mode'];
  if (typeof logical === 'string' && logical.length < 128 && !/[\r\n]/.test(logical)) extraHeaders['x-logical-part-mode'] = logical;
  return { url: `https://${node.UploadHost}/upload/v1/${info.StoreUri}`, auth: info.Auth, videoId: node.Vid, sessionKey: node.SessionKey, extraHeaders };
}

export function tiktokPostBody({ creationId, videoId, caption, durationSeconds, width, height }) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(creationId ?? '') || !validVid(videoId) || typeof caption !== 'string' || !caption || caption.length > 2200 ||
      !Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 180 || !Number.isInteger(width) || !Number.isInteger(height) || width < 256 || height < 256) throw new Error('TIKTOK_POST_INPUT_INVALID');
  const textExtra = [...caption.matchAll(/#[\p{L}\p{N}_]+/gu)].map(m => ({ start: m.index, end: m.index + m[0].length, type: 1, hashtag_name: m[0].slice(1), user_id: '' }));
  return {
    post_common_info: { creation_id: creationId, enter_post_page_from: 1, post_type: 3 },
    feature_common_info_list: [{ geofencing_regions: [], playlist_name: '', playlist_id: '', tcm_params: JSON.stringify({ commerce_toggle_info: {} }),
      sound_exemption: 0, anchors: [], aigc_info: { aigc_label_type: 1 }, vedit_common_info: { draft: '', video_id: videoId },
      privacy_setting_info: { visibility_type: 0, allow_duet: 0, allow_stitch: 0, allow_comment: 1, allow_content_reuse: 0, allow_ai_remix: 0 } }],
    single_post_req_list: [{ batch_index: 0, video_id: videoId, is_long_video: 0, single_post_feature_info: {
      text: caption, text_extra: textExtra, markup_text: caption, music_info: { origin_volume: '100' }, poster_delay: 0,
      cloud_edit_video_height: height, cloud_edit_video_width: width, cloud_edit_is_use_video_canvas: false,
      has_original_audio: 1, is_upload_audio_track: false,
      video_track_time_range_list: [{ start_time_in_ms: 0, end_time_in_ms: Math.round(durationSeconds * 1000) }],
    } }],
  };
}

/** Captured web lane, experimental. No signature/CAPTCHA emulation and no mutation retries. */
export class TikTokWeb {
  #session; #fetch;
  constructor({ env = process.env, fetchImpl = fetch, session } = {}) {
    this.#fetch = fetchImpl; this.#session = session ?? new TikTokSession({ env, fetchImpl });
  }
  readiness() { return this.#session.readiness(); }
  verifyAccount() { return this.#session.verifyAccount(); }
  async #gateway(request) {
    let response;
    try { response = await this.#fetch(request.url, { ...request, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error('TIKTOK_GATEWAY_OUTCOME_UNCONFIRMED'); }
    const data = await tiktokResponseJson(response);
    if (!response.ok || response.redirected || !data || data.ResponseMetadata?.Error) throw new Error('TIKTOK_GATEWAY_REJECTED');
    return data;
  }
  async upload({ media, caption, render, onReceipt, prepared }) {
    if (!Buffer.isBuffer(media) || media.length < 1 || media.length > MAX_BYTES) throw new Error('TIKTOK_CURRENT_CLIP_LIMIT_EXCEEDED');
    if (prepared && !/^[A-Za-z0-9_-]{16,64}$/.test(prepared.creationId ?? '')) throw new Error('TIKTOK_PREPARED_CREATION_INVALID');
    const creationId = prepared?.creationId ?? randomUUID().replaceAll('-', '');
    let phase = 'authorization', videoId;
    const notify = async status => onReceipt({ creationId, ...(videoId ? { videoId } : {}), status, phase });
    try {
      const token = await this.#session.uploadAuthorization();
      await this.#session.refreshCsrf();
      let allocation = prepared?.allocation;
      if (!allocation) {
        phase = 'project-create'; await notify('uploading');
        const project = await this.#session.request('/api/v1/web/project/create/', { method: 'POST', params: { creation_id: creationId, type: '1' } });
        if (!project.ok || project.data?.status_code !== 0 || !project.data?.project?.project_id) return { status: 'unknown', phase, creationId, confirmed: false };
        phase = 'allocation'; await notify('uploading');
        allocation = await this.#gateway(tiktokAwsRequest({ method: 'GET', token, params: {
          Action: 'ApplyUploadInner', Version: '2020-11-19', SpaceName: 'tiktok', FileType: 'video', IsInner: 1,
          FileSize: media.length, s: randomUUID().replaceAll('-', ''), device_platform: 'web', business_tag: 'tiktok_video_submission_web',
        } }));
      }
      const node = allocation.Result?.InnerUploadAddress?.UploadNodes?.[0];
      const target = tiktokStorageTarget(node);
      videoId = target.videoId;
      phase = 'transfer'; await notify('uploading');
      const headers = { authorization: target.auth, 'content-type': 'application/octet-stream', 'content-crc32': tiktokCrc32(media), ...target.extraHeaders };
      // Direct transfer is present in the captured official SDK. Credentials for
      // storage are scoped separately: no account cookies are sent to the CDN.
      const response = await this.#fetch(target.url, { method: 'POST', headers, body: media, redirect: 'error', signal: AbortSignal.timeout(90_000) });
      const transfer = await tiktokResponseJson(response);
      if (!response.ok || response.redirected || transfer?.code !== 2000) return { status: 'unknown', phase, creationId, videoId, confirmed: false };
      phase = 'commit'; await notify('uploading');
      const commit = await this.#gateway(tiktokAwsRequest({ method: 'POST', token,
        params: { Action: 'CommitUploadInner', Version: '2020-11-19', SpaceName: 'tiktok' },
        body: JSON.stringify({ SessionKey: target.sessionKey, Functions: [{ name: 'GetMeta' }] }),
      }));
      if (commit.Result?.Results?.[0]?.Vid !== videoId) return { status: 'unknown', phase, creationId, videoId, confirmed: false };
      phase = 'post'; await notify('uploaded');
      const posted = await this.#session.request('/tiktok/web/project/post/v1/', { method: 'POST', params: { tz_name: 'America/Sao_Paulo' },
        body: tiktokPostBody({ creationId, videoId, caption, ...render }) });
      const code = posted.data?.status_code;
      if (!posted.ok || code !== 0) return { status: 'unknown', phase, creationId, videoId, confirmed: false,
        httpStatus: posted.httpStatus, ...(Number.isSafeInteger(code) ? { applicationCode: code } : {}) };
      // Successful project submission is not evidence of processing or visibility.
      return { status: 'processing', phase, creationId, videoId, confirmed: false };
    } catch (error) {
      return { status: 'unknown', phase, creationId, ...(videoId ? { videoId } : {}), confirmed: false,
        code: /^TIKTOK_[A-Z_]+$/.test(error.message ?? '') ? error.message : 'TIKTOK_REQUEST_OUTCOME_UNCONFIRMED' };
    }
  }
  async status({ creationId, postId }) {
    await this.verifyAccount();
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(creationId ?? '')) throw new Error('TIKTOK_CREATION_RECEIPT_REQUIRED');
    if (!validId(postId)) {
      const project = await this.#session.request('/tiktok/web/project/status/v1/', { params: { creation_id: creationId } });
      // Until the real response schema is captured, never infer an item ID or
      // public visibility from project success. Keep a bounded operator diagnosis.
      return { status: 'processing', confirmed: false, phase: 'status', httpStatus: project.httpStatus,
        applicationCode: Number.isSafeInteger(project.data?.status_code) ? project.data.status_code : null,
        responseFields: project.data ? Object.keys(project.data).slice(0, 30) : [] };
    }
    const result = await this.#session.request('/api/item/detail/', { params: { itemId: postId } });
    const item = result.data?.itemInfo?.itemStruct;
    const account = await this.verifyAccount();
    if (!result.ok || result.data?.statusCode !== 0 || item?.id !== postId || item?.author?.id !== account.accountId ||
        item?.author?.uniqueId !== account.handle || item?.privateItem !== false || item?.secret !== false || item?.forFriend !== false) return { status: 'processing', confirmed: false, phase: 'status' };
    return { status: 'published', confirmed: true, postId, phase: 'status', privacy: 'public',
      url: `https://www.tiktok.com/@${account.handle}/video/${postId}` };
  }
}
