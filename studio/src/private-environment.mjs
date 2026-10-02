import { dirname, join } from 'node:path';
import { constants } from 'node:fs';
import { access, open, realpath } from 'node:fs/promises';
import { parseEnv } from 'node:util';

export async function loadPrivateEnvironment(filename, base = process.env) {
  if (typeof filename !== 'string' || !filename.startsWith('/')) throw new Error('A private absolute environment file is required.');
  const parent = await realpath(dirname(filename));
  for (let directory = parent; ; directory = dirname(directory)) {
    let gitDirectory = false;
    try { await access(join(directory, '.git')); gitDirectory = true; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Private environment ancestry could not be verified.'); }
    if (gitDirectory) throw new Error('Private environment files must remain outside Git checkouts.');
    if (directory === dirname(directory)) break;
  }
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 || (info.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('The environment file must be owned, single-link and mode 0600.');
    const body = await file.readFile('utf8');
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error('The environment file exceeds its size limit.');
    return { ...base, ...parseEnv(body), YTFUN_PRIVATE_ENV_FILE: filename };
  } finally { await file.close(); }
}
