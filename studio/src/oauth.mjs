const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REFRESH_TIMEOUT_MS = 30_000;
const EXPIRY_SKEW_MS = 60_000;
const FAILURE_COOLDOWN_MS = 30_000;
const MAX_CACHE_MS = 24 * 3_600_000;

export const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
export const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
export const YOUTUBE_ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';

function configured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeCredential(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && /^[\x21-\x7e]+$/.test(value);
}

class YouTubeAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function authError(code, message) {
  return new YouTubeAuthError(code, message);
}

function expirySetting(value, name, reasons) {
  if (value === undefined || value === '') return null;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  const canonical = typeof value !== 'string' ? null : value.includes('.')
    ? value.replace(/\.(\d{1,3})Z$/, (_, fraction) => `.${fraction.padEnd(3, '0')}Z`)
    : value.replace(/Z$/, '.000Z');
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(parsed) || new Date(parsed).toISOString() !== canonical) {
    reasons.push(`${name} must be an ISO UTC timestamp.`);
    return null;
  }
  return parsed;
}

function requiredScopeList(value) {
  if (!Array.isArray(value) || value.length > 20 || value.some(scope => typeof scope !== 'string' ||
      !/^https:\/\/www\.googleapis\.com\/auth\/[a-zA-Z0-9._-]+$/.test(scope))) {
    throw authError('YOUTUBE_AUTH_SCOPES_INVALID', 'Required OAuth scopes must be Google API scope URLs.');
  }
  return [...new Set(value)];
}

function responseScopes(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 16_384 || /[\x00-\x1f\x7f]/.test(value)) {
    throw authError('YOUTUBE_OAUTH_RESPONSE_INVALID', 'Google returned invalid OAuth scope metadata.');
  }
  return new Set(value.split(/ +/).filter(Boolean));
}

function scopeIssues(scopes, requiredScopes) {
  if (scopes === null) return [];
  return requiredScopes.filter(scope => !scopes.has(scope)).map(scope => `The refreshed token does not grant required OAuth scope ${scope}.`);
}

// Credentials and cached tokens have no enumerable properties and never enter
// StudioStore. This provider only renews already-consented access; it does not
// run an authorization-code flow or grant consent on the user's behalf.
export class YouTubeAuth {
  #fetch;
  #now;
  #mode;
  #credentials;
  #configurationIssues = [];
  #staticExpiresAt;
  #refreshExpiresAt;
  #cache = null;
  #inFlight = null;
  #terminalError = null;
  #lastFailure = null;
  #invalidated = false;
  #onInvalidGrant;

  constructor({ env = process.env, fetchImpl = fetch, now = Date.now, onInvalidGrant, requireGrantId = false } = {}) {
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#onInvalidGrant = onInvalidGrant;
    this.#mode = ['YOUTUBE_REFRESH_TOKEN', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'].some(name => configured(env[name]))
      ? 'refresh_token' : configured(env.YOUTUBE_ACCESS_TOKEN) ? 'access_token' : 'unconfigured';
    this.#credentials = {
      refreshToken: env.YOUTUBE_REFRESH_TOKEN,
      clientId: env.YOUTUBE_CLIENT_ID,
      clientSecret: env.YOUTUBE_CLIENT_SECRET,
      accessToken: env.YOUTUBE_ACCESS_TOKEN,
    };
    if (this.#mode === 'refresh_token') {
      for (const name of ['YOUTUBE_REFRESH_TOKEN', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET']) {
        if (!safeCredential(env[name])) this.#configurationIssues.push(`${name} must be configured as a nonempty credential without whitespace.`);
      }
      this.#refreshExpiresAt = expirySetting(env.YOUTUBE_REFRESH_TOKEN_EXPIRES_AT, 'YOUTUBE_REFRESH_TOKEN_EXPIRES_AT', this.#configurationIssues);
    } else if (this.#mode === 'access_token') {
      if (!safeCredential(env.YOUTUBE_ACCESS_TOKEN)) this.#configurationIssues.push('YOUTUBE_ACCESS_TOKEN must be configured as a nonempty credential without whitespace.');
      this.#staticExpiresAt = expirySetting(env.YOUTUBE_ACCESS_TOKEN_EXPIRES_AT, 'YOUTUBE_ACCESS_TOKEN_EXPIRES_AT', this.#configurationIssues);
    } else {
      this.#configurationIssues.push('Configure YOUTUBE_ACCESS_TOKEN or YOUTUBE_REFRESH_TOKEN with YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.');
    }
    if (requireGrantId && this.#mode !== 'unconfigured' && (env.YTFUN_YOUTUBE_GRANT_ID === 'legacy' || !/^[A-Za-z0-9_-]{1,100}$/.test(env.YTFUN_YOUTUBE_GRANT_ID ?? ''))) {
      this.#configurationIssues.push('YTFUN_YOUTUBE_GRANT_ID is required for the personal MCP. Use a unique local generation for this consent; stop old processes before migrating an existing grant.');
    }
    if (typeof fetchImpl !== 'function' || typeof now !== 'function') {
      this.#configurationIssues.push('YouTube authentication requires a fetch function and a clock function.');
    }
  }

  #time() {
    let value;
    try { value = this.#now(); } catch { /* Never propagate an injected clock diagnostic. */ }
    if (!Number.isSafeInteger(value) || value < 0) throw authError('YOUTUBE_AUTH_CLOCK_INVALID', 'YouTube authentication requires a valid clock.');
    return value;
  }

  readiness({ requiredScopes = [] } = {}) {
    const scopes = requiredScopeList(requiredScopes);
    const reasons = [...this.#configurationIssues];
    let now;
    try { now = this.#time(); } catch { reasons.push('YouTube authentication requires a valid clock.'); }
    if (this.#mode === 'access_token' && this.#staticExpiresAt !== null && this.#staticExpiresAt <= now + EXPIRY_SKEW_MS) {
      reasons.push('The configured YouTube access token is expired or too close to expiry; replace it or configure offline refresh credentials.');
    }
    if (this.#mode === 'refresh_token' && this.#refreshExpiresAt !== null && this.#refreshExpiresAt <= now + EXPIRY_SKEW_MS) {
      reasons.push('The YouTube refresh token is expired or too close to expiry; obtain new user consent.');
    }
    if (this.#terminalError) reasons.push(this.#terminalError.message);
    else if (this.#lastFailure && now < this.#lastFailure.retryAfter) reasons.push('YouTube OAuth refresh recently failed; no repeated request is made during the cooldown.');
    reasons.push(...scopeIssues(this.#cache?.scopes ?? null, scopes));
    return {
      ready: reasons.length === 0,
      mode: this.#mode,
      refreshable: this.#mode === 'refresh_token' && this.#configurationIssues.length === 0 && !this.#terminalError &&
        Number.isFinite(now) && (this.#refreshExpiresAt === null || this.#refreshExpiresAt > now + EXPIRY_SKEW_MS),
      scopesVerified: this.#cache?.scopes !== undefined && this.#cache?.scopes !== null,
      reasons,
    };
  }

  // JSON serialization is safe even if a caller accidentally returns the class.
  toJSON() {
    return this.readiness();
  }

  invalidate({ code = 'YOUTUBE_DISCONNECTED', message = 'YouTube access is disconnected; obtain fresh consent and restart the MCP.' } = {}) {
    this.#invalidated = true;
    this.#cache = null;
    this.#credentials = {};
    this.#terminalError = { code, message };
  }

  async getAccessToken({ requiredScopes = [], forceRefresh = false } = {}) {
    const scopes = requiredScopeList(requiredScopes);
    const readiness = this.readiness();
    if (!readiness.ready) {
      throw authError(this.#terminalError?.code ?? 'YOUTUBE_AUTH_NOT_READY', readiness.reasons.join(' '));
    }
    if (this.#mode === 'access_token') return this.#credentials.accessToken;
    const now = this.#time();
    if (!forceRefresh && this.#cache && now >= this.#cache.obtainedAt && now + EXPIRY_SKEW_MS < this.#cache.expiresAt) {
      const issues = scopeIssues(this.#cache.scopes, scopes);
      if (issues.length) throw authError('YOUTUBE_OAUTH_SCOPE_MISSING', issues.join(' '));
      return this.#cache.token;
    }
    if (!this.#inFlight) this.#inFlight = this.#refresh();
    const pending = this.#inFlight;
    let cache;
    try { cache = await pending; }
    finally { if (this.#inFlight === pending) this.#inFlight = null; }
    if (this.#invalidated) throw authError('YOUTUBE_DISCONNECTED', 'YouTube access was disconnected during OAuth refresh.');
    const issues = scopeIssues(cache.scopes, scopes);
    if (issues.length) throw authError('YOUTUBE_OAUTH_SCOPE_MISSING', issues.join(' '));
    return cache.token;
  }

  async #refresh() {
    const startedAt = this.#time();
    this.#cache = null;
    try {
      let response;
      try {
        response = await this.#fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: this.#credentials.refreshToken,
            client_id: this.#credentials.clientId,
            client_secret: this.#credentials.clientSecret,
          }).toString(),
        });
      } catch {
        throw authError('YOUTUBE_OAUTH_UNAVAILABLE', 'Google OAuth refresh failed or timed out; no automatic retry was made.');
      }
      let body;
      try { body = await response.json(); } catch { body = null; }
      if (!response?.ok) {
        if (body?.error === 'invalid_grant') {
          throw authError('YOUTUBE_OAUTH_REAUTH_REQUIRED', 'Google rejected the YouTube refresh grant; obtain new user consent and replace the refresh token.');
        }
        if (['invalid_client', 'unauthorized_client'].includes(body?.error)) {
          throw authError('YOUTUBE_OAUTH_CLIENT_REJECTED', 'Google rejected the OAuth client; check the configured client credentials.');
        }
        if (body?.error === 'invalid_scope') {
          throw authError('YOUTUBE_OAUTH_SCOPE_REJECTED', 'Google rejected the OAuth grant scopes; obtain consent for the required YouTube scopes.');
        }
        throw authError('YOUTUBE_OAUTH_UNAVAILABLE', 'Google did not confirm OAuth refresh; no automatic retry was made.');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !safeCredential(body.access_token) ||
          typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer' ||
          !Number.isSafeInteger(body.expires_in) || body.expires_in <= EXPIRY_SKEW_MS / 1000) {
        throw authError('YOUTUBE_OAUTH_RESPONSE_INVALID', 'Google returned an invalid or near-expiry OAuth access token.');
      }
      const expiresAt = startedAt + Math.min(body.expires_in * 1000, MAX_CACHE_MS);
      if (this.#time() + EXPIRY_SKEW_MS >= expiresAt) {
        throw authError('YOUTUBE_OAUTH_RESPONSE_INVALID', 'The refreshed YouTube access token is too close to expiry to use.');
      }
      const scopes = responseScopes(body.scope);
      if (body.refresh_token_expires_in !== undefined) {
        if (!Number.isSafeInteger(body.refresh_token_expires_in) || body.refresh_token_expires_in <= EXPIRY_SKEW_MS / 1000) {
          throw authError('YOUTUBE_OAUTH_REAUTH_REQUIRED', 'The YouTube refresh grant is expired or too close to expiry; obtain new user consent.');
        }
        const expires = startedAt + Math.min(body.refresh_token_expires_in * 1000, Number.MAX_SAFE_INTEGER - startedAt);
        this.#refreshExpiresAt = Math.min(this.#refreshExpiresAt ?? expires, expires);
      }
      if (this.#invalidated) throw authError('YOUTUBE_DISCONNECTED', 'YouTube access was disconnected during OAuth refresh.');
      this.#cache = { token: body.access_token, obtainedAt: startedAt, expiresAt, scopes };
      this.#lastFailure = null;
      return this.#cache;
    } catch (failure) {
      const error = failure instanceof YouTubeAuthError
        ? failure : authError('YOUTUBE_OAUTH_UNAVAILABLE', 'Google OAuth refresh failed; credentials and provider diagnostics are not logged.');
      if (['YOUTUBE_OAUTH_REAUTH_REQUIRED', 'YOUTUBE_OAUTH_CLIENT_REJECTED', 'YOUTUBE_OAUTH_SCOPE_REJECTED'].includes(error.code)) {
        this.#terminalError = { code: error.code, message: error.message };
      }
      if (error.code === 'YOUTUBE_OAUTH_REAUTH_REQUIRED') {
        try { await this.#onInvalidGrant?.(); } catch { /* The lifecycle remains blocked and reports cleanup failure separately. */ }
        this.invalidate({ code: error.code, message: error.message });
      }
      let failedAt = startedAt;
      try { failedAt = this.#time(); } catch { /* Keep the safe diagnostic from the refresh failure. */ }
      this.#lastFailure = { retryAfter: failedAt + FAILURE_COOLDOWN_MS };
      throw error;
    }
  }
}
