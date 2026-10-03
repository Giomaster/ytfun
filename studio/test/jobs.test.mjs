import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioStore } from '../src/store.mjs';
import { ProductionJobs } from '../src/jobs.mjs';

test('slow production returns a persistent job and prevents a second concurrent dispatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StudioStore(directory);
  await store.transaction(state => state.episodes.push({ id: 'episode' }));
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const jobs = new ProductionJobs(store, { generateAsset: async () => { await wait; return { id: 'asset' }; } });
  const job = await jobs.start({ action: 'generate', input: { episodeId: 'episode' } });
  assert.equal(job.status, 'running');
  assert.equal((await jobs.get(job.id)).workerActiveHere, true);
  await assert.rejects(jobs.start({ action: 'render', input: { episodeId: 'episode' } }), /already running/);
  await assert.rejects(jobs.reconcile({ jobId: job.id, confirmedBy: 'operator', evidence: 'Checked' }), /still running/);
  release();
  await jobs.running.get(job.id);
  const done = await jobs.get(job.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.result.id, 'asset');
});

test('restart does not rerun an interrupted attempt or erase uncertain provider spending', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StudioStore(directory);
  await store.transaction(state => {
    state.episodes.push({ id: 'episode' });
    state.spending.push({ id: 'charge', status: 'unknown' });
    state.productionJobs = [{ id: 'job', episodeId: 'episode', action: 'generate', status: 'running' }];
  });
  const jobs = new ProductionJobs(store, { generateAsset: () => { throw new Error('Must not run'); } });
  const read = await jobs.get('job');
  assert.equal(read.workerActiveHere, false);
  await jobs.reconcile({ jobId: 'job', confirmedBy: 'operator', evidence: 'Prior worker terminated; remote billing remains unknown.' });
  assert.equal((await store.read()).spending[0].status, 'unknown');
});
