import test from 'node:test';
import assert from 'node:assert/strict';
import { Research } from '../src/research.mjs';

test('YouTube trend discovery fetches metadata only and distinguishes cumulative views from growth', async () => {
  const calls = [], signals = [];
  const studio = { addTrend: async record => { signals.push(record); return record; } };
  const research = new Research(studio, { env: { YOUTUBE_API_KEY: 'not-a-real-key' }, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ items: [{ id: 'abcdefghijk', snippet: { title: 'Original concept', publishedAt: '2026-01-01T00:00:00Z' }, statistics: { viewCount: '100' } }] }) };
  } });
  const result = await research.discover({ source: 'youtube', region: 'BR', limit: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/youtube/v3/videos');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(signals[0].sourceUrl, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(JSON.parse(signals[0].evidence).views, '100');
  assert.match(signals[0].evidence, /growth velocity is not measured/);
  assert.ok(!JSON.stringify(result).includes('not-a-real-key'));
});

test('provider failures do not echo credentials or raw requests', async () => {
  const research = new Research({}, { env: { YOUTUBE_API_KEY: 'private-api-key' }, fetchImpl: async () => { throw new Error('private-api-key'); } });
  await assert.rejects(research.discover({ source: 'youtube' }), error => !error.message.includes('private-api-key'));
});

test('Hugging Face models remain a production catalog and never create audience trend records', async () => {
  let records = 0;
  const research = new Research({ addTrend: async () => { records++; } }, { fetchImpl: async () => ({ ok: true, json: async () => [{ id: 'org/model', pipeline_tag: 'text-to-video', tags: ['license:apache-2.0'] }] }) });
  const result = await research.productionModels({ task: 'text-to-video' });
  assert.equal(records, 0);
  assert.equal(result.models[0].modelCardUrl, 'https://huggingface.co/org/model');
  assert.match(result.limitation, /Production catalog only/);
  await assert.rejects(research.discover({ source: 'huggingface' }), /audience evidence/);
});

test('missing Analytics rows stay unknown instead of being recorded as zero', async () => {
  let recorded = false;
  const studio = { store: { read: async () => ({ publications: [{ episodeId: 'episode', platform: 'youtube', accountId: 'channel', videoId: 'abcdefghijk', status: 'uploaded' }] }) }, recordMetrics: async () => { recorded = true; } };
  const research = new Research(studio, { env: { YOUTUBE_ACCESS_TOKEN: 'secret', YOUTUBE_CHANNEL_ID: 'channel' }, fetchImpl: async () => ({ ok: true, json: async () => ({ rows: [] }) }) });
  const result = await research.syncYouTubeMetrics({ episodeId: 'episode', startDate: '2026-01-01', endDate: '2026-01-31' });
  assert.equal(result.recorded, false);
  assert.equal(recorded, false);
});

test('insights retain metrics per platform and flag uncertain estimates', async () => {
  const research = new Research({ store: { read: async () => ({ projects: [{ id: 'project' }], episodes: [{ id: 'episode', projectId: 'project', title: 'Title', metrics: [{ platform: 'youtube', views: 100, observedAt: '2026-01-01T00:00:00Z' }, { platform: 'tiktok', views: 300, observedAt: '2026-01-01T00:00:00Z' }] }], spending: [{ episodeId: 'episode', estimatedCostUsd: 0.01, status: 'unknown' }] }) } });
  const result = await research.insights('project');
  assert.equal(result.episodes[0].latestMetricsByPlatform.youtube.views, 100);
  assert.equal(result.episodes[0].latestMetricsByPlatform.tiktok.views, 300);
  assert.equal(result.episodes[0].estimatesUncertain, true);
});
