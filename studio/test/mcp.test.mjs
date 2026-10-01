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
  assert.equal(tools.tools.length, 23);
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_tiktok_export'));
  assert.ok(!tools.tools.some(tool => tool.name === 'ytfun_tiktok_publish'));
  const created = await client.callTool({ name: 'ytfun_project_create', arguments: { title: 'Arquivo das cidades impossíveis', premise: 'Uma cidade imaginária diferente por episódio.', audience: 'Pessoas interessadas em ficção especulativa.', language: 'pt-BR' } });
  assert.ok(!created.isError, JSON.stringify(created));
  const project = JSON.parse(created.content[0].text);
  assert.equal(project.budgetMonthlyUsd, null);
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
