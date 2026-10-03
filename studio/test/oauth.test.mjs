import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { YouTubeAuth, YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE, YOUTUBE_ANALYTICS_SCOPE } from '../src/oauth.mjs';

const START = Date.parse('2026-09-30T12:00:00Z');
const ENV = {
  YOUTUBE_REFRESH_TOKEN: 'fixture-refresh-secret',
  YOUTUBE_CLIENT_ID: 'fixture-client.apps.googleusercontent.com',
  YOUTUBE_CLIENT_SECRET: 'fixture-client-secret',
};
const ACCESS = 'fixture-access-secret';

function grant(overrides = {}) {
  return { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600,
    scope: `${YOUTUBE_UPLOAD_SCOPE} ${YOUTUBE_READONLY_SCOPE} ${YOUTUBE_ANALYTICS_SCOPE}`, ...overrides };
}

function fixture({ env = ENV, response = () => Response.json(grant()) } = {}) {
  let now = START;
  const calls = [];
  const auth = new YouTubeAuth({ env, now: () => now, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(calls.length);
  } });
  return { auth, calls, advance: milliseconds => { now += milliseconds; } };
}

function noSecrets(value) {
  const encoded = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [...Object.values(ENV), ACCESS]) assert.equal(encoded.includes(secret), false);
}

test('legacy static access token remains supported without any OAuth request', async () => {
  const f = fixture({ env: { YOUTUBE_ACCESS_TOKEN: ACCESS } });
  assert.deepEqual(f.auth.readiness(), { ready: true, mode: 'access_token', refreshable: false, scopesVerified: false, reasons: [] });
  assert.equal(await f.auth.getAccessToken({ requiredScopes: [YOUTUBE_UPLOAD_SCOPE] }), ACCESS);
  assert.equal(f.calls.length, 0);
  noSecrets(JSON.stringify(f.auth));
  noSecrets(inspect(f.auth));
});

test('configuration readiness makes no network call and never serializes credentials', async () => {
  const f = fixture();
  assert.equal(f.auth.readiness().ready, true);
  assert.equal(f.auth.readiness().refreshable, true);
  assert.equal(f.auth.readiness().scopesVerified, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(Object.keys(f.auth), []);
  noSecrets(f.auth.readiness());
  noSecrets(JSON.stringify(f.auth));
  noSecrets(inspect(f.auth));
});

test('a partially configured refresh grant blocks instead of falling back to a static token', async () => {
  const f = fixture({ env: { YOUTUBE_ACCESS_TOKEN: ACCESS, YOUTUBE_REFRESH_TOKEN: ENV.YOUTUBE_REFRESH_TOKEN } });
  assert.equal(f.auth.readiness().ready, false);
  assert.equal(f.auth.readiness().mode, 'refresh_token');
  assert.ok(f.auth.readiness().reasons.some(reason => reason.includes('YOUTUBE_CLIENT_ID')));
  await assert.rejects(f.auth.getAccessToken(), error => error.code === 'YOUTUBE_AUTH_NOT_READY');
  assert.equal(f.calls.length, 0);
  noSecrets(f.auth.readiness());
});

test('refresh grants take precedence over an expired static access token', async () => {
  const f = fixture({ env: { ...ENV, YOUTUBE_ACCESS_TOKEN: 'old-secret', YOUTUBE_ACCESS_TOKEN_EXPIRES_AT: '2020-01-01T00:00:00Z' } });
  assert.equal(await f.auth.getAccessToken(), ACCESS);
  assert.equal(f.calls.length, 1);
});

test('only the fixed Google HTTPS endpoint receives form-encoded refresh credentials', async () => {
  const f = fixture();
  assert.equal(await f.auth.getAccessToken(), ACCESS);
  const { url, options } = f.calls[0];
  assert.equal(url, 'https://oauth2.googleapis.com/token');
  assert.equal(new URL(url).search, '');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(options.headers.Authorization, undefined);
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), {
    grant_type: 'refresh_token', refresh_token: ENV.YOUTUBE_REFRESH_TOKEN,
    client_id: ENV.YOUTUBE_CLIENT_ID, client_secret: ENV.YOUTUBE_CLIENT_SECRET,
  });
  noSecrets(f.auth.readiness());
  noSecrets(JSON.stringify(f.auth));
});

test('concurrent callers share one refresh while checking their own required scopes', async () => {
  let finish;
  const f = fixture({ response: () => new Promise(resolve => { finish = resolve; }) });
  const first = f.auth.getAccessToken({ requiredScopes: [YOUTUBE_UPLOAD_SCOPE] });
  const second = f.auth.getAccessToken({ requiredScopes: [YOUTUBE_ANALYTICS_SCOPE] });
  assert.equal(f.calls.length, 1);
  finish(Response.json(grant()));
  assert.deepEqual(await Promise.all([first, second]), [ACCESS, ACCESS]);
  assert.equal(await f.auth.getAccessToken(), ACCESS);
  assert.equal(f.calls.length, 1);
});

test('expiry skew refreshes before the cached token expires', async () => {
  const f = fixture({ response: count => Response.json(grant({ access_token: `fixture-token-${count}` })) });
  assert.equal(await f.auth.getAccessToken(), 'fixture-token-1');
  f.advance(3_539_000);
  assert.equal(await f.auth.getAccessToken(), 'fixture-token-1');
  f.advance(1000);
  assert.equal(await f.auth.getAccessToken(), 'fixture-token-2');
  assert.equal(f.calls.length, 2);
});

test('even an exceptionally long provider lifetime cannot cache a token forever', async () => {
  const f = fixture({ response: count => Response.json(grant({ access_token: `fixture-token-${count}`, expires_in: 31_536_000 })) });
  assert.equal(await f.auth.getAccessToken(), 'fixture-token-1');
  f.advance(24 * 3_600_000);
  assert.equal(await f.auth.getAccessToken(), 'fixture-token-2');
  assert.equal(f.calls.length, 2);
});

test('a clock rollback invalidates the cached token instead of extending its lifetime', async () => {
  const f = fixture({ response: count => Response.json(grant({ access_token: `fixture-token-${count}` })) });
  assert.equal(await f.auth.getAccessToken(), 'fixture-token-1');
  f.advance(-1000);
  assert.equal(await f.auth.getAccessToken(), 'fixture-token-2');
  assert.equal(f.calls.length, 2);
});

test('scopes are checked against the provider response and missing scopes never trigger another refresh', async () => {
  const f = fixture({ response: () => Response.json(grant({ scope: YOUTUBE_UPLOAD_SCOPE })) });
  await assert.rejects(f.auth.getAccessToken({ requiredScopes: [YOUTUBE_ANALYTICS_SCOPE] }), error => error.code === 'YOUTUBE_OAUTH_SCOPE_MISSING');
  await assert.rejects(f.auth.getAccessToken({ requiredScopes: [YOUTUBE_READONLY_SCOPE] }), error => error.code === 'YOUTUBE_OAUTH_SCOPE_MISSING');
  assert.equal(await f.auth.getAccessToken({ requiredScopes: [YOUTUBE_UPLOAD_SCOPE] }), ACCESS);
  assert.equal(f.auth.readiness({ requiredScopes: [YOUTUBE_ANALYTICS_SCOPE] }).ready, false);
  assert.equal(f.auth.readiness().scopesVerified, true);
  assert.equal(f.calls.length, 1);
});

test('omitted scope metadata stays unverified and is never fabricated from requested scopes', async () => {
  const f = fixture({ response: () => Response.json(grant({ scope: undefined })) });
  assert.equal(await f.auth.getAccessToken({ requiredScopes: [YOUTUBE_UPLOAD_SCOPE] }), ACCESS);
  assert.equal(f.auth.readiness().scopesVerified, false);
  assert.equal(f.calls.length, 1);
});

test('revoked grants and rejected clients stop subsequent refresh calls until configuration is replaced', async () => {
  for (const [providerError, code] of [['invalid_grant', 'YOUTUBE_OAUTH_REAUTH_REQUIRED'], ['invalid_client', 'YOUTUBE_OAUTH_CLIENT_REJECTED'],
    ['unauthorized_client', 'YOUTUBE_OAUTH_CLIENT_REJECTED'], ['invalid_scope', 'YOUTUBE_OAUTH_SCOPE_REJECTED']]) {
    const f = fixture({ response: () => Response.json({ error: providerError, error_description: `${ACCESS} ${ENV.YOUTUBE_REFRESH_TOKEN}` }, { status: 400 }) });
    await assert.rejects(f.auth.getAccessToken(), error => {
      assert.equal(error.code, code);
      noSecrets(error.message);
      assert.equal(error.cause, undefined);
      return true;
    });
    f.advance(24 * 3_600_000);
    await assert.rejects(f.auth.getAccessToken(), error => error.code === code);
    assert.equal(f.calls.length, 1);
    assert.equal(f.auth.readiness().ready, false);
    assert.equal(f.auth.readiness().refreshable, false);
    noSecrets(f.auth.readiness());
  }
});

test('transient failures sanitize provider errors and only a later explicit call can retry after cooldown', async () => {
  const f = fixture({ response: count => {
    if (count === 1) return Response.json({ error: ACCESS, error_description: ENV.YOUTUBE_CLIENT_SECRET }, { status: 503 });
    return Response.json(grant());
  } });
  await assert.rejects(f.auth.getAccessToken(), error => {
    assert.equal(error.code, 'YOUTUBE_OAUTH_UNAVAILABLE');
    noSecrets(error.message);
    return true;
  });
  await assert.rejects(f.auth.getAccessToken(), error => error.code === 'YOUTUBE_AUTH_NOT_READY');
  assert.equal(f.calls.length, 1);
  f.advance(30_000);
  assert.equal(await f.auth.getAccessToken(), ACCESS);
  assert.equal(f.calls.length, 2);
});

test('a timed out or throwing fetch never leaks its diagnostic or retries in the same call', async () => {
  const f = fixture({ response: () => { throw new Error(`${ACCESS} ${ENV.YOUTUBE_CLIENT_SECRET}`); } });
  await assert.rejects(f.auth.getAccessToken(), error => {
    assert.equal(error.code, 'YOUTUBE_OAUTH_UNAVAILABLE');
    noSecrets(error.message);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(f.calls.length, 1);
  noSecrets(f.auth.readiness());
});

test('failure cooldown starts when a slow request fails, not when it was sent', async () => {
  let f;
  f = fixture({ response: () => { f.advance(30_000); throw new Error(ACCESS); } });
  await assert.rejects(f.auth.getAccessToken(), error => error.code === 'YOUTUBE_OAUTH_UNAVAILABLE');
  await assert.rejects(f.auth.getAccessToken(), error => error.code === 'YOUTUBE_AUTH_NOT_READY');
  assert.equal(f.calls.length, 1);
});

test('provider objects cannot inject a supposedly safe error code with a secret-bearing diagnostic', async () => {
  const f = fixture({ response: () => ({
    json: async () => grant(),
    get ok() { throw Object.assign(new Error(ACCESS), { code: 'YOUTUBE_OAUTH_UNAVAILABLE' }); },
  }) });
  await assert.rejects(f.auth.getAccessToken(), error => {
    assert.equal(error.code, 'YOUTUBE_OAUTH_UNAVAILABLE');
    noSecrets(error.message);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test('a failed renewal never falls back to an expired cached access token or a static token', async () => {
  const f = fixture({ env: { ...ENV, YOUTUBE_ACCESS_TOKEN: 'stale-static-secret' }, response: count => count === 1
    ? Response.json(grant()) : Response.json({ error: 'invalid_grant' }, { status: 400 }) });
  assert.equal(await f.auth.getAccessToken(), ACCESS);
  f.advance(3_540_000);
  await assert.rejects(f.auth.getAccessToken(), error => error.code === 'YOUTUBE_OAUTH_REAUTH_REQUIRED');
  await assert.rejects(f.auth.getAccessToken(), error => error.code === 'YOUTUBE_OAUTH_REAUTH_REQUIRED');
  assert.equal(f.calls.length, 2);
});

test('malformed or near-expiry responses are rejected without caching or leaking token values', async () => {
  for (const body of [null, [], grant({ access_token: '' }), grant({ access_token: `${ACCESS}\n` }), grant({ token_type: 'MAC' }),
    grant({ token_type: 1 }), grant({ expires_in: 60 }), grant({ expires_in: -1 }), grant({ expires_in: '3600' }),
    grant({ expires_in: null }), grant({ scope: `${YOUTUBE_UPLOAD_SCOPE}\n${ACCESS}` }), grant({ scope: [YOUTUBE_UPLOAD_SCOPE] })]) {
    const f = fixture({ response: () => Response.json(body) });
    await assert.rejects(f.auth.getAccessToken(), error => {
      assert.equal(error.code, 'YOUTUBE_OAUTH_RESPONSE_INVALID');
      noSecrets(error.message);
      return true;
    });
    await assert.rejects(f.auth.getAccessToken());
    assert.equal(f.calls.length, 1);
    assert.equal(f.auth.readiness().scopesVerified, false);
  }
});

test('a response that has already lost its usable lifetime cannot be used', async () => {
  let f;
  f = fixture({ response: () => { f.advance(70_000); return Response.json(grant({ expires_in: 120 })); } });
  await assert.rejects(f.auth.getAccessToken(), error => error.code === 'YOUTUBE_OAUTH_RESPONSE_INVALID');
  assert.equal(f.calls.length, 1);
});

test('known static and refresh expiry prevent network calls and require user reauthorization', async () => {
  for (const env of [{ YOUTUBE_ACCESS_TOKEN: ACCESS, YOUTUBE_ACCESS_TOKEN_EXPIRES_AT: '2026-09-30T12:00:30Z' },
    { ...ENV, YOUTUBE_REFRESH_TOKEN_EXPIRES_AT: '2026-09-29T12:00:00Z' }]) {
    const f = fixture({ env });
    assert.equal(f.auth.readiness().ready, false);
    await assert.rejects(f.auth.getAccessToken(), error => error.code === 'YOUTUBE_AUTH_NOT_READY');
    assert.equal(f.calls.length, 0);
    noSecrets(f.auth.readiness());
  }
});

test('provider refresh-grant expiry is honored without silently extending a known expiry', async () => {
  const f = fixture({ response: () => Response.json(grant({ refresh_token_expires_in: 100 })) });
  assert.equal(await f.auth.getAccessToken(), ACCESS);
  f.advance(40_000);
  assert.equal(f.auth.readiness().ready, false);
  assert.equal(f.auth.readiness().refreshable, false);
  await assert.rejects(f.auth.getAccessToken(), error => error.code === 'YOUTUBE_AUTH_NOT_READY');
  assert.equal(f.calls.length, 1);
  const alreadyExpiring = fixture({ response: () => Response.json(grant({ refresh_token_expires_in: 60 })) });
  await assert.rejects(alreadyExpiring.auth.getAccessToken(), error => error.code === 'YOUTUBE_OAUTH_REAUTH_REQUIRED');
});

test('malformed environment expiry and header injection block before any credentials are sent', async () => {
  for (const env of [{ ...ENV, YOUTUBE_CLIENT_SECRET: `${ENV.YOUTUBE_CLIENT_SECRET}\n` },
    { ...ENV, YOUTUBE_REFRESH_TOKEN_EXPIRES_AT: 'not-a-timestamp' },
    { ...ENV, YOUTUBE_REFRESH_TOKEN_EXPIRES_AT: '2026-02-30T12:00:00Z' },
    { YOUTUBE_ACCESS_TOKEN: `${ACCESS}\r\nInjected: header` },
    { YOUTUBE_ACCESS_TOKEN: ACCESS, YOUTUBE_ACCESS_TOKEN_EXPIRES_AT: '2026-09-30' }, {}]) {
    const f = fixture({ env });
    assert.equal(f.auth.readiness().ready, false);
    await assert.rejects(f.auth.getAccessToken(), error => { noSecrets(error.message); return true; });
    assert.equal(f.calls.length, 0);
  }
});

test('invalid injected clocks and malformed required scopes never reach the provider', async () => {
  const auth = new YouTubeAuth({ env: ENV, now: () => { throw new Error(ACCESS); }, fetchImpl: () => { throw new Error('Unexpected request'); } });
  noSecrets(auth.readiness());
  assert.equal(auth.readiness().ready, false);
  await assert.rejects(auth.getAccessToken(), error => { noSecrets(error.message); return true; });
  const f = fixture();
  await assert.rejects(f.auth.getAccessToken({ requiredScopes: [`https://attacker.example/${ACCESS}`] }), error => error.code === 'YOUTUBE_AUTH_SCOPES_INVALID');
  assert.equal(f.calls.length, 0);
});
