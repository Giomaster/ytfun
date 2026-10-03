import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFile, appendFile } from 'node:fs/promises';

// This preparation step deliberately has no provider credentials or media work.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_RUN_ATTEMPT !== '1') throw new Error('Automatic reruns may not start paid production');
const launch = JSON.parse(await readFile('studio/batches/launch.json', 'utf8'));
const packet = JSON.parse(gunzipSync(Buffer.from(process.env.AI_MEOW_BATCH_PACKET ?? '', 'base64'), { maxOutputLength: 2 * 1024 * 1024 }));
if (packet.id !== launch.batchId || createHash('sha256').update(JSON.stringify(packet)).digest('hex') !== launch.packetSha256 || !Array.isArray(launch.sceneIndices) || !launch.sceneIndices.length || launch.sceneIndices.length > 120 || new Set(launch.sceneIndices).size !== launch.sceneIndices.length || launch.sceneIndices.some(x => !packet.scenes?.some(s => s.index === x))) throw new Error('Launch does not match the authorized scene selection');
await appendFile(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ index: launch.sceneIndices })}\n`);
