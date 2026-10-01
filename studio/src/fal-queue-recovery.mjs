const ROUTER = 'https://router.huggingface.co';
const MAX_JSON_BYTES = 65_536;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const SAFE_PATH = /^\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const STATES = new Set(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']);
const failure = () => new Error('The existing fal-ai request could not be safely retrieved; preserve its receipt and do not submit again.');

function queuePath(receipt) {
  if (receipt?.provider !== 'fal-ai' || receipt.transport !== 'huggingface-router' ||
      typeof receipt.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(receipt.requestId) ||
      typeof receipt.responsePath !== 'string' || receipt.responsePath.length > 2048 ||
      !SAFE_PATH.test(receipt.responsePath) || !receipt.responsePath.startsWith('/fal-ai/') ||
      receipt.responsePath.split('/').some(part => part === '.' || part === '..')) throw failure();
  const suffix = `/requests/${receipt.requestId}`;
  if (receipt.responsePath.endsWith(suffix)) return receipt.responsePath;
  if (receipt.responsePath.endsWith(`${suffix}/response`)) return receipt.responsePath.slice(0, -'/response'.length);
  throw failure();
}

function mediaUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/.test(value)) throw failure();
  let parsed;
  try { parsed = new URL(value); } catch { throw failure(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash ||
      !(parsed.hostname === 'fal.media' || /^[A-Za-z0-9-]+\.fal\.media$/.test(parsed.hostname) ||
        (parsed.hostname === 'storage.googleapis.com' && parsed.pathname.startsWith('/falserverless/')))) throw failure();
  return parsed.href;
}

async function boundedBody(response, limit) {
  if (!response.ok) throw failure();
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw failure();
  const reader = response.body?.getReader();
  if (!reader) throw failure();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw failure();
      chunks.push(value);
    }
    if (!size) throw failure();
    return Buffer.concat(chunks, size);
  } catch {
    void reader.cancel().catch(() => {});
    throw failure();
  } finally { reader.releaseLock(); }
}

async function jsonBody(response) {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw failure();
  try { return JSON.parse((await boundedBody(response, MAX_JSON_BYTES)).toString('utf8')); }
  catch { throw failure(); }
}

/** One queue snapshot and, if completed, its original MP4. Never submits, retries or cancels inference. */
export async function recoverFalVideo(receipt, { hfToken, fetchImpl = fetch, signal } = {}) {
  const responsePath = queuePath(receipt);
  if (typeof hfToken !== 'string' || !hfToken || /\s/.test(hfToken)) throw failure();
  const deadline = AbortSignal.timeout(180_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const headers = { Authorization: `Bearer ${hfToken}`, Accept: 'application/json' };
  // HF's official SDK prefixes the original fal response path with /fal-ai.
  // A /response suffix is the result route, while status belongs to its request.
  const base = `${ROUTER}/fal-ai${responsePath}`;
  const resultPath = receipt.responsePath.endsWith('/response') ? `${base}/response` : base;
  try {
    const status = await jsonBody(await fetchImpl(`${base}/status?_subdomain=queue`, {
      method: 'GET', headers, redirect: 'error', signal: requestSignal,
    }));
    if (!status || typeof status !== 'object' || Array.isArray(status) || !STATES.has(status.status) ||
        (status.request_id !== undefined && status.request_id !== receipt.requestId) || status.error || status.error_type) throw failure();
    if (status.status !== 'COMPLETED') return { requestId: receipt.requestId, remoteStatus: status.status };
    const result = await jsonBody(await fetchImpl(`${resultPath}?_subdomain=queue`, {
      method: 'GET', headers, redirect: 'error', signal: requestSignal,
    }));
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.error || result.error_type) throw failure();
    const video = await fetchImpl(mediaUrl(result.video?.url), {
      method: 'GET', headers: { Accept: 'video/mp4' }, redirect: 'error', signal: requestSignal,
    });
    // Provider authorization is deliberately absent from the public media GET.
    const type = video.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!['video/mp4', 'application/octet-stream'].includes(type)) throw failure();
    const bytes = await boundedBody(video, MAX_VIDEO_BYTES);
    if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw failure();
    return { requestId: receipt.requestId, remoteStatus: 'COMPLETED', blob: new Blob([bytes], { type: 'video/mp4' }) };
  } catch {
    // Tokens, signed URLs, provider response bodies and transport errors stay private.
    throw failure();
  }
}
