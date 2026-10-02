import { randomUUID } from 'node:crypto';
import { episodeReviewHash } from './domain.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { assertYouTubeConnected, youtubeApiData } from './youtube-data-policy.mjs';

const PLATFORMS = ['youtube', 'facebook', 'tiktok', 'kwai'];
const ACTIVE = new Set(['queued', 'running', 'attention']);

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Persistent, single-attempt delivery. Provider reservations remain the authority for cadence and outcomes. */
export class DeliveryQueue {
  constructor(store, publisher, { now = Date.now } = {}) {
    this.store = store;
    this.publisher = publisher;
    this.now = now;
    this.timer = null;
    this.ticking = false;
  }

  async list() { return (await this.store.read()).deliveries ?? []; }

  async enqueue({ episodeId, platform, expectedReviewHash, privacy, madeForKids, dueAt }) {
    if (!PLATFORMS.includes(platform)) throw new Error('Unsupported delivery platform.');
    if (!/^[a-f0-9]{64}$/.test(expectedReviewHash ?? '')) throw new Error('A reviewed episode fingerprint is required.');
    if (!validTime(dueAt) || Date.parse(dueAt) < this.now() - 60_000) throw new Error('dueAt must be a current or future canonical ISO UTC timestamp.');
    if (platform === 'youtube' && typeof madeForKids !== 'boolean') throw new Error('YouTube audience selection is required.');
    if (platform === 'facebook' && privacy !== 'public') throw new Error('Facebook Reels requires explicit public visibility.');
    if (platform === 'kwai' && privacy !== 'private') throw new Error('Kwai creator exports use private package visibility.');
    if (platform === 'tiktok' && !['private', 'public'].includes(privacy)) throw new Error('TikTok uses a private export package or explicit public REST delivery.');
    const plan = await this.publisher.preflight({ episodeId, platform, privacy }, { now: Date.parse(dueAt) });
    if (plan.reviewHash !== expectedReviewHash) throw new Error('Episode changed since review.');
    if (!plan.ready && !plan.readyToExport) throw new Error(plan.reasons.join(' '));
    return this.store.transaction(state => {
      if (platform === 'youtube') assertYouTubeConnected(state, { YTFUN_YOUTUBE_GRANT_ID: plan.youtubeGrantId ?? 'legacy' });
      state.deliveries ??= [];
      const existing = state.deliveries.find(item => item.episodeId === episodeId && item.platform === platform &&
        (ACTIVE.has(item.status) || (item.reviewHash === expectedReviewHash && item.status === 'completed')));
      if (existing) return { duplicate: true, delivery: existing };
      const episode = state.episodes.find(item => item.id === episodeId);
      if (!episode || episodeReviewHash(episode) !== expectedReviewHash || episode.approval?.reviewHash !== expectedReviewHash || episode.render?.sha256 !== plan.render.sha256) throw new Error('Reviewed media changed while enqueueing.');
      const delivery = { id: randomUUID(), episodeId, platform, accountId: plan.accountId, reviewHash: expectedReviewHash,
        renderSha256: plan.render.sha256, privacy, ...(platform === 'youtube' ? { madeForKids } : {}), dueAt,
        mode: ['youtube', 'facebook'].includes(platform) ? 'official_api' : platform === 'tiktok' && privacy === 'public' ? 'experimental_session_rest' : 'creator_export',
        ...(platform === 'youtube' ? { apiData: youtubeApiData({ authorized: true, grantId: plan.youtubeGrantId ?? 'legacy', now: this.now() }) } : {}),
        status: 'queued', createdAt: new Date(this.now()).toISOString() };
      state.deliveries.push(delivery);
      return { delivery, warning: 'Cadence and authorization are checked again when due. Queued time is not a provider-confirmed schedule.' };
    });
  }

  async cancel({ deliveryId }) {
    return this.store.transaction(state => {
      const item = state.deliveries?.find(entry => entry.id === deliveryId);
      if (!item || !(item.status === 'queued' || (item.status === 'attention' && item.phase === 'preflight'))) throw new Error('Only an unstarted delivery can be cancelled.');
      item.status = 'cancelled';
      item.updatedAt = new Date(this.now()).toISOString();
      return item;
    });
  }

  async reconcile({ deliveryId, workerStopped, confirmedBy, evidence }) {
    if (workerStopped !== true || typeof confirmedBy !== 'string' || !confirmedBy.trim() || typeof evidence !== 'string' || !evidence.trim()) throw new Error('Confirm the original worker is stopped and supply operator reconciliation evidence.');
    return this.store.transaction(state => {
      const delivery = state.deliveries?.find(item => item.id === deliveryId);
      if (!delivery || !['running', 'attention'].includes(delivery.status)) throw new Error('Only an interrupted or attention delivery can be reconciled.');
      const matches = state.publications.filter(item => delivery.publicationId ? item.id === delivery.publicationId : item.deliveryId === delivery.id);
      if (matches.length === 0 && !delivery.publicationId) {
        delivery.status = 'cancelled'; delivery.reconciledBy = confirmedBy.trim(); delivery.reconciliationEvidence = evidence.trim();
        delivery.updatedAt = new Date(this.now()).toISOString();
        return { delivery, reason: 'Stopped claim had no publication reservation. Closed without retrying any operation.' };
      }
      const publication = matches[0];
      if (delivery.platform === 'youtube' && (delivery.apiData?.grantId ?? delivery.grantId ?? 'legacy') !== (publication?.apiData?.grantId ?? publication?.grantId ?? 'legacy')) throw new Error('Reconcile only a receipt from the same YouTube grant generation.');
      if (matches.length !== 1 || !publication || publication.episodeId !== delivery.episodeId || publication.platform !== delivery.platform || publication.accountId !== delivery.accountId || publication.reviewHash !== delivery.reviewHash || publication.renderSha256 !== delivery.renderSha256 || !['uploaded', 'processing', 'scheduled', 'published', 'exported', 'failed'].includes(publication.status)) throw new Error('Reconcile the exact provider publication first; this operation never guesses an unknown outcome or resets a task for retry.');
      Object.assign(delivery, { status: 'completed', publicationId: publication.id, outcome: publication.status, reconciledBy: confirmedBy.trim(), reconciliationEvidence: evidence.trim(), updatedAt: new Date(this.now()).toISOString() });
      return { delivery };
    });
  }

  async runDue({ execute = false } = {}) {
    if (typeof execute !== 'boolean') throw new Error('execute must be a boolean.');
    const state = await this.store.read();
    // A worker crash leaves an inspectable record. Never infer it is safe to repeat a request.
    if (state.deliveries?.some(item => item.status === 'running')) return { blocked: true, reason: 'A running delivery needs operator reconciliation before the worker continues.' };
    const candidate = (state.deliveries ?? []).filter(item => item.status === 'queued' && Date.parse(item.dueAt) <= this.now())
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id))[0];
    if (!candidate) return { idle: true };
    if (!execute) return { execute: false, delivery: candidate, plan: await this.publisher.preflight({ episodeId: candidate.episodeId, platform: candidate.platform, privacy: candidate.privacy }) };
    const claimed = await this.store.transaction(current => {
      if (current.deliveries?.some(item => item.status === 'running')) return null;
      const item = current.deliveries?.find(entry => entry.id === candidate.id);
      if (item?.status !== 'queued' || Date.parse(item.dueAt) > this.now()) return null;
      if (item.platform === 'youtube') {
        const grantId = this.publisher.youtubeGrantId ?? 'legacy';
        assertYouTubeConnected(current, { YTFUN_YOUTUBE_GRANT_ID: grantId });
        if ((item.apiData?.grantId ?? 'legacy') !== grantId) {
          Object.assign(item, { status: 'attention', phase: 'preflight', error: 'Delivery belongs to another YouTube consent generation; cancel and explicitly authorize a new delivery.', updatedAt: new Date(this.now()).toISOString() });
          return { blocked: true, delivery: item };
        }
      }
      item.status = 'running'; item.startedAt = new Date(this.now()).toISOString();
      return item;
    });
    if (!claimed) return { contended: true };
    if (claimed.blocked) return claimed;
    let result;
    let phase = 'preflight';
    try {
      const plan = await this.publisher.preflight({ episodeId: claimed.episodeId, platform: claimed.platform, privacy: claimed.privacy });
      if (claimed.platform === 'youtube' && (claimed.apiData?.grantId ?? 'legacy') !== (plan.youtubeGrantId ?? 'legacy')) throw new Error('Delivery consent generation changed.');
      if (plan.accountId !== claimed.accountId || plan.reviewHash !== claimed.reviewHash || plan.render?.sha256 !== claimed.renderSha256) throw new Error('Delivery identity or reviewed content changed.');
      if (!plan.ready && !plan.readyToExport && !plan.publication) throw new Error('Delivery preflight no longer permits the operation.');
      const input = { episodeId: claimed.episodeId, expectedReviewHash: claimed.reviewHash, privacy: claimed.privacy, madeForKids: claimed.madeForKids, execute: true, deliveryId: claimed.id };
      phase = 'delivery';
      if (claimed.platform === 'youtube') result = await this.publisher.publishYouTube(input);
      else if (claimed.platform === 'facebook') result = await this.publisher.publishFacebook(input);
      else if (claimed.platform === 'tiktok' && claimed.privacy === 'public') result = await this.publisher.publishTikTok(input);
      else result = await this.publisher.exportPackage({ ...input, platform: claimed.platform });
    } catch {
      // Provider implementations sanitize their own diagnostics; the queue stores none of the thrown text.
      return this.finish(claimed.id, { status: 'attention', phase, error: 'Delivery was blocked or interrupted. Inspect preflight and provider receipts; no automatic retry is made.' });
    }
    const publication = result?.publication;
    const known = ['uploaded', 'processing', 'scheduled', 'published', 'exported'].includes(publication?.status);
    return this.finish(claimed.id, { status: known ? 'completed' : 'attention',
      ...(publication?.id ? { publicationId: publication.id, outcome: publication.status } : {}),
      ...(!known ? { error: 'Provider outcome requires inspection; this task will not retry automatically.' } : {}) });
  }

  async finish(id, changes) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.store.transaction(state => {
          const item = state.deliveries?.find(entry => entry.id === id);
          if (!item || item.status !== 'running') throw new Error('Delivery claim no longer matches.');
          Object.assign(item, changes, { updatedAt: new Date(this.now()).toISOString() });
          return { delivery: item };
        });
      } catch (error) {
        if (error.code !== 'STUDIO_BUSY' || attempt >= 19) throw error;
        await delay(50);
      }
    }
  }

  start({ intervalMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 300_000) throw new Error('Delivery poll interval must be 10 to 300 seconds.');
    if (this.timer) return;
    this.timer = setInterval(async () => {
      if (this.ticking) return;
      this.ticking = true;
      try { await this.runDue({ execute: true }); } catch { /* Store/worker failures leave existing claims intact; no request is replayed. */ }
      finally { this.ticking = false; }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}
