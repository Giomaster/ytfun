#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { StudioStore } from './store.mjs';
import { Studio } from './domain.mjs';
import { Production, videoParametersSchema } from './production.mjs';
import { Publisher } from './publishing.mjs';
import { Research } from './research.mjs';
import { ProductionJobs } from './jobs.mjs';
import { DeliveryQueue } from './delivery-queue.mjs';
import { YouTubeDataLifecycle } from './youtube-data.mjs';

const id = z.string().uuid();
const text = z.string().trim().min(1).max(10_000);
const url = z.url().refine(value => ['https:', 'http:'].includes(new URL(value).protocol), 'HTTP(S) URL required');
const license = z.object({ url, notes: text });
const kind = z.enum(['image', 'video', 'audio']);
const platform = z.enum(['youtube', 'facebook', 'tiktok', 'kwai']);
const metadata = z.object({ description: z.string().max(5000), hashtags: z.array(z.string().trim().min(1).max(60).regex(/^#[\p{L}\p{N}_]+$/u)).max(8) });
const generationSchema = {
  episodeId: id, sceneId: id, kind, model: z.string().trim().min(1).max(200), provider: z.string().trim().min(1).max(100), prompt: text.optional(), estimatedCostUsd: z.number().finite().nonnegative(), pricingSourceUrl: url, commercialLicense: license, acknowledgePaidCost: z.boolean().default(false),
  videoParameters: videoParametersSchema.optional(),
};

export function createServer({ directory = process.env.YTFUN_STUDIO_DIR, env = process.env, fetchImpl = fetch, store, studio, production, publisher, research, youtubeLifecycle } = {}) {
  if (!directory && !store) throw new Error('YTFUN_STUDIO_DIR is required; use a private persistent absolute path');
  store ??= new StudioStore(directory);
  youtubeLifecycle ??= new YouTubeDataLifecycle(store, { env, fetchImpl });
  studio ??= new Studio(store, { env });
  production ??= new Production(store, { env });
  publisher ??= new Publisher(store, { env, fetchImpl: youtubeLifecycle.fetch, youtubeAuth: youtubeLifecycle.auth });
  research ??= new Research(studio, { env, fetchImpl: youtubeLifecycle.fetch, youtubeAuth: youtubeLifecycle.auth, youtubeLifecycle });
  const jobs = new ProductionJobs(store, production);
  const deliveries = new DeliveryQueue(store, publisher);
  const server = new McpServer({ name: 'ytfun-ai-studio', version: '0.1.0' });
  const register = (name, description, schema, handler, { readOnly = false, external = false } = {}) => {
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: external } }, async input => {
      try {
        await youtubeLifecycle.maintain();
        const result = await handler(input);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        // Provider adapters never forward raw request headers or response bodies.
        const message = error instanceof Error ? error.message : 'Operation failed';
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    });
  };

  register('ytfun_overview', 'Read studio projects, production and publication states. Uploaded, scheduled, exported and published are distinct.', {}, async () => {
    const state = await store.read();
    return { schemaVersion: state.schemaVersion, projects: state.projects, episodes: state.episodes.map(episode => ({ id: episode.id, projectId: episode.projectId, title: episode.title, status: episode.status, durationSeconds: episode.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), render: episode.render, approval: episode.approval })), publications: state.publications, deliveries: state.deliveries ?? [], spending: state.spending, constraints: ['Only original synthetic source media', 'Free-first; cost estimates are not invoices', 'TikTok and Kwai export packages require creator publication', 'No guarantee of views, distribution or revenue'] };
  }, { readOnly: true });
  register('ytfun_project_create', 'Persist an agreed original AI series: premise, audience, continuity and editorial cadence. Do not create an approved project before the user agrees to the concept.', {
    title: z.string().trim().min(1).max(160), premise: text, audience: text, language: z.string().min(2).max(30), continuity: text.optional(), mode: z.enum(['fiction', 'factual']).default('fiction'),
    cadence: z.object({ minHoursBetweenPosts: z.number().min(12), maxPostsPerRollingDay: z.number().int().min(1).max(3) }).optional(),
    budgetMonthlyUsd: z.number().finite().nonnegative().nullable().optional(),
  }, input => studio.createProject(input));
  register('ytfun_project_list', 'Read agreed series before proposing episodes. No automatically invented projects.', {}, () => studio.listProjects(), { readOnly: true });
  register('ytfun_trend_record', 'Persist a researched trend with exact source and observation time. Evidence is metadata, never media reuse clearance.', { topic: text, sourceUrl: url, observedAt: z.iso.datetime(), evidence: text, projectId: id.optional() }, input => studio.addTrend(input));
  register('ytfun_trend_discover', 'Fetch official YouTube regional popular-video metadata for editorial research. Does not download clips. A signal is not a forecast. Other authorized connectors can supply audience evidence through ytfun_trend_record.', { source: z.literal('youtube').default('youtube'), projectId: id.optional(), region: z.string().regex(/^[A-Z]{2}$/).default('BR'), limit: z.number().int().min(1).max(25).default(10) }, input => research.discover(input), { external: true });
  register('ytfun_production_models', 'List Hugging Face production model cards by image, voice or video task. This is a tools catalog, separate from audience trends. Confirm inference availability, price, free quota and commercial terms.', { task: z.enum(['text-to-image', 'text-to-speech', 'text-to-video']), limit: z.number().int().min(1).max(25).default(10) }, input => research.productionModels(input), { readOnly: true, external: true });
  register('ytfun_episode_plan', 'Persist a distinct original episode with narrated or strictly silent scenes. Silent scenes omit narration and use visuals only. Maintain series continuity. Factual projects need claim-specific source URLs. No copyrighted character or voice imitation.', {
    projectId: id, title: z.string().trim().min(1).max(100), hook: text, synopsis: text, continuityNote: text, originalAngle: text,
    audioMode: z.enum(['narrated', 'silent']).default('narrated'),
    scenes: z.array(z.object({ durationSeconds: z.number().min(1).max(60), narration: z.string().trim().max(10_000).default(''), visualPrompt: text })).min(1).max(12), metadata,
    trendIds: z.array(id).max(20).optional(), factualSources: z.array(z.object({ claim: text, url })).max(40).optional(),
  }, input => studio.planEpisode(input));
  register('ytfun_episode_get', 'Read full episode, scene IDs and linked asset provenance before producing or reviewing.', { episodeId: id }, async ({ episodeId }) => ({ episode: await studio.getEpisode(episodeId), assets: (await store.read()).assets.filter(asset => asset.episodeId === episodeId) }), { readOnly: true });
  register('ytfun_episode_review', 'Run structural editorial checks; this cannot watch a render or establish originality or monetization eligibility.', { episodeId: id }, ({ episodeId }) => studio.editorialReview(episodeId), { readOnly: true });
  register('ytfun_asset_generate', 'Generate one original image, speech or video with remote Hugging Face inference. Requires model/provider/license/pricing evidence. A zero estimate does not establish free usage. Paid calls require per-call acknowledgment and a runtime enable flag. Prefer ytfun_production_job_start for slow generations.', generationSchema, input => production.generateAsset(input), { external: true });
  register('ytfun_asset_import', 'Import an already-generated original AI asset from a regular local file (for example another authorized connector). Requires exact provider/model/prompt and commercial terms evidence. Does not accept third-party footage or music.', {
    episodeId: id, sceneId: id, kind, localPath: text, provenance: z.object({ provider: text, model: text, prompt: text, commercialLicense: license, synthetic: z.literal(true) }),
  }, input => production.registerAsset(input));
  register('ytfun_episode_render', 'Render original 9:16 scenes with FFmpeg. Narrated mode needs visuals plus voice and produces approximate scene-timed SRT; silent mode uses visuals only, discards embedded audio and produces no captions. Run production on a suitable worker, never as a laptop validation test.', { episodeId: id }, input => production.renderEpisode(input));
  register('ytfun_production_job_start', 'Start one slow production operation and return a persistent job ID immediately. One job runs at a time. Keep the MCP process alive; interrupted jobs never regenerate automatically.', { job: z.discriminatedUnion('action', [z.object({ action: z.literal('generate'), input: z.object(generationSchema) }), z.object({ action: z.literal('render'), input: z.object({ episodeId: id }) })]) }, ({ job }) => jobs.start(job), { external: true });
  register('ytfun_production_job_get', 'Read persistent production job status and completed output. Does not infer that another worker or an interrupted attempt failed.', { jobId: id }, ({ jobId }) => jobs.get(jobId), { readOnly: true });
  register('ytfun_production_job_reconcile', 'Close an interrupted worker record only after the operator verifies no worker is still active. Cost reservations and upload outcomes keep their independent gates; this does not retry them.', { jobId: id, confirmedBy: text, evidence: text }, input => jobs.reconcile(input));
  register('ytfun_episode_approve', 'Bind actual completed editorial review to this exact render and metadata. Never claim a render was watched or sources checked without doing so. Records reviewer accountability, not permission to bypass provider requirements.', {
    episodeId: id, review: z.object({ originalityChecked: z.literal(true), factsChecked: z.literal(true), renderWatched: z.literal(true), reviewedBy: z.string().trim().min(1).max(200), notes: text }),
  }, input => studio.approveEpisode(input));
  register('ytfun_publish_plan', 'Read readiness, review hash, channel-wide cadence and release blockers without uploading. Choose privacy explicitly. Scheduling public release requires audit/release flags.', { episodeId: id, platform, privacy: z.enum(['private', 'unlisted', 'public']), publishAt: z.iso.datetime().optional() }, input => publisher.preflight(input), { readOnly: true });
  register('ytfun_youtube_publish', 'Upload the exact reviewed original synthetic video through official YouTube OAuth. execute=false previews; execute=true has an external effect. Unknown outcomes reserve the attempt and must be reconciled before another upload.', { episodeId: id, privacy: z.enum(['private', 'unlisted', 'public']), publishAt: z.iso.datetime().optional(), expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/), madeForKids: z.boolean(), execute: z.boolean().default(false) }, input => publisher.publishYouTube(input), { external: true });
  register('ytfun_youtube_publication_sync', 'Verify an owned uploaded video through YouTube before declaring it published. Public privacy plus processed upload are required. Does not retry uploads or guess a receipt for unknown attempts.', { publicationId: id }, input => publisher.syncPublication(input), { external: true });
  register('ytfun_youtube_data_maintenance', 'Preview or execute removal of expired YouTube API snapshots. Preserves original media and local dedupe blocks; never resets an upload or deletes a YouTube video.', { execute: z.boolean().default(false) }, input => youtubeLifecycle.maintenance(input));
  register('ytfun_youtube_disconnect', 'Preview personal-account disconnect and data deletion. execute=true requires the exact channel ID, revokes every Google OAuth scope for this project, removes stored YouTube data/tokens, cancels unstarted deliveries and preserves local upload blocks. Backups/AI host transcripts require separate deletion; existing YouTube videos remain.', { execute: z.boolean().default(false), expectedChannelId: z.string().min(1).max(100).optional() }, input => youtubeLifecycle.disconnect(input), { external: true });
  register('ytfun_tiktok_export', 'Export the reviewed vertical video, caption/hashtags, disclosure and subtitles for posting through a permitted TikTok workflow. Exported is not posted. No Direct Post bypass.', { episodeId: id, expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/) }, input => publisher.exportTikTok(input));
  register('ytfun_distribution_capabilities', 'Read implemented delivery modes, configuration gaps and official platform constraints. Does not reveal tokens or confirm live authorization.', {}, () => publisher.capabilities(), { readOnly: true });
  register('ytfun_facebook_publish', 'Publish a reviewed synthetic Page Reel through official Meta APIs. Explicit public privacy and execute=true are required. Processing is not confirmed publication.', { episodeId: id, expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/), privacy: z.literal('public'), execute: z.boolean().default(false) }, input => publisher.publishFacebook(input), { external: true });
  register('ytfun_facebook_publication_sync', 'Check a Facebook receipt, Page ownership and completed processing before marking a Reel published. Does not repeat uploads.', { publicationId: id }, input => publisher.syncFacebook(input), { external: true });
  register('ytfun_kwai_export', 'Export the reviewed video, metadata and AI disclosure guidance for international Kwai. A Kuaishou API is not evidence of international Kwai support; export is not publication.', { episodeId: id, expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/) }, input => publisher.exportPackage({ ...input, platform: 'kwai' }));
  register('ytfun_delivery_enqueue', 'Authorize one reviewed delivery for a selected account and due time. The worker rechecks review, identity and cadence. TikTok/Kwai produce packages, not automatic posts. Queue time is not a provider-confirmed schedule.', { episodeId: id, platform, expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/), privacy: z.enum(['private', 'unlisted', 'public']), madeForKids: z.boolean().optional(), dueAt: z.iso.datetime() }, input => deliveries.enqueue(input));
  register('ytfun_delivery_list', 'Read persistent queued, running, completed and attention deliveries. Interrupted attempts are never replayed automatically.', {}, () => deliveries.list(), { readOnly: true });
  register('ytfun_delivery_run_due', 'Preview the next due delivery, or execute one when execute=true. Official API uploads have external effects; creator exports remain pending creator publication.', { execute: z.boolean().default(false) }, input => deliveries.runDue(input), { external: true });
  register('ytfun_delivery_cancel', 'Cancel an unstarted queued delivery; never cancels or deletes provider media.', { deliveryId: id }, input => deliveries.cancel(input));
  register('ytfun_delivery_reconcile', 'Close an interrupted delivery only after its exact publication receipt is reconciled and the operator verifies the original worker is stopped. Never resets unknown attempts for retry.', { deliveryId: id, workerStopped: z.literal(true), confirmedBy: text, evidence: text }, input => deliveries.reconcile(input));
  register('ytfun_metrics_record', 'Record a real performance observation from a platform/export with timestamp and source. Keep unknown values absent and platform metrics separate. Ratios may exceed 1 for loops.', { episodeId: id, platform, observedAt: z.iso.datetime(), sourceUrl: url, views: z.number().int().nonnegative().optional(), retentionRatio: z.number().finite().nonnegative().optional(), completionRate: z.number().min(0).max(1).optional(), revenueUsd: z.number().finite().nonnegative().optional(), periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }, input => studio.recordMetrics(input));
  register('ytfun_youtube_metrics_sync', 'Fetch period-level YouTube Analytics with yt-analytics.readonly OAuth. Empty data stays unknown. Does not establish qualified monetization views.', { episodeId: id, startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }, input => research.syncYouTubeMetrics(input), { external: true });
  register('ytfun_project_insights', 'Compare recorded episode performance and cost estimates to choose the next editorial experiment. No fabricated RPM, revenue prediction or causal conclusion.', { projectId: id }, ({ projectId }) => research.insights(projectId), { readOnly: true });

  server.registerResource('studio-state', 'ytfun://studio/state', { mimeType: 'application/json', description: 'Private persisted original-series studio state, including evidence and receipts. No credentials.' }, async uri => {
    await youtubeLifecycle.maintain();
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await store.read(), null, 2) }] };
  });
  server.registerPrompt('studio-director', { description: 'Plan an original AI series and continue its episodes from recorded evidence.', argsSchema: { direction: z.string().optional() } }, ({ direction }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Use ytfun_project_list and ytfun_overview first. Direction: ${direction ?? 'Explore original AI fiction, animation, humor or factual storytelling.'} Propose a series premise, audience, characters/style bible, distinct episode ideas and continuity. Research current signals with authorized connectors and preserve source/time. Reach concept consensus with the user before creating a project. Everything in the final video must be original synthetic media with commercial terms evidence; no borrowed clips, famous character replicas, celebrity voice imitation or invented facts. For each new concept, start with a low-cost, lower-fidelity pilot to validate the visual story, pacing and composition; upgrade only when the expected quality gain justifies its cost. Prefer covered credits or free usage when suitable, verify actual provider pricing and honor paid-call acknowledgment/runtime gates. Do not predict top trends or income. Prioritize a coherent long-form video and plan multiple standalone shorts from its outline. Each short needs its own visual hook, sufficient context, development and complete payoff or intentional seamless loop. Select narrative boundaries, re-edit/reframe as needed and leave room for the ending to land. Record each short's parent/source ranges and review/schedule each deliverable separately with shared channel cadence. AI Meow videos communicate through visuals and optional original nonverbal sound, without speech or on-screen text. Read the planning/render contracts and use supported production modes; do not force narration into a language-free concept. Check previous episodes before each next script. Generate/import assets, render, inspect the actual output, record a truthful review, then preview publication and execute only within authorized scope. YouTube requires synthetic disclosure; private TikTok workflow exports a package for a permitted posting experience. Collect real performance and change one hypothesis at a time.` } }] }));
  youtubeLifecycle.start();
  if (env.YTFUN_DELIVERY_WORKER_ENABLED === 'true') {
    deliveries.start();
  }
  const close = server.close.bind(server);
  server.close = async () => { youtubeLifecycle.stop(); deliveries.stop(); await close(); };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await createServer().connect(new StdioServerTransport()); }
  catch { console.error('ytfun MCP could not start. Set YTFUN_STUDIO_DIR and install studio dependencies.'); process.exitCode = 1; }
}
