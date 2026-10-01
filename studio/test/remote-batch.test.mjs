import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StudioStore } from '../src/store.mjs';
import { RemoteBatch, BATCH_MODEL, BATCH_ESTIMATE, hash, packetHash, validatePacket, sourceUrl } from '../src/remote-batch.mjs';
import { unpackPacket, assertNoPreviousSubmission, runWorker } from '../scripts/remote-batch-worker.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-remote-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StudioStore(directory); const projectId = randomUUID(); const episodeId = randomUUID(); const sourceId = randomUUID(); const sceneId = randomUUID();
  const bytes = Buffer.from('0000ftypremote-original');
  await store.transaction(state => {
    state.projects.push({ id: projectId, status: 'active', budgetMonthlyUsd: null });
    state.episodes.push({ id: episodeId, projectId, title: 'Original collection', format: 'long', audioMode: 'silent', status: 'planned', scenes: [{ id: sceneId, durationSeconds: 7.5, visualPrompt: 'One supported sphere, one unique hidden world.' }], render: null });
    state.assets.push({ id: sourceId, episodeId: randomUUID(), sceneId: randomUUID(), kind: 'video', synthetic: true, sha256: hash(bytes), provenance: { commercialLicense: { url: 'https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B' } } });
  });
  const service = new RemoteBatch(store);
  const input = { episodeId, sourceAssetId: sourceId, referenceUrl: 'https://v3.fal.media/files/original.mp4', sceneIds: [sceneId], costCeilingUsd: 1, acknowledgePaidCost: true, paidGenerationEnabled: true };
  return { store, service, input, directory, sceneId };
}

test('remote reservation is persistent, budgeted and blocks a duplicate submission', async t => {
  const { store, service, input } = await fixture(t);
  await assert.rejects(service.reserve({ ...input, acknowledgePaidCost: false }), /authorized/);
  await assert.rejects(service.reserve({ ...input, costCeilingUsd: 0.5 }), /ceiling/);
  assert.equal((await store.read()).spending.length, 0);
  const packet = await service.reserve(input);
  assert.equal(packet.model, BATCH_MODEL); assert.equal(packet.estimatedCostPerSceneUsd, BATCH_ESTIMATE);
  assert.equal((await store.read()).spending[0].status, 'reserved');
  await assert.rejects(service.reserve(input), /reconciled/);
});

test('packet integrity, distinct scenes and original media host are enforced', async t => {
  const { service, input } = await fixture(t); const packet = await service.reserve(input);
  const encoded = gzipSync(JSON.stringify(packet)).toString('base64');
  assert.deepEqual(unpackPacket(encoded, packetHash(packet)), packet);
  assert.throws(() => unpackPacket(encoded, '0'.repeat(64)), /identity/);
  assert.throws(() => validatePacket({ ...packet, scenes: [packet.scenes[0], packet.scenes[0]] }), /selection/);
  assert.throws(() => sourceUrl('https://fal.media.evil.test/x'), /owned/);
  assert.throws(() => sourceUrl('https://secret@fal.media/x'), /owned/);
});

test('remote import binds commit, run, input and bytes; changed episodes stay reserved', async t => {
  const { store, service, input, directory } = await fixture(t); const packet = await service.reserve(input);
  const commitSha = 'a'.repeat(40); await service.bindRun({ batchId: packet.id, runId: '42', commitSha, packetSha256: packetHash(packet) });
  const bytes = Buffer.from('0000ftyporiginal-synthetic-result'); const localPath = join(directory, 'download.mp4'); await writeFile(localPath, bytes);
  const scene = packet.scenes[0]; const result = { batchId: packet.id, packetSha256: packetHash(packet), remoteRunId: '42', commitSha, sceneId: scene.sceneId, reservationId: scene.reservationId, status: 'completed', sha256: hash(bytes), referenceImageSha256: 'b'.repeat(64), sourceSha256: packet.source.sha256, remoteRequest: { provider: 'fal-ai', transport: 'huggingface-router', requestId: 'owned-request' } };
  await assert.rejects(service.accept({ batchId: packet.id, runId: '43', result, localPath }), /authorized batch/);
  await store.transaction(state => { state.episodes[0].title = 'Changed after charge'; });
  await assert.rejects(service.accept({ batchId: packet.id, runId: '42', result, localPath }), /changed/);
  assert.equal((await store.read()).spending[0].status, 'reserved');
  await store.transaction(state => { state.episodes[0].title = 'Original collection'; });
  const asset = await service.accept({ batchId: packet.id, runId: '42', result, localPath });
  assert.equal(asset.sha256, result.sha256); assert.equal(asset.provenance.remoteRunId, '42');
  assert.equal((await store.read()).spending[0].status, 'completed');
  assert.equal((await store.read()).productionBatches[0].status, 'completed');
  const again = await service.accept({ batchId: packet.id, runId: '42', result, localPath });
  assert.equal(again.id, asset.id); assert.equal(again.alreadyImported, true);
  assert.equal((await store.read()).assets.filter(x => x.episodeId === input.episodeId).length, 1);
});

test('artifact lookup failures and prior reservations fail before a new charge', async () => {
  const args = { repository: 'owner/repo', artifactName: 'reserved', token: 'private-token' };
  await assert.rejects(assertNoPreviousSubmission({ ...args, fetchImpl: async () => new Response('', { status: 403 }) }), /barrier/);
  await assert.rejects(assertNoPreviousSubmission({ ...args, fetchImpl: async () => Response.json({ total_count: 1, artifacts: [{ name: 'reserved' }] }) }), /never resubmit/);
  await assertNoPreviousSubmission({ ...args, fetchImpl: async () => Response.json({ total_count: 0, artifacts: [] }) });
});

test('production worker refuses local execution and automatic reruns without calling inference', async () => {
  let called = false; const client = { imageToVideo: async () => { called = true; } };
  await assert.rejects(runWorker({ env: { GITHUB_ACTIONS: 'false' }, client }), /remote production/);
  await assert.rejects(runWorker({ env: { GITHUB_ACTIONS: 'true', GITHUB_RUN_ATTEMPT: '2', HF_TOKEN: 'secret', YTFUN_BATCH_PAID_ENABLED: 'true' }, client }), /remote production/);
  assert.equal(called, false);
});

async function workerFixture(t, failReceipt = false) {
  const { service, input, directory } = await fixture(t); const packet = await service.reserve(input);
  const launch = { batchId: packet.id, packetSha256: packetHash(packet), sceneIndices: [1] };
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(directory, 'studio/batches'), { recursive: true });
  await writeFile(join(directory, 'studio/batches/launch.json'), JSON.stringify(launch));
  const events = []; let posts = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).startsWith('https://api.github.com/')) return Response.json({ total_count: 0, artifacts: [] });
    if (String(url).startsWith('https://v3.fal.media/')) {
      assert.equal(options.headers?.Authorization, undefined);
      return new Response(Buffer.from('0000ftypremote-original'));
    }
    assert.equal(options.method, 'POST'); posts++; events.push('POST');
    return Response.json({ request_id: 'owned-request', response_url: 'https://queue.fal.run/fal-ai/wan/requests/owned-request', status: 'IN_QUEUE' });
  };
  const artifact = { uploadArtifact: async (name, files) => {
    const suffix = name.split('-').at(-1); events.push(`upload-${suffix}`);
    if (failReceipt && suffix === 'receipt') throw new Error('transport contains private-provider-secret');
    assert.ok(files.length > 0); return { id: 1 };
  } };
  const client = { imageToVideo: async (args, options) => {
    assert.equal(args.model, BATCH_MODEL); assert.equal(options.retry_on_error, false);
    await options.fetch('https://router.huggingface.co/fal-ai/fal-ai/wan?_subdomain=queue', { method: 'POST', headers: { Authorization: 'Bearer private-provider-secret' } });
    events.push('poll');
    return new Blob([Buffer.from('0000ftyporiginal-result')], { type: 'video/mp4' });
  } };
  const runner = async (binary, args) => {
    assert.equal(binary, 'ffmpeg');
    await writeFile(args.at(-1), Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  };
  const env = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ATTEMPT: '1', YTFUN_BATCH_PAID_ENABLED: 'true', HF_TOKEN: 'private-provider-secret', GITHUB_TOKEN: 'private-github-secret', GITHUB_WORKSPACE: directory, RUNNER_TEMP: directory, GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '42', GITHUB_SHA: 'a'.repeat(40), SPHERE_INDEX: '1', AI_MEOW_BATCH_PACKET: gzipSync(JSON.stringify(packet)).toString('base64') };
  return { env, artifact, client, fetchImpl, runner, events, posts: () => posts };
}

test('reservation is remote before POST and receipt is remote before polling', async t => {
  const setup = await workerFixture(t);
  const result = await runWorker(setup);
  assert.equal(result.status, 'completed'); assert.equal(setup.posts(), 1);
  assert.deepEqual(setup.events, ['upload-reserved', 'POST', 'upload-receipt', 'poll', 'upload-result']);
});

test('receipt persistence failure prevents polling and cannot trigger a replacement charge', async t => {
  const setup = await workerFixture(t, true);
  await assert.rejects(runWorker(setup), error => /reconciliation/.test(error.message) && !error.message.includes('private-provider-secret'));
  assert.equal(setup.posts(), 1);
  assert.deepEqual(setup.events, ['upload-reserved', 'POST', 'upload-receipt', 'upload-attention']);
});

test('CLI remains alive while the SDK-style polling timer is unreferenced', async () => {
  const module = new URL('../scripts/remote-batch-worker.mjs', import.meta.url).href;
  const source = `import { withInferenceLiveness } from ${JSON.stringify(module)}; await withInferenceLiveness(() => new Promise(resolve => { const timer = setTimeout(resolve, 100); timer.unref(); })); console.log('provider-result-persisted');`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { timeout: 5000 });
  assert.equal(result.stdout.trim(), 'provider-result-persisted');
});

test('only an owned terminal job whose provider step was skipped releases an unsubmitted reservation', async t => {
  const { store, service, input, sceneId } = await fixture(t); const packet = await service.reserve(input);
  const commitSha = 'c'.repeat(40); await service.bindRun({ batchId: packet.id, runId: '42', commitSha, packetSha256: packetHash(packet) });
  const job = { id: 77, run_id: 42, head_sha: commitSha, name: 'sphere (1)', status: 'completed', conclusion: 'cancelled', steps: [{ name: 'Run actions/github-script@v7', status: 'completed', conclusion: 'skipped' }] };
  let proof = job;
  const checked = new RemoteBatch(store, { repository: 'owner/repo', githubToken: 'private-token', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/owner/repo/actions/jobs/77');
    assert.equal(options.redirect, 'error'); return Response.json(proof);
  } });
  for (const invalid of [{ ...job, status: 'in_progress' }, { ...job, head_sha: 'd'.repeat(40) }, { ...job, run_id: 43 }, { ...job, name: 'sphere (2)' }, { ...job, steps: [{ ...job.steps[0], conclusion: 'failure' }] }]) {
    proof = invalid; await assert.rejects(checked.releaseUnsubmitted({ batchId: packet.id, sceneId, jobId: 77 }), /does not prove/);
    assert.equal((await store.read()).spending[0].status, 'reserved');
  }
  proof = job; const evidence = await checked.releaseUnsubmitted({ batchId: packet.id, sceneId, jobId: 77 });
  assert.equal(evidence.providerStep, 'skipped'); assert.equal((await store.read()).spending[0].actualCostUsd, 0);
  const next = await service.reserve(input); assert.notEqual(next.id, packet.id);
});

test('quality retakes require exact observed rejection and changed direction while retaining the first charge', async t => {
  const { store, service, input, sceneId } = await fixture(t); const packet = await service.reserve(input);
  const assetId = randomUUID(); const sha256 = 'e'.repeat(64);
  await store.transaction(state => {
    const spending = state.spending.find(x => x.id === packet.scenes[0].reservationId); Object.assign(spending, { status: 'completed', assetId });
    state.assets.push({ id: assetId, episodeId: input.episodeId, sceneId, kind: 'video', synthetic: true, sha256, provenance: { prompt: packet.scenes[0].prompt } });
  });
  const changed = { ...input, promptOverrides: { [sceneId]: 'A large three-dimensional brass mechanism visibly moving inside the opened sphere.' }, replaceRejectedAssetIds: { [sceneId]: assetId } };
  await assert.rejects(service.reserve(changed), /explicitly rejected/);
  await assert.rejects(service.rejectAsset({ episodeId: input.episodeId, assetId, sha256: 'f'.repeat(64), reviewedBy: 'Reviewer', findings: 'Observed flat interior without the requested mechanism.' }), /Exact completed/);
  await service.rejectAsset({ episodeId: input.episodeId, assetId, sha256, reviewedBy: 'Reviewer', findings: 'Observed flat interior without the requested mechanism.' });
  await assert.rejects(service.reserve({ ...changed, promptOverrides: {} }), /corrected direction/);
  await assert.rejects(service.reserve({ ...changed, replaceRejectedAssetIds: { [sceneId]: randomUUID() } }), /explicitly rejected/);
  const retake = await service.reserve(changed);
  assert.equal(retake.scenes[0].replacesRejectedAssetId, assetId); assert.equal(retake.scenes[0].seed, packet.scenes[0].seed + 1000);
  const state = await store.read(); assert.equal(state.spending.length, 2); assert.equal(state.spending[0].status, 'completed'); assert.equal(state.assets.at(-1).id, assetId);
  await assert.rejects(service.reserve(changed), /reconciled/);
});
