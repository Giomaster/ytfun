import { YouTubeAuth, YOUTUBE_READONLY_SCOPE } from './oauth.mjs';
import { assertYouTubeConnected, purgeYouTubeData, setYouTubeConnection, youtubeBlocked, youtubeConnection } from './youtube-data-policy.mjs';
import { withYouTubeGrantLock, YOUTUBE_GRANT_KEYS } from './private-env.mjs';

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DAY_MS = 86_400_000;
const GOOGLE_HOSTS = new Set(['www.googleapis.com', 'youtube.googleapis.com', 'youtubeanalytics.googleapis.com', 'oauth2.googleapis.com']);

/** One personal account, one shared OAuth cache and a persistent disconnect barrier. */
export class YouTubeDataLifecycle {
  #env;
  #fetch;
  #now;
  #blocked = false;
  #abort = new AbortController();
  #timer;
  #ticking = false;
  #lastAuthorizationCheck = null;
  #automaticDisconnecting;
  #explicitDisconnecting;
  #grantId;
  #channelId;
  #oauthConfigured;

  constructor(store, { env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
    this.store = store;
    this.#env = env;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#grantId = env.YTFUN_YOUTUBE_GRANT_ID || 'legacy';
    this.#channelId = env.YOUTUBE_CHANNEL_ID;
    this.#oauthConfigured = ['YOUTUBE_ACCESS_TOKEN', 'YOUTUBE_REFRESH_TOKEN', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'].some(key => Boolean(env[key]));
    this.fetch = this.#guardedFetch.bind(this);
    this.auth = new YouTubeAuth({ env, fetchImpl: this.fetch, now, requireGrantId: true, onInvalidGrant: () => this.authorizationLost() });
  }

  toJSON() { return { auth: this.auth.readiness(), blockedInProcess: this.#blocked }; }

  async assertConnected() {
    if (this.#blocked) throw new Error('YouTube is disconnected in this MCP process.');
    if (this.#oauthConfigured && this.#grantId === 'legacy') throw new Error('Configure a unique YTFUN_YOUTUBE_GRANT_ID for this consent before using the personal MCP.');
    assertYouTubeConnected(await this.store.read(), { YTFUN_YOUTUBE_GRANT_ID: this.#grantId });
  }

  async #guardedFetch(input, options = {}) {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!GOOGLE_HOSTS.has(url.hostname)) return this.#fetch(input, options);
    await this.assertConnected();
    const signal = options.signal ? AbortSignal.any([options.signal, this.#abort.signal]) : this.#abort.signal;
    const response = await this.#fetch(input, { ...options, signal });
    if (response.status === 401 && new Headers(options.headers).has('authorization')) await this.authorizationLost();
    return response;
  }

  async maintenance({ execute = false } = {}) {
    if (typeof execute !== 'boolean') throw new Error('execute must be a boolean.');
    const now = this.#now();
    if (!execute) {
      const state = await this.store.read();
      return { execute: false, retentionDays: 30, expired: purgeYouTubeData(state, { now }), preservesOriginalMedia: true, preservesLocalUploadBlocks: true };
    }
    return this.store.transaction(state => ({ execute: true, retentionDays: 30, removed: purgeYouTubeData(state, { now }) }));
  }

  async maintain() {
    // Local expiry precedes every MCP response; no provider request is made here.
    const state = await this.store.read();
    if (youtubeBlocked(state, { YTFUN_YOUTUBE_GRANT_ID: this.#grantId })) this.#invalidate();
    const options = { now: this.#now() };
    const purge = current => {
      const expired = purgeYouTubeData(current, options);
      const own = this.#blocked && this.#grantId !== 'legacy' ? purgeYouTubeData(current, { ...options, all: true, grantId: this.#grantId }) : {};
      return Object.fromEntries(Object.keys(expired).map(key => [key, expired[key] + (own[key] ?? 0)]));
    };
    const preview = purge(state);
    if (Object.values(preview).some(count => count > 0)) await this.store.transaction(purge);
  }

  #invalidate() {
    this.#blocked = true;
    this.#abort.abort();
    this.auth.invalidate();
  }

  async disconnect({ execute = false, expectedChannelId } = {}) {
    if (typeof execute !== 'boolean') throw new Error('execute must be a boolean.');
    const state = await this.store.read();
    const removed = purgeYouTubeData(structuredClone(state), { now: this.#now(), all: true, grantId: this.#grantId });
    const reasons = [];
    if (!this.#env.YTFUN_PRIVATE_ENV_FILE?.startsWith('/')) reasons.push('Configure YTFUN_PRIVATE_ENV_FILE as an absolute private 0600 environment path outside Git.');
    if (this.#oauthConfigured && this.#grantId === 'legacy') reasons.push('Configure a unique YTFUN_YOUTUBE_GRANT_ID before disconnecting this grant.');
    if (!this.#env.YOUTUBE_CHANNEL_ID && !youtubeBlocked(state, { YTFUN_YOUTUBE_GRANT_ID: this.#grantId })) reasons.push('No personal YouTube channel is configured.');
    const preview = { execute: false, ready: reasons.length === 0, reasons, removes: removed,
      effects: ['Stops YouTube operations and aborts in-flight Google requests.', 'Revokes all OAuth scopes granted to this Google project, across its OAuth clients.', 'Removes user tokens/channel binding and stored YouTube data; keeps original media and local upload blocks.', 'Does not delete videos stored on YouTube.'],
      manualScope: ['Other backups or copied state files', 'AI host conversations and transcripts'] };
    if (!execute) return preview;
    if (reasons.length) throw new Error(reasons.join(' '));
    if (typeof expectedChannelId !== 'string' || !expectedChannelId || (this.#channelId && expectedChannelId !== this.#channelId)) throw new Error('Confirm the exact configured YouTube channel with expectedChannelId.');
    if (this.#explicitDisconnecting) return this.#explicitDisconnecting;
    const previous = youtubeConnection(state, { YTFUN_YOUTUBE_GRANT_ID: this.#grantId });
    const automatic = this.#automaticDisconnecting ?? (previous?.reason === 'authorization_invalid' ? Promise.resolve(previous) : null);
    const pending = automatic ? this.#finishExplicitAfterAutomatic(automatic) : this.#performDisconnect({ expectedChannelId, revoke: true, all: true });
    this.#explicitDisconnecting = pending;
    try { return await pending; } finally { if (this.#explicitDisconnecting === pending) this.#explicitDisconnecting = null; }
  }

  async authorizationLost() {
    if (this.#explicitDisconnecting) return this.#explicitDisconnecting;
    if (this.#automaticDisconnecting) return this.#automaticDisconnecting;
    if (this.#blocked) return;
    // invalid_grant/401 can also mean expiry. Do not assert external revocation.
    const pending = this.#performDisconnect({ expectedChannelId: this.#channelId, revoke: false, all: false });
    this.#automaticDisconnecting = pending;
    try { return await pending; } finally { if (this.#automaticDisconnecting === pending) this.#automaticDisconnecting = null; }
  }

  async #performDisconnect({ expectedChannelId, revoke, all }) {
    const token = this.#env.YOUTUBE_REFRESH_TOKEN || this.#env.YOUTUBE_ACCESS_TOKEN;
    const privatePath = this.#env.YTFUN_PRIVATE_ENV_FILE;
    const expected = { expectedChannelId, expectedToken: token, expectedGrantId: this.#grantId };
    if (!revoke) this.#invalidate();
    try { return await withYouTubeGrantLock(privatePath, expected, ({ cleanup }) => this.#disconnectSteps({ token, revoke, all, cleanup })); }
    catch (error) {
      if (revoke) throw error;
      const connection = { blocked: true, grantId: this.#grantId, blockedAt: new Date(this.#now()).toISOString(), reason: 'authorization_invalid',
        revocation: { status: 'not_requested' }, environmentCleanup: { confirmed: false }, grantValidationConfirmed: false };
      let barrierConfirmed = false;
      try { await this.store.transaction(state => { setYouTubeConnection(state, connection); }); barrierConfirmed = true; } catch { /* Truthful partial result. */ }
      this.#clearRuntimeGrant();
      return { execute: true, mode: 'automatic', blocked: true, complete: false, barrierConfirmed, revocation: connection.revocation,
        environmentCleanup: connection.environmentCleanup, storeCleanup: { confirmed: false }, actionRequired: 'The current private grant could not be verified. Inspect the grant generation and private file; no other grant was purged or revoked.' };
    }
  }

  async #finishExplicitAfterAutomatic(automatic) {
    let previous;
    try { previous = await automatic; } catch { /* Cleanup failure is not revocation confirmation. */ }
    this.#invalidate();
    const revocation = previous?.revocation ?? { status: 'unavailable' };
    const environmentCleanup = previous?.environmentCleanup ?? { confirmed: false };
    let storeCleanup = { confirmed: false };
    try {
      const removed = await this.store.transaction(state => {
        const old = youtubeConnection(state, { YTFUN_YOUTUBE_GRANT_ID: this.#grantId });
        const counts = purgeYouTubeData(state, { now: this.#now(), all: true, grantId: this.#grantId });
        setYouTubeConnection(state, { blocked: true, grantId: this.#grantId, blockedAt: old?.blockedAt ?? new Date(this.#now()).toISOString(),
          reason: 'user_disconnect', revocation, environmentCleanup, updatedAt: new Date(this.#now()).toISOString() });
        return counts;
      });
      storeCleanup = { confirmed: true, removed };
    } catch { /* Do not claim deletion or replay a POST after partial automatic cleanup. */ }
    this.#clearRuntimeGrant();
    return { execute: true, mode: 'explicit', blocked: true, complete: revocation.status === 'confirmed' && environmentCleanup.confirmed && storeCleanup.confirmed,
      revocation, environmentCleanup, storeCleanup, actionRequired: 'Remove this project in Google Account third-party connections: automatic authorization cleanup did not confirm revocation. Inspect any unconfirmed private environment/store cleanup; no POST was replayed.',
      manualScope: ['Delete backups/copied state and AI host transcripts separately.', 'Existing YouTube videos remain on YouTube.'] };
  }

  #clearRuntimeGrant() {
    for (const key of YOUTUBE_GRANT_KEYS) delete this.#env[key];
    this.#env.YTFUN_YOUTUBE_PUBLIC_ENABLED = 'false';
    this.#env.YTFUN_YOUTUBE_AUDIT_CONFIRMED = 'false';
  }

  async #disconnectSteps({ token, revoke, all, cleanup }) {
    this.#invalidate();
    const blockedAt = new Date(this.#now()).toISOString();
    let previous, initiallyRemoved;
    try {
      await this.store.transaction(state => {
        previous = youtubeBlocked(state, { YTFUN_YOUTUBE_GRANT_ID: this.#grantId }) ? youtubeConnection(state, { YTFUN_YOUTUBE_GRANT_ID: this.#grantId }) : null;
        setYouTubeConnection(state, previous ?? { blocked: true, grantId: this.#grantId, blockedAt, grantValidationConfirmed: true,
          reason: revoke ? 'user_disconnect' : 'authorization_invalid', revocation: { status: revoke ? 'unknown' : 'not_requested' } });
        initiallyRemoved = purgeYouTubeData(state, { now: this.#now(), all: true, authorizedOnly: !all, ...(!all ? { grantId: this.#grantId } : {}) });
      });
    } catch {
      throw new Error('YouTube is blocked in this process, but persistent data cleanup was not confirmed. Keep the MCP stopped and inspect its private store. No revocation request was made.');
    }
    let revocation = previous?.revocation ?? { status: revoke ? 'unknown' : 'not_requested' };
    // Persist the attempt before its POST. Interrupted/ambiguous requests are never replayed.
    if (revoke && !previous && token) {
      try {
        const response = await this.#fetch(REVOKE_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() });
        revocation = { status: response.status === 200 ? 'confirmed' : 'rejected', httpStatus: response.status };
        await response.body?.cancel().catch(() => {});
      } catch { revocation = { status: 'unknown' }; }
    } else if (revoke && !previous) revocation = { status: 'unavailable' };
    let environmentCleanup = { confirmed: false };
    try { environmentCleanup = await cleanup(); }
    catch { /* Safe, explicit partial result; never log the path or file values. */ }
    this.#clearRuntimeGrant();
    let storeCleanup = { confirmed: false };
    try {
      const removed = await this.store.transaction(state => {
        const counts = purgeYouTubeData(state, { now: this.#now(), all: true, authorizedOnly: !all, ...(!all ? { grantId: this.#grantId } : {}) });
        setYouTubeConnection(state, { blocked: true, grantId: this.#grantId, blockedAt: previous?.blockedAt ?? blockedAt, grantValidationConfirmed: true,
          reason: revoke ? 'user_disconnect' : 'authorization_invalid', revocation, environmentCleanup, updatedAt: new Date(this.#now()).toISOString() });
        return counts;
      });
      storeCleanup = { confirmed: true, removed: Object.fromEntries(Object.keys(removed).map(key => [key, removed[key] + initiallyRemoved[key]])) };
    } catch { /* Initial persistent barrier remains, with unknown revocation status. */ }
    return { execute: true, mode: revoke ? 'explicit' : 'automatic', blocked: true, revocation, environmentCleanup, storeCleanup,
      complete: (!revoke || revocation.status === 'confirmed') && environmentCleanup.confirmed && storeCleanup.confirmed,
      ...(!(revocation.status === 'confirmed') && revoke ? { actionRequired: 'Remove this project in Google Account third-party connections; the API revocation is not confirmed. No POST will be retried automatically.' } : {}),
      manualScope: ['Delete other backups/copied state and AI host transcripts separately.', 'Existing YouTube videos remain on YouTube.'] };
  }

  async tick() {
    await this.maintain();
    const readiness = this.auth.readiness();
    if (!this.#blocked && readiness.reasons.some(reason => /token is expired/.test(reason))) await this.authorizationLost();
    if (this.#blocked || !readiness.ready || !this.#env.YOUTUBE_CHANNEL_ID) return;
    const now = this.#now();
    if (this.#lastAuthorizationCheck !== null && now - this.#lastAuthorizationCheck < DAY_MS) return;
    this.#lastAuthorizationCheck = now;
    try {
      const token = await this.auth.getAccessToken({ requiredScopes: [YOUTUBE_READONLY_SCOPE], forceRefresh: true });
      const response = await this.fetch('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      // A 401 is handled by the transport; quota/permission/transient errors do not
      // establish revocation. Retention cleanup still runs independently.
      await response.body?.cancel().catch(() => {});
    } catch { /* No immediate retry, credential diagnostics or fabricated verification. */ }
  }

  start({ intervalMs = 60_000 } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new Error('YouTube maintenance requires a valid interval.');
    if (this.#timer) return;
    this.#timer = setInterval(async () => {
      if (this.#ticking) return;
      this.#ticking = true;
      try { await this.tick(); } catch { /* Failed cleanup is retried locally on the next tick/response, not remotely. */ }
      finally { this.#ticking = false; }
    }, intervalMs);
    this.#timer.unref?.();
  }

  stop() { clearInterval(this.#timer); this.#timer = null; }
}
