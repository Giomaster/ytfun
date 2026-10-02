import { constants } from 'node:fs';
import { mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { StudioStore, StudioBusyError } from './store.mjs';

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
const sha = /^[a-f0-9]{64}$/;

function safeRelative(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\') || value.includes('\0') ||
      normalize(value) !== value || value.startsWith('..') || !['assets', 'renders', 'exports'].includes(value.split('/')[0])) {
    throw new Error('Snapshot contains an unsafe asset path.');
  }
  return value;
}

function referencedFiles(state) {
  const files = new Map();
  const add = (path, hash) => {
    safeRelative(path);
    if (!sha.test(hash ?? '')) throw new Error('A snapshot source is missing its exact hash.');
    if (files.has(path) && files.get(path) !== hash) throw new Error('Snapshot sources disagree about the same path.');
    files.set(path, hash);
  };
  for (const asset of state.assets) add(asset.path, asset.sha256);
  for (const episode of state.episodes) if (episode.render) {
    add(episode.render.path, episode.render.sha256);
    if (episode.render.captionsPath) add(episode.render.captionsPath, episode.render.captionsSha256);
  }
  return files;
}

async function sourceFile(root, path, limit = MAX_FILE_BYTES) {
  const filename = join(root, path);
  const parent = await realpath(dirname(filename));
  if (parent !== dirname(filename) || (parent !== root && !parent.startsWith(`${root}${sep}`))) throw new Error('Snapshot source traverses a symbolic link.');
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('Invalid or oversized snapshot source.');
    return { file, info };
  } catch (error) { await file.close(); throw error; }
}

async function copyVerified(sourceRoot, targetRoot, path, expectedHash, limit = MAX_FILE_BYTES) {
  const { file, info } = await sourceFile(sourceRoot, path, limit);
  let output;
  try {
    await mkdir(dirname(join(targetRoot, path)), { recursive: true, mode: 0o700 });
    output = await open(join(targetRoot, path), 'wx', 0o600);
    const hash = createHash('sha256');
    const input = file.createReadStream({ autoClose: false });
    for await (const chunk of input) { hash.update(chunk); await output.writeFile(chunk); }
    await output.sync();
    const after = await file.stat();
    const actualHash = hash.digest('hex');
    if (actualHash !== expectedHash || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new Error('Snapshot file changed or failed its exact hash check.');
    }
    return { path, sha256: actualHash, sizeBytes: info.size };
  } finally { await Promise.allSettled([file.close(), output?.close()]); }
}

async function boundedJson(root, path, limit = 16 * 1024 * 1024) {
  const { file } = await sourceFile(root, path, limit);
  try {
    const bytes = await file.readFile();
    if (bytes.length > limit) throw new Error('Snapshot JSON exceeds its size limit.');
    return { bytes, parsed: JSON.parse(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await file.close(); }
}

/** Read-only canonical export under its real writer lock. Never builds new state JSON. */
export async function exportStudioSnapshot(store, destination) {
  if (!isAbsolute(destination) || resolve(destination) === store.directory || resolve(destination).startsWith(`${store.directory}${sep}`)) {
    throw new Error('Snapshot destination must be a new absolute directory outside the store.');
  }
  const root = await realpath(store.directory);
  await mkdir(store.lockPath).catch(error => { if (error.code === 'EEXIST') throw new StudioBusyError(store.directory); throw error; });
  let created = false;
  try {
    const state = await store.read();
    const canonical = await boundedJson(root, 'state.json');
    if (JSON.stringify(state) !== JSON.stringify(canonical.parsed)) throw new Error('Canonical state changed while exporting.');
    const references = referencedFiles(state);
    await mkdir(destination, { mode: 0o700 }); created = true;
    const target = await realpath(destination);
    const files = []; let total = 0;
    for (const [path, hash] of references) {
      const copied = await copyVerified(root, target, path, hash);
      total += copied.sizeBytes;
      if (total > MAX_TOTAL_BYTES) throw new Error('Snapshot exceeds its total size limit.');
      files.push(copied);
    }
    files.push(await copyVerified(root, target, 'state.json', canonical.sha256, 16 * 1024 * 1024));
    const manifest = { schemaVersion: 1, stateSha256: canonical.sha256, totalBytes: total + canonical.bytes.length, files };
    await writeFile(join(target, 'snapshot-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { destination: target, stateSha256: canonical.sha256, files: files.length, totalBytes: manifest.totalBytes };
  } catch (error) { if (created) await rm(destination, { recursive: true, force: true }); throw error; }
  finally { await rm(store.lockPath, { recursive: true }); }
}

/** Restore exact validated bytes to an unused store; never overwrite an existing host. */
export async function importStudioSnapshot(snapshotDirectory, destination, { expectedStateSha256 } = {}) {
  if (!isAbsolute(snapshotDirectory) || !isAbsolute(destination) || !sha.test(expectedStateSha256 ?? '')) {
    throw new Error('Absolute snapshot/target directories and the expected state hash are required.');
  }
  const root = await realpath(snapshotDirectory);
  const { parsed: manifest } = await boundedJson(root, 'snapshot-manifest.json');
  if (manifest.schemaVersion !== 1 || manifest.stateSha256 !== expectedStateSha256 || !Array.isArray(manifest.files) || manifest.files.length > 20_000) {
    throw new Error('Snapshot manifest does not match the authorized state.');
  }
  const canonical = await boundedJson(root, 'state.json');
  if (canonical.sha256 !== expectedStateSha256) throw new Error('Snapshot canonical hash changed.');
  const sourceStore = new StudioStore(root);
  const state = await sourceStore.read();
  const expectedFiles = referencedFiles(state);
  expectedFiles.set('state.json', expectedStateSha256);
  const supplied = new Map(); let total = 0;
  for (const entry of manifest.files) {
    if (!entry || supplied.has(entry.path) || expectedFiles.get(entry.path) !== entry.sha256 || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      throw new Error('Snapshot manifest has unexpected, duplicate or invalid sources.');
    }
    total += entry.sizeBytes; supplied.set(entry.path, entry);
  }
  if (supplied.size !== expectedFiles.size || total !== manifest.totalBytes || total > MAX_TOTAL_BYTES) throw new Error('Snapshot is incomplete or exceeds its size limit.');
  // mkdir is exclusive: a concurrent or existing host makes the migration fail closed.
  await mkdir(destination, { mode: 0o700 });
  try {
    const target = await realpath(destination);
    for (const entry of manifest.files.filter(x => x.path !== 'state.json')) {
      const copied = await copyVerified(root, target, entry.path, entry.sha256);
      if (copied.sizeBytes !== entry.sizeBytes) throw new Error('Snapshot source size changed.');
    }
    const copiedState = await copyVerified(root, target, 'state.json', expectedStateSha256, 16 * 1024 * 1024);
    if (copiedState.sizeBytes !== supplied.get('state.json').sizeBytes) throw new Error('Snapshot state size changed.');
    await new StudioStore(target).read();
    return { directory: target, stateSha256: expectedStateSha256, files: supplied.size, totalBytes: total };
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}
