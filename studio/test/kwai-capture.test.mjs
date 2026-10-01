import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTURE_LIMITS, inspectKwaiHar, runCli } from '../scripts/inspect-kwai-har.mjs';

const ALLOWED = { allowedHosts: ['www.kwai.com'] };
const SECRET = 'NEVER_EMIT_ACCOUNT_OR_CREDENTIAL_97c5e07e';

function entry(overrides = {}) {
  return {
    request: {
      url: 'https://www.kwai.com/rest/video/upload', method: 'POST', bodySize: 512,
      queryString: [],
      postData: { mimeType: 'application/json; charset=utf-8', text: '{"title":"A synthetic cat","privacy":"public"}' },
    },
    response: { status: 200, bodySize: 128, content: { size: 128, mimeType: 'application/json' } },
    ...overrides,
  };
}

function har(entries = [entry()]) {
  return { log: { version: '1.2', entries } };
}

function output() {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: { write(text) { stdout += text; } },
      stderr: { write(text) { stderr += text; } },
    },
    read() { return { stdout, stderr }; },
  };
}

test('inventory is offline evidence and only reports explicitly selected hosts', () => {
  const selected = entry();
  const excluded = entry({ request: { ...selected.request, url: 'https://mail.example.com/private/inbox' } });
  const result = inspectKwaiHar(har([selected, selected, excluded]), ALLOWED);
  assert.equal(result.provesPublication, false);
  assert.equal(result.selectedEntries, 2);
  assert.equal(result.excludedEntries, 1);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].count, 2);
  assert.deepEqual(result.observations[0], {
    host: 'www.kwai.com', pathTemplate: '/rest/video/upload', method: 'POST', status: 200,
    requestMimeType: 'application/json', responseMimeType: 'application/json',
    requestBodyBytes: 512, responseBodyBytes: 128, responseContentBytes: 128,
    queryFields: { names: [], redactedNameCount: 0 },
    requestBodyFields: { names: ['privacy', 'title'], redactedNameCount: 0, inspection: 'json_names' },
    count: 2,
  });
  assert.equal(JSON.stringify(result).includes('mail.example.com'), false);
});

test('path, query, field-name, headers, cookies and all payload values are redacted', () => {
  const selected = entry();
  selected.request.url = `https://www.kwai.com/rest/${SECRET}/video/123/abc-${SECRET}.mp4?title=${SECRET}&${SECRET}=${SECRET}#${SECRET}`;
  selected.request.queryString = [{ name: 'title', value: SECRET }, { name: SECRET, value: SECRET }];
  selected.request.headers = [{ name: 'Authorization', value: SECRET }];
  selected.request.cookies = [{ name: 'session', value: SECRET }];
  selected.request.postData = {
    mimeType: `application/json; boundary=${SECRET}`,
    text: JSON.stringify({ title: SECRET, [SECRET]: SECRET, token: SECRET, data: { description: SECRET } }),
  };
  selected.response.headers = [{ name: 'Set-Cookie', value: SECRET }];
  selected.response.cookies = [{ name: 'session', value: SECRET }];
  selected.response.redirectURL = `https://www.kwai.com/${SECRET}`;
  selected.response.content.text = JSON.stringify({ [SECRET]: SECRET });
  const result = inspectKwaiHar(har([selected]), ALLOWED);
  const serialized = JSON.stringify(result);
  for (const forbidden of [SECRET, 'Authorization', 'Set-Cookie', 'redirectURL', 'token']) {
    assert.equal(serialized.includes(forbidden), false, `output excludes ${forbidden}`);
  }
  assert.equal(result.observations[0].pathTemplate, '/rest/:segment/video/:id/:file');
  assert.deepEqual(result.observations[0].queryFields, { names: ['title'], redactedNameCount: 1 });
  assert.deepEqual(result.observations[0].requestBodyFields, {
    names: ['data', 'description', 'title'], redactedNameCount: 2, inspection: 'json_names',
  });
});

test('allowlist never expands to a subdomain or lookalike implicitly', () => {
  const base = entry();
  const urls = [
    'https://upload.kwai.com/rest/video/upload',
    'https://www.kwai.com.evil.example/rest/video/upload',
    'https://www.kwai.net/rest/video/upload',
    'https://cutmotions.com/rest/video/upload',
  ];
  const result = inspectKwaiHar(har(urls.map((url) => entry({ request: { ...base.request, url } }))), ALLOWED);
  assert.equal(result.selectedEntries, 0);
  assert.equal(result.excludedEntries, urls.length);
  const configured = inspectKwaiHar(har([entry({ request: { ...base.request, url: urls[0] } })]), { allowedHosts: ['upload.kwai.com'] });
  assert.equal(configured.selectedEntries, 1);
  for (const allowedHosts of [undefined, [], ['*'], ['evil.example'], ['kwai.com.evil.example'], ['https://www.kwai.com'], ['www.kwai.com:443']]) {
    assert.throws(() => inspectKwaiHar(har(), { allowedHosts }), /Kwai capture inventory failed/);
  }
});

test('observed mobile hosts require exact selection and exclude siblings and spoofed destinations', () => {
  const base = entry();
  const allowedHosts = ['az2-api-akpro.kwaipros.com', 'kste.ksapisrv.com'];
  const excludedHosts = [
    'other.kwaipros.com', 'kwaipros.com',
    'ksapisrv.com', 'other.ksapisrv.com', 'sub.kste.ksapisrv.com',
    'az2-api-akpro.kwaipros.com.evil.example', 'kwaipros.com.evil.example',
    'kste.ksapisrv.com.evil.example', 'notkwaipros.com', 'notkste.ksapisrv.com',
    'foreign.example',
  ];
  const entries = [...allowedHosts, ...excludedHosts].map((host) =>
    entry({ request: { ...base.request, url: `https://${host}/rest/video/upload` } }));
  const result = inspectKwaiHar(har(entries), { allowedHosts });
  assert.equal(result.selectedEntries, allowedHosts.length);
  assert.equal(result.excludedEntries, excludedHosts.length);
  assert.deepEqual(result.observations.map((observation) => observation.host), allowedHosts);
  assert.equal(result.provesPublication, false);
});

test('configuration permits the observed kwaipros family and only the single ksapisrv host', () => {
  const base = entry();
  for (const host of ['kwaipros.com', 'az2-api-akpro.kwaipros.com', 'other.kwaipros.com', 'kste.ksapisrv.com']) {
    const result = inspectKwaiHar(har([entry({ request: { ...base.request, url: `https://${host}/rest/video/upload` } })]), { allowedHosts: [host] });
    assert.equal(result.selectedEntries, 1);
  }
  for (const host of [
    'ksapisrv.com', 'other.ksapisrv.com', 'sub.kste.ksapisrv.com', 'notkste.ksapisrv.com',
    'az2-api-akpro.kwaipros.com.evil.example', 'notkwaipros.com',
    'kste.ksapisrv.com.evil.example', 'foreign.example',
  ]) {
    assert.throws(() => inspectKwaiHar(har(), { allowedHosts: [host] }), /Kwai capture inventory failed/);
  }
});

test('malformed or unsafe selected entries fail without reflecting private input', () => {
  const base = entry();
  const variants = [
    entry({ request: { ...base.request, url: `https://${SECRET}:password@www.kwai.com/rest/video` } }),
    entry({ request: { ...base.request, url: 'http://www.kwai.com/rest/video' } }),
    entry({ request: { ...base.request, url: 'https://www.kwai.com:8443/rest/video' } }),
    entry({ request: { ...base.request, method: SECRET } }),
    entry({ response: { ...base.response, status: SECRET } }),
    entry({ request: { ...base.request, queryString: [{ name: SECRET.repeat(30) }] } }),
    entry({ request: { ...base.request, postData: { mimeType: 'application/json', text: `{${SECRET}` } } }),
    entry({ request: { ...base.request, bodySize: -2 } }),
    entry({ response: { ...base.response, content: 'not-an-object' } }),
  ];
  for (const variant of variants) {
    assert.throws(() => inspectKwaiHar(har([variant]), ALLOWED), (error) => {
      assert.equal(error.message.includes(SECRET), false);
      assert.equal(error.message, 'Kwai capture inventory failed. Check the HAR format, limits and explicit hosts.');
      return true;
    });
  }
  assert.throws(() => inspectKwaiHar({ log: { version: '0.1', entries: [] } }, ALLOWED));
  assert.throws(() => inspectKwaiHar(har(Array(CAPTURE_LIMITS.entries + 1).fill(base)), ALLOWED));
  assert.throws(() => inspectKwaiHar(har([entry({ request: { ...base.request, url: `https://www.kwai.com/${'a'.repeat(CAPTURE_LIMITS.urlCharacters)}` } })]), ALLOWED));
});

test('unknown MIME types and uninspected or bounded bodies cannot carry secrets', () => {
  const base = entry();
  const variants = [
    entry({ request: { ...base.request, postData: { mimeType: SECRET, text: SECRET, params: [{ name: 'file', value: SECRET, fileName: SECRET }, { name: SECRET, value: SECRET }] } } }),
    entry({ request: { ...base.request, postData: { mimeType: 'application/json', text: JSON.stringify({ title: SECRET.repeat(CAPTURE_LIMITS.jsonBodyBytes) }) } } }),
    entry({ request: { ...base.request, postData: { mimeType: 'application/json', text: JSON.stringify({ data: { data: { data: { data: { title: SECRET } } } } }) } } }),
  ];
  const result = inspectKwaiHar(har(variants), ALLOWED);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(result.observations[0].requestMimeType, 'unknown');
  assert.deepEqual(result.observations[0].requestBodyFields, { names: ['file'], redactedNameCount: 1, inspection: 'parameter_names' });
  assert.equal(result.observations[1].requestBodyFields.inspection, 'body_size_limit');
  assert.equal(result.observations[2].requestBodyFields.inspection, 'json_names_limited');
});

test('CLI outputs only a complete sanitized report and has non-reflective errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kwai-capture-ci-'));
  try {
    const file = join(directory, `${SECRET}.har`);
    await writeFile(file, JSON.stringify(har()), { mode: 0o600 });
    const success = output();
    assert.equal(await runCli([file, '--host', 'www.kwai.com'], success.streams), 0);
    assert.equal(JSON.parse(success.read().stdout).selectedEntries, 1);
    assert.equal(success.read().stderr, '');
    assert.equal(success.read().stdout.includes(SECRET), false);

    await writeFile(file, `{${SECRET}`, { mode: 0o600 });
    const failure = output();
    assert.equal(await runCli([file, '--host', 'www.kwai.com'], failure.streams), 1);
    assert.equal(failure.read().stdout, '');
    assert.equal(failure.read().stderr.includes(SECRET), false);

    const invalidArgs = output();
    assert.equal(await runCli([file, '--secret', SECRET], invalidArgs.streams), 1);
    assert.equal(invalidArgs.read().stdout, '');
    assert.equal(invalidArgs.read().stderr.includes(SECRET), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI refuses a symlink or oversized raw capture before parsing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kwai-capture-limit-ci-'));
  try {
    const file = join(directory, 'capture.har');
    const link = join(directory, 'capture-link.har');
    await writeFile(file, JSON.stringify(har()), { mode: 0o600 });
    await symlink(file, link);
    const linked = output();
    assert.equal(await runCli([link, '--host', 'www.kwai.com'], linked.streams), 1);
    assert.equal(linked.read().stdout, '');
    await writeFile(file, Buffer.alloc(CAPTURE_LIMITS.fileBytes + 1), { mode: 0o600 });
    const oversized = output();
    assert.equal(await runCli([file, '--host', 'www.kwai.com'], oversized.streams), 1);
    assert.equal(oversized.read().stdout, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
