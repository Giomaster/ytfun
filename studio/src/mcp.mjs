#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { StudioStore } from './store.mjs';
import { Studio } from './domain.mjs';
import { Production, videoParametersSchema, imageParametersSchema } from './production.mjs';
import { Publisher } from './publishing.mjs';
import { Research } from './research.mjs';
import { ProductionJobs } from './jobs.mjs';
import { DeliveryQueue } from './delivery-queue.mjs';
import { YouTubeDataLifecycle } from './youtube-data.mjs';
import { requiredToolScope, toolAuthorizationFailure } from './mcp-auth.mjs';
import { loadPrivateEnvironment } from './private-environment.mjs';
import { approvalReviewSchema } from './review-policy.mjs';

const id = z.string().uuid();
const text = z.string().trim().min(1).max(10_000);
const url = z.url().refine(value => ['https:', 'http:'].includes(new URL(value).protocol), 'HTTP(S) URL required');
const license = z.object({ url, notes: text });
const kind = z.enum(['image', 'video', 'audio']);
const operationPolicy = () => readFile(new URL('../docs/ai-meow-operation.md', import.meta.url), 'utf8');
const platform = z.enum(['youtube', 'facebook', 'tiktok', 'kwai']);
const cadence = z.object({ minHoursBetweenPosts: z.number().finite().min(0), maxPostsPerRollingDay: z.number().int().positive().nullable() });
const metadata = z.object({ description: z.string().max(5000), hashtags: z.array(z.string().trim().min(1).max(60).regex(/^#[\p{L}\p{N}_]+$/u)).max(8) });
const assetProvenance = z.object({ provider: text, model: text, prompt: text, commercialLicense: license, synthetic: z.literal(true) });
const generationSchema = {
  episodeId: id, sceneId: id, kind, model: z.string().trim().min(1).max(200), provider: z.string().trim().min(1).max(100), prompt: text.optional(), estimatedCostUsd: z.number().finite().nonnegative(), pricingSourceUrl: url, commercialLicense: license, acknowledgePaidCost: z.boolean().default(false),
  videoParameters: videoParametersSchema.optional(), imageParameters: imageParametersSchema.optional(), referenceImageAssetId: id.optional(), endReferenceImageAssetId: id.optional(), resumeReservationId: id.optional(),
};

export function createServer({ directory = process.env.YTFUN_STUDIO_DIR, env = process.env, fetchImpl = fetch, store, studio, production, publisher, research, jobs, youtubeLifecycle, startBackgroundWorkers = true, remoteAuth } = {}) {
  if (!directory && !store) throw new Error('YTFUN_STUDIO_DIR is required; use a private persistent absolute path');
  store ??= new StudioStore(directory);
  youtubeLifecycle ??= new YouTubeDataLifecycle(store, { env, fetchImpl });
  studio ??= new Studio(store, { env });
  production ??= new Production(store, { env });
  publisher ??= new Publisher(store, { env, fetchImpl: youtubeLifecycle.fetch, youtubeAuth: youtubeLifecycle.auth });
  research ??= new Research(studio, { env, fetchImpl: youtubeLifecycle.fetch, youtubeAuth: youtubeLifecycle.auth, youtubeLifecycle });
  jobs ??= new ProductionJobs(store, production);
  const requireLocalAssembly = () => {
    if (env.YTFUN_REMOTE_ASSEMBLY_ONLY === 'true') throw new Error('This host permits remote assembly only. Export the exact render manifest, assemble on an authorized remote worker and register its verified result.');
  };
  const deliveries = new DeliveryQueue(store, publisher);
  const server = new McpServer({ name: 'ytfun-ai-studio', version: '0.1.0' });
  const register = (name, description, schema, handler, { readOnly = false, external = false } = {}) => {
    const scope = requiredToolScope(name, { readOnly });
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: external },
      ...(remoteAuth ? { _meta: { securitySchemes: [{ type: 'oauth2', scopes: [scope] }] } } : {}) }, async input => {
      try {
        if (remoteAuth) {
          const denied = toolAuthorizationFailure(remoteAuth.authInfo, scope, remoteAuth.resourceUrl);
          if (denied) return denied;
        }
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

  if (remoteAuth) register('ytfun_cloud_profile', 'Identify the authenticated private AI Meow studio and distinguish actual publishing integrations from export-only routes. Never returns provider credentials.', {}, () => ({
    name: 'AI Meow', cloudAuthenticated: true, publishing: {
      youtube: { channelId: env.YOUTUBE_CHANNEL_ID ?? null, oauthConfigured: Boolean(env.YOUTUBE_REFRESH_TOKEN || env.YOUTUBE_ACCESS_TOKEN),
        publicApiEnabled: env.YTFUN_YOUTUBE_PUBLIC_ENABLED === 'true', apiAuditConfirmed: env.YTFUN_YOUTUBE_AUDIT_CONFIRMED === 'true' },
      facebook: { pageId: env.FACEBOOK_PAGE_ID ?? null, officialApiConfigured: Boolean(env.FACEBOOK_PAGE_ACCESS_TOKEN), enabled: env.YTFUN_FACEBOOK_PUBLISH_ENABLED === 'true' },
      tiktok: { accountId: env.TIKTOK_ACCOUNT_ID ?? null, route: env.YTFUN_TIKTOK_SESSION_PUBLISH_ENABLED === 'true' ? 'experimental_session_rest' : 'creator-export',
        sessionRestConfigured: env.YTFUN_TIKTOK_SESSION_PUBLISH_ENABLED === 'true', remoteAuthorizationVerified: false, automaticPosting: false },
    }, backgroundDeliveryWorker: false,
  }), { readOnly: true });

  register('ytfun_overview', 'Read studio projects, production and publication states. Uploaded, scheduled, exported and published are distinct.', {}, async () => {
    const state = await store.read();
    return { schemaVersion: state.schemaVersion, projects: state.projects, episodes: state.episodes.map(episode => ({ id: episode.id, projectId: episode.projectId, title: episode.title, status: episode.status, format: episode.format ?? 'short', durationSeconds: episode.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), ...(episode.derivation ? { derivation: episode.derivation } : {}), render: episode.render, approval: episode.approval })), publications: state.publications, deliveries: state.deliveries ?? [], spending: state.spending, constraints: ['Only original synthetic source media', 'Free-first; cost estimates are not invoices', 'TikTok and Kwai export packages require creator publication', 'No guarantee of views, distribution or revenue'] };
  }, { readOnly: true });
  register('ytfun_project_create', 'Persist an agreed original AI series: premise, audience, continuity and editorial cadence. Do not create an approved project before the user agrees to the concept.', {
    title: z.string().trim().min(1).max(160), premise: text, audience: text, language: z.string().min(2).max(30), continuity: text.optional(), mode: z.enum(['fiction', 'factual']).default('fiction'),
    cadence: cadence.optional(),
    budgetMonthlyUsd: z.number().finite().nonnegative().nullable().optional(),
  }, input => studio.createProject(input));
  register('ytfun_project_list', 'Read agreed series before proposing episodes. No automatically invented projects.', {}, () => studio.listProjects(), { readOnly: true });
  register('ytfun_project_cadence_update', 'Change an authorized editorial cadence experiment with a recorded reason and expected previous policy. Existing uploads, reservations and account-wide cadence checks remain intact.', {
    projectId: id,
    cadence, expectedCadence: cadence,
    reason: text,
  }, input => studio.updateProjectCadence(input));
  register('ytfun_trend_record', 'Persist a researched trend with exact source and observation time. Evidence is metadata, never media reuse clearance.', { topic: text, sourceUrl: url, observedAt: z.iso.datetime(), evidence: text, projectId: id.optional() }, input => studio.addTrend(input));
  register('ytfun_trend_discover', 'Fetch official YouTube regional popular-video metadata for editorial research. Does not download clips. A signal is not a forecast. Other authorized connectors can supply audience evidence through ytfun_trend_record.', { source: z.literal('youtube').default('youtube'), projectId: id.optional(), region: z.string().regex(/^[A-Z]{2}$/).default('BR'), limit: z.number().int().min(1).max(25).default(10) }, input => research.discover(input), { external: true });
  register('ytfun_production_models', 'List Hugging Face production model cards by image, voice or video task. This is a tools catalog, separate from audience trends. Confirm inference availability, price, free quota and commercial terms.', { task: z.enum(['text-to-image', 'text-to-speech', 'text-to-video']), limit: z.number().int().min(1).max(25).default(10) }, input => research.productionModels(input), { readOnly: true, external: true });
  register('ytfun_episode_plan', 'Persist a distinct original episode. Default format=short retains 12 scenes/180 seconds; explicit format=long permits 120 scenes/900 seconds. renderCanvas defaults to portrait (1080x1920); landscape explicitly selects 1920x1080 independently of duration limits. narrated requires narration; silent uses visuals only; nonverbal requires original audio per scene without narration or captions. Maintain series continuity and plan complete standalone units for later shorts. Factual projects need claim-specific source URLs. No copyrighted character or voice imitation.', {
    projectId: id, title: z.string().trim().min(1).max(100), hook: text, synopsis: text, continuityNote: text, originalAngle: text,
    audioMode: z.enum(['narrated', 'silent', 'nonverbal']).default('narrated'), format: z.enum(['short', 'long']).default('short'),
    renderCanvas: z.enum(['portrait', 'landscape']).optional(),
    scenes: z.array(z.object({ durationSeconds: z.number().min(1).max(60), narration: z.string().trim().max(10_000).default(''), visualPrompt: text })).min(1).max(120), metadata,
    trendIds: z.array(id).max(20).optional(), factualSources: z.array(z.object({ claim: text, url })).max(40).optional(),
  }, input => studio.planEpisode(input));
  register('ytfun_episode_derive_short', 'Create a planned, unapproved short from 1–12 unique scenes of a valid rendered long episode, in source order and at most 180 seconds. Copies/remaps original synthetic asset records with provenance, lineage and planned source time ranges; does not render, crop the master, approve or publish. Select a complete standalone story and supply distinct metadata. Duplicate source selections and unrelated near duplicates remain blocked.', {
    parentEpisodeId: id, sceneIds: z.array(id).min(1).max(12), title: z.string().trim().min(1).max(100), hook: text, synopsis: text, originalAngle: text, continuityNote: text.optional(), metadata,
  }, input => studio.deriveShort(input));
  register('ytfun_episode_get', 'Read full episode, scene IDs and linked asset provenance before producing or reviewing.', { episodeId: id }, async ({ episodeId }) => ({ episode: await studio.getEpisode(episodeId), assets: (await store.read()).assets.filter(asset => asset.episodeId === episodeId) }), { readOnly: true });
  register('ytfun_episode_review', 'Run structural editorial checks; this cannot watch a render or establish originality or monetization eligibility.', { episodeId: id }, ({ episodeId }) => studio.editorialReview(episodeId), { readOnly: true });
  register('ytfun_asset_generate', 'Generate one original image, speech or video with remote Hugging Face inference. imageParameters controls bounded image dimensions, steps and seed. referenceImageAssetId animates a synthetic image from the same episode and scene with imageToVideo. endReferenceImageAssetId supplies a validated final image only for fal-ai Wan2.2-I2V-A14B with an initial reference; both images retain license, hash, snapshot and lineage. FILM requires one interpolated frame and adjust_fps_for_interpolation=true to preserve duration. Requires model/provider/license/pricing evidence. A zero estimate does not establish free usage. Paid calls require per-call acknowledgment and a runtime enable flag. resumeReservationId retrieves an existing fal-ai video receipt with GET only, matching original inputs; pending does not create an asset. Prefer ytfun_production_job_start for slow generations.', generationSchema, input => production.generateAsset(input), { external: true });
  register('ytfun_asset_import', 'Import an already-generated original AI asset from a regular local file (for example another authorized connector). Requires exact provider/model/prompt and commercial terms evidence. Does not accept third-party footage or music.', {
    episodeId: id, sceneId: id, kind, localPath: text, provenance: assetProvenance,
  }, input => production.registerAsset(input));
  register('ytfun_episode_render', 'Render original scenes in the planned portrait or landscape canvas with FFmpeg on a remote production worker. narrated uses voice and approximate SRT; silent uses visuals only and discards audio; nonverbal uses original audio per scene without narration or captions. Default short retains 12 scenes/180 seconds; explicit long permits 120 scenes/900 seconds. Never render on the laptop.', { episodeId: id }, input => { requireLocalAssembly(); return production.renderEpisode(input); });
  register('ytfun_episode_render_manifest', 'Export the exact current scene/script/asset/provenance hashes and planned duration for remote assembly. Sources must be present and generation outcomes reconciled. Return the entire manifest unchanged when registering the result; no rendering or approval occurs. Hashing many sources can exceed one minute.', { episodeId: id }, input => production.exportRenderManifest(input), { readOnly: true });
  register('ytfun_episode_render_register', 'Register an original MP4 assembled remotely from a previously exported exact manifest. localPath belongs to this worker filesystem. Independently checks source hashes, current plan, bounded file copy, ffprobe duration/resolution/frame rate/audio and commit-time races. Long render cap=512 MiB; short/source caps=100 MiB. Provenance is an operator attestation, not proof of semantic assembly or a watched render. Approval/publication remain separate; allow an extended client timeout for hashing.', {
    episodeId: id, localPath: text, manifest: z.record(z.string(), z.unknown()), provenance: assetProvenance,
  }, input => production.registerRemoteRender(input));
  register('ytfun_production_job_start', 'Start one slow production operation and return a persistent job ID immediately. One job runs at a time. Keep the MCP process alive; interrupted jobs never regenerate automatically.', { job: z.discriminatedUnion('action', [z.object({ action: z.literal('generate'), input: z.object(generationSchema) }), z.object({ action: z.literal('render'), input: z.object({ episodeId: id }) })]) }, ({ job }) => { if (job.action === 'render') requireLocalAssembly(); return jobs.start(job); }, { external: true });
  register('ytfun_production_job_get', 'Read persistent production job status and completed output. Does not infer that another worker or an interrupted attempt failed.', { jobId: id }, ({ jobId }) => jobs.get(jobId), { readOnly: true });
  register('ytfun_production_job_reconcile', 'Close an interrupted worker record only after the operator verifies no worker is still active. Cost reservations and upload outcomes keep their independent gates; this does not retry them.', { jobId: id, confirmedBy: text, evidence: text }, input => jobs.reconcile(input));
  register('ytfun_episode_approve', 'Bind truthful review to this exact render and metadata. Watched review is the default. Explicit owner_accepted_technical mode may record renderWatched=false with structured owner acceptance and technical checks only when its runtime flag is enabled. Originality, facts, licenses, files and provider gates remain mandatory; never invent watching or consent.', {
    episodeId: id, review: approvalReviewSchema,
  }, input => studio.approveEpisode(input));
  register('ytfun_publish_plan', 'Read readiness, review hash, channel-wide cadence and release blockers without uploading. Choose privacy explicitly. Scheduling public release requires audit/release flags.', { episodeId: id, platform, privacy: z.enum(['private', 'unlisted', 'public']), publishAt: z.iso.datetime().optional() }, input => publisher.preflight(input), { readOnly: true });
  register('ytfun_youtube_publish', 'Upload the exact reviewed synthetic video through the selected YouTube API provider. Zernio is immediate public-only; own OAuth audit gates remain on the own-app route. Unknown outcomes stay reserved, with GET-only reconciliation.', { episodeId: id, privacy: z.enum(['private', 'unlisted', 'public']), publishAt: z.iso.datetime().optional(), expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/), madeForKids: z.boolean(), execute: z.boolean().default(false) }, input => publisher.publishYouTube(input), { external: true });
  register('ytfun_youtube_publication_sync', 'Verify an owned uploaded video through YouTube before declaring it published. Public privacy plus processed upload are required. Does not retry uploads or guess a receipt for unknown attempts.', { publicationId: id }, input => publisher.syncPublication(input), { external: true });
  register('ytfun_youtube_data_maintenance', 'Preview or execute removal of expired YouTube API snapshots. Preserves original media and local dedupe blocks; never resets an upload or deletes a YouTube video.', { execute: z.boolean().default(false) }, input => youtubeLifecycle.maintenance(input));
  register('ytfun_youtube_disconnect', 'Preview personal-account disconnect and data deletion. execute=true requires the exact channel ID, revokes every Google OAuth scope for this project, removes stored YouTube data/tokens, cancels unstarted deliveries and preserves local upload blocks. Backups/AI host transcripts require separate deletion; existing YouTube videos remain.', { execute: z.boolean().default(false), expectedChannelId: z.string().min(1).max(100).optional() }, input => youtubeLifecycle.disconnect(input), { external: true });
  register('ytfun_tiktok_export', 'Export the reviewed vertical video, caption/hashtags, disclosure and subtitles for posting through a permitted TikTok workflow. Exported is not posted. No Direct Post bypass.', { episodeId: id, expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/) }, input => publisher.exportTikTok(input));
  register('ytfun_tiktok_publish', 'Publish exact reviewed media through the explicitly selected TikTok API provider. Zernio additionally requires actual owner preview and express consent. Public only, identity/cadence required, no automatic retry. Upload receipts are not public posts.', { episodeId: id, expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/), privacy: z.literal('public'), execute: z.boolean().default(false) }, input => publisher.publishTikTok(input), { external: true });
  register('ytfun_tiktok_publication_sync', 'Reconcile an existing TikTok REST receipt using GET only. Requires actual owned public item evidence; never repeats an upload or post.', { publicationId: id }, input => publisher.syncTikTok(input), { external: true });
  register('ytfun_distribution_capabilities', 'Read implemented delivery modes, configuration gaps and official platform constraints. Does not reveal tokens or confirm live authorization.', {}, () => publisher.capabilities(), { readOnly: true });
  register('ytfun_facebook_publish', 'Publish a reviewed synthetic Page video through official Meta APIs. Explicit long episodes use Page Video; short/default episodes retain Reels 4–60s. Explicit public privacy and execute=true are required. Processing is not confirmed publication.', { episodeId: id, expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/), privacy: z.literal('public'), execute: z.boolean().default(false) }, input => publisher.publishFacebook(input), { external: true });
  register('ytfun_facebook_publication_sync', 'Check a Facebook receipt through its original upload route, Page ownership and completed processing. Long Page Video also requires an official returned permalink. Does not repeat uploads.', { publicationId: id }, input => publisher.syncFacebook(input), { external: true });
  register('ytfun_kwai_export', 'Export the reviewed video, metadata and AI disclosure guidance for international Kwai. A Kuaishou API is not evidence of international Kwai support; export is not publication.', { episodeId: id, expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/) }, input => publisher.exportPackage({ ...input, platform: 'kwai' }));
  register('ytfun_delivery_enqueue', 'Authorize one reviewed delivery for a selected account and due time. Uses the explicitly configured provider, exact account binding and cadence. Zernio is public-only; exports are not publications. Queue time is not provider scheduling. Call separately for each distinct eligible work.', { episodeId: id, platform, expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/), privacy: z.enum(['private', 'unlisted', 'public']), madeForKids: z.boolean().optional(), dueAt: z.iso.datetime() }, input => deliveries.enqueue(input));
  register('ytfun_zernio_delivery_migrate', 'Explicitly move only a proved unstarted public YouTube/TikTok claim to the authorized Zernio account. Preserves due time and media hashes. Rejects all provider reservations, running claims and unknown attempts.', { deliveryId: id, expectedMode: z.enum(['official_api', 'experimental_session_rest']), expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().min(1).max(1000) }, input => deliveries.migrateUnstartedToZernio(input), { external: true });
  register('ytfun_tiktok_zernio_consent_record', 'Record actual owner preview and express consent required by Zernio for the exact final TikTok media. Never infer watching from technical approval or general autonomous-publishing permission. Caller must have the owner evidence already.', { episodeId: id, expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/),
    attestation: z.object({ renderSha256: z.string().regex(/^[a-f0-9]{64}$/), contentPreviewConfirmed: z.literal(true), expressConsentGiven: z.literal(true), previewWitness: z.literal('owner'), consentSource: z.literal('owner_explicit'), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/), recordedAt: z.iso.datetime() }),
    interactionSettings: z.object({ allow_comment: z.boolean(), allow_duet: z.boolean(), allow_stitch: z.boolean() }) }, input => publisher.recordTikTokZernioConsent(input));
  register('ytfun_delivery_list', 'Read persistent queued, running, completed and attention deliveries. Interrupted attempts are never replayed automatically.', {}, () => deliveries.list(), { readOnly: true });
  register('ytfun_delivery_run_due', 'Preview or execute one due delivery. Per-platform workers must select their platform. API uploads have external effects; creator exports remain distinct from public posts.', { execute: z.boolean().default(false), platform: platform.optional() }, input => deliveries.runDue(input), { external: true });
  register('ytfun_delivery_cancel', 'Cancel an unstarted queued delivery; never cancels or deletes provider media.', { deliveryId: id }, input => deliveries.cancel(input));
  register('ytfun_delivery_reschedule', 'Re-time an exact unstarted delivery after current media/account/provider preflight. Preserves its ID and history; never resets an unknown or reserved provider attempt. Separate from publishing and provider scheduling.', {
    deliveryId: id, expectedClaim: z.object({ dueAt: z.iso.datetime(), platform, privacy: z.enum(['private', 'unlisted', 'public']), madeForKids: z.boolean().nullable(),
      reviewHash: z.string().regex(/^[a-f0-9]{64}$/), renderSha256: z.string().regex(/^[a-f0-9]{64}$/),
      accountId: z.string().trim().min(1).max(128), mode: z.enum(['official_api', 'experimental_session_rest', 'creator_export', 'zernio']),
      providerAccountId: z.string().regex(/^[a-f0-9]{24}$/).nullable(), bindingSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict(),
    dueAt: z.iso.datetime(), reason: z.string().trim().min(1).max(1000),
  }, input => deliveries.rescheduleUnstarted(input));
  register('ytfun_delivery_reconcile', 'Close an interrupted delivery only after its exact publication receipt is reconciled and the operator verifies the original worker is stopped. Never resets unknown attempts for retry.', { deliveryId: id, workerStopped: z.literal(true), confirmedBy: text, evidence: text }, input => deliveries.reconcile(input));
  register('ytfun_metrics_record', 'Record a real performance observation from a platform/export with timestamp and source. Keep unknown values absent and platform metrics separate. Ratios may exceed 1 for loops.', { episodeId: id, platform, observedAt: z.iso.datetime(), sourceUrl: url, views: z.number().int().nonnegative().optional(), retentionRatio: z.number().finite().nonnegative().optional(), completionRate: z.number().min(0).max(1).optional(), revenueUsd: z.number().finite().nonnegative().optional(), periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }, input => studio.recordMetrics(input));
  register('ytfun_youtube_metrics_sync', 'Fetch period-level YouTube Analytics with yt-analytics.readonly OAuth. Empty data stays unknown. Does not establish qualified monetization views.', { episodeId: id, startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }, input => research.syncYouTubeMetrics(input), { external: true });
  register('ytfun_project_insights', 'Compare recorded episode performance and cost estimates to choose the next editorial experiment. No fabricated RPM, revenue prediction or causal conclusion.', { projectId: id }, ({ projectId }) => research.insights(projectId), { readOnly: true });

  server.registerResource('studio-state', 'ytfun://studio/state', { mimeType: 'application/json', description: 'Private persisted original-series studio state, including evidence and receipts. No credentials.' }, async uri => {
    await youtubeLifecycle.maintain();
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await store.read(), null, 2) }] };
  });
  server.registerResource('studio-operation-policy', 'ytfun://studio/operation-policy', { mimeType: 'text/markdown', description: 'The single current AI Meow editorial and operational policy, read from the repository file.' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await operationPolicy() }],
  }));
  server.registerPrompt('studio-director', { description: 'Load the single current AI Meow policy before planning or continuing original content.', argsSchema: { direction: z.string().optional() } }, async ({ direction }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `AI Meow policy source: studio/docs/ai-meow-operation.md (ytfun://studio/operation-policy).\nRequested direction: ${direction ?? 'Continue the authorized AI Meow operation.'}\n\n${await operationPolicy()}` } }],
  }));
  if (startBackgroundWorkers) youtubeLifecycle.start();
  if (startBackgroundWorkers && env.YTFUN_DELIVERY_WORKER_ENABLED === 'true') {
    deliveries.start();
  }
  const close = server.close.bind(server);
  server.close = async () => { if (startBackgroundWorkers) { youtubeLifecycle.stop(); deliveries.stop(); } await close(); };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const env = process.env.YTFUN_PRIVATE_ENV_FILE ? await loadPrivateEnvironment(process.env.YTFUN_PRIVATE_ENV_FILE) : process.env;
    await createServer({ env, directory: env.YTFUN_STUDIO_DIR }).connect(new StdioServerTransport());
  } catch { console.error('ytfun MCP could not start. Check the owned private environment and studio dependencies.'); process.exitCode = 1; }
}
