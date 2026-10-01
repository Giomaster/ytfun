import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';

const MAX_BYTES = 65_536;
export const YOUTUBE_GRANT_KEYS = ['YOUTUBE_ACCESS_TOKEN', 'YOUTUBE_ACCESS_TOKEN_EXPIRES_AT', 'YOUTUBE_REFRESH_TOKEN', 'YOUTUBE_REFRESH_TOKEN_EXPIRES_AT', 'YOUTUBE_CHANNEL_ID', 'YTFUN_YOUTUBE_GRANT_ID'];

function fail() { return new Error('Private YouTube environment cleanup was not confirmed; inspect the owned 0600 file and OAuth lock without exposing credentials.'); }

function lines(text) {
  const result = text.split(/\r?\n/);
  for (const line of result) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw fail();
    const value = match[2].trim();
    if (/^["']/.test(value)) {
      const end = value.lastIndexOf(value[0]);
      if (end === 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) throw fail();
    }
  }
  return result;
}

async function readPrivate(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw fail();
  const directory = await realpath(path.dirname(filename));
  // Credentials must never be rewritten inside a Git checkout, including a worktree.
  for (let parent = directory; ; parent = path.dirname(parent)) {
    let exists = false;
    try { await access(path.join(parent, '.git')); exists = true; }
    catch (error) { if (error.code !== 'ENOENT') throw fail(); }
    if (exists) throw fail();
    if (parent === path.dirname(parent)) break;
  }
  const canonical = path.join(directory, path.basename(filename));
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES || (info.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw fail();
    const text = await handle.readFile('utf8');
    if (Buffer.byteLength(text) > MAX_BYTES) throw fail();
    lines(text);
    return { canonical, directory, text, info, env: parseEnv(text) };
  } finally { await handle.close(); }
}

// Holds the setup's lock across revocation as well as the atomic rewrite, so
// fresh consent cannot race a project-wide revocation. No secret reaches callback.
export async function withYouTubeGrantLock(filename, { expectedChannelId, expectedToken, expectedGrantId } = {}, operation) {
  let lock, temporary, lockFile;
  let started = false;
  try {
    const before = await readPrivate(filename);
    lockFile = `${before.canonical}.oauth.lock`;
    lock = await open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const current = await readPrivate(filename);
    if (current.text !== before.text || current.info.ino !== before.info.ino || current.info.dev !== before.info.dev) throw fail();
    const configuredToken = current.env.YOUTUBE_REFRESH_TOKEN || current.env.YOUTUBE_ACCESS_TOKEN;
    // Permit idempotent local cleanup, but never delete a newly consented grant.
    if ((current.env.YOUTUBE_CHANNEL_ID && current.env.YOUTUBE_CHANNEL_ID !== expectedChannelId) ||
        (configuredToken && configuredToken !== expectedToken) ||
        (configuredToken && expectedGrantId !== undefined && (current.env.YTFUN_YOUTUBE_GRANT_ID || 'legacy') !== expectedGrantId)) throw fail();
    const cleanup = async () => {
      try {
        const replaced = new Set([...YOUTUBE_GRANT_KEYS, 'YTFUN_YOUTUBE_PUBLIC_ENABLED', 'YTFUN_YOUTUBE_AUDIT_CONFIRMED']);
        const retained = lines(current.text).filter(line => !replaced.has(line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]));
        const ending = current.text.includes('\r\n') ? '\r\n' : '\n';
        const content = [...retained, 'YTFUN_YOUTUBE_PUBLIC_ENABLED=false', 'YTFUN_YOUTUBE_AUDIT_CONFIRMED=false', ''].join(ending);
        if (Buffer.byteLength(content) > MAX_BYTES) throw fail();
        temporary = `${current.canonical}.disconnect-${randomBytes(12).toString('hex')}.tmp`;
        const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try { await output.writeFile(content); await output.sync(); } finally { await output.close(); }
        const last = await readPrivate(filename);
        if (last.text !== current.text || last.info.ino !== current.info.ino || last.info.dev !== current.info.dev) throw fail();
        await rename(temporary, current.canonical);
        temporary = null;
        const directory = await open(current.directory, constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
        return { confirmed: true };
      } catch { throw fail(); }
    };
    started = true;
    return await operation({ cleanup });
  } catch (error) { throw started ? error : fail(); }
  finally {
    if (temporary) await unlink(temporary).catch(() => {});
    if (lock) { await lock.close(); await unlink(lockFile).catch(() => {}); }
  }
}

export async function removeYouTubeGrant(filename, expected = {}) {
  return withYouTubeGrantLock(filename, expected, ({ cleanup }) => cleanup());
}
