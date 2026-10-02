import { constants } from 'node:fs';
import { access, lstat, open, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ORIGIN = 'https://www.tiktok.com';
const LIMIT = 2 * 1024 * 1024;
const ROUTES = new Set(['/api/v1/user/profile/upload/', '/api/v1/video/upload/auth/',
  '/tiktokstudio/api/web/user', '/api/v1/web/project/create/', '/tiktok/web/project/post/v1/',
  '/tiktok/web/project/status/v1/', '/api/v1/post/detail/', '/api/item/detail/']);
const id = value => typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value);
const cookieName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const cookieValue = value => typeof value === 'string' && value.length <= 16_384 && !/[\x00-\x20\x7f;,]/.test(value);

export async function privateSessionFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('TIKTOK_PRIVATE_SESSION_REQUIRED');
  const parent = await realpath(path.dirname(filename));
  if (parent !== path.dirname(filename)) throw new Error('TIKTOK_PRIVATE_PATH_UNSAFE');
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || (parentInfo.mode & 0o077) || (typeof process.getuid === 'function' && parentInfo.uid !== process.getuid())) throw new Error('TIKTOK_PRIVATE_DIRECTORY_UNSAFE');
  for (let directory = parent; ; directory = path.dirname(directory)) {
    try { await access(path.join(directory, '.git')); throw new Error('TIKTOK_SESSION_MUST_REMAIN_OUTSIDE_GIT'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (directory === path.dirname(directory)) break;
  }
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > LIMIT || (info.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('TIKTOK_PRIVATE_FILE_UNSAFE');
    const bytes = await handle.readFile();
    if (bytes.length > LIMIT) throw new Error('TIKTOK_PRIVATE_FILE_TOO_LARGE');
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (/^TIKTOK_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error('TIKTOK_PRIVATE_FILE_INVALID');
  } finally { await handle.close(); }
}

export async function savePrivateSessionFile(filename, value) {
  // Destination has already passed the private-file checks; reject substitutions.
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('TIKTOK_PRIVATE_FILE_UNSAFE');
  const temporary = filename + '.tmp-' + randomUUID();
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, filename);
}

export async function tiktokResponseJson(response) {
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

/** Private web-session lane. This is not OAuth, Direct Post approval or a login bypass. */
export class TikTokSession {
  #env; #fetch; #session;
  constructor({ env = process.env, fetchImpl = fetch } = {}) {
    this.#env = { ...env }; this.#fetch = fetchImpl;
  }
  readiness() {
    const reasons = [];
    if (this.#env.YTFUN_TIKTOK_SESSION_PUBLISH_ENABLED !== 'true') reasons.push('Enable the explicitly authorized experimental TikTok session REST route.');
    if (!id(this.#env.TIKTOK_ACCOUNT_ID) || !/^[A-Za-z0-9._]{2,64}$/.test(this.#env.TIKTOK_ACCOUNT_HANDLE ?? '')) reasons.push('Configure the exact numeric TikTok account ID and handle.');
    if (!path.isAbsolute(this.#env.TIKTOK_SESSION_FILE ?? '')) reasons.push('Configure an owned 0600 TikTok session file outside Git.');
    return { ready: reasons.length === 0, reasons, accountId: this.#env.TIKTOK_ACCOUNT_ID ?? null,
      route: 'experimental_session_rest', oauth: false, browserRequiredForRequests: false, remoteAuthorizationVerified: false };
  }
  async #load() {
    if (!this.readiness().ready) throw new Error('TIKTOK_SESSION_CONFIGURATION_REQUIRED');
    this.#session = await privateSessionFile(this.#env.TIKTOK_SESSION_FILE);
    const account = this.#session.expectedAccount;
    if (account?.accountId !== this.#env.TIKTOK_ACCOUNT_ID || account?.handle !== '@' + this.#env.TIKTOK_ACCOUNT_HANDLE || !Array.isArray(this.#session.cookies)) throw new Error('TIKTOK_SESSION_ACCOUNT_CHANGED');
    return this.#session;
  }
  async #headers() {
    const session = await this.#load();
    const cookies = session.cookies.filter(c => cookieName(c.name) && cookieValue(c.value) &&
      ['.tiktok.com', 'tiktok.com', 'www.tiktok.com'].includes(c.domain) && c.path === '/' &&
      (!Number.isFinite(Date.parse(c.expires)) || Date.parse(c.expires) > Date.now()));
    if (!cookies.some(c => c.name === 'sessionid' && c.value)) throw new Error('TIKTOK_SESSION_REIMPORT_REQUIRED');
    const headers = { cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '), accept: 'application/json', referer: ORIGIN + '/tiktokstudio/upload' };
    for (const name of ['user-agent', 'accept-language']) {
      const value = session.requestHeaders?.[name];
      if (typeof value === 'string' && value.length < 2048 && !/[\r\n]/.test(value)) headers[name] = value;
    }
    if (cookieValue(session.csrfToken) && session.csrfToken) headers['tt-csrf-token'] = session.csrfToken;
    return headers;
  }
  async #rotate(response) {
    const session = await this.#load();
    let changed = false;
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair, ...attributes] = raw.split(';').map(x => x.trim());
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator), value = pair.slice(separator + 1);
      if (separator < 1 || !cookieName(name) || !cookieValue(value)) continue;
      const attrs = Object.fromEntries(attributes.map(a => { const i = a.indexOf('='); return [a.slice(0, i < 0 ? undefined : i).toLowerCase(), i < 0 ? true : a.slice(i + 1)]; }));
      const domain = attrs.domain ?? 'www.tiktok.com', cookiePath = attrs.path ?? '/';
      if (!['.tiktok.com', 'tiktok.com', 'www.tiktok.com'].includes(domain) || cookiePath !== '/') continue;
      let expires = attrs.expires;
      if (/^-?\d+$/.test(String(attrs['max-age'] ?? ''))) expires = new Date(Date.now() + Number(attrs['max-age']) * 1000).toISOString();
      const next = { name, value, domain, path: cookiePath, expires, secure: attrs.secure === true, httpOnly: attrs.httponly === true };
      session.cookies = session.cookies.filter(c => !(c.name === name && c.domain === domain && c.path === cookiePath));
      if (value && (!Number.isFinite(Date.parse(expires)) || Date.parse(expires) > Date.now())) session.cookies.push(next);
      changed = true;
    }
    if (changed) { session.rotatedAt = new Date().toISOString(); await savePrivateSessionFile(this.#env.TIKTOK_SESSION_FILE, session); }
  }
  async request(route, { method = 'GET', params = {}, body } = {}) {
    if (!ROUTES.has(route) || !['GET', 'POST'].includes(method)) throw new Error('TIKTOK_ROUTE_NOT_CAPTURED');
    const url = new URL(route, ORIGIN);
    url.search = new URLSearchParams({ aid: '1988', ...params }).toString();
    const headers = await this.#headers();
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try { response = await this.#fetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error('TIKTOK_REST_OUTCOME_UNCONFIRMED'); }
    const data = await tiktokResponseJson(response);
    await this.#rotate(response);
    return { httpStatus: response.status, data, ok: response.ok && !response.redirected && data !== null };
  }
  async verifyAccount() {
    const result = await this.request('/api/v1/user/profile/upload/');
    const user = result.data?.user;
    if (!result.ok || result.data?.status_code !== 0) throw new Error('TIKTOK_SESSION_REIMPORT_OR_CHALLENGE_REQUIRED');
    if (user?.uid !== this.#env.TIKTOK_ACCOUNT_ID || user?.unique_id !== this.#env.TIKTOK_ACCOUNT_HANDLE || user?.private_account !== false) throw new Error('TIKTOK_PUBLIC_ACCOUNT_NOT_CONFIRMED');
    return { accountId: user.uid, handle: user.unique_id, maxDurationSeconds: user.max_video_duration_in_sec };
  }
  async uploadAuthorization() {
    const result = await this.request('/api/v1/video/upload/auth/');
    const token = result.data?.video_token_v5;
    if (!result.ok || result.data?.status_code !== 0 || !token?.access_key_id || !token?.secret_acess_key || !token?.session_token || !Number.isFinite(Date.parse(token.expired_time)) || Date.parse(token.expired_time) < Date.now() + 60_000) throw new Error('TIKTOK_UPLOAD_AUTHORIZATION_REQUIRED');
    return token; // Never placed in a public receipt or the canonical store.
  }
  async refreshCsrf() {
    const result = await this.request('/tiktokstudio/api/web/user');
    const token = result.data?.['tt-csrf-token'];
    if (!result.ok || result.data?.statusCode !== 0 || result.data.userId !== this.#env.TIKTOK_ACCOUNT_ID || !cookieValue(token) || !token) throw new Error('TIKTOK_CSRF_NOT_CONFIRMED');
    const session = await this.#load();
    session.csrfToken = token;
    await savePrivateSessionFile(this.#env.TIKTOK_SESSION_FILE, session);
  }
}
