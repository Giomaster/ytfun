import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Studio, episodeAssetHash, episodeLimits, episodeReviewHash, validateEpisodeCompositionSource } from './domain.mjs';

const id = z.string().trim().min(1).max(100);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({ episodeId: id, expectedRenderSha256: sha,
  sceneIds: z.array(id).min(1).max(120) }).strict();
const sourcesSchema = z.array(sourceSchema).min(1).max(120);
const planSchema = z.object({ projectId: id, sources: sourcesSchema,
  format: z.enum(['short', 'long']).default('short'),
  renderCanvas: z.enum(['portrait', 'landscape']).default('portrait'),
  title: z.string(), hook: z.string(), synopsis: z.string(), originalAngle: z.string(),
  continuityNote: z.string().optional(), metadata: z.unknown(),
}).strict();
const sourceStatuses = new Set(['rendered', 'approved', 'publishing', 'processing', 'uploaded', 'scheduled', 'published']);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function draftStore(state, directory) {
  return { directory, read: async () => state, transaction: async fn => fn(state) };
}

async function collectSources(state, sources, directory, env, ancestors = new Set()) {
  const validated = new Map();
  const sceneKeys = new Set();
  const visualHashes = new Set();
  const selected = [];
  for (const input of sources) {
    const parent = state.episodes.find(episode => episode.id === input.episodeId);
    if (!parent || ancestors.has(parent.id)) throw new Error('Fragment composition source is missing or has cyclic lineage');
    if (!sourceStatuses.has(parent.status) || parent.audioMode !== 'nonverbal' || parent.render?.audioMode !== 'nonverbal' || parent.render?.hasAudio !== true || parent.render?.sha256 !== input.expectedRenderSha256) {
      throw new Error(`Fragment source ${input.episodeId} requires its exact rendered nonverbal audiovisual file`);
    }
    if (state.spending.some(item => item.episodeId === parent.id && ['reserved', 'unknown'].includes(item.status)) ||
        state.productionJobs?.some(item => item.episodeId === parent.id && item.status === 'running')) throw new Error(`Resolve pending source production before composing ${parent.id}`);
    if (!validated.has(parent.id)) {
      await validateEpisodeCompositionSource(state, parent, directory, { env, compositionAncestors: ancestors });
      validated.set(parent.id, { episodeId: parent.id, renderSha256: parent.render.sha256,
        reviewHash: episodeReviewHash(parent), assetReviewHash: episodeAssetHash(parent, state.assets) });
    }
    let offset = 0;
    const ranges = new Map(parent.scenes.map(scene => {
      const start = offset;
      offset += scene.durationSeconds;
      return [scene.id, [start, offset]];
    }));
    for (const sceneId of input.sceneIds) {
      const scene = parent.scenes.find(item => item.id === sceneId);
      const mapping = parent.render.sceneAssets.find(item => item.sceneId === sceneId);
      const visual = state.assets.find(item => item.id === mapping?.visualAssetId);
      const audio = state.assets.find(item => item.id === mapping?.audioAssetId);
      if (!scene || !visual || !audio) throw new Error(`Fragment source scene ${sceneId} is missing its exact visual/audio mapping`);
      const key = `${parent.id}:${scene.id}`;
      if (sceneKeys.has(key) || visualHashes.has(visual.sha256)) throw new Error('The same source scene or visual bytes cannot repeat inside a fragment composition');
      sceneKeys.add(key);
      visualHashes.add(visual.sha256);
      selected.push({ parent, scene, visual, audio, sourceRangeSeconds: ranges.get(scene.id) });
    }
  }
  return { selected, snapshots: [...validated.values()] };
}

function fingerprint(projectId, format, renderCanvas, selected) {
  const definition = { schemaVersion: 1, timebase: 'complete-source-scenes', projectId, format, renderCanvas,
    scenes: selected.map(({ parent, scene, visual, audio, sourceRangeSeconds }) => ({
      sourceEpisodeId: parent.id, sourceRenderSha256: parent.render.sha256, sourceSceneId: scene.id,
      sourceRangeSeconds, durationSeconds: scene.durationSeconds, visualSha256: visual.sha256, audioSha256: audio.sha256,
    })) };
  return createHash('sha256').update(canonical(definition)).digest('hex');
}

function assetLineage(parent, scene, original, compositionFingerprint) {
  return { sourceEpisodeId: parent.id, sourceSceneId: scene.id, sourceAssetId: original.id,
    sourceSha256: original.sha256, parentRenderSha256: parent.render.sha256, compositionFingerprint,
    ...(original.lineage === undefined ? {} : { sourceLineage: structuredClone(original.lineage) }) };
}

/** Validate the stored definition against current originals; no rendering or external requests. */
export async function validateFragmentComposition(state, episode, directory, { env = {}, ancestors = new Set() } = {}) {
  const composition = episode.fragmentComposition;
  if (composition?.schemaVersion !== 1 || composition.timebase !== 'complete-source-scenes' || !sha.safeParse(composition.fingerprint).success ||
      episode.audioMode !== 'nonverbal' || episode.derivation !== undefined || ancestors.has(episode.id)) throw new Error('Fragment composition definition is invalid or cyclic');
  const chain = new Set(ancestors).add(episode.id);
  const sources = sourcesSchema.parse(composition.sources);
  const { selected, snapshots } = await collectSources(state, sources, directory, env, chain);
  if (fingerprint(episode.projectId, episodeLimits(episode).format, episode.renderCanvas ?? 'portrait', selected) !== composition.fingerprint ||
      canonical(snapshots) !== canonical(composition.sourceSnapshots)) throw new Error('Fragment composition originals or fingerprint changed');
  if (!Array.isArray(episode.scenes) || episode.scenes.length !== selected.length || !Array.isArray(composition.sceneBindings) || composition.sceneBindings.length !== selected.length) throw new Error('Fragment composition must map each selected source exactly once');
  const assetIds = new Set();
  for (const [index, original] of selected.entries()) {
    const scene = episode.scenes[index];
    const binding = composition.sceneBindings[index];
    if (scene.id !== binding?.sceneId || binding.sourceEpisodeId !== original.parent.id || binding.sourceSceneId !== original.scene.id ||
        binding.sourceRenderSha256 !== original.parent.render.sha256 || canonical(binding.sourceRangeSeconds) !== canonical(original.sourceRangeSeconds) ||
        scene.durationSeconds !== original.scene.durationSeconds || (scene.narration ?? '') !== (original.scene.narration ?? '') || scene.visualPrompt !== original.scene.visualPrompt) throw new Error('Fragment composition scene order, script or full-source range changed');
    for (const kind of ['visual', 'audio']) {
      const source = original[kind];
      const record = binding[kind];
      const copied = state.assets.find(asset => asset.id === record?.assetId);
      if (!copied || assetIds.has(copied.id) || copied.episodeId !== episode.id || copied.sceneId !== scene.id ||
          record.sourceAssetId !== source.id || record.sha256 !== source.sha256 || copied.kind !== source.kind || copied.path !== source.path ||
          copied.sha256 !== source.sha256 || copied.synthetic !== true || canonical(copied.provenance) !== canonical(source.provenance) ||
          canonical(copied.lineage) !== canonical(assetLineage(original.parent, original.scene, source, composition.fingerprint))) throw new Error('Fragment composition must preserve original source bytes, rights and exact asset lineage');
      assetIds.add(copied.id);
      if (episode.render && episode.render.sceneAssets?.find(item => item.sceneId === scene.id)?.[`${kind}AssetId`] !== copied.id) throw new Error('Fragment render must use its explicitly remapped source assets');
    }
  }
}

/** Plan from existing complete audiovisual scenes; repeated selection reuses one canonical work. */
export class FragmentComposition {
  constructor(store, { env = process.env } = {}) { this.store = store; this.env = env; }

  async plan(value) {
    const input = planSchema.parse(value);
    return this.store.transaction(async state => {
      if (!state.projects.some(project => project.id === input.projectId && project.status === 'active')) throw new Error('Fragment composition requires its active target project');
      const { selected, snapshots } = await collectSources(state, input.sources, this.store.directory, this.env);
      const limits = episodeLimits(input.format);
      const durationSeconds = selected.reduce((total, item) => total + item.scene.durationSeconds, 0);
      if (selected.length > limits.maxScenes || durationSeconds > limits.maxDurationSeconds) throw new Error('Fragment composition exceeds the selected format scene or duration limit');
      // Validate editorial input through the same domain contract even on reuse,
      // without persisting the disposable plan or acquiring another store lock.
      const factualSources = [...new Map(selected.flatMap(({ parent }) => parent.factualSources ?? []).map(source => [canonical(source), structuredClone(source)])).values()];
      const planningState = { ...state, episodes: [...state.episodes] };
      const studio = new Studio(draftStore(planningState, this.store.directory), { env: this.env });
      const episode = await studio.planEpisode({ projectId: input.projectId, format: input.format, renderCanvas: input.renderCanvas,
        title: input.title, hook: input.hook, synopsis: input.synopsis, originalAngle: input.originalAngle,
        ...(input.continuityNote === undefined ? {} : { continuityNote: input.continuityNote }), metadata: input.metadata,
        audioMode: 'nonverbal', factualSources,
        scenes: selected.map(({ scene }) => ({ durationSeconds: scene.durationSeconds, narration: '', visualPrompt: scene.visualPrompt })) });
      const compositionFingerprint = fingerprint(input.projectId, input.format, input.renderCanvas, selected);
      const existing = state.episodes.find(episode => episode.fragmentComposition?.fingerprint === compositionFingerprint);
      if (existing) {
        await validateFragmentComposition(state, existing, this.store.directory, { env: this.env });
        return { episode: existing, reused: true };
      }
      const parent = selected[0].parent;
      if (parent.projectId === input.projectId && episodeLimits(parent).format === input.format &&
          (parent.renderCanvas ?? 'portrait') === input.renderCanvas && selected.length === parent.scenes.length &&
          selected.every((item, index) => item.parent.id === parent.id && item.scene.id === parent.scenes[index].id)) {
        return { episode: parent, reused: true, reuseReason: 'complete-source' };
      }
      state.episodes.push(episode);
      const createdAt = new Date().toISOString();
      const sceneBindings = selected.map((original, index) => {
        const scene = episode.scenes[index];
        const binding = { sceneId: scene.id, sourceEpisodeId: original.parent.id, sourceSceneId: original.scene.id,
          sourceRenderSha256: original.parent.render.sha256, sourceRangeSeconds: [...original.sourceRangeSeconds] };
        for (const kind of ['visual', 'audio']) {
          const source = original[kind];
          const copied = { ...structuredClone(source), id: randomUUID(), episodeId: episode.id, sceneId: scene.id, createdAt,
            lineage: assetLineage(original.parent, original.scene, source, compositionFingerprint) };
          state.assets.push(copied);
          binding[kind] = { assetId: copied.id, sourceAssetId: source.id, sha256: source.sha256 };
        }
        return binding;
      });
      episode.fragmentComposition = { schemaVersion: 1, timebase: 'complete-source-scenes', fingerprint: compositionFingerprint,
        sources: structuredClone(input.sources), sourceSnapshots: snapshots, sceneBindings };
      await validateFragmentComposition(state, episode, this.store.directory, { env: this.env });
      return { episode, reused: false };
    });
  }
}
