import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { episodeReviewHash } from './domain.mjs';

export const BATCH_MODEL = 'Wan-AI/Wan2.2-I2V-A14B';
export const BATCH_ESTIMATE = 0.605;
export const BATCH_PARAMETERS = Object.freeze({ resolution: '720p', num_frames: 121, frames_per_second: 16, num_inference_steps: 40, interpolator_model: 'none', num_interpolated_frames: 0, enable_prompt_expansion: false });
export const BATCH_LICENSE = Object.freeze({ url: 'https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B', notes: 'Apache-2.0 model. Original synthetic reference and outputs; actual provider charges remain unknown until reconciled.' });
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const packetHash = packet => hash(JSON.stringify(packet));
const blocked = new Set(['reserved', 'uploading', 'sending', 'unknown', 'processing', 'uploaded', 'scheduled', 'published']);

export function sourceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !/^(?:[a-z0-9-]+\.)?fal\.media$/i.test(url.hostname)) throw new Error('Only the original owned fal.media result is supported');
  return url.href;
}

export function validatePacket(packet) {
  if (packet?.version !== 1 || !uuid.test(packet.id) || !uuid.test(packet.episodeId) || !digest.test(packet.editorialSha256) || packet.model !== BATCH_MODEL || packet.provider !== 'fal-ai' || packet.estimatedCostPerSceneUsd !== BATCH_ESTIMATE || !Number.isFinite(packet.costCeilingUsd) || packet.costCeilingUsd <= 0 || packet.costCeilingUsd > 75) throw new Error('Invalid authorized generation packet');
  if (!uuid.test(packet.source?.assetId) || !digest.test(packet.source.sha256)) throw new Error('Invalid original reference identity');
  sourceUrl(packet.source.url);
  if (!Array.isArray(packet.scenes) || !packet.scenes.length || packet.scenes.length > 120 || new Set(packet.scenes.map(x => x.sceneId)).size !== packet.scenes.length || new Set(packet.scenes.map(x => x.index)).size !== packet.scenes.length) throw new Error('Invalid batch scene selection');
  for (const scene of packet.scenes) {
    if (!uuid.test(scene.sceneId) || !uuid.test(scene.reservationId) || !Number.isInteger(scene.index) || scene.index < 1 || scene.index > 120 || scene.durationSeconds !== 7.5 || typeof scene.prompt !== 'string' || !scene.prompt.trim() || scene.prompt.length > 10000 || !Number.isInteger(scene.seed) || scene.seed < 0 || scene.seed > 4294967295) throw new Error('Invalid bounded batch scene');
  }
  if (packet.scenes.length * BATCH_ESTIMATE > packet.costCeilingUsd + 1e-9) throw new Error('Generation estimate exceeds the batch ceiling');
  const authorized = Date.parse(packet.authorizedAt); const expires = Date.parse(packet.authorizationExpiresAt);
  if (!Number.isFinite(authorized) || !Number.isFinite(expires) || expires <= authorized || expires - authorized > 12 * 3600000) throw new Error('A bounded batch authorization window is required');
  return structuredClone(packet);
}

function context(state, id) {
  const episode = state.episodes.find(x => x.id === id);
  const project = state.projects.find(x => x.id === episode?.projectId);
  if (!episode || !project || project.status !== 'active' || episode.status === 'published' || state.publications.some(x => x.episodeId === id && blocked.has(x.status))) throw new Error('A mutable active production episode is required');
  return { episode, project };
}

/** Explicit remote reservations use the same spending retry barriers as local inference. */
export class RemoteBatch {
  constructor(store, { fetchImpl = fetch, githubToken, repository } = {}) { this.store = store; this.fetch = fetchImpl; this.githubToken = githubToken; this.repository = repository; }

  async reserve({ episodeId, sourceAssetId, referenceUrl, sceneIds, promptOverrides = {}, replaceRejectedAssetIds = {}, costCeilingUsd, acknowledgePaidCost = false, paidGenerationEnabled = false }) {
    if (!acknowledgePaidCost || !paidGenerationEnabled) throw new Error('Paid batch generation must be explicitly authorized');
    return this.store.transaction(state => {
      const { episode, project } = context(state, episodeId);
      const source = state.assets.find(x => x.id === sourceAssetId);
      if (source?.synthetic !== true || source.kind !== 'video' || !digest.test(source.sha256) || !source.provenance?.commercialLicense?.url) throw new Error('Original synthetic source video with license evidence is required');
      if (!Array.isArray(sceneIds) || !sceneIds.length || new Set(sceneIds).size !== sceneIds.length) throw new Error('Select distinct episode scenes');
      for (const map of [promptOverrides, replaceRejectedAssetIds]) if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).some(key => !sceneIds.includes(key))) throw new Error('Overrides must identify only selected scenes');
      const scenes = sceneIds.map(sceneId => {
        const index = episode.scenes.findIndex(x => x.id === sceneId);
        if (index < 0) throw new Error('Batch scene does not belong to the episode');
        const scene = episode.scenes[index];
        if (state.spending.some(x => x.episodeId === episodeId && x.sceneId === sceneId && ['reserved', 'unknown'].includes(x.status))) throw new Error('Existing generation outcome must be reconciled; never regenerate automatically');
        const previous = state.assets.findLast(x => x.episodeId === episodeId && x.sceneId === sceneId && x.kind === 'video');
        const completed = state.spending.some(x => x.episodeId === episodeId && x.sceneId === sceneId && x.status === 'completed');
        const prompt = promptOverrides[sceneId] ?? scene.visualPrompt;
        if (previous || completed) {
          if (!previous || replaceRejectedAssetIds[sceneId] !== previous.id || previous.qualityReview?.decision !== 'rejected' || previous.qualityReview.sha256 !== previous.sha256 || prompt === previous.provenance.prompt) throw new Error('Existing asset must be explicitly rejected with observed evidence and corrected direction before another paid generation');
        } else if (replaceRejectedAssetIds[sceneId] !== undefined) throw new Error('Replacement must identify an existing rejected asset');
        return { index: index + 1, sceneId, reservationId: randomUUID(), prompt, durationSeconds: scene.durationSeconds, seed: 20261026 + index + (previous ? 1000 : 0), ...(previous ? { replacesRejectedAssetId: previous.id } : {}) };
      });
      const authorizedAt = new Date().toISOString();
      const packet = validatePacket({ version: 1, id: randomUUID(), episodeId, editorialSha256: episodeReviewHash({ ...episode, render: null }), authorizedAt, authorizationExpiresAt: new Date(Date.now() + 12 * 3600000).toISOString(), model: BATCH_MODEL, provider: 'fal-ai', estimatedCostPerSceneUsd: BATCH_ESTIMATE, costCeilingUsd, source: { assetId: source.id, sha256: source.sha256, url: sourceUrl(referenceUrl) }, scenes });
      const estimate = scenes.length * BATCH_ESTIMATE;
      if (project.budgetMonthlyUsd !== undefined && project.budgetMonthlyUsd !== null) {
        if (!Number.isFinite(project.budgetMonthlyUsd) || project.budgetMonthlyUsd < 0) throw new Error('Project generation budget is invalid');
        const month = new Date().toISOString().slice(0, 7);
        const spent = state.spending.filter(x => x.projectId === project.id && x.createdAt?.startsWith(month) && x.status !== 'failed').reduce((n, x) => n + (x.estimatedCostUsd ?? 0), 0);
        if (spent + estimate > project.budgetMonthlyUsd) throw new Error('Project generation budget exceeded');
      }
      state.productionBatches ??= [];
      state.productionBatches.push({ id: packet.id, packet, packetSha256: packetHash(packet), status: 'reserved', createdAt: new Date().toISOString() });
      for (const scene of scenes) state.spending.push({ id: scene.reservationId, projectId: project.id, episodeId, sceneId: scene.sceneId, kind: 'video', provider: 'fal-ai', model: BATCH_MODEL, prompt: scene.prompt, videoParameters: { ...BATCH_PARAMETERS, seed: scene.seed }, commercialLicense: BATCH_LICENSE, estimatedCostUsd: BATCH_ESTIMATE, pricingSourceUrl: 'https://fal.ai/models/fal-ai/wan/v2.2-a14b/image-to-video', status: 'reserved', batchId: packet.id, createdAt: new Date().toISOString() });
      episode.render = null; episode.approval = null; episode.status = 'planned';
      return packet;
    });
  }

  async rejectAsset({ episodeId, assetId, sha256, reviewedBy, findings }) {
    if (typeof reviewedBy !== 'string' || !reviewedBy.trim() || typeof findings !== 'string' || findings.trim().length < 20 || findings.length > 5000) throw new Error('Observed quality findings and reviewer are required');
    return this.store.transaction(state => {
      const { episode } = context(state, episodeId);
      const asset = state.assets.find(x => x.id === assetId && x.episodeId === episodeId && x.kind === 'video');
      if (!asset || asset.sha256 !== sha256 || state.spending.some(x => x.episodeId === episodeId && x.sceneId === asset.sceneId && ['reserved', 'unknown'].includes(x.status))) throw new Error('Exact completed asset with no pending outcome is required');
      asset.qualityReview = { decision: 'rejected', sha256, reviewedBy: reviewedBy.trim(), findings: findings.trim(), reviewedAt: new Date().toISOString() };
      episode.render = null; episode.approval = null; episode.status = 'planned';
      return asset.qualityReview;
    });
  }

  async releaseUnsubmitted({ batchId, sceneId, jobId }) {
    const state = await this.store.read(); const batch = state.productionBatches?.find(x => x.id === batchId); const scene = batch?.packet.scenes.find(x => x.sceneId === sceneId);
    if (!batch?.remoteRun || !scene || !/^\d+$/.test(String(jobId)) || !this.githubToken || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.repository ?? '')) throw new Error('Bound remote job and read-only GitHub proof are required');
    const url = `https://api.github.com/repos/${this.repository}/actions/jobs/${jobId}`;
    const response = await this.fetch(url, { headers: { Authorization: `Bearer ${this.githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error' });
    if (!response.ok) throw new Error('Cannot verify that the provider step was skipped');
    const job = await response.json();
    const providerStep = job.steps?.find(x => x.name === 'Run actions/github-script@v7');
    if (String(job.id) !== String(jobId) || String(job.run_id) !== batch.remoteRun.runId || job.head_sha !== batch.remoteRun.commitSha || job.name !== `sphere (${scene.index})` || job.status !== 'completed' || providerStep?.status !== 'completed' || providerStep.conclusion !== 'skipped') throw new Error('The owned terminal job does not prove that provider submission was skipped');
    return this.store.transaction(draft => {
      const current = draft.productionBatches.find(x => x.id === batchId); context(draft, batch.packet.episodeId);
      const reservation = draft.spending.find(x => x.id === scene.reservationId);
      if (current.remoteRun.runId !== batch.remoteRun.runId || reservation.status !== 'reserved' || reservation.remoteRequest || draft.assets.some(x => x.episodeId === batch.packet.episodeId && x.sceneId === sceneId && x.kind === 'video')) throw new Error('Submission evidence or generation outcome changed');
      reservation.status = 'failed'; reservation.actualCostUsd = 0; reservation.unsubmittedEvidence = { url: job.html_url ?? url, jobId: String(jobId), runId: current.remoteRun.runId, commitSha: job.head_sha, providerStep: 'skipped', verifiedAt: new Date().toISOString() }; current.status = 'attention';
      return reservation.unsubmittedEvidence;
    });
  }

  async bindRun({ batchId, runId, commitSha, packetSha256 }) {
    if (!/^\d+$/.test(String(runId)) || !/^[a-f0-9]{40}$/.test(commitSha)) throw new Error('Verified remote run identity is required');
    return this.store.transaction(state => {
      const batch = state.productionBatches?.find(x => x.id === batchId);
      if (!batch || batch.packetSha256 !== packetSha256 || batch.remoteRun) throw new Error('Batch dispatch identity changed or already bound');
      batch.remoteRun = { runId: String(runId), commitSha }; batch.status = 'running';
      return structuredClone(batch.remoteRun);
    });
  }

  async accept({ batchId, runId, result, localPath }) {
    if (!isAbsolute(localPath)) throw new Error('A local downloaded artifact is required');
    const state = await this.store.read();
    const batch = state.productionBatches?.find(x => x.id === batchId);
    const scene = batch?.packet.scenes.find(x => x.sceneId === result?.sceneId);
    if (!batch?.remoteRun || batch.remoteRun.runId !== String(runId) || result?.remoteRunId !== String(runId) || result.commitSha !== batch.remoteRun.commitSha || result.packetSha256 !== batch.packetSha256 || result.batchId !== batchId || !scene || result.reservationId !== scene.reservationId || result.status !== 'completed' || !digest.test(result.sha256) || !digest.test(result.referenceImageSha256) || result.sourceSha256 !== batch.packet.source.sha256 || !result.remoteRequest || result.remoteRequest.provider !== 'fal-ai' || result.remoteRequest.transport !== 'huggingface-router' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.remoteRequest.requestId)) throw new Error('Remote result does not match the authorized batch and run');
    const handle = await open(localPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 12 || info.size > 100 * 1024 * 1024) throw new Error('Remote source asset size is invalid');
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    if (bytes.length > 100 * 1024 * 1024 || bytes.toString('ascii', 4, 8) !== 'ftyp' || hash(bytes) !== result.sha256) throw new Error('Remote MP4 integrity failed');
    const assetId = randomUUID();
    const relativePath = `assets/${assetId}.mp4`;
    const destination = join(this.store.directory, relativePath);
    await mkdir(join(this.store.directory, 'assets'), { recursive: true });
    const output = await open(destination, 'wx', 0o600);
    try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
    try {
      return await this.store.transaction(draft => {
        const currentBatch = draft.productionBatches.find(x => x.id === batchId);
        const { episode } = context(draft, batch.packet.episodeId);
        if (currentBatch.packetSha256 !== batch.packetSha256 || currentBatch.remoteRun.runId !== String(runId) || episodeReviewHash(episode) !== batch.packet.editorialSha256) throw new Error('Episode or dispatch changed during remote generation');
        const reservation = draft.spending.find(x => x.id === scene.reservationId);
        if (reservation.status === 'completed') {
          const previous = draft.assets.find(x => x.id === reservation.assetId);
          if (previous?.sha256 !== result.sha256) throw new Error('Remote result changed after import');
          return { ...previous, alreadyImported: true };
        }
        if (!['reserved', 'unknown'].includes(reservation.status)) throw new Error('Generation reservation changed');
        const asset = { id: assetId, episodeId: episode.id, sceneId: scene.sceneId, kind: 'video', path: relativePath, sha256: result.sha256, synthetic: true, provenance: { provider: 'fal-ai', model: BATCH_MODEL, prompt: scene.prompt, videoParameters: { ...BATCH_PARAMETERS, seed: scene.seed }, commercialLicense: BATCH_LICENSE, parents: [{ assetId: batch.packet.source.assetId, sha256: batch.packet.source.sha256 }], derivedReference: { sourceVideoSha256: result.sourceSha256, timeSeconds: 0, sha256: result.referenceImageSha256 }, batchId, remoteRunId: String(runId), remoteRequestId: result.remoteRequest.requestId }, createdAt: new Date().toISOString() };
        draft.assets.push(asset);
        Object.assign(reservation, { status: 'completed', assetId, remoteRequest: result.remoteRequest, completedAt: new Date().toISOString(), actualCostUsd: null });
        episode.render = null; episode.approval = null; episode.status = 'planned';
        if (currentBatch.packet.scenes.every(x => draft.spending.find(y => y.id === x.reservationId)?.status === 'completed')) currentBatch.status = 'completed';
        return asset;
      });
    } catch (error) { await rm(destination, { force: true }); throw error; }
    finally {
      const imported = await this.store.read();
      if (!imported.assets.some(x => x.id === assetId)) await rm(destination, { force: true });
    }
  }
}
