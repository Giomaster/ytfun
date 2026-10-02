import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { assertYouTubeConnected, isYouTubeTrend, youtubeApiData } from './youtube-data-policy.mjs';
import { renderProfile } from './render-profile.mjs';
import { normalizeApprovalReview } from './review-policy.mjs';

const maximumTrendAgeMs = 7 * 24 * 60 * 60 * 1000;
const futureToleranceMs = 5 * 60 * 1000;
const sourceAssetMaximumBytes = 100 * 1024 * 1024;

export function episodeLimits(episodeOrFormat) {
  const supplied = typeof episodeOrFormat === 'object' && episodeOrFormat !== null ? episodeOrFormat.format : episodeOrFormat;
  const format = supplied === undefined ? 'short' : supplied;
  if (!['short', 'long'].includes(format)) throw new Error('format must be short or long');
  return format === 'long'
    ? { format, maxScenes: 120, maxDurationSeconds: 900, maxRenderBytes: 512 * 1024 * 1024 }
    : { format, maxScenes: 12, maxDurationSeconds: 180, maxRenderBytes: sourceAssetMaximumBytes };
}

function text(value, name, maximum = 10000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > maximum) throw new Error(`${name} is too long (maximum ${maximum})`);
  return value.trim();
}

function optionalText(value, name, maximum = 10000) {
  return value === undefined ? '' : text(value, name, maximum);
}

function audioMode(value) {
  const mode = value ?? 'narrated';
  if (!['narrated', 'silent', 'nonverbal'].includes(mode)) throw new Error('audioMode must be narrated, silent or nonverbal');
  return mode;
}

function sceneNarration(value, mode) {
  if (mode === 'narrated') return text(value, 'narration');
  if (value !== undefined && (typeof value !== 'string' || value.trim())) throw new Error(`${mode === 'silent' ? 'Silent' : 'Nonverbal'} episodes cannot contain narration`);
  return '';
}

function storyText(episode) {
  return ['silent', 'nonverbal'].includes(episode.audioMode)
    ? [episode.originalAngle ?? '', ...(episode.scenes ?? []).map(scene => scene.visualPrompt)].join(' ')
    : (episode.scenes ?? []).map(scene => scene.narration).join(' ');
}

function repeatedStory(left, right) {
  return (left.audioMode ?? 'narrated') === (right.audioMode ?? 'narrated') && tokenOverlap(storyText(left), storyText(right)) > 0.85;
}

function description(value) {
  if (typeof value !== 'string' || value.length > 5000) throw new Error('metadata.description must be text of at most 5000 characters');
  return value.trim();
}

function episodeMetadata(value) {
  const hashtags = value?.hashtags ?? [];
  if (!Array.isArray(hashtags) || hashtags.length > 8) throw new Error('metadata.hashtags must contain at most 8 relevant hashtags');
  const validatedHashtags = hashtags.map((tag) => {
    const result = text(tag, 'hashtag', 60);
    if (!/^#[\p{L}\p{N}_]+$/u.test(result)) throw new Error('Hashtags must begin with # and contain only letters, numbers or underscores');
    return result;
  });
  if (new Set(validatedHashtags.map((tag) => tag.toLowerCase())).size !== validatedHashtags.length) throw new Error('Hashtags must be unique');
  return { description: description(value?.description), hashtags: validatedHashtags };
}

function httpUrl(value, name) {
  const result = text(value, name, 4000);
  let parsed;
  try { parsed = new URL(result); } catch { throw new Error(`${name} must be an HTTP(S) URL`); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${name} must be an HTTP(S) URL without credentials`);
  return parsed.href;
}

function observedTime(value, name = 'observedAt') {
  const input = text(value, name, 100);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) throw new Error(`${name} must be an ISO timestamp with timezone`);
  const [year, month, day] = input.slice(0, 10).split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() + 1 !== month || calendarDate.getUTCDate() !== day) throw new Error(`${name} must be a valid timestamp`);
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} must be a valid timestamp`);
  if (timestamp > Date.now() + futureToleranceMs) throw new Error(`${name} cannot be in the future`);
  return new Date(timestamp).toISOString();
}

function number(value, name, minimum, maximum = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}

function calendarDay(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must be an ISO calendar date`);
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) throw new Error(`${name} must be a valid calendar date`);
  return value;
}

function rejectClientId(input) {
  if (input?.id !== undefined) throw new Error('Entity IDs are generated by the studio');
}

function requireProject(state, id) {
  const project = state.projects.find((entry) => entry.id === id);
  if (!project) throw new Error(`Project not found: ${id}`);
  if (project.status !== 'active') throw new Error(`Project is not active: ${id}`);
  return project;
}

function requireEpisode(state, id) {
  const episode = state.episodes.find((entry) => entry.id === id);
  if (!episode) throw new Error(`Episode not found: ${id}`);
  return episode;
}

function normalizedTokens(value) {
  return new Set(String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

export function tokenOverlap(left, right) {
  const a = normalizedTokens(left);
  const b = normalizedTokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / (a.size + b.size - intersection);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function episodeReviewHash(episode) {
  const editorial = {
    title: episode.title, hook: episode.hook, synopsis: episode.synopsis,
    ...(episode.audioMode === undefined ? {} : { audioMode: episode.audioMode }),
    ...(episode.format === undefined ? {} : { format: episode.format }),
    ...(episode.renderCanvas === undefined ? {} : { renderCanvas: episode.renderCanvas }),
    ...(episode.derivation === undefined ? {} : { derivation: episode.derivation }),
    continuityNote: episode.continuityNote, originalAngle: episode.originalAngle,
    factualSources: episode.factualSources ?? [], scenes: episode.scenes,
    metadata: episode.metadata, trendIds: episode.trendIds,
    render: episode.render ? {
      sha256: episode.render.sha256, path: episode.render.path,
      durationSeconds: episode.render.durationSeconds,
      width: episode.render.width, height: episode.render.height,
      framesPerSecond: episode.render.framesPerSecond, format: episode.render.format,
      audioMode: episode.render.audioMode, hasAudio: episode.render.hasAudio,
      captionsPath: episode.render.captionsPath, captionsSha256: episode.render.captionsSha256,
      sceneAssets: episode.render.sceneAssets, synthetic: episode.render.synthetic,
      ...(episode.render.provenance === undefined ? {} : { provenance: episode.render.provenance }),
    } : null,
  };
  return createHash('sha256').update(canonicalJson(editorial)).digest('hex');
}

export function episodeAssetHash(episode, assets) {
  const ids = [...new Set((episode.render?.sceneAssets ?? []).flatMap((scene) => [scene.visualAssetId, scene.audioAssetId]).filter(Boolean))].sort();
  const manifest = ids.map((id) => {
    const asset = assets.find((entry) => entry.id === id);
    return asset ? { id, episodeId: asset.episodeId, sceneId: asset.sceneId, kind: asset.kind, path: asset.path, sha256: asset.sha256, synthetic: asset.synthetic, provenance: asset.provenance, ...(asset.lineage === undefined ? {} : { lineage: asset.lineage }), ...(asset.qualityReview === undefined ? {} : { qualityReview: asset.qualityReview }) } : { id, missing: true };
  });
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

export async function studioArtifactPath(directory, relativePath) {
  if (typeof relativePath !== 'string' || isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').some((part) => part === '..' || part === '.' || !part) || !relativePath.startsWith('assets/')) throw new Error('Artifact path must be relative within assets/');
  const base = resolve(directory);
  const target = resolve(base, relativePath);
  const actualBase = await realpath(base);
  const actualTarget = await realpath(target);
  if (!actualTarget.startsWith(`${actualBase}${sep}assets${sep}`)) throw new Error('Artifact path escapes studio assets directory');
  const info = await stat(actualTarget);
  if (!info.isFile() || info.size < 1) throw new Error('Artifact must be a nonempty regular file');
  return actualTarget;
}

export async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function licenseEvidence(asset) {
  const provenance = asset.provenance;
  if (asset.synthetic !== true) throw new Error(`Asset ${asset.id} must be generated with AI`);
  text(provenance?.provider, `Asset ${asset.id} provider`);
  text(provenance?.model, `Asset ${asset.id} model`);
  text(provenance?.prompt, `Asset ${asset.id} prompt`);
  httpUrl(provenance?.commercialLicense?.url, `Asset ${asset.id} commercialLicense.url`);
  text(provenance?.commercialLicense?.notes ?? provenance?.commercialLicense?.evidence, `Asset ${asset.id} commercialLicense evidence`);
}

async function validateArtifactFile(directory, artifact, maximumBytes = Infinity) {
  if (!/^[a-f0-9]{64}$/i.test(artifact.sha256 ?? '')) throw new Error(`Artifact ${artifact.id ?? 'render'} requires a SHA256`);
  const path = await studioArtifactPath(directory, artifact.path);
  if ((await stat(path)).size > maximumBytes) throw new Error(`Artifact ${artifact.id ?? 'render'} exceeds its byte limit`);
  if (await fileSha256(path) !== artifact.sha256.toLowerCase()) throw new Error(`Artifact ${artifact.id ?? 'render'} file hash changed`);
}

function sourceRanges(parent, sceneIds, scenes) {
  let startSeconds = 0;
  const ranges = new Map(parent.scenes.map((scene) => {
    const range = { sourceSceneId: scene.id, startSeconds, endSeconds: startSeconds + scene.durationSeconds };
    startSeconds = range.endSeconds;
    return [scene.id, range];
  }));
  return sceneIds.map((id, index) => ({ ...ranges.get(id), sceneId: scenes[index].id }));
}

function derivationSource(state, episode) {
  const lineage = episode.derivation;
  if (!lineage || episodeLimits(episode).format !== 'short') throw new Error('Derived episodes must be short and retain their lineage');
  const parent = requireEpisode(state, lineage.parentEpisodeId);
  if (episodeLimits(parent).format !== 'long' || parent.derivation !== undefined || !parent.render) throw new Error('Derivation requires an original rendered long episode');
  if (lineage.parentRenderSha256 !== parent.render.sha256 || lineage.parentReviewHash !== episodeReviewHash(parent) || lineage.parentAssetReviewHash !== episodeAssetHash(parent, state.assets)) throw new Error('The derivation source changed; create and review a new deliverable explicitly');
  const ids = lineage.sourceSceneIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 12 || new Set(ids).size !== ids.length || !Array.isArray(episode.scenes) || episode.scenes.length !== ids.length) throw new Error('Derivation must identify between 1 and 12 unique source scenes');
  let previous = -1;
  for (const [index, id] of ids.entries()) {
    const position = parent.scenes.findIndex(scene => scene.id === id);
    if (position <= previous) throw new Error('Source scenes must exist in their original chronological order');
    previous = position;
    const original = parent.scenes[position];
    const derived = episode.scenes[index];
    if (derived.durationSeconds !== original.durationSeconds || derived.narration !== original.narration || derived.visualPrompt !== original.visualPrompt) throw new Error('Derived scene scripts must match their original source');
  }
  if (lineage.timebase !== 'planned-scene-boundaries' || canonicalJson(lineage.sourceTimeRanges) !== canonicalJson(sourceRanges(parent, ids, episode.scenes))) throw new Error('Derived source time ranges must match the planned parent timeline');
  if (episode.projectId !== parent.projectId || audioMode(episode.audioMode) !== audioMode(parent.audioMode) || canonicalJson(episode.factualSources ?? []) !== canonicalJson(parent.factualSources ?? [])) throw new Error('Derived episodes must retain the original project, audio mode and factual evidence');
  const references = [];
  const copiedIds = new Set();
  for (const [index, id] of ids.entries()) {
    const scene = episode.scenes[index];
    const mapping = parent.render.sceneAssets?.find(entry => entry.sceneId === id);
    for (const field of ['visualAssetId', ...(parent.audioMode === 'silent' ? [] : ['audioAssetId'])]) {
      const original = state.assets.find(asset => asset.id === mapping?.[field]);
      const record = lineage.assets?.find(asset => asset.sourceAssetId === original?.id && asset.sceneId === scene.id);
      const copied = state.assets.find(asset => asset.id === record?.assetId);
      if (!original || original.episodeId !== parent.id || original.sceneId !== id || !copied || copied.episodeId !== episode.id || copied.sceneId !== scene.id || copiedIds.has(copied.id)) throw new Error('Derived scene assets must be copied and remapped from their original source');
      if (original.qualityReview?.decision === 'rejected' || copied.qualityReview?.decision === 'rejected') throw new Error('Rejected assets cannot be used as original or copied derivation sources');
      copiedIds.add(copied.id);
      const expected = { sourceEpisodeId: parent.id, sourceSceneId: id, sourceAssetId: original.id, sourceSha256: original.sha256, parentRenderSha256: parent.render.sha256 };
      if (record.sourceSceneId !== id || record.sha256 !== original.sha256 || canonicalJson(copied.lineage) !== canonicalJson(expected) || copied.kind !== original.kind || copied.path !== original.path || copied.sha256 !== original.sha256 || copied.synthetic !== true || canonicalJson(copied.provenance) !== canonicalJson(original.provenance)) throw new Error('Derived assets must preserve original bytes, generation provenance and lineage');
      if (episode.render && episode.render.sceneAssets?.find(entry => entry.sceneId === scene.id)?.[field] !== copied.id) throw new Error('The short render must use its remapped original source assets');
      references.push(original);
    }
  }
  if (!Array.isArray(lineage.assets) || lineage.assets.length !== references.length) throw new Error('Derivation asset lineage must contain exactly its source mappings');
  return { parent, references };
}

function sourceParentPair(state, left, right) {
  const child = left.derivation?.parentEpisodeId === right.id ? left : right.derivation?.parentEpisodeId === left.id ? right : null;
  if (!child) return false;
  try { derivationSource(state, child); return true; } catch { return false; }
}

async function validateDerivation(state, episode, directory) {
  const { parent, references } = derivationSource(state, episode);
  await validateArtifactFile(directory, parent.render, episodeLimits(parent).maxRenderBytes);
  for (const asset of references) { licenseEvidence(asset); await validateArtifactFile(directory, asset, sourceAssetMaximumBytes); }
}

export async function validateEpisodeDerivation(state, episode, directory) {
  if (episode.derivation !== undefined) await validateDerivation(state, episode, directory);
}

async function episodeFindings(state, episode, directory) {
  const findings = [];
  const add = (code, message) => findings.push({ severity: 'blocker', code, message });
  const project = state.projects.find((entry) => entry.id === episode.projectId);
  let limits;
  try { limits = episodeLimits(episode); } catch (error) { add('format_invalid', error.message); return findings; }
  if (!project || project.status !== 'active') add('project_inactive', 'The linked project must be active.');
  if (project?.mode === 'factual' && !(episode.factualSources?.length > 0)) add('facts_missing', 'Factual content needs claim-specific sources; trend references do not verify facts.');
  try {
    text(episode.title, 'title', 100);
    text(episode.hook, 'hook');
    description(episode.metadata?.description);
    for (const source of episode.factualSources ?? []) { text(source.claim, 'factualSources.claim'); httpUrl(source.url, 'factualSources.url'); }
  } catch (error) { add('editorial_input_invalid', error.message); }
  if (!Array.isArray(episode.scenes) || !episode.scenes.length || episode.scenes.length > limits.maxScenes) { add('scenes_invalid', `Episode must retain between 1 and ${limits.maxScenes} planned scenes.`); return findings; }
  try {
    if (new Set(episode.scenes.map((scene) => scene.id)).size !== episode.scenes.length) throw new Error('Scene IDs must be unique');
    const mode = audioMode(episode.audioMode);
    for (const scene of episode.scenes) { text(scene.id, 'scene.id', 100); number(scene.durationSeconds, 'durationSeconds', 1, 60); sceneNarration(scene.narration, mode); text(scene.visualPrompt, 'visualPrompt'); }
    if (episode.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) > limits.maxDurationSeconds) throw new Error(`Episode duration cannot exceed ${limits.maxDurationSeconds} seconds`);
  } catch (error) { add('scene_script_invalid', error.message); }
  if (episode.derivation !== undefined) {
    try { await validateDerivation(state, episode, directory); } catch (error) { add('derivation_invalid', error.message); }
  }
  const duplicates = state.episodes.filter((other) => other.id !== episode.id && (tokenOverlap(other.title, episode.title) > 0.85 || (!sourceParentPair(state, other, episode) && repeatedStory(other, episode))));
  if (duplicates.length) add('duplicate_episode', `Near duplicate episodes: ${duplicates.map((entry) => entry.id).join(', ')}`);
  if (!episode.originalAngle?.trim()) add('original_angle_missing', 'Describe the original narrative angle.');
  if (['rendering', 'publishing', 'processing', 'uploaded', 'scheduled', 'published'].includes(episode.status) || state.publications.some((publication) => publication.episodeId === episode.id && ['reserved', 'uploading', 'sending', 'unknown', 'processing', 'uploaded', 'scheduled', 'published'].includes(publication.status))) add('episode_busy', 'Publication has reserved or frozen this episode; approval cannot change until its outcome is reconciled.');
  if (!episode.render) {
    add('render_missing', 'Generate and watch the final render before approval.');
    return findings;
  }
  if (episode.render.synthetic !== true) add('render_not_synthetic', 'The render must identify the content as AI generated.');
  const silent = episode.audioMode === 'silent';
  const nonverbal = episode.audioMode === 'nonverbal';
  if (silent && (episode.render.audioMode !== 'silent' || episode.render.hasAudio !== false ||
      ['captionsPath', 'captionsSha256', 'captionsTiming'].some(key => episode.render[key] !== undefined) ||
      (Array.isArray(episode.render.sceneAssets) && episode.render.sceneAssets.some(mapping => mapping.audioAssetId !== undefined)))) add('silent_render_invalid', 'Silent renders must attest zero audio and contain no narration assets or captions.');
  if (!silent && episode.render.audioMode === 'silent') add('audio_mode_mismatch', 'The render audio mode must match the planned episode.');
  if (nonverbal && (episode.render.audioMode !== 'nonverbal' || episode.render.hasAudio !== true || ['captionsPath', 'captionsSha256', 'captionsTiming'].some(key => episode.render[key] !== undefined))) add('nonverbal_render_invalid', 'Nonverbal renders must contain original audio and no narration captions.');
  try { await validateArtifactFile(directory, episode.render, limits.maxRenderBytes); } catch (error) { add('render_invalid', error.message); }
  if (episode.render.captionsPath) {
    try { await validateArtifactFile(directory, { path: episode.render.captionsPath, sha256: episode.render.captionsSha256 }); }
    catch (error) { add('captions_invalid', error.message); }
  }
  const duration = episode.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  if (!Number.isFinite(episode.render.durationSeconds) || episode.render.durationSeconds <= 0 || episode.render.durationSeconds > limits.maxDurationSeconds || Math.abs(episode.render.durationSeconds - duration) > 1) add('render_duration', `Render duration must match the planned scene durations within one second and remain within ${limits.maxDurationSeconds} seconds.`);
  const mapping = episode.render.sceneAssets;
  if (!Array.isArray(mapping)) { add('scene_assets_missing', 'Final render requires sceneAssets mappings.'); return findings; }
  const sceneIds = new Set(episode.scenes.map((scene) => scene.id));
  if (mapping.length !== episode.scenes.length || new Set(mapping.map((entry) => entry.sceneId)).size !== mapping.length || mapping.some((entry) => !sceneIds.has(entry.sceneId))) add('scene_mapping_invalid', 'Final render must map each planned scene exactly once.');
  for (const scene of episode.scenes) {
    const linked = mapping.find((entry) => entry.sceneId === scene.id);
    const fields = [['visualAssetId', ['image', 'video']], ...(!silent ? [['audioAssetId', ['audio']]] : [])];
    for (const [field, allowed] of fields) {
      const asset = state.assets.find((entry) => entry.id === linked?.[field]);
      if (!asset || asset.episodeId !== episode.id || asset.sceneId !== scene.id || !allowed.includes(asset.kind)) { add('scene_asset_invalid', `${scene.id}: ${field} needs a linked AI-generated ${allowed.join('/')} asset.`); continue; }
      if (asset.qualityReview?.decision === 'rejected') { add('asset_rejected', `Asset ${asset.id} was rejected by quality review; replace it explicitly before approval or derivation.`); continue; }
      try { licenseEvidence(asset); await validateArtifactFile(directory, asset, sourceAssetMaximumBytes); } catch (error) { add('asset_invalid', error.message); }
    }
  }
  return findings;
}

export class Studio {
  constructor(store, { env = process.env } = {}) { this.store = store; this.env = env; this.youtubeGrantId = env.YTFUN_YOUTUBE_GRANT_ID || 'legacy'; }

  async createProject(input) {
    rejectClientId(input);
    const mode = input.mode ?? 'fiction';
    if (!['fiction', 'factual'].includes(mode)) throw new Error('mode must be fiction or factual');
    const cadence = {
      minHoursBetweenPosts: number(input.cadence?.minHoursBetweenPosts ?? 24, 'minHoursBetweenPosts', 12),
      maxPostsPerRollingDay: number(input.cadence?.maxPostsPerRollingDay ?? 1, 'maxPostsPerRollingDay', 1, 3),
    };
    if (!Number.isInteger(cadence.maxPostsPerRollingDay)) throw new Error('maxPostsPerRollingDay must be an integer');
    const budgetMonthlyUsd = input.budgetMonthlyUsd ?? null;
    if (budgetMonthlyUsd !== null) number(budgetMonthlyUsd, 'budgetMonthlyUsd', 0);
    if (input.costPolicy !== undefined && input.costPolicy !== 'free_first') throw new Error('costPolicy must be free_first');
    const language = text(input.language, 'language', 30);
    if (language.length < 2) throw new Error('language must contain at least 2 characters');
    const project = {
      id: randomUUID(), title: text(input.title, 'title', 160), premise: text(input.premise, 'premise'),
      audience: text(input.audience, 'audience'), language,
      continuity: optionalText(input.continuity, 'continuity'), mode, cadence, budgetMonthlyUsd,
      costPolicy: 'free_first', status: 'active', createdAt: new Date().toISOString(),
    };
    return this.store.transaction((state) => { state.projects.push(project); return project; });
  }

  async listProjects() { return (await this.store.read()).projects; }

  async updateProjectCadence(input) {
    const projectId = text(input.projectId, 'projectId', 100);
    const cadence = {
      minHoursBetweenPosts: number(input.cadence?.minHoursBetweenPosts, 'minHoursBetweenPosts', 12),
      maxPostsPerRollingDay: number(input.cadence?.maxPostsPerRollingDay, 'maxPostsPerRollingDay', 1, 3),
    };
    if (!Number.isInteger(cadence.maxPostsPerRollingDay)) throw new Error('maxPostsPerRollingDay must be an integer');
    const expectedCadence = {
      minHoursBetweenPosts: number(input.expectedCadence?.minHoursBetweenPosts, 'expectedCadence.minHoursBetweenPosts', 12),
      maxPostsPerRollingDay: number(input.expectedCadence?.maxPostsPerRollingDay, 'expectedCadence.maxPostsPerRollingDay', 1, 3),
    };
    const reason = text(input.reason, 'reason');
    return this.store.transaction((state) => {
      const project = requireProject(state, projectId);
      if (project.cadence.minHoursBetweenPosts !== expectedCadence.minHoursBetweenPosts || project.cadence.maxPostsPerRollingDay !== expectedCadence.maxPostsPerRollingDay) throw new Error('Project cadence changed; read the current policy before updating');
      if (project.cadence.minHoursBetweenPosts === cadence.minHoursBetweenPosts && project.cadence.maxPostsPerRollingDay === cadence.maxPostsPerRollingDay) return project;
      project.cadenceHistory ??= [];
      project.cadenceHistory.push({ previous: { ...project.cadence }, next: { ...cadence }, reason, changedAt: new Date().toISOString() });
      project.cadence = cadence;
      return project;
    });
  }

  async addTrend(input) {
    rejectClientId(input);
    const trend = { id: randomUUID(), topic: text(input.topic, 'topic', 500), sourceUrl: httpUrl(input.sourceUrl, 'sourceUrl'), observedAt: observedTime(input.observedAt), evidence: text(input.evidence, 'evidence'), ...(input.projectId === undefined ? {} : { projectId: text(input.projectId, 'projectId', 100) }) };
    if (isYouTubeTrend(trend)) trend.apiData = youtubeApiData({ grantId: this.youtubeGrantId, now: Date.parse(trend.observedAt) });
    return this.store.transaction((state) => {
      if (trend.apiData) assertYouTubeConnected(state, { YTFUN_YOUTUBE_GRANT_ID: this.youtubeGrantId });
      if (trend.projectId) requireProject(state, trend.projectId);
      state.trends.push(trend); return trend;
    });
  }

  async planEpisode(input) {
    rejectClientId(input);
    const mode = audioMode(input.audioMode);
    const limits = episodeLimits(input.format);
    renderProfile(input.renderCanvas);
    if (!Array.isArray(input.scenes) || !input.scenes.length || input.scenes.length > limits.maxScenes) throw new Error(`scenes must contain between 1 and ${limits.maxScenes} scenes`);
    const scenes = input.scenes.map((scene) => {
      rejectClientId(scene);
      return { id: randomUUID(), durationSeconds: number(scene.durationSeconds, 'durationSeconds', 1, 60), narration: sceneNarration(scene.narration, mode), visualPrompt: text(scene.visualPrompt, 'visualPrompt') };
    });
    if (scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) > limits.maxDurationSeconds) throw new Error(`Episode duration cannot exceed ${limits.maxDurationSeconds} seconds`);
    const trendIds = input.trendIds ?? [];
    if (!Array.isArray(trendIds) || trendIds.length > 20 || trendIds.some((id) => typeof id !== 'string' || !id) || new Set(trendIds).size !== trendIds.length) throw new Error('trendIds must contain at most 20 unique IDs');
    const factualSources = input.factualSources ?? [];
    if (!Array.isArray(factualSources) || factualSources.length > 40) throw new Error('factualSources must be an array of at most 40 sources');
    const validatedSources = factualSources.map((source) => ({ claim: text(source.claim, 'factualSources.claim'), url: httpUrl(source.url, 'factualSources.url') }));
    const episode = {
      id: randomUUID(), projectId: text(input.projectId, 'projectId', 100), title: text(input.title, 'title', 100),
      hook: text(input.hook, 'hook'), synopsis: text(input.synopsis, 'synopsis'),
      continuityNote: optionalText(input.continuityNote, 'continuityNote'), originalAngle: text(input.originalAngle, 'originalAngle'),
      factualSources: validatedSources, scenes, audioMode: mode, format: limits.format,
      ...(input.renderCanvas === undefined ? {} : { renderCanvas: input.renderCanvas }),
      metadata: episodeMetadata(input.metadata),
      trendIds: [...trendIds], createdAt: new Date().toISOString(), status: 'planned', render: null, approval: null, metrics: [],
    };
    return this.store.transaction((state) => {
      const project = requireProject(state, episode.projectId);
      if (project.mode === 'factual' && !validatedSources.length) throw new Error('Factual episodes require claim-specific factualSources; trends do not verify facts');
      for (const id of trendIds) {
        const trend = state.trends.find((entry) => entry.id === id);
        if (!trend) throw new Error(`Trend not found: ${id}`);
        if (trend.projectId && trend.projectId !== episode.projectId) throw new Error(`Trend belongs to another project: ${id}`);
        const observedAt = Date.parse(trend.observedAt);
        if (!Number.isFinite(observedAt) || observedAt > Date.now() + futureToleranceMs || Date.now() - observedAt > maximumTrendAgeMs) throw new Error(`Trend evidence is stale or invalid (maximum age 7 days): ${id}`);
      }
      for (const previous of state.episodes) {
        if (tokenOverlap(previous.title, episode.title) > 0.85 || repeatedStory(previous, episode)) throw new Error(`Near duplicate episode ${previous.id}: title or ${mode === 'narrated' ? 'narration' : 'visual story'} token overlap exceeds 0.85`);
      }
      state.episodes.push(episode);
      return episode;
    });
  }

  async deriveShort(input) {
    rejectClientId(input);
    const ids = input.sceneIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 12 || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('sceneIds must contain between 1 and 12 unique source scene IDs');
    const editorial = {
      title: text(input.title, 'title', 100), hook: text(input.hook, 'hook'), synopsis: text(input.synopsis, 'synopsis'),
      originalAngle: text(input.originalAngle, 'originalAngle'), continuityNote: optionalText(input.continuityNote, 'continuityNote'), metadata: episodeMetadata(input.metadata),
    };
    return this.store.transaction(async (state) => {
      const parent = requireEpisode(state, input.parentEpisodeId);
      requireProject(state, parent.projectId);
      if (episodeLimits(parent).format !== 'long' || parent.derivation !== undefined || !parent.render || !['rendered', 'approved', 'publishing', 'processing', 'uploaded', 'scheduled', 'published'].includes(parent.status)) throw new Error('Derivation requires an original rendered long episode');
      if (state.spending.some(entry => entry.episodeId === parent.id && ['reserved', 'unknown'].includes(entry.status))) throw new Error('Resolve pending source generation outcomes before derivation');
      if (state.episodes.some(entry => entry.derivation?.parentEpisodeId === parent.id && canonicalJson(entry.derivation.sourceSceneIds) === canonicalJson(ids))) throw new Error('This source scene selection has already been derived');
      const findings = (await episodeFindings(state, parent, this.store.directory)).filter(entry => entry.code !== 'episode_busy');
      if (findings.length) throw new Error(`Derivation source is invalid: ${findings.map(entry => entry.message).join('; ')}`);
      let previous = -1;
      const scenes = ids.map((id) => {
        const position = parent.scenes.findIndex(scene => scene.id === id);
        if (position <= previous) throw new Error('Source scenes must exist in their original chronological order');
        previous = position;
        return { ...structuredClone(parent.scenes[position]), id: randomUUID() };
      });
      if (scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) > episodeLimits('short').maxDurationSeconds) throw new Error('Derived short duration cannot exceed 180 seconds');
      const episode = {
        id: randomUUID(), projectId: parent.projectId, ...editorial, scenes, audioMode: audioMode(parent.audioMode), format: 'short',
        factualSources: structuredClone(parent.factualSources ?? []), trendIds: [], createdAt: new Date().toISOString(), status: 'planned', render: null, approval: null, metrics: [],
        derivation: { parentEpisodeId: parent.id, parentRenderSha256: parent.render.sha256, parentReviewHash: episodeReviewHash(parent), parentAssetReviewHash: episodeAssetHash(parent, state.assets), sourceSceneIds: [...ids], timebase: 'planned-scene-boundaries', sourceTimeRanges: sourceRanges(parent, ids, scenes), assets: [] },
      };
      const copied = [];
      for (const [index, sourceSceneId] of ids.entries()) {
        const mapping = parent.render.sceneAssets.find(entry => entry.sceneId === sourceSceneId);
        for (const assetId of [mapping.visualAssetId, ...(parent.audioMode === 'silent' ? [] : [mapping.audioAssetId])]) {
          const original = state.assets.find(asset => asset.id === assetId);
          const asset = { ...structuredClone(original), id: randomUUID(), episodeId: episode.id, sceneId: scenes[index].id, createdAt: new Date().toISOString(), lineage: { sourceEpisodeId: parent.id, sourceSceneId, sourceAssetId: original.id, sourceSha256: original.sha256, parentRenderSha256: parent.render.sha256 } };
          copied.push(asset);
          episode.derivation.assets.push({ assetId: asset.id, sourceAssetId: original.id, sourceSceneId, sceneId: asset.sceneId, sha256: original.sha256 });
        }
      }
      state.assets.push(...copied);
      await validateDerivation(state, episode, this.store.directory);
      for (const previousEpisode of state.episodes) {
        if (tokenOverlap(previousEpisode.title, episode.title) > 0.85 || (!sourceParentPair(state, previousEpisode, episode) && repeatedStory(previousEpisode, episode))) throw new Error(`Near duplicate episode ${previousEpisode.id}: title or visual story/narration token overlap exceeds 0.85`);
      }
      state.episodes.push(episode);
      return episode;
    });
  }

  async getEpisode(id) { return requireEpisode(await this.store.read(), id); }

  async recordMetrics(input) {
    rejectClientId(input);
    if (!['youtube', 'facebook', 'tiktok', 'kwai'].includes(input.platform)) throw new Error('platform must be youtube, facebook, tiktok, or kwai');
    const metric = { id: randomUUID(), platform: input.platform, observedAt: observedTime(input.observedAt), sourceUrl: httpUrl(input.sourceUrl, 'sourceUrl') };
    if (metric.platform === 'youtube') metric.apiData = youtubeApiData({ authorized: true, grantId: this.youtubeGrantId, now: Date.parse(metric.observedAt) });
    for (const [key, maximum] of [['views', Infinity], ['retentionRatio', Infinity], ['completionRate', 1], ['revenueUsd', Infinity]]) {
      if (input[key] !== undefined) metric[key] = number(input[key], key, 0, maximum);
    }
    if (metric.views !== undefined && !Number.isInteger(metric.views)) throw new Error('views must be an integer');
    if (!['views', 'retentionRatio', 'completionRate', 'revenueUsd'].some((key) => metric[key] !== undefined)) throw new Error('At least one observed metric is required');
    if ((input.periodStart !== undefined) !== (input.periodEnd !== undefined)) throw new Error('periodStart and periodEnd must be supplied together');
    if (input.periodStart !== undefined) {
      metric.periodStart = calendarDay(input.periodStart, 'periodStart');
      metric.periodEnd = calendarDay(input.periodEnd, 'periodEnd');
      if (metric.periodStart > metric.periodEnd) throw new Error('periodStart must not be after periodEnd');
    }
    return this.store.transaction((state) => {
      if (metric.platform === 'youtube') assertYouTubeConnected(state, { YTFUN_YOUTUBE_GRANT_ID: this.youtubeGrantId });
      const episode = requireEpisode(state, input.episodeId);
      if (episode.metrics.some((entry) => entry.platform === metric.platform && entry.observedAt === metric.observedAt && entry.sourceUrl === metric.sourceUrl && entry.periodStart === metric.periodStart && entry.periodEnd === metric.periodEnd)) throw new Error('Metric observation already recorded');
      episode.metrics.push(metric);
      return metric;
    });
  }

  async editorialReview(id) {
    const state = await this.store.read();
    const episode = requireEpisode(state, id);
    const findings = await episodeFindings(state, episode, this.store.directory);
    let limits;
    try { limits = episodeLimits(episode); } catch { limits = { format: episode.format }; }
    return {
      episodeId: episode.id, readyForApproval: findings.length === 0, findings,
      reviewHash: episodeReviewHash(episode),
      limits: { format: limits.format, maximumScenes: limits.maxScenes, maximumDurationSeconds: limits.maxDurationSeconds, maximumRenderBytes: limits.maxRenderBytes, maximumTrendAgeDays: 7, duplicateTokenOverlapThreshold: 0.85, cadenceIsEditorialHypothesis: true, monetization: 'Platform eligibility and revenue require platform decisions and observed results; no views or income are promised.' },
    };
  }

  async approveEpisode(input) {
    return this.store.transaction(async (state) => {
      const episode = requireEpisode(state, input.episodeId);
      const review = normalizeApprovalReview(input.review, { env: this.env, render: episode.render });
      const findings = await episodeFindings(state, episode, this.store.directory);
      if (findings.length) throw new Error(`Episode is not ready for approval: ${findings.map((entry) => entry.message).join('; ')}`);
      episode.approval = { reviewHash: episodeReviewHash(episode), assetReviewHash: episodeAssetHash(episode, state.assets), approvedAt: new Date().toISOString(), review };
      episode.status = 'approved';
      return episode;
    });
  }
}
