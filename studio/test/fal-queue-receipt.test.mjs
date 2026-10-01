import test from 'node:test';
import assert from 'node:assert/strict';
import { falQueueReceiptFetch } from '../src/fal-queue-receipt.mjs';

// CI-only contract checks. All storage and HTTP responses are in memory;
// no SDK, credential file, provider or real network is involved.
const reservationId = 'reservation-1';
const submittedUrl = 'https://router.huggingface.co/fal-ai/fal-ai/wan/v2.2-a14b/text-to-video?_subdomain=queue';
const responsePath = '/fal-ai/wan/requests/request-123';
const responseUrl = `https://queue.fal.run${responsePath}`;
const capturedAt = '2026-10-01T12:00:00.000Z';
const reconcile = /reconcile the existing attempt without submitting again/;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function memoryStore({ spending = [{ id: reservationId, status: 'reserved', provider: 'fal-ai', kind: 'video' }], beforeCommit } = {}) {
  const state = { spending: structuredClone(spending) };
  let transactions = 0;
  return {
    state,
    get transactions() { return transactions; },
    async transaction(fn) {
      transactions += 1;
      const draft = structuredClone(state);
      const result = await fn(draft);
      if (beforeCommit) await beforeCommit(draft);
      Object.assign(state, draft);
      return structuredClone(result);
    },
  };
}

function queueResponse(overrides = {}, init = {}) {
  return Response.json({ request_id: 'request-123', status: 'IN_QUEUE', response_url: responseUrl, ...overrides }, init);
}

function capture(store, fetchImpl) {
  return falQueueReceiptFetch(store, reservationId, { fetchImpl, now: () => Date.parse(capturedAt) });
}

function expectedReceipt(status = 'IN_QUEUE') {
  return { provider: 'fal-ai', transport: 'huggingface-router', requestId: 'request-123',
    submissionUrl: submittedUrl, responsePath, status, capturedAt };
}

test('the POST response remains withheld until the sanitized queue receipt commits', async () => {
  const entered = deferred();
  const commit = deferred();
  const store = memoryStore({ beforeCommit: async draft => {
    assert.deepEqual(draft.spending[0].remoteRequest, expectedReceipt());
    entered.resolve();
    await commit.promise;
  } });
  const response = queueResponse();
  const calls = [];
  const options = { method: 'POST', headers: { Authorization: 'Bearer fake-token' }, body: '{}', redirect: 'follow' };
  const hook = capture(store, async (input, passedOptions) => {
    calls.push({ input, options: passedOptions });
    return response;
  });
  let returned = false;
  const pending = hook(submittedUrl, options);
  pending.then(() => { returned = true; }, () => { returned = true; });
  try {
    await Promise.race([entered.promise, pending.then(() => {
      assert.fail('The SDK received its response before persistence began');
    })]);
    assert.equal(returned, false);
    assert.equal(store.state.spending[0].remoteRequest, undefined);
    await assert.rejects(hook(submittedUrl, options), reconcile);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, submittedUrl);
    assert.deepEqual(calls[0].options, { ...options, redirect: 'error' });
    assert.equal(options.redirect, 'follow');
  } finally { commit.resolve(); }
  const returnedResponse = await pending;
  assert.equal(returnedResponse, response);
  assert.deepEqual(store.state.spending[0].remoteRequest, expectedReceipt());
  assert.deepEqual(await returnedResponse.json(), { request_id: 'request-123', status: 'IN_QUEUE', response_url: responseUrl });
});

test('only selected queue fields persist; headers, provider extras and signed media URLs do not', async () => {
  const store = memoryStore();
  const extras = { status_url: `${responseUrl}/status?token=fake-private-query`,
    cancel_url: `${responseUrl}/cancel`, video: { url: 'https://media.example/video.mp4?signature=fake-private-signature' },
    authorization: 'fake-private-body', logs: ['fake-private-log'] };
  const response = queueResponse(extras, { headers: { 'x-private-diagnostic': 'fake-private-header' } });
  const hook = capture(store, async () => response);
  const returned = await hook(submittedUrl, { method: 'POST', headers: { Authorization: 'Bearer fake-private-request' } });
  assert.deepEqual(store.state.spending[0].remoteRequest, expectedReceipt());
  assert.doesNotMatch(JSON.stringify(store.state), /fake-private|status_url|cancel_url|authorization|logs|signature/);
  assert.equal(returned, response);
  assert.equal(returned.headers.get('x-private-diagnostic'), 'fake-private-header');
  assert.deepEqual(await returned.json(), { request_id: 'request-123', status: 'IN_QUEUE', response_url: responseUrl, ...extras });
});

test('queue status values are bounded and the returned response path may differ from the submitted model route', async () => {
  for (const status of ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'fake-private-status', null]) {
    const store = memoryStore();
    const response = queueResponse({ status });
    const hook = capture(store, async () => response);
    await hook(new URL(submittedUrl), { method: 'post' });
    assert.deepEqual(store.state.spending[0].remoteRequest,
      expectedReceipt(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'].includes(status) ? status : 'unknown'));
    assert.ok(!submittedUrl.includes(responsePath));
  }
});

test('official result routes with and without a response suffix retain their exact validated path', async () => {
  for (const suffix of ['', '/response']) {
    const store = memoryStore();
    const path = `${responsePath}${suffix}`;
    const response = queueResponse({ response_url: `https://queue.fal.run${path}` });
    const hook = capture(store, async () => response);
    assert.equal(await hook(submittedUrl, { method: 'POST' }), response);
    assert.deepEqual(store.state.spending[0].remoteRequest, { ...expectedReceipt(), responsePath: path });
    assert.equal((await response.json()).response_url, `https://queue.fal.run${path}`);
  }
});

test('unsafe submission routes fail before any POST or store transaction', async () => {
  const invalid = [
    'https://queue.fal.run/fal-ai/wan?_subdomain=queue',
    'http://router.huggingface.co/fal-ai/wan?_subdomain=queue',
    'https://router.huggingface.co:444/fal-ai/wan?_subdomain=queue',
    'https://router.huggingface.co/other-provider/wan?_subdomain=queue',
    'https://router.huggingface.co/fal-ai/wan',
    'https://router.huggingface.co/fal-ai/wan?_subdomain=queue&token=fake-private-query',
    'https://router.huggingface.co/fal-ai/wan?token=fake-private-query&_subdomain=queue',
    'https://fake-private-user@router.huggingface.co/fal-ai/wan?_subdomain=queue',
    `${submittedUrl}#fake-private-fragment`,
    'https://router.huggingface.co/fal-ai/%2e%2e/wan?_subdomain=queue',
    'https://router.huggingface.co/fal-ai/../wan?_subdomain=queue',
    'https://router.huggingface.co/fal-ai/wan\\evil?_subdomain=queue',
  ];
  for (const input of invalid) {
    const store = memoryStore();
    let posts = 0;
    const hook = capture(store, async () => { posts += 1; return queueResponse(); });
    await assert.rejects(hook(input, { method: 'POST' }), error => {
      assert.match(error.message, reconcile);
      assert.doesNotMatch(error.message, /fake-private/);
      return true;
    });
    assert.equal(posts, 0);
    assert.equal(store.transactions, 0);
  }
});

test('malformed queue identifiers, signed response URLs and route mismatches cannot persist or trigger another POST', async () => {
  const invalid = [
    { request_id: '' }, { request_id: 'request/123' }, { request_id: 'fake-private\nvalue' },
    { request_id: 'x'.repeat(129) }, { request_id: 123 },
    { response_url: 'https://queue.fal.run/fal-ai/wan/requests/different-request' },
    { response_url: 'https://queue.fal.run/fal-ai/wan/requests/different-request/response' },
    { response_url: 'https://media.example/fal-ai/wan/requests/request-123' },
    { response_url: 'http://queue.fal.run/fal-ai/wan/requests/request-123' },
    { response_url: 'https://queue.fal.run/other-provider/wan/requests/request-123' },
    { response_url: 'https://queue.fal.run/fal-ai/wan/requests/request-123/status' },
    { response_url: `${responseUrl}/response/extra` },
    { response_url: `${responseUrl}/response/response` },
    { response_url: `${responseUrl}?signature=fake-private-signature` },
    { response_url: `${responseUrl}#fake-private-fragment` },
    { response_url: 'https://fake-private-user@queue.fal.run/fal-ai/wan/requests/request-123' },
    { response_url: 'https://queue.fal.run/fal-ai/%2e%2e/wan/requests/request-123' },
    { response_url: 'https://queue.fal.run/fal-ai/../wan/requests/request-123' },
    { response_url: null },
  ];
  for (const overrides of invalid) {
    const store = memoryStore();
    let posts = 0;
    const hook = capture(store, async () => { posts += 1; return queueResponse(overrides); });
    await assert.rejects(hook(submittedUrl, { method: 'POST' }), error => {
      assert.match(error.message, reconcile);
      assert.doesNotMatch(error.message, /fake-private/);
      return true;
    });
    await assert.rejects(hook(submittedUrl, { method: 'POST' }), reconcile);
    assert.equal(posts, 1);
    assert.equal(store.transactions, 0);
    assert.equal(store.state.spending[0].remoteRequest, undefined);
  }
});

test('invalid or oversized queue response bodies are bounded, sanitized and never retried', async () => {
  const responses = [
    new Response('fake-private-malformed-json', { headers: { 'Content-Type': 'application/json' } }),
    Response.json(null), Response.json([]), Response.json({}),
    queueResponse({ ignored: 'x'.repeat(65_536) }),
    new Response(null, { status: 204 }),
  ];
  for (const response of responses) {
    const store = memoryStore();
    let posts = 0;
    const hook = capture(store, async () => { posts += 1; return response; });
    await assert.rejects(hook(submittedUrl, { method: 'POST' }), error => {
      assert.match(error.message, reconcile);
      assert.doesNotMatch(error.message, /fake-private/);
      return true;
    });
    await assert.rejects(hook(submittedUrl, { method: 'POST' }), reconcile);
    assert.equal(posts, 1);
    assert.equal(store.transactions, 0);
    await response.text();
  }
});

test('a failed persistence commit withholds the response and keeps the same hook from submitting again', async () => {
  const store = memoryStore({ beforeCommit: async () => { throw new Error('Simulated storage unavailable'); } });
  const response = queueResponse();
  let posts = 0;
  const hook = capture(store, async () => { posts += 1; return response; });
  await assert.rejects(hook(submittedUrl, { method: 'POST' }));
  assert.equal(store.state.spending[0].remoteRequest, undefined);
  await assert.rejects(hook(submittedUrl, { method: 'POST' }), reconcile);
  assert.equal(posts, 1);
  assert.equal(store.transactions, 1);
  assert.deepEqual(await response.json(), { request_id: 'request-123', status: 'IN_QUEUE', response_url: responseUrl });
});

test('a receipt binds to exactly one reserved fal-ai video generation and cannot replace an existing receipt', async () => {
  const invalid = [
    [], [{ id: 'other-reservation', status: 'reserved', provider: 'fal-ai', kind: 'video' }],
    [{ id: reservationId, status: 'unknown', provider: 'fal-ai', kind: 'video' }],
    [{ id: reservationId, status: 'completed', provider: 'fal-ai', kind: 'video' }],
    [{ id: reservationId, status: 'reserved', provider: 'hf-inference', kind: 'video' }],
    [{ id: reservationId, status: 'reserved', provider: 'fal-ai', kind: 'image' }],
    [{ id: reservationId, status: 'reserved', provider: 'fal-ai', kind: 'video', remoteRequest: { requestId: 'older-request' } }],
  ];
  for (const spending of invalid) {
    const store = memoryStore({ spending });
    const original = structuredClone(store.state);
    let posts = 0;
    const hook = capture(store, async () => { posts += 1; return queueResponse(); });
    await assert.rejects(hook(submittedUrl, { method: 'POST' }), reconcile);
    await assert.rejects(hook(submittedUrl, { method: 'POST' }), reconcile);
    assert.deepEqual(store.state, original);
    assert.equal(posts, 1);
  }
});

test('an HTTP 503 passes through unchanged for SDK handling while the hook forbids a second POST', async () => {
  const store = memoryStore();
  const response = Response.json({ error: 'fake-private-provider-error' }, { status: 503 });
  let posts = 0;
  const hook = capture(store, async () => { posts += 1; return response; });
  assert.equal(await hook(submittedUrl, { method: 'POST' }), response);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'fake-private-provider-error' });
  assert.equal(store.transactions, 0);
  await assert.rejects(hook(submittedUrl, { method: 'POST' }), reconcile);
  assert.equal(posts, 1);
});

test('a transport failure preserves the no-repeat barrier even without an HTTP response', async () => {
  const store = memoryStore();
  let posts = 0;
  const hook = capture(store, async () => { posts += 1; throw new Error('Simulated transport failure'); });
  await assert.rejects(hook(submittedUrl, { method: 'POST' }));
  await assert.rejects(hook(submittedUrl, { method: 'POST' }), reconcile);
  assert.equal(posts, 1);
  assert.equal(store.transactions, 0);
});

test('Hub mapping GETs pass through with their input, options and consumable response untouched', async () => {
  for (const input of ['https://huggingface.co/api/models/Wan-AI/Wan2.2-T2V-A14B',
    new URL('https://huggingface.co/api/models/Wan-AI/Wan2.2-T2V-A14B'),
    new Request('https://huggingface.co/api/models/Wan-AI/Wan2.2-T2V-A14B')]) {
    const store = memoryStore();
    const response = Response.json({ inferenceProviderMapping: { 'fal-ai': { status: 'live', task: 'text-to-video' } } });
    const options = { headers: { Authorization: 'Bearer fake-token' }, redirect: 'follow' };
    const calls = [];
    const hook = capture(store, async (passedInput, passedOptions) => {
      calls.push({ input: passedInput, options: passedOptions });
      return response;
    });
    assert.equal(await hook(input, options), response);
    assert.equal(calls[0].input, input);
    assert.equal(calls[0].options, options);
    assert.deepEqual(await response.json(), { inferenceProviderMapping: { 'fal-ai': { status: 'live', task: 'text-to-video' } } });
    assert.equal(store.transactions, 0);
  }
});

test('a POST Request object supplies the submission method and preserves its body for the fetch implementation', async () => {
  const store = memoryStore();
  const input = new Request(submittedUrl, { method: 'POST', body: JSON.stringify({ prompt: 'Original synthetic scene' }) });
  const response = queueResponse();
  const hook = capture(store, async (passedInput, options) => {
    assert.equal(passedInput, input);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(await passedInput.json(), { prompt: 'Original synthetic scene' });
    return response;
  });
  assert.equal(await hook(input), response);
  assert.deepEqual(store.state.spending[0].remoteRequest, expectedReceipt());
});
