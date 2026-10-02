import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { cloudAuthConfiguration, createCloudTokenVerifier } from '../src/mcp-auth.mjs';
import { createCloudApp, loadCloudEnvironment } from '../src/mcp-http.mjs';
import { StudioStore } from '../src/store.mjs';

const configuration = {
  YTFUN_MCP_RESOURCE_URL: 'https://studio.example.com/mcp',
  YTFUN_MCP_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example',
  YTFUN_MCP_AUTHORIZATION_ENDPOINT: 'https://owner.auth.us-east-1.amazoncognito.com/oauth2/authorize',
  YTFUN_MCP_TOKEN_ENDPOINT: 'https://owner.auth.us-east-1.amazoncognito.com/oauth2/token',
  YTFUN_MCP_CLIENT_IDS: 'owner-client', YTFUN_MCP_OWNER_SUBJECTS: 'owner-subject',
};

async function keys() {
  const pair = await generateKeyPair('RS256');
  const publicKey = await exportJWK(pair.publicKey);
  publicKey.kid = 'ci-key';
  const sign = (overrides = {}) => new SignJWT({ token_use: 'access', client_id: 'owner-client',
    scope: 'ytfun/read ytfun/write ytfun/publish', ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'ci-key' }).setIssuer(configuration.YTFUN_MCP_ISSUER)
    .setSubject('owner-subject').setAudience(configuration.YTFUN_MCP_RESOURCE_URL)
    .setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  return { ...pair, keySet: createLocalJWKSet({ keys: [publicKey] }), sign };
}

test('cloud authentication requires explicit HTTPS resource, registered client and owner', () => {
  const config = cloudAuthConfiguration(configuration);
  assert.equal(config.resource.href, configuration.YTFUN_MCP_RESOURCE_URL);
  assert.equal(config.metadata.issuer, config.resource.origin);
  assert.equal(config.issuer, configuration.YTFUN_MCP_ISSUER);
  assert.deepEqual(config.metadata.code_challenge_methods_supported, ['S256']);
  for (const [key, value] of [['YTFUN_MCP_OWNER_SUBJECTS', ''], ['YTFUN_MCP_CLIENT_IDS', ''],
    ['YTFUN_MCP_RESOURCE_URL', 'http://studio.example.com/mcp'], ['YTFUN_MCP_RESOURCE_URL', 'https://secret@studio.example.com/mcp'],
    ['YTFUN_MCP_RESOURCE_URL', 'https://studio.example.com/mcp?secret=oops'], ['YTFUN_MCP_RESOURCE_URL', 'https://studio.example.com/']]) {
    assert.throws(() => cloudAuthConfiguration({ ...configuration, [key]: value }));
  }
});

test('Cognito verifier rejects ID tokens, other owners/clients, missing resource binding and expired grants', async () => {
  const config = cloudAuthConfiguration(configuration);
  const { keySet, privateKey, sign } = await keys();
  const verifier = createCloudTokenVerifier(config, { keySet });
  const valid = await verifier.verifyAccessToken(await sign());
  assert.equal(valid.extra.subject, 'owner-subject');
  assert.equal(valid.resource.href, configuration.YTFUN_MCP_RESOURCE_URL);
  const wrongTokens = [await sign({ token_use: 'id' }), await sign({ client_id: 'another-client' }),
    await new SignJWT({ token_use: 'access', client_id: 'owner-client', scope: 'ytfun/read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'ci-key' }).setIssuer(config.issuer).setSubject('another-owner')
      .setAudience(config.resource.href).setIssuedAt().setExpirationTime('5m').sign(privateKey),
    await new SignJWT({ token_use: 'access', client_id: 'owner-client', scope: 'ytfun/read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'ci-key' }).setIssuer(config.issuer).setSubject('owner-subject')
      .setAudience('owner-client').setIssuedAt().setExpirationTime('5m').sign(privateKey),
    await new SignJWT({ token_use: 'access', client_id: 'owner-client', scope: 'ytfun/read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'ci-key' }).setIssuer(config.issuer).setSubject('owner-subject')
      .setAudience([config.resource.href, 'https://another-resource.example.com']).setIssuedAt().setExpirationTime('5m').sign(privateKey),
    await new SignJWT({ token_use: 'access', client_id: 'owner-client', scope: 'ytfun/read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'ci-key' }).setIssuer('https://wrong.example.com').setSubject('owner-subject')
      .setAudience(config.resource.href).setIssuedAt().setExpirationTime('5m').sign(privateKey),
    await new SignJWT({ token_use: 'access', client_id: 'owner-client', scope: 'ytfun/read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'ci-key' }).setIssuer(config.issuer).setSubject('owner-subject')
      .setAudience(config.resource.href).setIssuedAt().setExpirationTime(1).sign(privateKey),
    'private-provider-token-never-return-this', 'x'.repeat(16_385)];
  for (const token of wrongTokens) await assert.rejects(verifier.verifyAccessToken(token), error => {
    assert.equal(error.errorCode, 'invalid_token');
    assert.ok(!error.message.includes(token)); return true;
  });
});

test('HTTP cloud transport negotiates OAuth and isolates read/write/publish grants on the real studio', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-cloud-ci-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...configuration, YTFUN_STUDIO_DIR: directory, YTFUN_REMOTE_ASSEMBLY_ONLY: 'true', HF_TOKEN: 'private-provider-secret',
    FACEBOOK_PAGE_ACCESS_TOKEN: 'private-facebook-secret', FACEBOOK_PAGE_ID: 'authorized-page',
    YOUTUBE_CHANNEL_ID: 'authorized-channel', TIKTOK_ACCOUNT_ID: 'authorized-tiktok' };
  const config = cloudAuthConfiguration(env);
  const { keySet, sign } = await keys();
  const verifier = createCloudTokenVerifier(config, { keySet });
  const lifecycle = { maintain: async () => {}, fetch: globalThis.fetch, starts: 0, stops: 0,
    start() { this.starts++; }, stop() { this.stops++; } };
  let releaseGeneration;
  const pendingGeneration = new Promise(resolve => { releaseGeneration = resolve; });
  const production = { generateAsset: async () => { await pendingGeneration; return { id: 'original-asset' }; },
    renderEpisode: () => { throw new Error('Local renderer must not run'); } };
  const { app, store, jobs } = createCloudApp({ env, config, verifier, lifecycle, production });
  const listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const base = new URL(`http://127.0.0.1:${listener.address().port}`);
  const anonymous = await fetch(new URL('/mcp', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  assert.deepEqual((await store.read()).projects, []);
  const discovery = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', base));
  const resourceMetadata = await discovery.json();
  assert.equal(resourceMetadata.resource, config.resource.href);
  assert.deepEqual(resourceMetadata.authorization_servers, [config.resource.origin]);
  const authorizationMetadata = await (await fetch(new URL('/.well-known/oauth-authorization-server', base))).json();
  assert.equal(authorizationMetadata.issuer, resourceMetadata.authorization_servers[0]);
  assert.deepEqual(authorizationMetadata.code_challenge_methods_supported, ['S256']);
  assert.equal(authorizationMetadata.token_endpoint, configuration.YTFUN_MCP_TOKEN_ENDPOINT);
  const clientFor = async scopes => {
    const client = new Client({ name: 'ci-cloud-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), {
      requestInit: { headers: { Authorization: `Bearer ${await sign({ scope: scopes })}` } },
    }));
    t.after(() => client.close()); return client;
  };
  const read = await clientFor('ytfun/read');
  const tools = await read.listTools();
  assert.equal(tools.tools.length, 43);
  assert.deepEqual(tools.tools.find(x => x.name === 'ytfun_facebook_publish')._meta.securitySchemes,
    [{ type: 'oauth2', scopes: ['ytfun/publish'] }]);
  assert.deepEqual(tools.tools.find(x => x.name === 'ytfun_tiktok_publish')._meta.securitySchemes,
    [{ type: 'oauth2', scopes: ['ytfun/publish'] }]);
  for (const name of ['ytfun_zernio_delivery_migrate', 'ytfun_tiktok_zernio_consent_record']) {
    assert.deepEqual(tools.tools.find(x => x.name === name)._meta.securitySchemes,
      [{ type: 'oauth2', scopes: ['ytfun/publish'] }]);
  }
  const profile = await read.callTool({ name: 'ytfun_cloud_profile', arguments: {} });
  assert.ok(!profile.isError);
  assert.ok(!JSON.stringify(profile).includes('private-provider-secret'));
  assert.ok(!JSON.stringify(profile).includes('private-facebook-secret'));
  const identity = JSON.parse(profile.content[0].text);
  assert.equal(identity.publishing.tiktok.automaticPosting, false);
  assert.equal(identity.publishing.youtube.apiAuditConfirmed, false);
  const project = { title: 'AI Meow', premise: 'Original impossible material reveals', audience: 'Global', language: 'nonverbal' };
  const rejected = await read.callTool({ name: 'ytfun_project_create', arguments: project });
  assert.equal(rejected.isError, true);
  assert.match(rejected._meta['mcp/www_authenticate'][0], /ytfun\/write/);
  assert.equal((await store.read()).projects.length, 0);
  const writer = await clientFor('ytfun/read ytfun/write');
  const created = await writer.callTool({ name: 'ytfun_project_create', arguments: project });
  assert.ok(!created.isError, JSON.stringify(created));
  const episodeId = '717f7a19-2e5f-4c55-b1d6-35c0d7899a23';
  await store.transaction(state => state.episodes.push({ id: episodeId }));
  for (const request of [
    { name: 'ytfun_episode_render', arguments: { episodeId } },
    { name: 'ytfun_production_job_start', arguments: { job: { action: 'render', input: { episodeId } } } },
  ]) {
    const refused = await writer.callTool(request);
    assert.equal(refused.isError, true); assert.match(refused.content[0].text, /remote assembly only/);
    assert.equal((await store.read()).productionJobs?.length ?? 0, 0);
  }
  const job = await jobs.start({ action: 'generate', input: { episodeId } });
  const active = await read.callTool({ name: 'ytfun_production_job_get', arguments: { jobId: job.id } });
  assert.equal(JSON.parse(active.content[0].text).workerActiveHere, true);
  const unsafeReconcile = await writer.callTool({ name: 'ytfun_production_job_reconcile', arguments: {
    jobId: job.id, confirmedBy: 'CI operator', evidence: 'A new RPC must retain the owning process.' } });
  assert.equal(unsafeReconcile.isError, true); assert.match(unsafeReconcile.content[0].text, /still running/);
  const work = jobs.running.get(job.id);
  releaseGeneration(); await work;
  const completed = await read.callTool({ name: 'ytfun_production_job_get', arguments: { jobId: job.id } });
  assert.equal(JSON.parse(completed.content[0].text).status, 'completed');
  const publish = await writer.callTool({ name: 'ytfun_facebook_publish', arguments: {
    episodeId: JSON.parse(created.content[0].text).id, expectedReviewHash: 'a'.repeat(64), privacy: 'public', execute: true,
  } });
  assert.equal(publish.isError, true);
  assert.match(publish._meta['mcp/www_authenticate'][0], /ytfun\/publish/);
  for (const request of [
    { name: 'ytfun_zernio_delivery_migrate', arguments: { deliveryId: episodeId, expectedMode: 'official_api', expectedReviewHash: 'a'.repeat(64), reason: 'Scope check' } },
    { name: 'ytfun_tiktok_zernio_consent_record', arguments: { episodeId, expectedReviewHash: 'a'.repeat(64),
      attestation: { renderSha256: 'a'.repeat(64), contentPreviewConfirmed: true, expressConsentGiven: true,
        previewWitness: 'owner', consentSource: 'owner_explicit', evidenceSha256: 'b'.repeat(64), recordedAt: '2026-10-02T22:00:00.000Z' },
      interactionSettings: { allow_comment: true, allow_duet: false, allow_stitch: false } } },
  ]) {
    const refused = await writer.callTool(request);
    assert.equal(refused.isError, true);
    assert.match(refused._meta['mcp/www_authenticate'][0], /ytfun\/publish/);
  }
  const listed = await read.callTool({ name: 'ytfun_project_list', arguments: {} });
  assert.equal(JSON.parse(listed.content[0].text).length, 1);
  assert.equal((await store.read()).publications.length, 0);
  assert.equal(lifecycle.starts, 0); assert.equal(lifecycle.stops, 0);
  const hostileOrigin = await fetch(new URL('/mcp', base), { method: 'POST',
    headers: { Authorization: `Bearer ${await sign()}`, Origin: 'https://untrusted.example.com', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(hostileOrigin.status, 403);
});

test('cloud startup rejects a competing delivery worker and unsafe private environment files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-cloud-env-ci-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...configuration, YTFUN_STUDIO_DIR: directory, YTFUN_DELIVERY_WORKER_ENABLED: 'true' };
  assert.throws(() => createCloudApp({ env }), /background delivery worker/);
  const filename = join(directory, 'private.env');
  await writeFile(filename, 'HF_TOKEN=private-value\n', { mode: 0o600 });
  const loaded = await loadCloudEnvironment(filename, {});
  assert.equal(loaded.HF_TOKEN, 'private-value'); assert.equal(loaded.YTFUN_PRIVATE_ENV_FILE, filename);
  await chmod(filename, 0o644);
  await assert.rejects(loadCloudEnvironment(filename), /0600/);
  await chmod(filename, 0o600);
  const linked = join(directory, 'linked.env');
  await symlink(filename, linked);
  await assert.rejects(loadCloudEnvironment(linked));
  await assert.rejects(loadCloudEnvironment('relative.env'));
  await mkdir(join(directory, '.git'));
  await assert.rejects(loadCloudEnvironment(filename), /outside Git/);
});
