import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Studio, episodeAssetHash, episodeReviewHash, fileSha256, validateEpisodeDerivation } from '../src/domain.mjs';
import { FragmentComposition } from '../src/fragment-composition.mjs';
import { Production } from '../src/production.mjs';
import { StudioStore } from '../src/store.mjs';
import { ownerAcceptedTechnicalReview, technicalReviewEnv } from './technical-review-fixture.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-fragments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'assets'));
  const store = new StudioStore(directory);
  const studio = new Studio(store, { env: technicalReviewEnv });
  const project = await studio.createProject({ title: 'Shared impossible spheres', premise: 'Original modular reveals', audience: 'Global visual entertainment', language: 'en' });
  const compositions = new FragmentComposition(store, { env: technicalReviewEnv });
  return { directory, store, studio, project, compositions };
}

async function source(f, { format = 'long', count = 1, duration = 15, historicalReview = false, previousLineage = false } = {}) {
  const label = randomUUID();
  const episode = await f.studio.planEpisode({ projectId: f.project.id, format, title: `Original reveal ${label}`,
    hook: 'One shell opens to reveal an impossible interior.', synopsis: 'A complete nonverbal reveal and graceful ending.',
    originalAngle: `Original visual world ${label}`, audioMode: 'nonverbal',
    scenes: Array.from({ length: count }, (_, index) => ({ durationSeconds: duration, visualPrompt: `An original sphere ${label}, interior ${index}, complete settled ending.` })),
    metadata: { description: 'Original synthetic visual entertainment.', hashtags: ['#AIMeow'] } });
  const assets = [];
  const sceneAssets = [];
  for (const scene of episode.scenes) {
    const mapping = { sceneId: scene.id };
    for (const kind of ['video', 'audio']) {
      const id = randomUUID();
      const path = `assets/${id}.${kind === 'video' ? 'mp4' : 'wav'}`;
      await writeFile(join(f.directory, path), `original-${kind}-${episode.id}-${scene.id}`);
      const asset = { id, episodeId: episode.id, sceneId: scene.id, kind, path,
        sha256: await fileSha256(join(f.directory, path)), synthetic: true,
        provenance: { provider: 'fixture-provider', model: 'licensed-original-model', prompt: scene.visualPrompt,
          commercialLicense: { url: 'https://example.org/model-license', notes: 'Original generated inputs and commercial output permission.' } },
        ...(previousLineage ? { lineage: { sourceAssetId: randomUUID(), sourceSha256: 'a'.repeat(64), note: 'Preserve this preceding origin.' } } : {}) };
      if (historicalReview) asset.qualityReview = { decision: 'rejected', sha256: asset.sha256, findings: 'An accepted generated visual imperfection.' };
      assets.push(asset);
      mapping[kind === 'video' ? 'visualAssetId' : 'audioAssetId'] = id;
    }
    sceneAssets.push(mapping);
  }
  const path = `assets/${episode.id}.mp4`;
  await writeFile(join(f.directory, path), `render-${episode.id}`);
  const render = { path, sha256: await fileSha256(join(f.directory, path)), durationSeconds: count * duration,
    width: 1080, height: 1920, framesPerSecond: 30, audioMode: 'nonverbal', hasAudio: true, synthetic: true, sceneAssets };
  await f.store.transaction(state => {
    state.assets.push(...assets);
    Object.assign(state.episodes.find(item => item.id === episode.id), { render, status: 'rendered' });
  });
  return f.studio.getEpisode(episode.id);
}

function selected(episode, sceneIds = episode.scenes.map(scene => scene.id)) {
  return { episodeId: episode.id, expectedRenderSha256: episode.render.sha256, sceneIds };
}

function input(f, sources, overrides = {}) {
  return { projectId: f.project.id, sources, title: 'Impossible worlds opening', hook: 'Every reveal has its own payoff.',
    synopsis: 'Several distinct complete reveals share one original audiovisual work.', originalAngle: 'A coherent sequence of impossible satisfying interiors.',
    metadata: { description: 'Original AI-generated worlds with original nonverbal audio.', hashtags: ['#AIMeow'] }, ...overrides };
}

async function attachRender(f, episode) {
  const path = `assets/${episode.id}-assembled.mp4`;
  await writeFile(join(f.directory, path), `assembled-${episode.id}`);
  const render = { path, sha256: await fileSha256(join(f.directory, path)),
    durationSeconds: episode.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
    audioMode: 'nonverbal', hasAudio: true, synthetic: true, width: 1080, height: 1920, framesPerSecond: 30,
    sceneAssets: episode.fragmentComposition.sceneBindings.map(binding => ({ sceneId: binding.sceneId,
      visualAssetId: binding.visual.assetId, audioAssetId: binding.audio.assetId })) };
  await f.store.transaction(state => Object.assign(state.episodes.find(item => item.id === episode.id), { render, status: 'rendered' }));
  return f.studio.getEpisode(episode.id);
}

test('direct composition uses complete scenes from short and long audiovisual sources without a master prerequisite', async t => {
  const f = await fixture(t);
  const first = await source(f, { format: 'short', historicalReview: true, previousLineage: true });
  const second = await source(f, { format: 'long', count: 2 });
  const before = await f.store.read();
  const result = await f.compositions.plan(input(f, [selected(first), selected(second, second.scenes.map(scene => scene.id).reverse())], { format: 'long', renderCanvas: 'landscape' }));
  assert.equal(result.reused, false);
  assert.equal(result.episode.format, 'long');
  assert.equal(result.episode.renderCanvas, 'landscape');
  assert.equal(result.episode.audioMode, 'nonverbal');
  assert.equal(result.episode.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 45);
  assert.equal(result.episode.status, 'planned');
  assert.equal(result.episode.render, null);
  assert.equal(result.episode.approval, null);
  assert.deepEqual(result.episode.fragmentComposition.sceneBindings.map(binding => binding.sourceSceneId), [first.scenes[0].id, second.scenes[1].id, second.scenes[0].id]);
  const after = await f.store.read();
  assert.deepEqual(after.spending, before.spending);
  assert.deepEqual(after.assets.filter(asset => asset.episodeId !== result.episode.id), before.assets);
  for (const copy of after.assets.filter(asset => asset.episodeId === result.episode.id)) {
    const original = before.assets.find(asset => asset.id === copy.lineage.sourceAssetId);
    assert.equal(copy.path, original.path);
    assert.equal(copy.sha256, original.sha256);
    assert.deepEqual(copy.provenance, original.provenance);
    assert.deepEqual(copy.qualityReview, original.qualityReview);
    assert.deepEqual(copy.lineage.sourceLineage, original.lineage);
  }
});

test('the same exact work is idempotent across presentation titles while genuine format/project changes have distinct identity', async t => {
  const f = await fixture(t);
  const original = await source(f);
  const args = input(f, [selected(original)]);
  const first = await f.compositions.plan(args);
  const rendered = await attachRender(f, first.episode);
  await f.studio.approveEpisode({ episodeId: rendered.id, review: ownerAcceptedTechnicalReview(rendered) });
  await f.store.transaction(state => {
    state.episodes.find(episode => episode.id === rendered.id).status = 'published';
    state.publications.push({ id: randomUUID(), projectId: f.project.id, episodeId: rendered.id, platform: 'facebook',
      accountId: 'owned-page', status: 'published', renderSha256: rendered.render.sha256, publishedAt: new Date().toISOString() });
  });
  const before = await f.store.read();
  const again = await f.compositions.plan({ ...args, title: 'Network-specific presentation belongs to Publisher' });
  assert.equal(again.reused, true);
  assert.equal(again.episode.id, first.episode.id);
  assert.equal(again.episode.title, first.episode.title);
  assert.equal(again.episode.status, 'published');
  assert.deepEqual(await f.store.read(), before);
  await assert.rejects(f.compositions.plan({ ...args, title: '' }), /title is required/);
  assert.deepEqual(await f.store.read(), before, 'Reuse does not excuse malformed editorial input');
  const regular = await f.compositions.plan({ ...args, format: 'long', renderCanvas: 'landscape' });
  assert.notEqual(regular.episode.fragmentComposition.fingerprint, first.episode.fragmentComposition.fingerprint);
  const otherProject = await f.studio.createProject({ title: 'Another explicit project', premise: 'Independent project', audience: 'Visual viewers', language: 'en' });
  const separate = await f.compositions.plan({ ...args, projectId: otherProject.id });
  assert.equal(separate.reused, false);
  assert.equal(separate.episode.projectId, otherProject.id);
});

test('a complete existing source is reused without copying, retitling, changing approval or remuxing', async t => {
  const f = await fixture(t);
  const original = await source(f, { format: 'short' });
  await f.studio.approveEpisode({ episodeId: original.id, review: ownerAcceptedTechnicalReview(original) });
  const before = await f.store.read();
  const args = input(f, [selected(original)]);
  const reused = await f.compositions.plan(args);
  assert.equal(reused.reused, true);
  assert.equal(reused.reuseReason, 'complete-source');
  assert.equal(reused.episode.id, original.id);
  assert.equal(reused.episode.title, original.title);
  assert.equal(reused.episode.fragmentComposition, undefined);
  assert.deepEqual(await f.store.read(), before);
  await assert.rejects(f.compositions.plan({ ...args, metadata: { description: '', hashtags: ['invalid'] } }), /Hashtags/);
  assert.deepEqual(await f.store.read(), before);
  const landscape = await f.compositions.plan({ ...args, renderCanvas: 'landscape' });
  assert.equal(landscape.reused, false);
  assert.notEqual(landscape.episode.id, original.id);
});

test('concurrent identical composition requests commit one canonical work without nested store locks', async t => {
  const f = await fixture(t);
  const original = await source(f);
  const args = input(f, [selected(original)]);
  const results = await Promise.all([f.compositions.plan(args), f.compositions.plan(args)]);
  assert.equal(results[0].episode.id, results[1].episode.id);
  assert.deepEqual(results.map(result => result.reused).sort(), [false, true]);
  assert.equal((await f.store.read()).episodes.length, 2);
});

test('repeated scene selections or aliased visual bytes cannot be used to fill composition duration', async t => {
  const f = await fixture(t);
  const first = await source(f);
  const second = await source(f);
  const before = await f.store.read();
  await assert.rejects(f.compositions.plan(input(f, [selected(first, [first.scenes[0].id, first.scenes[0].id])])), /cannot repeat/);
  assert.deepEqual(await f.store.read(), before);
  const firstVisual = before.assets.find(asset => asset.episodeId === first.id && asset.kind === 'video');
  const secondVisual = before.assets.find(asset => asset.episodeId === second.id && asset.kind === 'video');
  await writeFile(join(f.directory, secondVisual.path), `original-video-${first.id}-${first.scenes[0].id}`);
  await f.store.transaction(state => { state.assets.find(asset => asset.id === secondVisual.id).sha256 = firstVisual.sha256; });
  const aliases = await f.store.read();
  await assert.rejects(f.compositions.plan(input(f, [selected(first), selected(second)])), /visual bytes cannot repeat/);
  assert.deepEqual(await f.store.read(), aliases);
});

test('invalid source files, exact hashes, mappings, rights and outstanding production roll back before composition', async t => {
  for (const failure of ['hash', 'bytes', 'audioMapping', 'rights', 'pending', 'running', 'status', 'silent']) await t.test(failure, async subtest => {
    const f = await fixture(subtest);
    const original = await source(f);
    const args = input(f, [selected(original)]);
    await f.store.transaction(state => {
      const episode = state.episodes[0];
      if (failure === 'audioMapping') delete episode.render.sceneAssets[0].audioAssetId;
      if (failure === 'rights') state.assets[0].provenance.commercialLicense.notes = '';
      if (failure === 'pending') state.spending.push({ id: randomUUID(), episodeId: original.id, status: 'unknown' });
      if (failure === 'running') state.productionJobs = [{ id: randomUUID(), episodeId: original.id, status: 'running' }];
      if (failure === 'status') episode.status = 'rendering';
      if (failure === 'silent') episode.render.hasAudio = false;
    });
    if (failure === 'hash') args.sources[0].expectedRenderSha256 = '0'.repeat(64);
    if (failure === 'bytes') await writeFile(join(f.directory, original.render.path), 'changed render file');
    const before = await f.store.read();
    await assert.rejects(f.compositions.plan(args));
    assert.deepEqual(await f.store.read(), before);
  });
});

test('format limits and invalid editorial input cannot leave partial copied assets or episodes', async t => {
  const f = await fixture(t);
  const original = await source(f, { format: 'long', count: 4, duration: 60 });
  const before = await f.store.read();
  await assert.rejects(f.compositions.plan(input(f, [selected(original)])), /format scene or duration limit/);
  await assert.rejects(f.compositions.plan(input(f, [selected(original, [original.scenes[0].id])], { title: '' })), /title is required/);
  assert.deepEqual(await f.store.read(), before);
});

test('composition definition, original snapshots and remapped lineage are bound by approval and asset hashes', async t => {
  const f = await fixture(t);
  const original = await source(f, { historicalReview: true });
  const planned = (await f.compositions.plan(input(f, [selected(original)]))).episode;
  const episode = await attachRender(f, planned);
  const approved = await f.studio.approveEpisode({ episodeId: episode.id, review: ownerAcceptedTechnicalReview(episode) });
  const before = await f.store.read();
  const tampered = structuredClone(approved);
  tampered.fragmentComposition.fingerprint = '0'.repeat(64);
  assert.notEqual(episodeReviewHash(tampered), approved.approval.reviewHash);
  assert.notEqual(episodeAssetHash(tampered, before.assets), approved.approval.assetReviewHash);
  await f.store.transaction(state => { state.assets.find(asset => asset.episodeId === approved.id).lineage.sourceAssetId = randomUUID(); });
  const findings = await f.studio.editorialReview(approved.id);
  assert.ok(findings.findings.some(finding => finding.code === 'composition_invalid'));
  await assert.rejects(validateEpisodeDerivation(await f.store.read(), await f.studio.getEpisode(approved.id), f.directory, { env: technicalReviewEnv }), /exact asset lineage/);
});

test('render export selects the composition-bound originals and refuses changed originals without running media tools', async t => {
  const f = await fixture(t);
  const original = await source(f);
  const episode = (await f.compositions.plan(input(f, [selected(original)]))).episode;
  await f.store.transaction(state => {
    const copied = state.assets.find(asset => asset.episodeId === episode.id && asset.kind === 'video');
    state.assets.push({ ...structuredClone(copied), id: randomUUID() });
  });
  const production = new Production(f.store, { env: technicalReviewEnv, runner: async () => assert.fail('Planning/export cannot encode or probe') });
  const manifest = await production.exportRenderManifest({ episodeId: episode.id });
  assert.equal(manifest.scenes[0].visual.assetId, episode.fragmentComposition.sceneBindings[0].visual.assetId);
  assert.equal(manifest.durationSeconds, 15);
  await writeFile(join(f.directory, original.render.path), 'changed original render');
  await assert.rejects(production.exportRenderManifest({ episodeId: episode.id }), /hash changed/);
});

test('nested complete-source compositions preserve preceding lineage and reject cyclic source definitions', async t => {
  const f = await fixture(t);
  const original = await source(f);
  const first = await attachRender(f, (await f.compositions.plan(input(f, [selected(original)]))).episode);
  const nested = (await f.compositions.plan(input(f, [selected(first)], { format: 'long' }))).episode;
  const copied = (await f.store.read()).assets.find(asset => asset.episodeId === nested.id && asset.kind === 'video');
  assert.equal(copied.lineage.sourceEpisodeId, first.id);
  assert.equal(copied.lineage.sourceLineage.sourceEpisodeId, original.id);
  await f.store.transaction(state => { state.episodes.find(episode => episode.id === first.id).fragmentComposition.sources = [selected(first)]; });
  await assert.rejects(validateEpisodeDerivation(await f.store.read(), await f.studio.getEpisode(first.id), f.directory, { env: technicalReviewEnv }), /cyclic/);
});
