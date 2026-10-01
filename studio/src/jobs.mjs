import { randomUUID } from 'node:crypto';

// Start slow production without depending on a host's synchronous tool timeout.
// Persist intent first; never re-run interrupted inference automatically.
export class ProductionJobs {
  constructor(store, production) {
    this.store = store;
    this.production = production;
    this.running = new Map();
  }

  async start({ action, input }) {
    if (!['generate', 'render'].includes(action)) throw new Error('action must be generate or render');
    const job = { id: randomUUID(), action, episodeId: input.episodeId, status: 'running', createdAt: new Date().toISOString() };
    await this.store.transaction(state => {
      if (!state.episodes.some(episode => episode.id === input.episodeId)) throw new Error('Episode not found');
      state.productionJobs ??= [];
      if (state.productionJobs.some(item => item.status === 'running')) throw new Error('A production job is already running or interrupted. Inspect its status before starting another.');
      state.productionJobs.push(job);
    });
    const promise = this.#execute(job, input);
    this.running.set(job.id, promise);
    // Retain the promise and handle every rejection. No protocol output on stdout.
    void promise.finally(() => this.running.delete(job.id)).catch(() => {});
    return { ...job, nextAction: 'Use ytfun_production_job_get to read progress and its result. Keep this MCP process alive.' };
  }

  async #execute(job, input) {
    try {
      const result = await (job.action === 'generate' ? this.production.generateAsset(input) : this.production.renderEpisode(input));
      await this.store.transaction(state => {
        const record = state.productionJobs.find(item => item.id === job.id);
        Object.assign(record, { status: 'completed', result, completedAt: new Date().toISOString() });
      });
    } catch (error) {
      await this.store.transaction(state => {
        const record = state.productionJobs.find(item => item.id === job.id);
        Object.assign(record, { status: 'failed', error: error instanceof Error ? error.message : 'Production failed', completedAt: new Date().toISOString() });
      });
    }
  }

  async get(jobId) {
    const state = await this.store.read();
    const job = state.productionJobs?.find(item => item.id === jobId);
    if (!job) throw new Error('Production job not found');
    return { ...job, ...(job.status === 'running' && !this.running.has(job.id) ? { workerActiveHere: false, nextAction: 'Inspect spending reservations and render/upload artifacts. This worker does not own the persisted attempt; it may have been interrupted or belong to another MCP process. Never assume failure or retry automatically.' } : { workerActiveHere: this.running.has(job.id) }) };
  }

  async reconcile({ jobId, confirmedBy, evidence }) {
    if (!confirmedBy?.trim() || !evidence?.trim()) throw new Error('Operator and outcome evidence are required');
    if (this.running.has(jobId)) throw new Error('Cannot reconcile a job still running in this process');
    return this.store.transaction(state => {
      const job = state.productionJobs?.find(item => item.id === jobId);
      if (!job || job.status !== 'running') throw new Error('Only an interrupted running job can be reconciled');
      // This only closes the worker record. Cost reservations and upload outcomes
      // retain their separate gates and require independent reconciliation.
      Object.assign(job, { status: 'interrupted', reconciledBy: confirmedBy, evidence, reconciledAt: new Date().toISOString() });
      return job;
    });
  }
}
