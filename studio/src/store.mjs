import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const transactionTails = new Map();
const collections = ['projects', 'episodes', 'trends', 'assets', 'publications', 'spending'];

export function emptyStudioState() {
  return { schemaVersion: 1, projects: [], episodes: [], trends: [], assets: [], publications: [], spending: [] };
}

export class StudioBusyError extends Error {
  constructor(directory) {
    super(`Studio store is busy: ${directory}. An existing lock requires operator inspection; it is never removed automatically.`);
    this.name = 'StudioBusyError';
    this.code = 'STUDIO_BUSY';
  }
}

function validateState(state) {
  if (!state || state.schemaVersion !== 1) throw new Error('Unsupported or invalid studio state schemaVersion');
  for (const name of collections) {
    if (!Array.isArray(state[name])) throw new Error(`Invalid studio state: ${name} must be an array`);
    const ids = new Set();
    for (const entity of state[name]) {
      if (!entity || typeof entity.id !== 'string' || !entity.id) throw new Error(`Invalid studio state: ${name} entity id is required`);
      if (ids.has(entity.id)) throw new Error(`Invalid studio state: duplicate ${name} id ${entity.id}`);
      ids.add(entity.id);
    }
  }
  if (state.deliveries !== undefined) {
    if (!Array.isArray(state.deliveries)) throw new Error('Invalid studio state: deliveries must be an array');
    const ids = new Set();
    for (const item of state.deliveries) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !['queued', 'running', 'completed', 'attention', 'cancelled'].includes(item.status)) throw new Error('Invalid studio delivery record');
      ids.add(item.id);
    }
  }
  if (state.productionBatches !== undefined) {
    if (!Array.isArray(state.productionBatches)) throw new Error('Invalid production batch collection');
    const ids = new Set();
    for (const batch of state.productionBatches) {
      if (!batch || typeof batch.id !== 'string' || ids.has(batch.id) || !['reserved', 'running', 'completed', 'attention'].includes(batch.status) || batch.packet?.id !== batch.id || !/^[a-f0-9]{64}$/.test(batch.packetSha256)) throw new Error('Invalid production batch record');
      ids.add(batch.id);
    }
  }
}

export class StudioStore {
  constructor(directory) {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('Studio directory is required');
    this.directory = resolve(directory);
    this.statePath = join(this.directory, 'state.json');
    this.lockPath = join(this.directory, '.store-lock');
  }

  async read() {
    let body;
    try {
      body = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyStudioState();
      throw error;
    }
    const state = JSON.parse(body);
    validateState(state);
    return structuredClone(state);
  }

  async transaction(fn) {
    if (typeof fn !== 'function') throw new Error('Transaction callback is required');
    const preceding = transactionTails.get(this.directory) ?? Promise.resolve();
    const current = preceding.catch(() => {}).then(() => this.#commit(fn));
    transactionTails.set(this.directory, current);
    try {
      return await current;
    } finally {
      if (transactionTails.get(this.directory) === current) transactionTails.delete(this.directory);
    }
  }

  async #commit(fn) {
    await mkdir(this.directory, { recursive: true });
    try {
      await mkdir(this.lockPath);
    } catch (error) {
      if (error.code === 'EEXIST') throw new StudioBusyError(this.directory);
      throw error;
    }
    const temporaryPath = join(this.directory, `.state-${randomUUID()}.tmp`);
    try {
      const state = await this.read();
      const result = await fn(state);
      validateState(state);
      // Check serializability and the return value before committing anything.
      const body = `${JSON.stringify(state, null, 2)}\n`;
      const clonedResult = structuredClone(result);
      const persistedState = JSON.parse(body);
      validateState(persistedState);
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.statePath);
      return clonedResult;
    } finally {
      await rm(temporaryPath, { force: true });
      await rm(this.lockPath, { recursive: true });
    }
  }
}
