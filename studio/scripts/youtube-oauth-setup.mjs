#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { OAuth2Client } from 'google-auth-library';
import { YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE } from '../src/oauth.mjs';

const SCOPES = [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE];
const MAX_WAIT_MS = 10 * 60_000;
const MAX_FILE_BYTES = 65_536;
const CHANNEL_URL = 'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true&maxResults=50';
const CREDENTIAL = /^[A-Za-z0-9._~+/:=-]{1,16384}$/;
function credential(value) { return typeof value === 'string' && CREDENTIAL.test(value); }

class SetupError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function fail(code, message) { return new SetupError(code, message); }
function safeFailure(error) {
  return error instanceof SetupError ? error : fail('OAUTH_SETUP_FAILED', 'YouTube OAuth setup failed; provider diagnostics and credentials are not printed.');
}

async function privateFile(filename) {
  let handle;
  try {
    const canonical = path.join(await realpath(path.dirname(path.resolve(filename))), path.basename(filename));
    handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES || (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      throw fail('OAUTH_FILE_UNSAFE', 'OAuth setup requires private regular files owned by this user, with mode 0600 and no links.');
    }
    return { filename: canonical, text: await handle.readFile('utf8'), inode: info.ino, device: info.dev };
  } catch (error) {
    throw error instanceof SetupError ? error : fail('OAUTH_FILE_UNAVAILABLE', 'Could not read the private OAuth client or environment file.');
  } finally { await handle?.close(); }
}

function envLines(text) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw fail('OAUTH_ENV_INVALID', 'OAuth setup requires a .env file containing single-line assignments.');
    const value = match[2].trim();
    if (/^["']/.test(value)) {
      const end = value.lastIndexOf(value[0]);
      if (end === 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) {
        throw fail('OAUTH_ENV_INVALID', 'OAuth setup does not rewrite multiline environment values.');
      }
    }
  }
  return lines;
}

function environment(text) {
  envLines(text);
  try { return parseEnv(text); } catch { throw fail('OAUTH_ENV_INVALID', 'Could not parse the private environment file.'); }
}

export async function persistGrant(envFile, expectedChannelId, client, tokens, { signal, now = Date.now } = {}) {
  let lock, temporary;
  const lockFile = `${path.resolve(envFile)}.oauth.lock`;
  try {
    try { lock = await open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
    catch { throw fail('OAUTH_ENV_BUSY', 'The environment file is being updated by another OAuth setup; no changes were written.'); }
    const before = await privateFile(envFile);
    if (environment(before.text).YOUTUBE_CHANNEL_ID !== expectedChannelId) {
      throw fail('OAUTH_CHANNEL_CHANGED', 'The configured YouTube channel changed during consent; start setup again.');
    }
    const values = {
      YOUTUBE_CLIENT_ID: client.client_id, YOUTUBE_CLIENT_SECRET: client.client_secret,
      YOUTUBE_REFRESH_TOKEN: tokens.refresh_token,
      YTFUN_YOUTUBE_PUBLIC_ENABLED: 'false', YTFUN_YOUTUBE_AUDIT_CONFIRMED: 'false',
    };
    for (const value of Object.values(values)) {
      if (!credential(value)) throw fail('OAUTH_GRANT_INVALID', 'OAuth credentials cannot be safely stored in this environment file.');
    }
    if (tokens.refresh_token_expires_in !== undefined) {
      if (!Number.isSafeInteger(tokens.refresh_token_expires_in) || tokens.refresh_token_expires_in <= 60 || tokens.refresh_token_expires_in > 31_536_000) {
        throw fail('OAUTH_GRANT_INVALID', 'Google returned an invalid refresh-grant expiry.');
      }
      values.YOUTUBE_REFRESH_TOKEN_EXPIRES_AT = new Date(now() + tokens.refresh_token_expires_in * 1000).toISOString();
    }
    const replaced = new Set([...Object.keys(values), 'YOUTUBE_ACCESS_TOKEN', 'YOUTUBE_ACCESS_TOKEN_EXPIRES_AT', 'YOUTUBE_REFRESH_TOKEN_EXPIRES_AT']);
    const retained = envLines(before.text).filter(line => !replaced.has(line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]));
    const ending = before.text.includes('\r\n') ? '\r\n' : '\n';
    const content = [...retained, ...Object.entries(values).map(([key, value]) => `${key}=${value}`), ''].join(ending);
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw fail('OAUTH_ENV_INVALID', 'The updated environment file exceeds the size limit.');
    const temporaryName = `${before.filename}.oauth-${randomBytes(12).toString('hex')}.tmp`;
    const output = await open(temporaryName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    temporary = temporaryName;
    try { await output.writeFile(content); await output.sync(); } finally { await output.close(); }
    const current = await privateFile(envFile);
    if (current.text !== before.text || current.inode !== before.inode || current.device !== before.device || signal?.aborted) {
      throw fail('OAUTH_ENV_CHANGED', 'OAuth setup stopped because the environment changed or consent timed out; no grant was written.');
    }
    await rename(temporary, before.filename);
    temporary = null;
    const directory = await open(path.dirname(before.filename), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { throw safeFailure(error); }
  finally {
    if (temporary) await unlink(temporary).catch(() => {});
    if (lock) { await lock.close(); await unlink(lockFile).catch(() => {}); }
  }
}

export function createDesktopOAuth(client, redirectUri, signal) {
  const oauth = new OAuth2Client({ clientId: client.client_id, clientSecret: client.client_secret, redirectUri,
    useAuthRequestParameters: false,
    transporterOptions: { timeout: 30_000, maxRedirects: 0, retry: false },
  });
  // The SDK otherwise enables POST retries and optional raw OAuth logging.
  oauth.transporter.interceptors.request.add({ resolved: async options => {
    if (new URL(options.url).href !== 'https://oauth2.googleapis.com/token') {
      throw fail('OAUTH_ENDPOINT_INVALID', 'The OAuth token endpoint is outside the Google allowlist.');
    }
    return { ...options, retry: false, retryConfig: { retry: 0 }, redirect: 'error', follow: 0,
      maxRedirects: 0, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) };
  } });
  return oauth;
}

export function callbackResponse(request, origin, expectedState) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(expectedState) || request.method !== 'GET' || request.headers?.host !== new URL(origin).host ||
      !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress) ||
      typeof request.url !== 'string' || request.url.length > 8192 || !request.url.startsWith('/oauth2callback?')) return null;
  let url;
  try { url = new URL(request.url, origin); } catch { return null; }
  if (url.origin !== origin || url.pathname !== '/oauth2callback' || url.hash) return null;
  const entries = [...url.searchParams];
  if (entries.length > 12 || entries.some(([key, value]) => key.length > 64 || value.length > 4096) ||
      new Set(entries.map(([key]) => key)).size !== entries.length) return null;
  const state = url.searchParams.get('state') ?? '';
  if (Buffer.byteLength(state) !== Buffer.byteLength(expectedState) || !timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) return null;
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (error && !code) return { denied: true };
  if (!error && typeof code === 'string' && code.length <= 4096 && credential(code)) return { code };
  return null;
}

export async function setupYouTubeOAuth({ clientPath, envFilePath }, {
  oauthFactory = createDesktopOAuth, fetchImpl = fetch, onAuthorizationUrl = url => process.stdout.write(`${url}\n`),
  timeoutMs = MAX_WAIT_MS, signal, now = Date.now,
} = {}) {
  let server, timer;
  const abort = new AbortController();
  const operationSignal = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) throw fail('OAUTH_TIMEOUT_INVALID', 'OAuth setup cannot wait longer than ten minutes.');
    const clientFile = await privateFile(clientPath);
    let client;
    try { client = JSON.parse(clientFile.text).installed; } catch { /* Fixed error below. */ }
    if (!client || !credential(client.client_id) || !credential(client.client_secret)) {
      throw fail('OAUTH_CLIENT_INVALID', 'Use a Google OAuth Desktop client file with installed client credentials.');
    }
    const envFile = await privateFile(envFilePath);
    const channelId = environment(envFile.text).YOUTUBE_CHANNEL_ID;
    if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId ?? '')) throw fail('OAUTH_CHANNEL_INVALID', 'Configure the intended YOUTUBE_CHANNEL_ID in the private environment file first.');
    let finish, reject, consumed = false, origin, oauth, verifier;
    const completion = new Promise((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise; });
    // Startup failures can happen before the caller awaits completion.
    completion.catch(() => {});
    server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'");
      const callback = callbackResponse(request, origin, verifier?.state ?? '');
      if (!callback) { response.writeHead(400); response.end('Invalid OAuth callback. Return to the consent page.'); return; }
      if (consumed) { response.writeHead(409); response.end('This OAuth callback has already been used.'); return; }
      consumed = true;
      try {
        if (callback.denied) throw fail('OAUTH_CONSENT_DENIED', 'Google consent was denied; no grant was stored.');
        const { tokens } = await oauth.getToken({ code: callback.code, codeVerifier: verifier.codeVerifier, redirect_uri: `${origin}/oauth2callback` });
        const granted = new Set(typeof tokens?.scope === 'string' ? tokens.scope.split(/ +/) : []);
        if (!credential(tokens?.access_token) || !credential(tokens?.refresh_token) ||
            typeof tokens?.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer' ||
            !Number.isFinite(tokens.expiry_date) || tokens.expiry_date <= now() + 60_000 || SCOPES.some(scope => !granted.has(scope))) {
          throw fail('OAUTH_GRANT_INVALID', 'Google did not return a usable offline grant with YouTube upload and readonly scopes; no credentials were stored.');
        }
        const channelResponse = await fetchImpl(CHANNEL_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` },
          redirect: 'error', signal: AbortSignal.any([operationSignal, AbortSignal.timeout(30_000)]) });
        let channels;
        try { channels = await channelResponse.json(); } catch { /* Ownership remains unconfirmed. */ }
        if (!channelResponse.ok || !Array.isArray(channels?.items) || !channels.items.some(item => item.id === channelId)) {
          throw fail('OAUTH_CHANNEL_MISMATCH', 'The authorized YouTube channel does not match the configured channel; no credentials were stored.');
        }
        if (operationSignal.aborted) throw fail('OAUTH_SETUP_CANCELLED', 'OAuth setup was cancelled or timed out; no grant was stored.');
        await persistGrant(envFilePath, channelId, client, tokens, { signal: operationSignal, now });
        response.end('AI Meow YouTube authorization saved. Close this tab and return to the app.');
        finish({ channelId, refreshTokenStored: true });
      } catch (error) {
        response.writeHead(400); response.end('YouTube authorization was not saved. Return to the app for the next step.');
        reject(safeFailure(error));
      }
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    server.keepAliveTimeout = 1000;
    server.maxRequestsPerSocket = 1;
    await new Promise((resolve, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    oauth = oauthFactory(client, `${origin}/oauth2callback`, operationSignal);
    const pkce = await oauth.generateCodeVerifierAsync();
    verifier = { ...pkce, state: randomBytes(32).toString('base64url') };
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier.codeVerifier ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(verifier.codeChallenge ?? '')) {
      throw fail('OAUTH_PKCE_INVALID', 'Could not generate a valid OAuth PKCE challenge.');
    }
    const cancel = () => { reject(fail('OAUTH_SETUP_CANCELLED', 'OAuth consent timed out or was cancelled; start setup again.')); server.closeAllConnections(); };
    operationSignal.addEventListener('abort', cancel, { once: true });
    completion.finally(() => operationSignal.removeEventListener('abort', cancel)).catch(() => {});
    timer = setTimeout(() => abort.abort(), timeoutMs);
    if (operationSignal.aborted) cancel();
    else {
      const authorizationUrl = new URL(oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent select_account',
        scope: SCOPES, include_granted_scopes: false, state: verifier.state,
        code_challenge_method: 'S256', code_challenge: verifier.codeChallenge }));
      if (authorizationUrl.origin !== 'https://accounts.google.com' || authorizationUrl.pathname !== '/o/oauth2/v2/auth') {
        throw fail('OAUTH_ENDPOINT_INVALID', 'The consent endpoint is outside the Google allowlist.');
      }
      await onAuthorizationUrl(authorizationUrl.href);
    }
    return await completion;
  } catch (error) { throw safeFailure(error); }
  finally {
    clearTimeout(timer);
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    abort.abort();
  }
}

export function setupArguments(args) {
  let parsed;
  try { parsed = parseArgs({ args, options: { client: { type: 'string' }, 'env-file': { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: false, strict: true, tokens: true }); }
  catch { throw fail('OAUTH_ARGUMENTS_INVALID', 'Use --client <private Desktop client JSON> and --env-file <private existing .env>. Never pass credentials as arguments.'); }
  if (parsed.values.help) return { help: true };
  if (!parsed.values.client || !parsed.values['env-file'] || ['client', 'env-file'].some(name => parsed.tokens.filter(token => token.kind === 'option' && token.name === name).length !== 1)) {
    throw fail('OAUTH_ARGUMENTS_INVALID', 'Both --client and --env-file paths are required.');
  }
  return { clientPath: parsed.values.client, envFilePath: parsed.values['env-file'] };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const cancel = new AbortController();
  const stop = () => cancel.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const args = setupArguments(process.argv.slice(2));
    if (args.help) process.stdout.write('Usage: node scripts/youtube-oauth-setup.mjs --client <private Desktop client JSON> --env-file <private existing .env>\n');
    else {
      process.stdout.write('Open the following Google consent URL in the intended Chrome profile. Confirm the channel and the two YouTube permissions yourself.\n');
      const result = await setupYouTubeOAuth(args, { signal: cancel.signal });
      process.stdout.write(`YouTube offline authorization saved for channel ${result.channelId}. Public publishing and API audit flags remain disabled.\n`);
    }
  } catch (error) { process.stderr.write(`${safeFailure(error).message}\n`); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
