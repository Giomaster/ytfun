import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Studio, episodeAssetHash, episodeLimits, episodeReviewHash, fileSha256 } from '../src/domain.mjs';
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
      assets.push({ id, episodeId: episode.id, sceneId: scene.id, kind, path, sha256: await fileSha256(join(fixture.directory, path)), synthetic: true, provenance: { provider: 'fixture-provider', model: 'licensed-original-model', prompt: kind === 'image' ? scene.visualPrompt : episode.audioMode === 'nonverbal' ? 'Original procedural contact and reveal effects without voices or music.' : scene.narration, commercialLicense: { url: 'https://example.org/model-license', notes: 'Fixture evidence of commercial output rights.' } } });
      linked[kind === 'image' ? 'visualAssetId' : 'audioAssetId'] = id;
    }
    sceneAssets.push(linked);
  }
  const path = `assets/${episode.id}.mp4`;
  await writeFile(join(fixture.directory, path), 'render-fixture');
  const render = { path, sha256: await fileSha256(join(fixture.directory, path)), durationSeconds: episode.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), sceneAssets, synthetic: true, createdAt: new Date().toISOString(), ...(episode.audioMode === 'silent' ? { audioMode: 'silent', hasAudio: false } : episode.audioMode === 'nonverbal' ? { audioMode: 'nonverbal', hasAudio: true } : {}) };
  await fixture.store.transaction((state) => {
    state.assets.push(...assets);
    Object.assign(state.episodes.find((entry) => entry.id === episode.id), { render, status: 'rendered' });
  });
  return { assets, render };
}

const review = { originalityChecked: true, factsChecked: true, renderWatched: true, reviewedBy: 'Human editor', notes: 'Watched the complete render, compared scripts and verified the source and license evidence.' };

test('asset review hashing retains the legacy wire format without a quality review and binds an added rejection', () => {
  const episode = { render: { sceneAssets: [{ visualAssetId: 'visual' }] } };
  const asset = { id: 'visual', episodeId: 'episode', sceneId: 'scene', kind: 'video', path: 'assets/current.mp4', sha256: 'a'.repeat(64), synthetic: true, provenance: {} };
  const legacyWire = `[{"episodeId":"episode","id":"visual","kind":"video","path":"assets/current.mp4","provenance":{},"sceneId":"scene","sha256":"${'a'.repeat(64)}","synthetic":true}]`;
  const legacyHash = createHash('sha256').update(legacyWire).digest('hex');
  assert.equal(episodeAssetHash(episode, [asset]), legacyHash);
  assert.equal(episodeAssetHash(episode, [{ ...asset, qualityReview: undefined }]), legacyHash);
  const rejected = { ...asset, qualityReview: { decision: 'rejected', sha256: asset.sha256, findings: 'Observed incoherent geometry.' } };
  assert.notEqual(episodeAssetHash(episode, [rejected]), legacyHash);
  assert.notEqual(episodeAssetHash(episode, [rejected]), episodeAssetHash(episode, [{ ...rejected, qualityReview: { ...rejected.qualityReview, findings: 'Observed incoherent object interaction.' } }]));
});

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

const longScenes = [
  { durationSeconds: 10, narration: 'A copper shell splits and reveals a tiny snowstorm that quietly settles into a crystal.', visualPrompt: 'Copper shell with a miniature blizzard; reveal, settle and complete the visual payoff.' },
  { durationSeconds: 12, narration: 'An emerald sphere opens around a luminous waterfall and closes only after the cascade fills a pool.', visualPrompt: 'Emerald sphere, luminous cascade flowing downhill into a still pool, complete ending.' },
  { durationSeconds: 8, narration: 'A velvet globe releases a golden sunrise, turning the surrounding shadows into delicate birds.', visualPrompt: 'Velvet globe reveals golden sunrise and stable paperlike birds, completed transformation.' },
];
const derivedInput = (parent, overrides = {}) => ({ parentEpisodeId: parent.id, sceneIds: parent.scenes.map(scene => scene.id), title: 'Three impossible interiors revealed', hook: 'An unexpected universe hides inside each shell.', synopsis: 'Three complete reveals form an original standalone miniature film.', originalAngle: 'A tactile succession of original worlds with a resolved final reveal.', metadata: { description: 'Original synthetic standalone film derived from its original master.', hashtags: ['#AIMeow'] }, ...overrides });

async function renderDerived(f, episode) {
  const path = `assets/derived-${episode.id}.mp4`;
  await writeFile(join(f.directory, path), `original-derived-${episode.id}`);
  const render = {
    path, sha256: await fileSha256(join(f.directory, path)), durationSeconds: episode.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), synthetic: true,
    sceneAssets: [],
  };
  const state = await f.store.read();
  render.sceneAssets = episode.scenes.map(scene => {
    const records = episode.derivation.assets.filter(asset => asset.sceneId === scene.id);
    const visual = records.find(record => ['image', 'video'].includes(state.assets.find(asset => asset.id === record.assetId).kind));
    const audio = records.find(record => state.assets.find(asset => asset.id === record.assetId).kind === 'audio');
    return { sceneId: scene.id, visualAssetId: visual.assetId, ...(audio ? { audioAssetId: audio.assetId } : {}) };
  });
  if (episode.audioMode === 'silent') Object.assign(render, { audioMode: 'silent', hasAudio: false });
  if (episode.audioMode === 'nonverbal') Object.assign(render, { audioMode: 'nonverbal', hasAudio: true });
  await f.store.transaction(state => Object.assign(state.episodes.find(item => item.id === episode.id), { render, status: 'rendered' }));
}

test('only explicit long format expands planning and editorial duration; legacy short limits stay bounded', async t => {
  const f = await fixture(t);
  assert.deepEqual(episodeLimits(), { format: 'short', maxScenes: 12, maxDurationSeconds: 180, maxRenderBytes: 100 * 1024 * 1024 });
  assert.deepEqual(episodeLimits({}), episodeLimits('short'));
  assert.deepEqual(episodeLimits('long'), { format: 'long', maxScenes: 120, maxDurationSeconds: 900, maxRenderBytes: 512 * 1024 * 1024 });
  for (const format of ['horizontal', '', null, 0]) await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { format })), /format must be short or long/);
  const master = await f.studio.planEpisode(episodeInput(f.project.id, { format: 'long', scenes: Array.from({ length: 15 }, (_, index) => ({ durationSeconds: 60, narration: `Complete original sphere reveal number ${index}.`, visualPrompt: `Sphere ${index} with its own resolved luminous world.` })) }));
  assert.equal(master.format, 'long');
  assert.equal(master.scenes.length, 15);
  await rendered(f, master);
  assert.equal((await f.studio.editorialReview(master.id)).readyForApproval, true);
  assert.equal((await f.studio.editorialReview(master.id)).limits.maximumDurationSeconds, 900);
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { format: 'long', scenes: Array.from({ length: 16 }, () => ({ durationSeconds: 60, narration: 'Different narrative.', visualPrompt: 'Different scene.' })) })), /900 seconds/);
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { format: 'long', scenes: Array.from({ length: 121 }, () => ({ durationSeconds: 1, narration: 'Different narrative.', visualPrompt: 'Different scene.' })) })), /120 scenes/);
  assert.notEqual(episodeReviewHash(master), episodeReviewHash({ ...master, format: 'short' }));
  await f.store.transaction(state => { delete state.episodes[0].format; });
  const shortReview = await f.studio.editorialReview(master.id);
  assert.equal(shortReview.limits.maximumDurationSeconds, 180);
  assert.equal(shortReview.readyForApproval, false);
});

test('derived shorts remap original synthetic assets, bind lineage and still require their own watched render', async t => {
  const f = await fixture(t);
  const parent = await f.studio.planEpisode(episodeInput(f.project.id, { format: 'long', title: 'The master anthology of tactile universes', scenes: longScenes }));
  const { assets, render } = await rendered(f, parent);
  const short = await f.studio.deriveShort(derivedInput(parent));
  assert.equal(short.status, 'planned');
  assert.equal(short.format, 'short');
  assert.equal(short.render, null);
  assert.equal(short.approval, null);
  assert.deepEqual(short.trendIds, []);
  assert.deepEqual(short.derivation.sourceSceneIds, parent.scenes.map(scene => scene.id));
  assert.equal(short.derivation.parentRenderSha256, render.sha256);
  assert.deepEqual(short.derivation.sourceTimeRanges.map(({ startSeconds, endSeconds }) => [startSeconds, endSeconds]), [[0, 10], [10, 22], [22, 30]]);
  const state = await f.store.read();
  const copied = state.assets.filter(asset => asset.episodeId === short.id);
  assert.equal(copied.length, assets.length);
  for (const asset of copied) {
    const source = assets.find(original => original.id === asset.lineage.sourceAssetId);
    assert.notEqual(asset.id, source.id);
    assert.notEqual(asset.sceneId, source.sceneId);
    assert.equal(asset.path, source.path);
    assert.equal(asset.sha256, source.sha256);
    assert.deepEqual(asset.provenance, source.provenance);
  }
  await assert.rejects(f.studio.approveEpisode({ episodeId: short.id, review }), /final render/);
  await renderDerived(f, short);
  assert.equal((await f.studio.editorialReview(short.id)).readyForApproval, true);
  assert.equal((await f.studio.editorialReview(parent.id)).readyForApproval, true);
  const approved = await f.studio.approveEpisode({ episodeId: short.id, review });
  assert.equal(approved.status, 'approved');
  assert.notEqual(approved.approval.reviewHash, episodeReviewHash({ ...approved, derivation: undefined }));
  const changedAssets = structuredClone((await f.store.read()).assets);
  changedAssets.find(asset => asset.episodeId === short.id).lineage.sourceAssetId = randomUUID();
  assert.notEqual(approved.approval.assetReviewHash, episodeAssetHash(approved, changedAssets));
  await assert.rejects(f.studio.planEpisode(episodeInput(f.project.id, { title: 'Unrelated upload with recycled narrative', scenes: longScenes })), /Near duplicate/);
});

test('derivation validates source order, bounded duration and duplicate selection inside the transaction', async t => {
  const f = await fixture(t);
  const parent = await f.studio.planEpisode(episodeInput(f.project.id, { format: 'long', title: 'A collection of distinct completed reveals', scenes: longScenes }));
  await rendered(f, parent);
  for (const ids of [[parent.scenes[1].id, parent.scenes[0].id], [randomUUID()], [parent.scenes[0].id, parent.scenes[0].id]]) await assert.rejects(f.studio.deriveShort(derivedInput(parent, { sceneIds: ids })), /chronological order|unique/);
  const input = derivedInput(parent, { sceneIds: [parent.scenes[0].id, parent.scenes[2].id] });
  const outcomes = await Promise.allSettled([f.studio.deriveShort(input), f.studio.deriveShort({ ...input, title: 'A second caption cannot repeat the same selection' })]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(outcome => outcome.status === 'rejected').reason.message, /already been derived/);
  const short = outcomes.find(outcome => outcome.status === 'fulfilled').value;
  assert.deepEqual(short.derivation.sourceTimeRanges.map(({ startSeconds, endSeconds }) => [startSeconds, endSeconds]), [[0, 10], [22, 30]]);
  assert.equal((await f.store.read()).episodes.length, 2);

  const other = await fixture(t);
  const tooLong = await other.studio.planEpisode(episodeInput(other.project.id, { format: 'long', scenes: Array.from({ length: 4 }, (_, index) => ({ durationSeconds: 60, narration: `Original complete narrative ${index}.`, visualPrompt: `A distinct complete scene ${index}.` })) }));
  await rendered(other, tooLong);
  await assert.rejects(other.studio.deriveShort(derivedInput(tooLong)), /180 seconds/);
});

test('derivation rejects unrendered or tampered parents and retains source hash checks after creation', async t => {
  const f = await fixture(t);
  const parent = await f.studio.planEpisode(episodeInput(f.project.id, { format: 'long', title: 'Original source with verifiable generation history', scenes: longScenes }));
  await assert.rejects(f.studio.deriveShort(derivedInput(parent)), /rendered long episode/);
  const { assets } = await rendered(f, parent);
  await writeFile(join(f.directory, assets[0].path), 'changed source bytes');
  await assert.rejects(f.studio.deriveShort(derivedInput(parent)), /source is invalid.*hash changed/);
  await writeFile(join(f.directory, assets[0].path), `synthetic-${assets[0].kind}-${assets[0].sceneId}`);
  const short = await f.studio.deriveShort(derivedInput(parent));
  await f.store.transaction(state => { state.assets.find(asset => asset.id === assets[0].id).provenance.model = 'a different undisclosed generation'; });
  const findings = (await f.studio.editorialReview(short.id)).findings;
  assert.ok(findings.some(finding => finding.code === 'derivation_invalid' && /source changed/.test(finding.message)));
  await assert.rejects(f.studio.approveEpisode({ episodeId: short.id, review }), /source changed/);
});

test('rejected visual or audio sources invalidate an existing asset review and block approval and new derivation', async t => {
  for (const kind of ['image', 'audio']) {
    const f = await fixture(t);
    const parent = await f.studio.planEpisode(episodeInput(f.project.id, { format: 'long', title: 'A master with inspected original reveals', scenes: longScenes }));
    const { assets } = await rendered(f, parent);
    const approved = await f.studio.approveEpisode({ episodeId: parent.id, review });
    const target = assets.find(asset => asset.kind === kind);
    await f.store.transaction(state => { state.assets.find(asset => asset.id === target.id).qualityReview = { decision: 'rejected', sha256: target.sha256, reviewedBy: 'Human editor', findings: 'The original asset has visibly incoherent interactions.' }; });
    const before = await f.store.read();
    assert.notEqual(episodeAssetHash(approved, before.assets), approved.approval.assetReviewHash);
    const editorial = await f.studio.editorialReview(parent.id);
    assert.equal(editorial.readyForApproval, false);
    assert.ok(editorial.findings.some(finding => finding.code === 'asset_rejected'));
    await assert.rejects(f.studio.approveEpisode({ episodeId: parent.id, review }), /rejected by quality review/);
    await assert.rejects(f.studio.deriveShort(derivedInput(parent)), /source is invalid.*rejected by quality review/);
    assert.deepEqual(await f.store.read(), before, 'Blocked work must retain all source assets, costs and previous review records');
  }
});

test('derived approval rejects the original or copied source even if a parent hash is manually refreshed', async t => {
  for (const originalRejected of [true, false]) {
    const f = await fixture(t);
    const parent = await f.studio.planEpisode(episodeInput(f.project.id, { format: 'long', title: 'Original source for a complete derived reveal', scenes: longScenes }));
    await rendered(f, parent);
    const short = await f.studio.deriveShort(derivedInput(parent));
    await renderDerived(f, short);
    await f.store.transaction(state => {
      const source = state.assets.find(asset => asset.episodeId === parent.id && asset.kind === 'image');
      const target = originalRejected ? source : state.assets.find(asset => asset.episodeId === short.id && asset.lineage.sourceAssetId === source.id);
      target.qualityReview = { decision: 'rejected', sha256: target.sha256, findings: 'The source asset has visibly incoherent material behavior.' };
      if (originalRejected) state.episodes.find(episode => episode.id === short.id).derivation.parentAssetReviewHash = episodeAssetHash(state.episodes.find(episode => episode.id === parent.id), state.assets);
    });
    const findings = (await f.studio.editorialReview(short.id)).findings;
    assert.ok(findings.some(finding => finding.code === 'derivation_invalid' && /Rejected assets/.test(finding.message)));
    await assert.rejects(f.studio.approveEpisode({ episodeId: short.id, review }), /Rejected assets/);
  }
});

test('parent-child narrative reuse is narrow: repeated titles and sibling stories remain blocked', async t => {
  const f = await fixture(t);
  const narration = 'An amber moon opens to release silver rain that fills a basin and settles into a luminous garden.';
  const parent = await f.studio.planEpisode(episodeInput(f.project.id, { format: 'long', title: 'Amber moon anthology with complete reveals', scenes: [0, 1].map(() => ({ durationSeconds: 10, narration, visualPrompt: 'Amber moon releases silver rain into a luminous basin garden.' })) }));
  await rendered(f, parent);
  await assert.rejects(f.studio.deriveShort(derivedInput(parent, { title: parent.title, sceneIds: [parent.scenes[0].id] })), /Near duplicate/);
  await f.studio.deriveShort(derivedInput(parent, { sceneIds: [parent.scenes[0].id] }));
  await assert.rejects(f.studio.deriveShort(derivedInput(parent, { title: 'Silver rain creates a basin garden', sceneIds: [parent.scenes[1].id] })), /Near duplicate/);
  assert.equal((await f.store.read()).episodes.length, 2);
});

test('nonverbal episodes require original audio, forbid narration/captions and deduplicate their visual story', async t => {
  const f = await fixture(t);
  const input = episodeInput(f.project.id, { audioMode: 'nonverbal', scenes: [{ durationSeconds: 10, narration: '', visualPrompt: 'A quartz sphere reveals a complete tiny aurora and its crystal shell settles on the table.' }] });
  await assert.rejects(f.studio.planEpisode({ ...input, scenes: [{ ...input.scenes[0], narration: 'This would introduce spoken language.' }] }), /Nonverbal episodes cannot contain narration/);
  const episode = await f.studio.planEpisode(input);
  await rendered(f, episode);
  assert.equal((await f.studio.editorialReview(episode.id)).readyForApproval, true);
  await assert.rejects(f.studio.planEpisode({ ...input, title: 'A completely different headline' }), /visual story token overlap/);
  await f.store.transaction(state => { state.episodes[0].render.captionsTiming = 'scene-approximate'; });
  assert.ok((await f.studio.editorialReview(episode.id)).findings.some(finding => finding.code === 'nonverbal_render_invalid'));
  await f.store.transaction(state => { delete state.episodes[0].render.captionsTiming; delete state.episodes[0].render.sceneAssets[0].audioAssetId; });
  assert.ok((await f.studio.editorialReview(episode.id)).findings.some(finding => finding.code === 'scene_asset_invalid'));
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
