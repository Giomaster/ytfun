import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio MCP negotiates, lists tools and persists a series across restarts', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../src/mcp.mjs', import.meta.url));
  const connect = async () => {
    const client = new Client({ name: 'ci-studio-client', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [script], env: { PATH: process.env.PATH ?? '', YTFUN_STUDIO_DIR: directory }, stderr: 'pipe' }));
    return client;
  };
  const client = await connect();
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 34);
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_tiktok_export'));
  assert.ok(!tools.tools.some(tool => tool.name === 'ytfun_tiktok_publish'));
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_facebook_publish'));
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_kwai_export'));
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_delivery_enqueue'));
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
  const silent = await client.callTool({ name: 'ytfun_episode_plan', arguments: { projectId: project.id, audioMode: 'silent', title: 'The kitten and the obsidian portal', hook: 'A violet light travels beneath a black stone.', synopsis: 'A cybernetic kitten discovers an impossible interior.', continuityNote: 'First original visual reveal.', originalAngle: 'A complete comic portal reveal without speech or text.', scenes: [{ durationSeconds: 5, visualPrompt: 'An original silver cartoon kitten beside an obsidian sphere on a violet sofa.' }], metadata: { description: 'Original AI fiction.', hashtags: ['#AIMeow'] } } });
  assert.ok(!silent.isError, JSON.stringify(silent));
  assert.equal(JSON.parse(silent.content[0].text).audioMode, 'silent');
  assert.equal(JSON.parse(silent.content[0].text).scenes[0].narration, '');

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
