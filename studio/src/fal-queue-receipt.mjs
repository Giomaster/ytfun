const ROUTER = 'https://router.huggingface.co';
const QUEUE = 'https://queue.fal.run';
const MAX_RECEIPT_BYTES = 65_536;
const SAFE_PATH = /^\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const fail = () => new Error('The fal-ai queue receipt was not safely persisted; reconcile the existing attempt without submitting again.');

function url(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\%]/.test(value)) throw fail();
  let parsed;
  try { parsed = new URL(value); } catch { throw fail(); }
  if (parsed.username || parsed.password || parsed.hash || !SAFE_PATH.test(parsed.pathname) ||
      value !== parsed.href || parsed.pathname.split('/').some(part => part === '.' || part === '..')) throw fail();
  return parsed;
}

function submissionUrl(value) {
  const parsed = url(value);
  if (parsed.origin !== ROUTER || !parsed.pathname.startsWith('/fal-ai/') ||
      parsed.search !== '?_subdomain=queue') throw fail();
  return parsed.href;
}

async function queueBody(response) {
  const reader = response.clone().body?.getReader();
  if (!reader) throw fail();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RECEIPT_BYTES) throw fail();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // A tee branch's cancellation may wait for its sibling; do not block here.
    void reader.cancel().catch(() => {});
    throw fail();
  } finally { reader.releaseLock(); }
}

function receipt(body, submittedUrl) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof body.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(body.request_id)) throw fail();
  const response = url(body.response_url);
  const requestSuffix = `/requests/${body.request_id}`;
  if (response.origin !== QUEUE || response.search || !response.pathname.startsWith('/fal-ai/') ||
      !(response.pathname.endsWith(requestSuffix) || response.pathname.endsWith(`${requestSuffix}/response`))) throw fail();
  return {
    provider: 'fal-ai', transport: 'huggingface-router', requestId: body.request_id,
    submissionUrl: submittedUrl, responsePath: response.pathname,
    status: ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'].includes(body.status) ? body.status : 'unknown',
  };
}

/** Supported HF SDK Options.fetch hook. Return the POST response only after its receipt commits. */
export function falQueueReceiptFetch(store, reservationId, { fetchImpl = fetch, now = Date.now } = {}) {
  let submitted = false;
  return async (input, options = {}) => {
    const method = (options.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'POST') return fetchImpl(input, options);
    const submittedUrl = submissionUrl(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
    if (submitted) throw fail();
    submitted = true;
    try {
      const response = await fetchImpl(input, { ...options, redirect: 'error' });
      // A rejected/ambiguous HTTP response remains the SDK's sanitized failure path.
      if (!response.ok) return response;
      const remote = receipt(await queueBody(response), submittedUrl);
      await store.transaction(state => {
        const reservation = state.spending.find(item => item.id === reservationId);
        if (!reservation || reservation.status !== 'reserved' || reservation.provider !== 'fal-ai' ||
            reservation.kind !== 'video' || reservation.remoteRequest) throw fail();
        reservation.remoteRequest = { ...remote, capturedAt: new Date(now()).toISOString() };
      });
      return response;
    } catch {
      // A transport/store exception may include headers or provider response text.
      throw fail();
    }
  };
}
