#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const CAPTURE_LIMITS = Object.freeze({
  fileBytes: 20 * 1024 * 1024,
  entries: 2000,
  hosts: 20,
  urlCharacters: 8192,
  fieldsPerList: 1000,
  jsonBodyBytes: 128 * 1024,
  jsonBodyNodes: 1000,
  jsonBodyDepth: 4,
});

const HOST_FAMILIES = ['kwai.com', 'kwai.net', 'kwai-pro.com', 'cutmotions.com', 'kwaicdn.com'];
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
// Only this fixed vocabulary can survive into output. A plausible-looking
// account name, opaque identifier or credential must never become a path label.
const PATH_WORDS = new Set([
  'api', 'rest', 'web', 'app', 'open', 'upload', 'uploads', 'download', 'start',
  'finish', 'complete', 'commit', 'init', 'initialize', 'cancel', 'publish',
  'publication', 'create', 'update', 'delete', 'status', 'check', 'poll', 'list',
  'query', 'feed', 'user', 'users', 'account', 'profile', 'video', 'videos',
  'photo', 'photos', 'media', 'asset', 'assets', 'file', 'files', 'reel',
  'caption', 'thumbnail', 'cover', 'comment', 'comments', 'session', 'config',
]);
const FIELD_WORDS = new Set([
  'id', 'userId', 'user_id', 'accountId', 'account_id', 'photoId', 'photo_id',
  'videoId', 'video_id', 'uploadId', 'upload_id', 'mediaId', 'media_id',
  'file', 'files', 'fileName', 'file_name', 'fileSize', 'file_size', 'fileType',
  'file_type', 'size', 'length', 'offset', 'chunk', 'chunkIndex', 'chunk_index',
  'chunkSize', 'chunk_size', 'total', 'title', 'caption', 'description',
  'text', 'hashtags', 'tags', 'cover', 'thumbnail', 'width', 'height',
  'duration', 'format', 'mimeType', 'mime_type', 'type', 'status', 'result',
  'code', 'message', 'data', 'items', 'page', 'cursor', 'limit', 'privacy',
  'visibility', 'isAigc', 'is_aigc', 'synthetic', 'publishTime', 'publish_time',
]);
const MIME_TYPES = new Set([
  'application/json', 'application/octet-stream', 'application/x-www-form-urlencoded',
  'multipart/form-data', 'text/plain', 'text/html', 'text/css',
  'application/javascript', 'text/javascript', 'video/mp4', 'video/webm',
  'video/quicktime', 'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav',
]);
const FAILURE = 'Kwai capture inventory failed. Check the HAR format, limits and explicit hosts.';

function requireValid(condition) {
  if (!condition) throw new Error(FAILURE);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHosts(hosts) {
  requireValid(Array.isArray(hosts) && hosts.length > 0 && hosts.length <= CAPTURE_LIMITS.hosts);
  return new Set(hosts.map((host) => {
    requireValid(typeof host === 'string' && host.length <= 253);
    const normalized = host.toLowerCase();
    requireValid(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized));
    requireValid(normalized.split('.').every((label) => label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-')));
    requireValid(HOST_FAMILIES.some((family) => normalized === family || normalized.endsWith(`.${family}`)));
    return normalized;
  }));
}

function pathTemplate(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  requireValid(segments.length <= 100);
  return '/' + segments.map((segment) => {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { return ':segment'; }
    if (PATH_WORDS.has(decoded)) return decoded;
    if (/^v[1-9][0-9]?$/.test(decoded)) return decoded;
    if (/^[0-9]+$/.test(decoded)) return ':id';
    if (/\.(?:mp4|webm|mov|jpg|jpeg|png|webp|gif|m3u8|m4s|ts)$/i.test(decoded)) return ':file';
    return ':segment';
  }).join('/');
}

function mimeType(value) {
  if (value === undefined || value === '') return null;
  requireValid(typeof value === 'string' && value.length <= 512);
  const normalized = value.split(';', 1)[0].trim().toLowerCase();
  return MIME_TYPES.has(normalized) ? normalized : 'unknown';
}

function byteCount(value) {
  if (value === undefined || value === -1) return null;
  requireValid(Number.isSafeInteger(value) && value >= 0 && value <= 16 * 1024 * 1024 * 1024);
  return value;
}

function fieldSummary(names) {
  const known = new Set();
  const redacted = new Set();
  for (const name of names) {
    requireValid(typeof name === 'string' && name.length <= 1024);
    if (FIELD_WORDS.has(name)) known.add(name);
    else redacted.add(name);
  }
  return { names: [...known].sort(), redactedNameCount: redacted.size };
}

function namesFromParams(params) {
  if (params === undefined) return [];
  requireValid(Array.isArray(params) && params.length <= CAPTURE_LIMITS.fieldsPerList);
  return params.map((param) => {
    requireValid(record(param) && typeof param.name === 'string');
    return param.name;
  });
}

function bodyFields(postData, requestMimeType) {
  if (postData === undefined) return { names: [], redactedNameCount: 0, inspection: 'absent' };
  requireValid(record(postData));
  const names = namesFromParams(postData.params);
  let inspection = postData.params === undefined ? 'not_inspected' : 'parameter_names';
  if (postData.text !== undefined) requireValid(typeof postData.text === 'string');
  if (requestMimeType === 'application/json' && postData.text) {
    if (Buffer.byteLength(postData.text, 'utf8') > CAPTURE_LIMITS.jsonBodyBytes) {
      inspection = 'body_size_limit';
    } else {
      let value;
      try { value = JSON.parse(postData.text); } catch { throw new Error(FAILURE); }
      const queue = [{ value, depth: 0 }];
      let nodes = 0;
      let truncated = false;
      while (queue.length > 0 && nodes < CAPTURE_LIMITS.jsonBodyNodes) {
        const item = queue.pop();
        nodes += 1;
        if (item.value === null || typeof item.value !== 'object') continue;
        if (item.depth >= CAPTURE_LIMITS.jsonBodyDepth) { truncated = true; continue; }
        const pairs = Array.isArray(item.value)
          ? item.value.slice(0, CAPTURE_LIMITS.fieldsPerList).map((child) => [null, child])
          : Object.entries(item.value).slice(0, CAPTURE_LIMITS.fieldsPerList);
        if (Object.keys(item.value).length > CAPTURE_LIMITS.fieldsPerList) truncated = true;
        for (const [name, child] of pairs) {
          if (name !== null) names.push(name);
          if (queue.length < CAPTURE_LIMITS.jsonBodyNodes) queue.push({ value: child, depth: item.depth + 1 });
          else truncated = true;
        }
      }
      if (queue.length > 0) truncated = true;
      inspection = truncated ? 'json_names_limited' : 'json_names';
    }
  }
  return { ...fieldSummary(names), inspection };
}

/** Offline metadata only. This function has no network or publication capability. */
export function inspectKwaiHar(har, { allowedHosts } = {}) {
  const hosts = normalizeHosts(allowedHosts);
  requireValid(record(har) && record(har.log));
  requireValid(['1.1', '1.2'].includes(har.log.version));
  requireValid(Array.isArray(har.log.entries) && har.log.entries.length <= CAPTURE_LIMITS.entries);
  const observations = new Map();
  let selectedEntries = 0;
  for (const entry of har.log.entries) {
    requireValid(record(entry) && record(entry.request) && record(entry.response));
    const request = entry.request;
    const response = entry.response;
    requireValid(typeof request.url === 'string' && request.url.length <= CAPTURE_LIMITS.urlCharacters);
    let url;
    try { url = new URL(request.url); } catch { throw new Error(FAILURE); }
    if (!hosts.has(url.hostname)) continue;
    requireValid(url.protocol === 'https:' && !url.username && !url.password && !url.port);
    requireValid(METHODS.has(request.method));
    requireValid(Number.isInteger(response.status) && (response.status === 0 || (response.status >= 100 && response.status <= 599)));
    requireValid(response.content === undefined || record(response.content));
    requireValid(request.postData === undefined || record(request.postData));
    const requestMimeType = mimeType(request.postData?.mimeType);
    const observation = {
      host: url.hostname,
      pathTemplate: pathTemplate(url.pathname),
      method: request.method,
      status: response.status,
      requestMimeType,
      responseMimeType: mimeType(response.content?.mimeType),
      requestBodyBytes: byteCount(request.bodySize),
      responseBodyBytes: byteCount(response.bodySize),
      responseContentBytes: byteCount(response.content?.size),
      queryFields: fieldSummary([...url.searchParams.keys(), ...namesFromParams(request.queryString)]),
      requestBodyFields: bodyFields(request.postData, requestMimeType),
    };
    requireValid([...url.searchParams.keys()].length <= CAPTURE_LIMITS.fieldsPerList);
    const key = JSON.stringify(observation);
    const previous = observations.get(key);
    if (previous) previous.count += 1;
    else observations.set(key, { ...observation, count: 1 });
    selectedEntries += 1;
  }
  return {
    schemaVersion: 1,
    purpose: 'offline_sanitized_endpoint_inventory',
    provesPublication: false,
    selectedEntries,
    excludedEntries: har.log.entries.length - selectedEntries,
    observations: [...observations.values()],
    limitations: [
      'Paths and field names use a fixed safe vocabulary; other names are redacted.',
      'Only explicitly selected hosts are included. Headers, cookies, values and response bodies are omitted.',
      'Observing a request does not prove an upload, publication, authorization or API contract.',
    ],
  };
}

async function readHar(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireValid(stat.isFile() && stat.size > 0 && stat.size <= CAPTURE_LIMITS.fileBytes);
    const buffer = Buffer.alloc(CAPTURE_LIMITS.fileBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    requireValid(total > 0 && total <= CAPTURE_LIMITS.fileBytes);
    const json = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total));
    return JSON.parse(json);
  } finally {
    await handle.close();
  }
}

export async function runCli(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length === 1 && argv[0] === '--help') {
    stdout.write('Usage: node studio/scripts/inspect-kwai-har.mjs <private.har> --host <observed-host> [--host <observed-host>]\nOffline only. Never commit or share the raw HAR.\n');
    return 0;
  }
  try {
    requireValid(argv.length >= 3 && typeof argv[0] === 'string' && !argv[0].startsWith('-'));
    const allowedHosts = [];
    for (let index = 1; index < argv.length; index += 2) {
      requireValid(argv[index] === '--host' && typeof argv[index + 1] === 'string');
      allowedHosts.push(argv[index + 1]);
    }
    // Validate configuration before accessing any private file.
    normalizeHosts(allowedHosts);
    const report = inspectKwaiHar(await readHar(argv[0]), { allowedHosts });
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch {
    stderr.write(`${FAILURE}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
