import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Studio, episodeAssetHash, episodeReviewHash, fileSha256 } from '../src/domain.mjs';
import { StudioStore } from '../src/store.mjs';

const projectInput = { title: 'Original worlds', premise: 'Small fictional stories with evolving characters', audience: 'Adults who enjoy speculative fiction', language: 'pt-BR', continuity: 'Remember events between episodes' };
const episodeInput = (projectId, overrides = {}) => ({ projectId, title: 'The clockmaker discovers a floating island', hook: 'A broken clock starts counting backwards.', synopsis: 'The clockmaker chooses whether to follow the impossible countdown.', continuityNote: 'Introduce the clockmaker and her missing brother.', originalAngle: 'Use the countdown as a dilemma rather than a spectacle.', scenes: [{ durationSeconds: 60, narration: 'Helena repairs the ancient clock and sees an island rising above the harbor. The countdown threatens to erase her memories unless she repairs the missing spring.', visualPrompt: 'Original fictional clockmaker in a surreal floating island, painted illustration, no brands or real people.' }], metadata: { description: 'An original fictional story created with AI.', hashtags: ['#Ficção', '#HistóriaOriginal'] }, ...overrides });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-domain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StudioStore(directory);
  const studio = new Studio(store);
  const project = await studio.createProject(projectInput);
  return { directory, store, studio, project };
}

async function rendered(fixture, episode) {
  await mkdir(join(fixture.directory, 'assets'), { recursive: true });
  const assets = [];
  const sceneAssets = [];
  for (const scene of episode.scenes) {
    const linked = { sceneId: scene.id };
    for (const kind of episode.audioMode === 'silent' ? ['image'] : ['image', 'audio']) {
      const id = randomUUID();
      const path = `assets/${id}.${kind === 'image' ? 'png' : 'wav'}`;
      await writeFile(join(fixture.directory, path), `synthetic-${kind}-${scene.id}`);
      assets.push({ id, episodeId: episode.id, sceneId: scene.id, kind, path, sha256: await fileSha256(join(fixture.directory, path)), synthetic: true, provenance: { provider: 'fixture-provider', model: 'licensed-original-model', prompt: kind === 'image' ? scene.visualPrompt : scene.narration, commercialLicense: { url: 'https://example.org/model-license', notes: 'Fixture evidence of commercial output rights.' } } });
      linked[kind === 'image' ? 'visualAssetId' : 'audioAssetId'] = id;
    }
    sceneAssets.push(linked);
  }
  const path = `assets/${episode.id}.mp4`;
  await writeFile(join(fixture.directory, path), 'render-fixture');
  const render = { path, sha256: await fileSha256(join(fixture.directory, path)), durationSeconds: episode.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), sceneAssets, synthetic: true, createdAt: new Date().toISOString(), ...(episode.audioMode === 'silent' ? { audioMode: 'silent', hasAudio: false } : {}) };
  await fixture.store.transaction((state) => {
    state.assets.push(...assets);
    Object.assign(state.episodes.find((entry) => entry.id === episode.id), { render, status: 'rendered' });
  });
  return { assets, render };
}

const review = { originalityChecked: true, factsChecked: true, renderWatched: true, reviewedBy: 'Human editor', notes: 'Watched the complete render, compared scripts and verified the source and license evidence.' };

test('store rolls back a failed async mutation and readers never see partial state', async (t) => {
  const f = await fixture(t);
  const initial = await readFile(f.store.statePath, 'utf8');
  await assert.rejects(f.store.transaction(async (state) => {
    state.projects[0].title = 'Uncommitted title';
    assert.equal((await f.store.read()).projects[0].title, projectInput.title);
    throw new Error('failure after mutation');
  }), /failure after mutation/);
  assert.equal(await readFile(f.store.statePath, 'utf8'), initial);
  await f.store.transaction((state) => { state.projects[0].title = 'Committed title'; });
  assert.equal((await f.store.read()).projects[0].title, 'Committed title');
});

test('store serializes concurrent mutations across instances without losing updates', async (t) => {
  const f = await fixture(t);
  const another = new StudioStore(f.directory);
  await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? f.store : another).transaction(async (state) => {
    const current = state.projects[0].writes ?? 0;
    await Promise.resolve();
    state.projects[0].writes = current + 1;
  })));
  assert.equal((await f.store.read()).projects[0].writes, 20);
});

test('store returns detached snapshots and callback results', async (t) => {
  const f = await fixture(t);
  const state = await f.store.read();
  state.projects[0].title = 'outside mutation';
  const returned = await f.store.transaction((current) => current.projects[0]);
  returned.title = 'outside result mutation';
  assert.equal((await f.store.read()).projects[0].title, projectInput.title);
});

test('store fails busy on external or stale locks and leaves them for inspection', async (t) => {
  const f = await fixture(t);
  await mkdir(f.store.lockPath);
  await writeFile(join(f.store.lockPath, 'owner'), 'external process');
  await assert.rejects(f.store.transaction(() => {}), { code: 'STUDIO_BUSY' });
  assert.equal(await readFile(join(f.store.lockPath, 'owner'), 'utf8'), 'external process');
});

test('store refuses corrupted state and duplicate IDs without overwriting evidence', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.transaction((state) => state.projects.push(structuredClone(state.projects[0]))), /duplicate projects id/);
  await writeFile(f.store.statePath, '{truncated');
  await assert.rejects(f.store.transaction(() => {}), SyntaxError);
  assert.equal(await readFile(f.store.statePath, 'utf8'), '{truncated');
});

test('projects default to free-first with no fixed budget and conservative editorial cadence', async (t) => {
  const f = await fixture(t);
  assert.equal(f.project.budgetMonthlyUsd, null);
  assert.equal(f.project.costPolicy, 'free_first');
  assert.deepEqual(f.project.cadence, { minHoursBetweenPosts: 24, maxPostsPerRollingDay: 1 });
  await assert.rejects(f.studio.createProject({ ...projectInput, cadence: { minHoursBetweenPosts: 11 } }), /minHoursBetweenPosts/);
  await assert.rejects(f.studio.createProject({ ...projectInput, cadence: { maxPostsPerRollingDay: 4 } }), /maxPostsPerRollingDay/);
  await assert.rejects(f.studio.createProject({ ...projectInput, id: 'client-id' }), /generated/);
});

test('trend evidence needs real URLs and timezone timestamps; stale or duplicate references cannot plan', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.studio.addTrend({ topic: 'AI', sourceUrl: 'javascript:alert(1)', observedAt: new Date().toISOString(), evidence: 'Evidence' }), /HTTP/);
  await assert.rejects(f.studio.addTrend({ topic: 'AI', sourceUrl: 'https://example.org', observedAt: '1', evidence: 'Evidence' }), /ISO timestamp/);
  await assert.rejects(f.studio.addTrend({ topic: 'AI', sourceUrl: 'https://example.org', observedAt: '2026-02-30T12:00:00Z', evidence: 'Evidence' }), /valid timestamp/);
  const stale = await f.studio.addTrend({ topic: 'An older signal', sourceUrl: 'https://example.org/report', observedAt: new Date(Date.now() - 8 * 86400000).toISOString(), evidence: 'Actual old observations' });
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { trendIds: [stale.id] })), /stale/);
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { trendIds: [stale.id, stale.id] })), /unique/);
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { trendIds: [randomUUID()] })), /Trend not found/);
});

test('factual mode requires claim-specific sources even with valid trend evidence', async (t) => {
  const f = await fixture(t);
  const factual = await f.studio.createProject({ ...projectInput, title: 'Observed science', mode: 'factual' });
  const trend = await f.studio.addTrend({ topic: 'Astronomy', sourceUrl: 'https://example.org/trend', observedAt: new Date().toISOString(), evidence: 'Many readers discussed astronomy.' });
  await assert.rejects(f.studio.planEpisode(episodeInput(factual.id, { trendIds: [trend.id] })), /claim-specific/);
  const episode = await f.studio.planEpisode(episodeInput(factual.id, { factualSources: [{ claim: 'This documented result is the narrative subject.', url: 'https://example.org/primary-study' }] }));
  assert.equal(episode.factualSources.length, 1);
});

test('server scene IDs, duration caps and normalized near duplicates prevent repetitive plans', async (t) => {
  const f = await fixture(t);
  const first = await f.studio.planEpisode(episodeInput(f.project.id));
  assert.match(first.scenes[0].id, /^[a-f0-9-]{36}$/);
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { title: first.title.toUpperCase() })), /Near duplicate/);
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { title: 'Completely different title' })), /narration token overlap/);
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { scenes: [{ id: randomUUID(), durationSeconds: 10, narration: 'Original text', visualPrompt: 'Original visual' }] })), /generated/);
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { scenes: Array.from({ length: 4 }, (_, index) => ({ durationSeconds: 60, narration: `Original narration ${index}`, visualPrompt: `Original image ${index}` })) })), /180 seconds/);
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { scenes: Array.from({ length: 13 }, () => ({ durationSeconds: 1, narration: 'Scene', visualPrompt: 'Visual' })) })), /12 scenes/);
});

test('metrics keep missing values absent and support concurrent independent platforms', async (t) => {
  const f = await fixture(t);
  const episode = await f.studio.planEpisode(episodeInput(f.project.id));
  const observedAt = new Date().toISOString();
  const [youtube, tiktok] = await Promise.all(['youtube', 'tiktok'].map((platform) => f.studio.recordMetrics({ episodeId: episode.id, platform, sourceUrl: `https://${platform}.com/report`, observedAt, views: platform === 'youtube' ? 0 : 12 })));
  assert.equal(youtube.views, 0);
  assert.equal(tiktok.views, 12);
  assert.equal('revenueUsd' in youtube, false);
  assert.equal('retentionRatio' in tiktok, false);
  assert.equal((await f.studio.getEpisode(episode.id)).metrics.length, 2);
  await assert.rejects(f.studio.recordMetrics({ episodeId: episode.id, platform: 'youtube', sourceUrl: 'https://youtube.com/report', observedAt, views: 0 }), /already recorded/);
  await assert.rejects(f.studio.recordMetrics({ episodeId: episode.id, platform: 'youtube', sourceUrl: 'https://youtube.com/report', observedAt }), /At least one/);
  await assert.rejects(f.studio.recordMetrics({ episodeId: episode.id, platform: 'youtube', sourceUrl: 'https://youtube.com/report', observedAt, completionRate: 1.1 }), /completionRate/);
  const replay = await f.studio.recordMetrics({ episodeId: episode.id, platform: 'youtube', sourceUrl: 'https://youtube.com/analytics', observedAt, retentionRatio: 1.4, periodStart: '2026-09-01', periodEnd: '2026-09-30' });
  assert.equal(replay.retentionRatio, 1.4);
  assert.equal(replay.periodStart, '2026-09-01');
  await assert.rejects(f.studio.recordMetrics({ episodeId: episode.id, platform: 'youtube', sourceUrl: 'https://youtube.com/analytics', observedAt, views: 1, periodStart: '2026-09-01' }), /supplied together/);
  await assert.rejects(f.studio.recordMetrics({ episodeId: episode.id, platform: 'youtube', sourceUrl: 'https://youtube.com/analytics', observedAt, views: 1, periodStart: '2026-09-30', periodEnd: '2026-09-01' }), /must not be after/);
  await assert.rejects(f.studio.recordMetrics({ episodeId: episode.id, platform: 'youtube', sourceUrl: 'https://youtube.com/analytics', observedAt, views: 1, periodStart: '2026-02-30', periodEnd: '2026-03-01' }), /valid calendar/);
});

test('approval requires a final render, all AI scene assets and explicit review attestations', async (t) => {
  const f = await fixture(t);
  const episode = await f.studio.planEpisode(episodeInput(f.project.id));
  assert.equal((await f.studio.editorialReview(episode.id)).readyForApproval, false);
  await assert.rejects(f.studio.approveEpisode({ episodeId: episode.id, review }), /final render/);
  await rendered(f, episode);
  await assert.rejects(f.studio.approveEpisode({ episodeId: episode.id, review: { ...review, renderWatched: false } }), /attestations/);
  const prepared = await f.studio.editorialReview(episode.id);
  assert.equal(prepared.readyForApproval, true);
  assert.match(prepared.limits.monetization, /no views or income are promised/);
  const approved = await f.studio.approveEpisode({ episodeId: episode.id, review });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approval.reviewHash, episodeReviewHash(approved));
  assert.equal(approved.approval.assetReviewHash, episodeAssetHash(approved, (await f.store.read()).assets));
});

test('approval blocks missing mappings, non-AI assets, missing commercial evidence and file changes', async (t) => {
  const f = await fixture(t);
  const episode = await f.studio.planEpisode(episodeInput(f.project.id));
  const output = await rendered(f, episode);
  const original = await f.store.read();
  for (const mutate of [
    (state) => { state.episodes[0].render.sceneAssets = []; },
    (state) => { state.assets[0].synthetic = false; },
    (state) => { state.assets[0].provenance.commercialLicense.notes = ''; },
    (state) => { state.assets[0].sceneId = randomUUID(); },
    (state) => { state.episodes[0].render.durationSeconds = 181; },
  ]) {
    await f.store.transaction((state) => { Object.assign(state, structuredClone(original)); mutate(state); });
    await assert.rejects(f.studio.approveEpisode({ episodeId: episode.id, review }), /not ready/);
  }
  await f.store.transaction((state) => Object.assign(state, structuredClone(original)));
  await writeFile(join(f.directory, output.assets[0].path), 'changed bytes');
  await assert.rejects(f.studio.approveEpisode({ episodeId: episode.id, review }), /file hash changed/);
});

test('approval binds script, metadata, render and the referenced license manifest', async (t) => {
  const f = await fixture(t);
  const episode = await f.studio.planEpisode(episodeInput(f.project.id));
  await rendered(f, episode);
  const approved = await f.studio.approveEpisode({ episodeId: episode.id, review });
  const modified = structuredClone(approved);
  modified.metadata.hashtags.push('#Different');
  assert.notEqual(episodeReviewHash(modified), approved.approval.reviewHash);
  modified.metadata = approved.metadata;
  modified.scenes[0].narration = 'An unreviewed new narration.';
  assert.notEqual(episodeReviewHash(modified), approved.approval.reviewHash);
  const state = await f.store.read();
  state.assets[0].provenance.commercialLicense.notes = 'Changed license evidence';
  assert.notEqual(episodeAssetHash(approved, state.assets), approved.approval.assetReviewHash);
  assert.equal(episodeReviewHash({ ...approved, metrics: [{ views: 100 }], status: 'publishing' }), approved.approval.reviewHash);
});

test('approval rejects traversal and symlinks outside the controlled assets directory', async (t) => {
  const f = await fixture(t);
  const episode = await f.studio.planEpisode(episodeInput(f.project.id));
  const output = await rendered(f, episode);
  await f.store.transaction((state) => { state.assets[0].path = '../outside.png'; });
  await assert.rejects(f.studio.approveEpisode({ episodeId: episode.id, review }), /relative within assets/);
  const outside = join(f.directory, 'outside.png');
  await writeFile(outside, 'synthetic-image-outside');
  await symlink(outside, join(f.directory, 'assets', 'escape.png'));
  await f.store.transaction((state) => { state.assets[0].path = 'assets/escape.png'; state.assets[0].sha256 = output.assets[0].sha256; });
  await assert.rejects(f.studio.approveEpisode({ episodeId: episode.id, review }), /escapes studio/);
});


test('silent plans omit narration while narrated plans retain their voice requirement', async t => {
  const f = await fixture(t);
  const silent = { audioMode: 'silent', scenes: [{ durationSeconds: 5, visualPrompt: 'A polished obsidian sphere reveals a spiral galaxy above a purple miniature sofa.' }] };
  const episode = await f.studio.planEpisode(episodeInput(f.project.id, silent));
  assert.equal(episode.audioMode, 'silent');
  assert.equal(episode.scenes[0].narration, '');
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { ...silent, scenes: [{ ...silent.scenes[0], narration: 'A spoken line.' }] })), /cannot contain narration/);
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { audioMode: 'soundtrack' })), /audioMode/);
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { scenes: silent.scenes })), /narration/);
});

test('silent editorial review accepts visual-only mappings and rejects audio or captions', async t => {
  const f = await fixture(t);
  const episode = await f.studio.planEpisode(episodeInput(f.project.id, { audioMode: 'silent', scenes: [{ durationSeconds: 5, visualPrompt: 'An original cybernetic kitten hangs from a violet sofa as a tiny portal opens.' }] }));
  await rendered(f, episode);
  assert.equal((await f.studio.editorialReview(episode.id)).readyForApproval, true);
  const approved = await f.studio.approveEpisode({ episodeId: episode.id, review });
  assert.equal(approved.render.hasAudio, false);
  assert.equal(approved.render.sceneAssets[0].audioAssetId, undefined);
  const baseline = structuredClone(approved.render);
  for (const changed of [{ hasAudio: true }, { audioMode: 'narrated' }, { captionsTiming: 'scene-approximate' }]) {
    await f.store.transaction(state => { state.episodes[0].render = { ...baseline, ...changed }; });
    const findings = await f.studio.editorialReview(episode.id);
    assert.ok(findings.findings.some(item => item.code === 'silent_render_invalid'));
  }
});

test('silent duplicate detection compares visual stories without treating empty narration as a duplicate', async t => {
  const f = await fixture(t);
  const input = episodeInput(f.project.id, { audioMode: 'silent', scenes: [{ durationSeconds: 5, visualPrompt: 'A golden pear opens to reveal a coral reef with tiny swimming fish.' }] });
  await f.studio.planEpisode(input);
  await assert.rejects(f.studio.planEpisode({ ...input, title: 'Another unrelated title' }), /visual story token overlap/);
  const distinct = await f.studio.planEpisode({ ...input, title: 'The portal beneath the black stone', originalAngle: 'A comic kitten struggles against gravity in a miniature living room.', scenes: [{ durationSeconds: 5, visualPrompt: 'A dark obsidian cube forms a gravitational vortex that pulls a silver kitten and purple couch inward.' }] });
  assert.equal(distinct.audioMode, 'silent');
});

test('review hashes bind planned audio mode and final stream attestation', () => {
  const base = { title: 'Silent portal', scenes: [], audioMode: 'silent', render: { audioMode: 'silent', hasAudio: false } };
  assert.notEqual(episodeReviewHash(base), episodeReviewHash({ ...base, audioMode: 'narrated' }));
  assert.notEqual(episodeReviewHash(base), episodeReviewHash({ ...base, render: { ...base.render, hasAudio: true } }));
});
