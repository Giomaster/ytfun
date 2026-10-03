import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { callbackResponse, createDesktopOAuth, persistGrant, setupArguments, setupYouTubeOAuth } from '../scripts/youtube-oauth-setup.mjs';
import { YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE } from '../src/oauth.mjs';

const CHANNEL = 'UCjwAEFZPOQ6FIfweosLmCTg';
const OTHER = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CLIENT = { client_id: 'fixture.apps.googleusercontent.com', client_secret: 'fixture-client-secret' };
const CODE = '4/fixture-private-code';
const ACCESS = 'fixture-access-secret';
const REFRESH = '1//fixture-refresh-secret';

function grant(overrides = {}) {
  return { access_token: ACCESS, refresh_token: REFRESH, token_type: 'Bearer', expiry_date: Date.now() + 3_600_000,
    scope: `${YOUTUBE_UPLOAD_SCOPE} ${YOUTUBE_READONLY_SCOPE}`, ...overrides };
}

function noSecrets(value) {
  for (const secret of [CLIENT.client_secret, CODE, ACCESS, REFRESH]) assert.equal(String(value).includes(secret), false);
}

async function fixture(t, text = `# Keep cadence configuration\nYOUTUBE_CHANNEL_ID=${CHANNEL}\nYTFUN_MAX_UPLOAD_BYTES=262144000\nCUSTOM_PATH="/private/path with spaces"\nYTFUN_YOUTUBE_PUBLIC_ENABLED=false\nYTFUN_YOUTUBE_AUDIT_CONFIRMED=false\n`) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ytfun-oauth-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clientPath = path.join(directory, 'google-client.json');
  const envFilePath = path.join(directory, 'ytfun.env');
  await writeFile(clientPath, JSON.stringify({ installed: CLIENT }), { mode: 0o600 });
  await writeFile(envFilePath, text, { mode: 0o600 });
  return { directory, clientPath, envFilePath, original: text };
}

function oauthFactory(onToken = async () => ({ tokens: grant() })) {
  return (client, redirectUri, signal) => {
    const oauth = createDesktopOAuth(client, redirectUri, signal);
    oauth.getToken = onToken;
    return oauth;
  };
}

function callbackUrl(authorizationUrl, params = {}) {
  const consent = new URL(authorizationUrl);
  const callback = new URL(consent.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ code: CODE, state: consent.searchParams.get('state'), ...params }).toString();
  return callback;
}

test('Desktop consent uses state plus PKCE and stores refresh only after owned-channel verification', async t => {
  const f = await fixture(t);
  let consent, exchanged, verified = false;
  const result = await setupYouTubeOAuth(f, {
    oauthFactory: oauthFactory(async options => { exchanged = options; return { tokens: grant() }; }),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true&maxResults=50');
      assert.equal(options.headers.Authorization, `Bearer ${ACCESS}`);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(await readFile(f.envFilePath, 'utf8'), f.original);
      verified = true;
      return Response.json({ items: [{ id: CHANNEL }] });
    },
    onAuthorizationUrl: async url => {
      consent = new URL(url);
      const response = await fetch(callbackUrl(url));
      assert.equal(response.status, 200);
      noSecrets(await response.text());
    },
  });
  assert.deepEqual(result, { channelId: CHANNEL, refreshTokenStored: true });
  assert.equal(verified, true);
  assert.equal(consent.origin, 'https://accounts.google.com');
  assert.equal(consent.searchParams.get('access_type'), 'offline');
  assert.equal(consent.searchParams.get('prompt'), 'consent select_account');
  assert.equal(consent.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(consent.searchParams.get('scope'), `${YOUTUBE_UPLOAD_SCOPE} ${YOUTUBE_READONLY_SCOPE}`);
  assert.equal(consent.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(consent.searchParams.get('code_challenge'), createHash('sha256').update(exchanged.codeVerifier).digest('base64url'));
  assert.equal(exchanged.code, CODE);
  assert.match(consent.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(exchanged.redirect_uri, consent.searchParams.get('redirect_uri'));
  noSecrets(consent.href);
  noSecrets(JSON.stringify(result));
  const saved = parseEnv(await readFile(f.envFilePath, 'utf8'));
  assert.equal(saved.YOUTUBE_REFRESH_TOKEN, REFRESH);
  assert.equal(saved.YOUTUBE_CLIENT_ID, CLIENT.client_id);
  assert.equal(saved.YOUTUBE_CLIENT_SECRET, CLIENT.client_secret);
  assert.equal(saved.CUSTOM_PATH, '/private/path with spaces');
  assert.equal(saved.YTFUN_MAX_UPLOAD_BYTES, '262144000');
  assert.equal(saved.YTFUN_YOUTUBE_PUBLIC_ENABLED, 'false');
  assert.equal(saved.YTFUN_YOUTUBE_AUDIT_CONFIRMED, 'false');
  assert.equal((await stat(f.envFilePath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(f.directory)).sort(), ['google-client.json', 'ytfun.env']);
});

test('official SDK exchange disables raw auth interceptors, redirects and retries', async () => {
  const oauth = createDesktopOAuth(CLIENT, 'http://127.0.0.1:1234/oauth2callback', new AbortController().signal);
  assert.equal(oauth.transporter.interceptors.response.size, 0);
  let calls = 0;
  oauth.transporter.defaults.fetchImplementation = async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    assert.equal(options.redirect, 'error');
    assert.equal(options.retry, false);
    assert.equal(options.follow, 0);
    assert.equal(options.retryConfig.retry, 0);
    return Response.json({ error: 'temporarily_unavailable', error_description: REFRESH }, { status: 503 });
  };
  await assert.rejects(oauth.getToken({ code: CODE, codeVerifier: 'a'.repeat(64) }));
  assert.equal(calls, 1);
});

test('wrong state cannot consume the real callback or leak its code into the response', async t => {
  const f = await fixture(t);
  let exchanges = 0;
  await setupYouTubeOAuth(f, {
    oauthFactory: oauthFactory(async () => { exchanges++; return { tokens: grant() }; }),
    fetchImpl: async () => Response.json({ items: [{ id: CHANNEL }] }),
    onAuthorizationUrl: async url => {
      const invalid = await fetch(callbackUrl(url, { state: 'x'.repeat(43) }));
      assert.equal(invalid.status, 400);
      noSecrets(await invalid.text());
      const valid = await fetch(callbackUrl(url));
      assert.equal(valid.status, 200);
    },
  });
  assert.equal(exchanges, 1);
});

test('simultaneous callbacks exchange the authorization code exactly once', async t => {
  const f = await fixture(t);
  let entered, release, exchanges = 0;
  const tokenStarted = new Promise(resolve => { entered = resolve; });
  const tokenRelease = new Promise(resolve => { release = resolve; });
  await setupYouTubeOAuth(f, {
    oauthFactory: oauthFactory(async () => { exchanges++; entered(); await tokenRelease; return { tokens: grant() }; }),
    fetchImpl: async () => Response.json({ items: [{ id: CHANNEL }] }),
    onAuthorizationUrl: async url => {
      const first = fetch(callbackUrl(url));
      await tokenStarted;
      const duplicate = await fetch(callbackUrl(url));
      assert.equal(duplicate.status, 409);
      release();
      assert.equal((await first).status, 200);
    },
  });
  assert.equal(exchanges, 1);
});

test('a different authorized channel leaves the private environment unchanged', async t => {
  const f = await fixture(t);
  await assert.rejects(setupYouTubeOAuth(f, {
    oauthFactory: oauthFactory(), fetchImpl: async () => Response.json({ items: [{ id: OTHER }] }),
    onAuthorizationUrl: async url => { assert.equal((await fetch(callbackUrl(url))).status, 400); },
  }), error => error.code === 'OAUTH_CHANNEL_MISMATCH');
  assert.equal(await readFile(f.envFilePath, 'utf8'), f.original);
});

test('missing refresh, readonly consent or usable token lifetime blocks before channel verification', async t => {
  for (const tokens of [grant({ refresh_token: undefined }), grant({ scope: YOUTUBE_UPLOAD_SCOPE }),
    grant({ expiry_date: Date.now() + 10_000 }), grant({ token_type: 'MAC' }), grant({ access_token: 42 })]) {
    const f = await fixture(t);
    await assert.rejects(setupYouTubeOAuth(f, {
      oauthFactory: oauthFactory(async () => ({ tokens })),
      fetchImpl: async () => { throw new Error('Channel verification must not run'); },
      onAuthorizationUrl: async url => { assert.equal((await fetch(callbackUrl(url))).status, 400); },
    }), error => error.code === 'OAUTH_GRANT_INVALID');
    assert.equal(await readFile(f.envFilePath, 'utf8'), f.original);
  }
});

test('denied consent and raw SDK errors do not change the file or propagate credentials', async t => {
  for (const denied of [true, false]) {
    const f = await fixture(t);
    await assert.rejects(setupYouTubeOAuth(f, {
      oauthFactory: oauthFactory(async () => { throw new Error(`${CODE} ${CLIENT.client_secret} ${REFRESH}`); }),
      fetchImpl: async () => { throw new Error('Unexpected request'); },
      onAuthorizationUrl: async url => {
        const callback = callbackUrl(url);
        if (denied) { callback.searchParams.delete('code'); callback.searchParams.set('error', 'access_denied'); callback.searchParams.set('error_description', REFRESH); }
        const response = await fetch(callback);
        assert.equal(response.status, 400);
        noSecrets(await response.text());
      },
    }), error => { noSecrets(error.message); assert.equal(error.cause, undefined); return true; });
    assert.equal(await readFile(f.envFilePath, 'utf8'), f.original);
  }
});

test('callback validation rejects host/path/method/remote/duplicate/oversize inputs without interpreting descriptions', () => {
  const origin = 'http://127.0.0.1:1234';
  const state = 's'.repeat(43);
  const valid = { method: 'GET', headers: { host: '127.0.0.1:1234' }, socket: { remoteAddress: '127.0.0.1' }, url: `/oauth2callback?state=${state}&code=${encodeURIComponent(CODE)}` };
  assert.deepEqual(callbackResponse(valid, origin, state), { code: CODE });
  for (const changed of [{ method: 'POST' }, { headers: { host: 'attacker.example' } }, { socket: { remoteAddress: '192.0.2.1' } },
    { url: `https://attacker.example/oauth2callback?state=${state}&code=${CODE}` }, { url: '/oauth2callback/extra?state=' + state },
    { url: valid.url + '&code=another' }, { url: valid.url + '&state=' + state }, { url: valid.url + '&long=' + 'x'.repeat(8200) }]) {
    assert.equal(callbackResponse({ ...valid, ...changed }, origin, state), null);
  }
  assert.equal(callbackResponse(valid, origin, ''), null);
});

test('atomic environment update preserves unrelated CRLF values and removes all old access grants', async t => {
  const text = `# original comment\r\nYOUTUBE_CHANNEL_ID=${CHANNEL}\r\nCADENCE_HOURS=24\r\nYOUTUBE_ACCESS_TOKEN=old-access\r\nexport YOUTUBE_ACCESS_TOKEN=duplicate-old-access\r\nYOUTUBE_ACCESS_TOKEN_EXPIRES_AT=old-expiry\r\nYOUTUBE_REFRESH_TOKEN_EXPIRES_AT=old-refresh-expiry\r\nYTFUN_YOUTUBE_PUBLIC_ENABLED=true\r\nYTFUN_YOUTUBE_AUDIT_CONFIRMED=true\r\n`;
  const f = await fixture(t, text);
  await persistGrant(f.envFilePath, CHANNEL, CLIENT, grant({ refresh_token_expires_in: 3600 }), { now: () => Date.parse('2026-10-01T12:00:00Z') });
  const content = await readFile(f.envFilePath, 'utf8');
  assert.ok(content.startsWith('# original comment\r\n'));
  assert.equal(content.includes('duplicate-old-access'), false);
  assert.equal(content.includes('old-expiry'), false);
  assert.equal(parseEnv(content).CADENCE_HOURS, '24');
  assert.equal(parseEnv(content).YOUTUBE_REFRESH_TOKEN_EXPIRES_AT, '2026-10-01T13:00:00.000Z');
  assert.equal(parseEnv(content).YTFUN_YOUTUBE_PUBLIC_ENABLED, 'false');
  assert.equal(parseEnv(content).YTFUN_YOUTUBE_AUDIT_CONFIRMED, 'false');
});

test('changed target, unsafe values, symlink files and concurrent writers never overwrite credentials', async t => {
  const f = await fixture(t);
  await assert.rejects(persistGrant(f.envFilePath, OTHER, CLIENT, grant()), error => error.code === 'OAUTH_CHANNEL_CHANGED');
  await assert.rejects(persistGrant(f.envFilePath, CHANNEL, CLIENT, grant({ refresh_token: 'unsafe\nSECOND=value' })), error => error.code === 'OAUTH_GRANT_INVALID');
  await writeFile(f.envFilePath + '.oauth.lock', 'owned by another setup', { mode: 0o600 });
  await assert.rejects(persistGrant(f.envFilePath, CHANNEL, CLIENT, grant()), error => error.code === 'OAUTH_ENV_BUSY');
  assert.equal(await readFile(f.envFilePath + '.oauth.lock', 'utf8'), 'owned by another setup');
  assert.equal(await readFile(f.envFilePath, 'utf8'), f.original);
  await unlinkFixture(f.envFilePath + '.oauth.lock');
  const link = path.join(f.directory, 'link.env');
  await symlink(f.envFilePath, link);
  await assert.rejects(persistGrant(link, CHANNEL, CLIENT, grant()), error => error.code === 'OAUTH_FILE_UNAVAILABLE');
  assert.equal(await readFile(f.envFilePath, 'utf8'), f.original);
});

async function unlinkFixture(filename) { await rm(filename); }

test('group-readable credentials and non-Desktop clients stop before displaying consent', async t => {
  for (const mode of ['readable', 'web', 'multiline']) {
    const f = await fixture(t);
    if (mode === 'readable') await chmod(f.clientPath, 0o644);
    if (mode === 'web') await writeFile(f.clientPath, JSON.stringify({ web: CLIENT }));
    if (mode === 'multiline') await writeFile(f.envFilePath, `YOUTUBE_CHANNEL_ID=${CHANNEL}\nCUSTOM="first\nsecond"\n`);
    await assert.rejects(setupYouTubeOAuth(f, { onAuthorizationUrl: () => { throw new Error('Unexpected consent display'); } }));
  }
});

test('consent timeout closes the ephemeral loopback listener without writing a grant', async t => {
  const f = await fixture(t);
  let redirect;
  await assert.rejects(setupYouTubeOAuth(f, { timeoutMs: 20, oauthFactory: oauthFactory(), onAuthorizationUrl: url => { redirect = callbackUrl(url); } }), error => error.code === 'OAUTH_SETUP_CANCELLED');
  assert.equal(await readFile(f.envFilePath, 'utf8'), f.original);
  await assert.rejects(fetch(redirect));
});

test('argument errors never echo unknown values and duplicate paths are rejected', () => {
  assert.deepEqual(setupArguments(['--client', '/private/client.json', '--env-file', '/private/ytfun.env']), { clientPath: '/private/client.json', envFilePath: '/private/ytfun.env' });
  for (const args of [['--client', '/private/client.json'], ['--token', REFRESH], ['--client=/a', '--client=/b', '--env-file=/c']]) {
    assert.throws(() => setupArguments(args), error => { noSecrets(error.message); return error.code === 'OAUTH_ARGUMENTS_INVALID'; });
  }
});
