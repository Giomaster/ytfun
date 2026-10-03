import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverFalVideo } from '../src/fal-queue-recovery.mjs';

// CI only: in-memory HTTP fixtures, with no credential files or provider calls.
const path = '/fal-ai/wan/requests/request-123';
const receipt = { provider: 'fal-ai', transport: 'huggingface-router', requestId: 'request-123', responsePath: path };
const MP4 = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom000000000000')]);
const safeFailure = /preserve its receipt and do not submit again/;

function fetcher(responses) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, 'Unexpected HTTP request');
    return response;
  } };
}

test('one pending snapshot never fetches media or submits a new request', async () => {
  for (const remoteStatus of ['IN_QUEUE', 'IN_PROGRESS']) {
    const http = fetcher([Response.json({ status: remoteStatus, request_id: receipt.requestId, logs: ['private-log'] })]);
    assert.deepEqual(await recoverFalVideo(receipt, { hfToken: 'fake-hf-token', fetchImpl: http.fetchImpl }), { requestId: receipt.requestId, remoteStatus });
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0].url, `https://router.huggingface.co/fal-ai${path}/status?_subdomain=queue`);
  }
});

test('completed retrieval uses authenticated router GETs and an unauthenticated MP4 GET', async () => {
  const http = fetcher([Response.json({ status: 'COMPLETED' }), Response.json({ video: { url: 'https://v3.fal.media/files/pilot.mp4?signature=private-value' } }), new Response(MP4, { headers: { 'content-type': 'video/mp4' } })]);
  const result = await recoverFalVideo(receipt, { hfToken: 'fake-hf-token', fetchImpl: http.fetchImpl });
  assert.equal(result.remoteStatus, 'COMPLETED');
  assert.equal(result.blob.type, 'video/mp4');
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), MP4);
  assert.equal(http.calls.length, 3);
  for (const call of http.calls.slice(0, 2)) assert.equal(call.options.headers.Authorization, 'Bearer fake-hf-token');
  assert.equal(http.calls[1].url, `https://router.huggingface.co/fal-ai${path}?_subdomain=queue`);
  assert.equal(http.calls[2].options.headers.Authorization, undefined);
  assert.doesNotMatch(JSON.stringify(result), /fake-hf-token|signature|private-value/);
});

test('response-suffix receipts use the request status route and retain the result suffix', async () => {
  const http = fetcher([Response.json({ status: 'COMPLETED' }), Response.json({ video: { url: 'https://fal.media/pilot.mp4' } }), new Response(MP4, { headers: { 'content-type': 'application/octet-stream' } })]);
  await recoverFalVideo({ ...receipt, responsePath: `${path}/response` }, { hfToken: 'fake-hf-token', fetchImpl: http.fetchImpl });
  assert.equal(http.calls[0].url, `https://router.huggingface.co/fal-ai${path}/status?_subdomain=queue`);
  assert.equal(http.calls[1].url, `https://router.huggingface.co/fal-ai${path}/response?_subdomain=queue`);
});

test('invalid identities, receipt paths and credentials fail before any HTTP call', async () => {
  const mutations = [{ provider: 'other' }, { transport: 'provider-key' }, { requestId: '../secret' }, { responsePath: `${path}/status` }, { responsePath: '/fal-ai/../requests/request-123' }, { responsePath: `${path}?token=private` }, { responsePath: '/fal-ai/wan/requests/wrong-id' }];
  let calls = 0;
  const fetchImpl = async () => { calls += 1; assert.fail('Invalid receipt reached the network'); };
  for (const mutation of mutations) await assert.rejects(recoverFalVideo({ ...receipt, ...mutation }, { hfToken: 'fake-hf-token', fetchImpl }), safeFailure);
  await assert.rejects(recoverFalVideo(receipt, { hfToken: 'fake token', fetchImpl }), safeFailure);
  assert.equal(calls, 0);
});

test('mismatched IDs, failed queue states, oversized JSON and raw provider errors remain sanitized', async () => {
  const responses = [Response.json({ status: 'COMPLETED', request_id: 'wrong' }), Response.json({ status: 'FAILED', error: 'private-provider-error' }), Response.json({ status: 'COMPLETED', error_type: 'private-provider-error' }), new Response('private-body', { status: 503 }), new Response(' '.repeat(65_537), { headers: { 'content-type': 'application/json' } }), new Error('Authorization: Bearer private-provider-error')];
  for (const response of responses) {
    const http = fetcher([response]);
    await assert.rejects(recoverFalVideo(receipt, { hfToken: 'private-hf-token', fetchImpl: http.fetchImpl }), error => {
      assert.match(error.message, safeFailure);
      assert.doesNotMatch(error.message, /private-|Bearer/);
      return true;
    });
    assert.equal(http.calls.length, 1);
  }
});

test('untrusted media URLs cannot receive tokens, redirects or network requests', async () => {
  for (const url of ['http://v3.fal.media/pilot.mp4', 'https://127.0.0.1/pilot.mp4', 'https://v3.fal.media.evil.example/pilot.mp4', 'https://user:secret@v3.fal.media/pilot.mp4', 'https://v3.fal.media:8443/pilot.mp4', 'https://storage.googleapis.com/other-bucket/pilot.mp4']) {
    const http = fetcher([Response.json({ status: 'COMPLETED' }), Response.json({ video: { url } })]);
    await assert.rejects(recoverFalVideo(receipt, { hfToken: 'fake-hf-token', fetchImpl: http.fetchImpl }), safeFailure);
    assert.equal(http.calls.length, 2);
  }
});

test('oversized, redirected, wrong-MIME and invalid-header downloads never become assets', async () => {
  const videos = [new Response(MP4, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }), new Response(MP4, { headers: { 'content-type': 'video/mp4', 'content-length': String(100 * 1024 * 1024 + 1) } }), new Response(MP4, { headers: { 'content-type': 'text/html' } }), new Response('invalid mp4 header', { headers: { 'content-type': 'video/mp4' } })];
  for (const video of videos) {
    const http = fetcher([Response.json({ status: 'COMPLETED' }), Response.json({ video: { url: 'https://v3.fal.media/pilot.mp4' } }), video]);
    await assert.rejects(recoverFalVideo(receipt, { hfToken: 'fake-hf-token', fetchImpl: http.fetchImpl }), safeFailure);
    assert.equal(http.calls.length, 3);
  }
});
