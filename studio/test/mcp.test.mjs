import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio MCP negotiates, lists tools and persists a series across restarts', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../src/mcp.mjs', import.meta.url));
  const privateEnv = join(directory, 'private.env');
  await writeFile(privateEnv, `YTFUN_STUDIO_DIR=${directory}\nYTFUN_REMOTE_ASSEMBLY_ONLY=true\n`, { mode: 0o600 });
  const connect = async () => {
    const client = new Client({ name: 'ci-studio-client', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [script], env: { PATH: process.env.PATH ?? '', YTFUN_PRIVATE_ENV_FILE: privateEnv }, stderr: 'pipe' }));
    return client;
  };
  const client = await connect();
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 40);
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_tiktok_export'));
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_tiktok_publish'));
  assert.deepEqual(tools.tools.find(tool => tool.name === 'ytfun_tiktok_publish').inputSchema.properties.privacy, { type: 'string', const: 'public' });
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_facebook_publish'));
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_kwai_export'));
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_delivery_enqueue'));
  const refusedRender = await client.callTool({ name: 'ytfun_episode_render', arguments: { episodeId: '717f7a19-2e5f-4c55-b1d6-35c0d7899a23' } });
  assert.equal(refusedRender.isError, true); assert.match(refusedRender.content[0].text, /remote assembly only/);
  const planningSchema = tools.tools.find(tool => tool.name === 'ytfun_episode_plan').inputSchema;
  assert.deepEqual(planningSchema.properties.format.enum, ['short', 'long']);
  assert.equal(planningSchema.properties.format.default, 'short');
  assert.deepEqual(planningSchema.properties.renderCanvas.enum, ['portrait', 'landscape']);
  assert.ok(!planningSchema.required.includes('renderCanvas'));
  assert.deepEqual(planningSchema.properties.audioMode.enum, ['narrated', 'silent', 'nonverbal']);
  assert.equal(planningSchema.properties.scenes.maxItems, 120);
  const derivationSchema = tools.tools.find(tool => tool.name === 'ytfun_episode_derive_short').inputSchema;
  assert.equal(derivationSchema.properties.parentEpisodeId.format, 'uuid');
  assert.equal(derivationSchema.properties.sceneIds.maxItems, 12);
  assert.ok(tools.tools.find(tool => tool.name === 'ytfun_episode_render_manifest').annotations.readOnlyHint);
  const registrationSchema = tools.tools.find(tool => tool.name === 'ytfun_episode_render_register').inputSchema;
  assert.equal(registrationSchema.properties.manifest.type, 'object');
  assert.ok(registrationSchema.required.includes('provenance'));
  const videoSchema = tools.tools.find(tool => tool.name === 'ytfun_asset_generate').inputSchema.properties.videoParameters;
  assert.equal(videoSchema.additionalProperties, false);
  assert.deepEqual(videoSchema.properties.resolution.enum, ['480p', '580p', '720p']);
  assert.equal(videoSchema.properties.num_frames.minimum, 81);
  assert.equal(videoSchema.properties.num_frames.maximum, 121);
  assert.deepEqual(videoSchema.properties.frames_per_second.anyOf, [
    { type: 'number', const: 16 },
    { type: 'number', const: 24 },
  ]);
  assert.deepEqual(videoSchema.properties.interpolator_model.enum, ['none', 'film']);
  assert.deepEqual(videoSchema.properties.num_interpolated_frames.anyOf, [
    { type: 'number', const: 0 },
    { type: 'number', const: 1 },
  ]);
  assert.equal(videoSchema.properties.adjust_fps_for_interpolation.type, 'boolean');
  const jobSchema = tools.tools.find(tool => tool.name === 'ytfun_production_job_start').inputSchema;
  assert.match(JSON.stringify(jobSchema), /"videoParameters"/);
  const generationSchema = tools.tools.find(tool => tool.name === 'ytfun_asset_generate').inputSchema;
  const imageSchema = generationSchema.properties.imageParameters;
  assert.equal(imageSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(imageSchema.properties).sort(), ['height', 'num_inference_steps', 'seed', 'width']);
  for (const dimension of ['width', 'height']) {
    assert.equal(imageSchema.properties[dimension].type, 'integer');
    assert.equal(imageSchema.properties[dimension].minimum, 256);
    assert.equal(imageSchema.properties[dimension].maximum, 2048);
  }
  assert.equal(imageSchema.properties.num_inference_steps.minimum, 1);
  assert.equal(imageSchema.properties.num_inference_steps.maximum, 50);
  assert.equal(generationSchema.properties.referenceImageAssetId.type, 'string');
  assert.equal(generationSchema.properties.referenceImageAssetId.format, 'uuid');
  assert.equal(generationSchema.properties.endReferenceImageAssetId.type, 'string');
  assert.equal(generationSchema.properties.endReferenceImageAssetId.format, 'uuid');
  assert.match(JSON.stringify(jobSchema), /"imageParameters"/);
  assert.match(JSON.stringify(jobSchema), /"referenceImageAssetId"/);
  assert.match(JSON.stringify(jobSchema), /"endReferenceImageAssetId"/);
  assert.match(JSON.stringify(jobSchema), /"adjust_fps_for_interpolation"/);
  const created = await client.callTool({ name: 'ytfun_project_create', arguments: { title: 'Arquivo das cidades impossíveis', premise: 'Uma cidade imaginária diferente por episódio.', audience: 'Pessoas interessadas em ficção especulativa.', language: 'pt-BR' } });
  assert.ok(!created.isError, JSON.stringify(created));
  const project = JSON.parse(created.content[0].text);
  assert.equal(project.budgetMonthlyUsd, null);
  const cadenceArguments = { projectId: project.id, expectedCadence: project.cadence, cadence: { minHoursBetweenPosts: 18, maxPostsPerRollingDay: 2 }, reason: 'Authorized launch experiment' };
  const cadenceResult = await client.callTool({ name: 'ytfun_project_cadence_update', arguments: cadenceArguments });
  assert.ok(!cadenceResult.isError, JSON.stringify(cadenceResult));
  assert.deepEqual(JSON.parse(cadenceResult.content[0].text).cadence, cadenceArguments.cadence);
  const staleCadence = await client.callTool({ name: 'ytfun_project_cadence_update', arguments: cadenceArguments });
  assert.equal(staleCadence.isError, true);
  assert.match(staleCadence.content[0].text, /cadence changed/);
  const silent = await client.callTool({ name: 'ytfun_episode_plan', arguments: { projectId: project.id, audioMode: 'silent', title: 'The kitten and the obsidian portal', hook: 'A violet light travels beneath a black stone.', synopsis: 'A cybernetic kitten discovers an impossible interior.', continuityNote: 'First original visual reveal.', originalAngle: 'A complete comic portal reveal without speech or text.', scenes: [{ durationSeconds: 5, visualPrompt: 'An original silver cartoon kitten beside an obsidian sphere on a violet sofa.' }], metadata: { description: 'Original AI fiction.', hashtags: ['#AIMeow'] } } });
  assert.ok(!silent.isError, JSON.stringify(silent));
  assert.equal(JSON.parse(silent.content[0].text).audioMode, 'silent');
  assert.equal(JSON.parse(silent.content[0].text).format, 'short');
  assert.equal(JSON.parse(silent.content[0].text).scenes[0].narration, '');
  const longInput = { projectId: project.id, format: 'long', audioMode: 'nonverbal', title: 'An anthology of miniature living landscapes', hook: 'Every sphere reveals an unexpected landscape.', synopsis: 'Thirteen complete original material reveals with original nonverbal sound.', continuityNote: 'One coherent anthology, each unit has its own ending.', originalAngle: 'Tactile materials become self-contained kinetic landscapes.', scenes: Array.from({ length: 13 }, (_, index) => ({ durationSeconds: 15, visualPrompt: `Original sphere ${index} reveals a tiny luminous landscape and settles with a complete ending.` })), metadata: { description: 'Original synthetic visual anthology with original sound effects.', hashtags: ['#AIMeow'] } };
  const shortOverflow = await client.callTool({ name: 'ytfun_episode_plan', arguments: { ...longInput, format: 'short' } });
  assert.equal(shortOverflow.isError, true);
  assert.match(shortOverflow.content[0].text, /12 scenes/);
  const masterResult = await client.callTool({ name: 'ytfun_episode_plan', arguments: longInput });
  assert.ok(!masterResult.isError, JSON.stringify(masterResult));
  const master = JSON.parse(masterResult.content[0].text);
  assert.equal(master.format, 'long');
  assert.equal(master.audioMode, 'nonverbal');
  assert.equal(master.scenes.length, 13);
  const unrenderedDerivation = await client.callTool({ name: 'ytfun_episode_derive_short', arguments: { parentEpisodeId: master.id, sceneIds: [master.scenes[0].id], title: 'One miniature landscape revealed', hook: 'A new landscape unfolds.', synopsis: 'A complete standalone reveal.', originalAngle: 'A resolved transformation with tactile original sound.', metadata: longInput.metadata } });
  assert.equal(unrenderedDerivation.isError, true);
  assert.match(unrenderedDerivation.content[0].text, /rendered long episode/);

  const invalid = await client.callTool({ name: 'ytfun_episode_get', arguments: { episodeId: '../../outside' } });
  assert.equal(invalid.isError, true);
  const resources = await client.listResources();
  assert.ok(resources.resources.some(resource => resource.uri === 'ytfun://studio/state'));
  await client.close();
  const restarted = await connect();
  t.after(() => restarted.close());
  const listed = await restarted.callTool({ name: 'ytfun_project_list', arguments: {} });
  assert.equal(JSON.parse(listed.content[0].text)[0].id, project.id);
});
