export const YOUTUBE_DATA_TTL_MS = 30 * 86_400_000;

export function youtubeApiData({ authorized = false, grantId = 'legacy', now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('YouTube data requires a valid clock.');
  return { provider: 'youtube', authorized, grantId, fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + YOUTUBE_DATA_TTL_MS).toISOString() };
}

export function youtubeConnection(state, env = {}) {
  const grantId = env.YTFUN_YOUTUBE_GRANT_ID || 'legacy';
  return (state.youtubeConnections ?? []).find(item => item.grantId === grantId) ??
    (state.youtubeConnection?.grantId === grantId || grantId === 'legacy' ? state.youtubeConnection : undefined);
}

export function setYouTubeConnection(state, connection) {
  state.youtubeConnections ??= [];
  const index = state.youtubeConnections.findIndex(item => item.grantId === connection.grantId);
  if (index < 0) state.youtubeConnections.push(connection);
  else state.youtubeConnections[index] = connection;
  state.youtubeConnection = connection;
}

export function youtubeBlocked(state, env = {}) {
  return youtubeConnection(state, env)?.blocked === true;
}

export function assertYouTubeConnected(state, env = {}) {
  if (youtubeBlocked(state, env)) throw new Error('YouTube is disconnected. Obtain fresh consent and restart the MCP; existing upload reservations are never reset.');
}

export function isYouTubeTrend(trend) {
  if (trend.apiData?.provider === 'youtube') return true;
  try {
    const host = new URL(trend.sourceUrl).hostname.toLowerCase();
    if (['youtube.com', 'www.youtube.com', 'youtu.be', 'studio.youtube.com'].includes(host)) return true;
    return JSON.parse(trend.evidence).kind === 'regional_mostPopular_snapshot';
  } catch { return false; }
}

function expired(record, now, fallback) {
  // A local update does not refresh an API snapshot. Legacy/malformed data is
  // expired conservatively; future dates cannot extend its retention.
  const fetched = Date.parse(record.apiData?.fetchedAt ?? fallback);
  const expiry = Date.parse(record.apiData?.expiresAt ?? '');
  return !Number.isFinite(fetched) || fetched > now || now >= Math.min(fetched + YOUTUBE_DATA_TTL_MS, Number.isFinite(expiry) ? expiry : Infinity);
}

function localPublication(record, removedAt) {
  const local = Object.fromEntries(['id', 'episodeId', 'projectId', 'platform', 'reviewHash', 'renderSha256', 'youtubeMetadata', 'youtubeMetadataSha256', 'createdAt', 'effectiveAt', 'privacy', 'madeForKids', 'publishAt', 'deliveryId']
    .filter(key => record[key] !== undefined).map(key => [key, record[key]]));
  return { ...local, grantId: record.apiData?.grantId ?? 'legacy', status: 'unknown', localOnly: true, blockReason: 'youtube_api_data_removed', apiDataRemovedAt: removedAt };
}

/** Mutates only YouTube API/cache fields; local original media and dedupe IDs survive. */
export function purgeYouTubeData(state, { now = Date.now(), all = false, authorizedOnly = false, grantId } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('YouTube data requires a valid clock.');
  const removedAt = new Date(now).toISOString();
  const counts = { trends: 0, metrics: 0, publications: 0, deliveries: 0 };
  const removedTrends = new Set();
  const belongs = record => grantId === undefined || (record.apiData?.grantId ?? record.grantId ?? 'legacy') === grantId;
  state.trends = state.trends.filter(trend => {
    const remove = belongs(trend) && isYouTubeTrend(trend) && (!authorizedOnly || trend.apiData?.authorized === true) && (all || expired(trend, now, trend.observedAt));
    if (remove) { counts.trends++; removedTrends.add(trend.id); }
    return !remove;
  });
  for (const episode of state.episodes) {
    episode.trendIds = (episode.trendIds ?? []).filter(id => !removedTrends.has(id));
    episode.metrics = (episode.metrics ?? []).filter(metric => {
      const remove = belongs(metric) && metric.platform === 'youtube' && (all || expired(metric, now, metric.observedAt));
      if (remove) counts.metrics++;
      return !remove;
    });
  }
  const removedPublications = new Set();
  state.publications = state.publications.map(record => {
    if (!belongs(record) || record.platform !== 'youtube' || record.localOnly || !(all || expired(record, now, record.verifiedAt ?? record.createdAt))) return record;
    counts.publications++;
    removedPublications.add(record.id);
    const episode = state.episodes.find(item => item.id === record.episodeId);
    if (episode) episode.status = 'publishing';
    return localPublication(record, removedAt);
  });
  if (state.deliveries) state.deliveries = state.deliveries.map(record => {
    if (!belongs(record) || record.platform !== 'youtube' || record.localOnly || !(all || removedPublications.has(record.publicationId) || expired(record, now, record.createdAt))) return record;
    counts.deliveries++;
    const local = Object.fromEntries(['id', 'episodeId', 'platform', 'reviewHash', 'renderSha256', 'youtubeMetadata', 'youtubeMetadataSha256', 'privacy', 'madeForKids', 'dueAt', 'mode', 'createdAt', 'startedAt', 'publicationId']
      .filter(key => record[key] !== undefined).map(key => [key, record[key]]));
    const unstarted = record.status === 'queued' || (record.status === 'attention' && record.phase === 'preflight');
    const status = unstarted || record.status === 'cancelled' ? 'cancelled' : 'attention';
    return { ...local, grantId: record.apiData?.grantId ?? 'legacy', status, localOnly: true, blockReason: 'youtube_api_data_removed', apiDataRemovedAt: removedAt };
  });
  return counts;
}
