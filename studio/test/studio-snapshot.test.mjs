import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, access, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioStore } from '../src/store.mjs';
import { exportStudioSnapshot, importStudioSnapshot } from '../src/studio-snapshot.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ytfun-snapshot-ci-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StudioStore(join(root, 'canonical'));
  await mkdir(join(store.directory, 'assets'), { recursive: true });
  const visual = Buffer.from('original source bytes');
  const render = Buffer.from('encoded original audiovisual bytes');
  const captions = Buffer.from('original captions');
  await writeFile(join(store.directory, 'assets/source.mp4'), visual);
  await writeFile(join(store.directory, 'assets/render.mp4'), render);
  await writeFile(join(store.directory, 'assets/render.srt'), captions);
  await store.transaction(state => {
    state.projects.push({ id: 'project', title: 'AI Meow' });
    state.assets.push({ id: 'source', path: 'assets/source.mp4', sha256: hash(visual) });
    state.episodes.push({ id: 'episode', render: { path: 'assets/render.mp4', sha256: hash(render),
      captionsPath: 'assets/render.srt', captionsSha256: hash(captions) } });
    state.publications.push({ id: 'existing-receipt', platform: 'facebook', status: 'published',
      accountId: 'authorized-page', url: 'https://www.facebook.com/reel/confirmed' });
    state.spending.push({ id: 'unknown-paid-attempt', status: 'unknown' });
  });
  return { root, store, snapshot: join(root, 'snapshot'), target: join(root, 'new-host') };
}

test('store migration preserves exact canonical bytes, assets, captions, receipts and unknown paid outcomes', async t => {
  const { store, snapshot, target } = await fixture(t);
  const before = await readFile(store.statePath);
  const exported = await exportStudioSnapshot(store, snapshot);
  assert.equal(exported.stateSha256, hash(before));
  assert.equal(exported.files, 4);
  assert.deepEqual(await readFile(store.statePath), before);
  const restored = await importStudioSnapshot(snapshot, target, { expectedStateSha256: exported.stateSha256 });
  assert.equal(restored.stateSha256, exported.stateSha256);
  assert.deepEqual(await readFile(join(target, 'state.json')), before);
  for (const path of ['assets/source.mp4', 'assets/render.mp4', 'assets/render.srt']) {
    assert.deepEqual(await readFile(join(target, path)), await readFile(join(store.directory, path)));
  }
  const state = await new StudioStore(target).read();
  assert.equal(state.publications[0].status, 'published');
  assert.equal(state.spending[0].status, 'unknown');
  await assert.rejects(importStudioSnapshot(snapshot, target, { expectedStateSha256: exported.stateSha256 }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(join(target, 'state.json')), before);
});

test('migration rejects tampered media, missing source entries and a different expected canonical hash', async t => {
  const { store, snapshot, target } = await fixture(t);
  const exported = await exportStudioSnapshot(store, snapshot);
  await assert.rejects(importStudioSnapshot(snapshot, target, { expectedStateSha256: 'f'.repeat(64) }), /authorized state/);
  await writeFile(join(snapshot, 'assets/render.mp4'), 'corrupted media');
  await assert.rejects(importStudioSnapshot(snapshot, target, { expectedStateSha256: exported.stateSha256 }), /hash check/);
  await assert.rejects(access(target), { code: 'ENOENT' });
  const filename = join(snapshot, 'snapshot-manifest.json');
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  manifest.files = manifest.files.filter(x => x.path !== 'assets/render.srt');
  await writeFile(filename, JSON.stringify(manifest));
  await assert.rejects(importStudioSnapshot(snapshot, target, { expectedStateSha256: exported.stateSha256 }), /incomplete/);
  await assert.rejects(access(target), { code: 'ENOENT' });
});

test('snapshot never steals a live canonical lock or overwrites an existing destination', async t => {
  const { store, snapshot } = await fixture(t);
  await mkdir(store.lockPath);
  await assert.rejects(exportStudioSnapshot(store, snapshot), error => error.code === 'STUDIO_BUSY');
  await access(store.lockPath);
  await rm(store.lockPath, { recursive: true });
  await mkdir(snapshot);
  await writeFile(join(snapshot, 'keep.txt'), 'existing destination');
  await assert.rejects(exportStudioSnapshot(store, snapshot), { code: 'EEXIST' });
  assert.equal(await readFile(join(snapshot, 'keep.txt'), 'utf8'), 'existing destination');
  await assert.rejects(access(store.lockPath), { code: 'ENOENT' });
});

test('snapshot export rejects changed hashes and symbolic sources without leaving a partial backup', async t => {
  const { root, store, snapshot } = await fixture(t);
  await writeFile(join(store.directory, 'assets/source.mp4'), 'changed');
  await assert.rejects(exportStudioSnapshot(store, snapshot), /hash check/);
  await assert.rejects(access(snapshot), { code: 'ENOENT' });
  await rm(join(store.directory, 'assets/source.mp4'));
  const external = join(root, 'outside.mp4');
  await writeFile(external, 'original source bytes');
  await symlink(external, join(store.directory, 'assets/source.mp4'));
  await assert.rejects(exportStudioSnapshot(store, snapshot));
  await assert.rejects(access(snapshot), { code: 'ENOENT' });
});
