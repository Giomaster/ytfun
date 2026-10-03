import { YouTubeAuth, YOUTUBE_ANALYTICS_SCOPE } from './oauth.mjs';
// Research supplies signals, never source media or a promise of future views.
export class Research {
  constructor(studio, { env = process.env, fetchImpl = fetch, youtubeAuth, youtubeLifecycle } = {}) {
    this.studio = studio;
    this.env = env;
    this.fetch = fetchImpl;
    this.youtubeAuth = youtubeAuth ?? new YouTubeAuth({ env, fetchImpl });
    this.youtubeLifecycle = youtubeLifecycle;
  }

  async discover({ source, projectId, region = 'BR', limit = 10 }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('limit must be 1..25');
    if (projectId) await this.project(projectId);
    let signals;
    if (source === 'youtube') {
      await this.youtubeLifecycle?.assertConnected();
      if (!/^[A-Z]{2}$/.test(region)) throw new Error('region must be an ISO alpha-2 code');
      if (!this.env.YOUTUBE_API_KEY) throw new Error('Set YOUTUBE_API_KEY for official YouTube metadata');
      const url = new URL('https://www.googleapis.com/youtube/v3/videos');
      url.search = new URLSearchParams({ part: 'snippet,statistics', chart: 'mostPopular', regionCode: region, maxResults: String(limit), key: this.env.YOUTUBE_API_KEY }).toString();
      const body = await this.getJson(url);
      signals = (body.items ?? []).filter(item => /^[\w-]{11}$/.test(item.id)).map(item => ({
        topic: item.snippet?.title ?? item.id,
        sourceUrl: `https://www.youtube.com/watch?v=${item.id}`,
        evidence: JSON.stringify({ kind: 'regional_mostPopular_snapshot', region, views: item.statistics?.viewCount ?? null, publishedAt: item.snippet?.publishedAt ?? null, note: 'Cumulative views and this chart are signals; growth velocity is not measured.' }),
      }));
    } else throw new Error('source must be youtube; external authorized connectors can supply other audience evidence');
    const observedAt = new Date().toISOString();
    await this.youtubeLifecycle?.assertConnected();
    const records = [];
    for (const signal of signals) records.push(await this.studio.addTrend({ ...signal, projectId, observedAt }));
    await this.youtubeLifecycle?.assertConnected();
    return { source, observedAt, signals: records, limitation: 'Metadata only. Use external authorized research connectors for broader signals. No ranking guarantees.' };
  }

  async productionModels({ task, limit = 10 }) {
    if (!['text-to-image', 'text-to-speech', 'text-to-video'].includes(task)) throw new Error('Choose a supported media-generation task');
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('limit must be 1..25');
    const url = new URL('https://huggingface.co/api/models');
    url.search = new URLSearchParams({ pipeline_tag: task, limit: String(limit) }).toString();
    const body = await this.getJson(url);
    if (!Array.isArray(body)) throw new Error('Hugging Face returned an invalid model list');
    return {
      task,
      models: body.filter(item => typeof item.id === 'string').map(item => ({ model: item.id, task: item.pipeline_tag ?? task, modelCardUrl: `https://huggingface.co/${item.id.split('/').map(encodeURIComponent).join('/')}`, gated: item.gated ?? null, licenseTags: (item.tags ?? []).filter(tag => tag.startsWith('license:')) })),
      limitation: 'Production catalog only. A listing does not confirm available inference, price, free quota, output quality or commercial rights. Read the model card and the chosen provider terms before generating.',
    };
  }

  async syncYouTubeMetrics({ episodeId, startDate, endDate }) {
    await this.youtubeLifecycle?.assertConnected();
    for (const date of [startDate, endDate]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Use valid YYYY-MM-DD dates');
    }
    if (startDate > endDate) throw new Error('startDate must precede endDate');
    if (!this.youtubeAuth.readiness().ready || !this.env.YOUTUBE_CHANNEL_ID) throw new Error('YouTube OAuth token and channel are required');
    const state = await this.studio.store.read();
    const publication = state.publications.find(item => item.episodeId === episodeId && item.platform === 'youtube' && item.accountId === this.env.YOUTUBE_CHANNEL_ID && item.videoId && ['uploaded', 'published', 'scheduled'].includes(item.status));
    if (!publication) throw new Error('No confirmed YouTube upload for this episode and channel');
    const url = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
    url.search = new URLSearchParams({ ids: `channel==${this.env.YOUTUBE_CHANNEL_ID}`, startDate, endDate, metrics: 'views,averageViewPercentage,likes,shares,subscribersGained', filters: `video==${publication.videoId}` }).toString();
    const accessToken = await this.youtubeAuth.getAccessToken({ requiredScopes: [YOUTUBE_ANALYTICS_SCOPE] });
    const body = await this.getJson(url, { Authorization: `Bearer ${accessToken}` });
    if (!body.rows?.length) return { episodeId, recorded: false, reason: 'No data returned for this period; absent data is not zero.' };
    const values = Object.fromEntries((body.columnHeaders ?? []).map((column, index) => [column.name, body.rows[0][index]]));
    if (!Number.isFinite(values.views) || values.views < 0 || !Number.isFinite(values.averageViewPercentage)) throw new Error('Analytics returned invalid metrics');
    await this.youtubeLifecycle?.assertConnected();
    const metric = await this.studio.recordMetrics({ episodeId, platform: 'youtube', observedAt: new Date().toISOString(), sourceUrl: `https://studio.youtube.com/video/${publication.videoId}/analytics`, views: values.views, retentionRatio: values.averageViewPercentage / 100, periodStart: startDate, periodEnd: endDate });
    await this.youtubeLifecycle?.assertConnected();
    return { recorded: true, metric, period: { startDate, endDate }, observations: values, limitation: 'Average view percentage may exceed 100% on loops. Views and retention are period aggregates, not a causal experiment.' };
  }

  async insights(projectId) {
    const project = await this.project(projectId);
    const state = await this.studio.store.read();
    const episodes = state.episodes.filter(episode => episode.projectId === projectId);
    const rows = episodes.map(episode => {
      const estimates = state.spending.filter(cost => cost.episodeId === episode.id);
      const metrics = episode.metrics ?? [];
      const latest = {};
      for (const metric of metrics) if (!latest[metric.platform] || metric.observedAt > latest[metric.platform].observedAt) latest[metric.platform] = metric;
      const missingEstimates = estimates.filter(cost => !Number.isFinite(cost.estimatedCostUsd)).length;
      return { episodeId: episode.id, title: episode.title, originalAngle: episode.originalAngle, status: episode.status, estimatesUsd: estimates.reduce((sum, cost) => sum + (Number.isFinite(cost.estimatedCostUsd) ? cost.estimatedCostUsd : 0), 0), missingEstimates, estimatesUncertain: missingEstimates > 0 || estimates.some(cost => cost.status === 'unknown' || cost.status === 'reserved'), latestMetricsByPlatform: latest };
    });
    return { project, episodes: rows, nextExperiment: rows.some(row => Object.keys(row.latestMetricsByPlatform).length) ? 'Compare periods of equal length and similar publication age. Change one editorial variable, then collect another observation.' : 'Collect real performance before expanding volume. Start with one distinct episode and review image, narration, pacing and ending.', limitation: 'Recorded costs are estimates, not invoices. Platform metrics are separate and are not added or treated as evidence of monetization eligibility.' };
  }

  async project(id) {
    const state = await this.studio.store.read();
    const project = state.projects.find(item => item.id === id);
    if (!project) throw new Error('Project not found');
    return project;
  }

  async getJson(url, headers = {}) {
    let response;
    try { response = await this.fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error('Research provider request failed; credentials and response bodies are not logged'); }
    if (!response.ok) throw new Error(`Research provider returned HTTP ${response.status}`);
    return response.json();
  }
}
