import assert from 'node:assert/strict';
import test from 'node:test';
import { episodeReviewHash } from '../src/domain.mjs';
import { distributionCapabilities, publicationPackage } from '../src/distribution.mjs';
import { ownerAcceptedTechnicalReview, technicalReviewEnv } from './technical-review-fixture.mjs';

const CREATED_AT = '2026-09-30T15:00:00.000Z';
const VIDEO_HASH = 'a'.repeat(64);
const SRT_HASH = 'b'.repeat(64);

function fixture({ platform = 'tiktok', durationSeconds = 61, description = 'An original synthetic story.', subtitles = true } = {}) {
  const episode = {
    id: 'episode-1', projectId: 'project-1', title: 'A cat finds a tiny moon.',
    originalAngle: 'A moon that purrs when the cat sings.',
    scenes: [{ id: 'scene-1', durationSeconds, narration: 'The moon began to purr.' }],
    metadata: { description, hashtags: ['AI', '#Cats'] },
    render: {
      path: 'assets/episode-1/render.mp4', sha256: VIDEO_HASH, durationSeconds, synthetic: true,
      sceneAssets: [{ sceneId: 'scene-1', visualAssetId: 'visual-1', audioAssetId: 'audio-1' }],
      ...(subtitles ? { captionsPath: 'assets/episode-1/captions.srt', captionsSha256: SRT_HASH } : {}),
    },
  };
  const reviewHash = episodeReviewHash(episode);
  episode.approval = {
    reviewHash, approvedAt: CREATED_AT, assetReviewHash: 'c'.repeat(64),
    review: { originalityChecked: true, factsChecked: true, renderWatched: true, reviewedBy: 'Human editor' },
  };
  const fullDescription = [description, '#AI #Cats'].filter(Boolean).join('\n\n');
  const plan = {
    platform, episodeId: episode.id, projectId: episode.projectId, reviewHash,
    ready: false, readyToExport: true, reasons: [],
    render: { path: episode.render.path, sha256: VIDEO_HASH, durationSeconds },
    metadata: { title: episode.title, description: fullDescription, hashtags: [...episode.metadata.hashtags] },
    caption: [episode.title, fullDescription].filter(Boolean).join('\n\n'),
    cadence: { warnings: ['Respect the planned 24-hour interval.'] },
  };
  return { platform, plan, episode, createdAt: CREATED_AT };
}

test('capabilities separate credential presence from verified publishing authorization', () => {
  const capabilities = distributionCapabilities({
    YOUTUBE_ACCESS_TOKEN: 'secret-youtube-token', YOUTUBE_CHANNEL_ID: 'UCexpected',
    YTFUN_YOUTUBE_PUBLIC_ENABLED: 'true', YTFUN_YOUTUBE_AUDIT_CONFIRMED: 'true',
    FACEBOOK_PAGE_ID: '123456', FACEBOOK_PAGE_ACCESS_TOKEN: 'secret-facebook-token', FACEBOOK_GRAPH_API_VERSION: 'v25.0',
    YTFUN_FACEBOOK_PUBLISH_ENABLED: 'true', YTFUN_FACEBOOK_APP_REVIEW_CONFIRMED: 'true',
  });
  assert.deepEqual(capabilities.map((entry) => entry.platform), ['youtube', 'facebook', 'tiktok', 'kwai']);
  for (const capability of capabilities.slice(0, 2)) {
    assert.equal(capability.configuration.complete, true);
    assert.equal(capability.readyForPreflight, true);
    assert.equal(capability.authorizationVerified, false);
    assert.ok(capability.blockers.length > 0);
  }
  const serialized = JSON.stringify(capabilities);
  assert.equal(serialized.includes('secret-youtube-token'), false);
  assert.equal(serialized.includes('secret-facebook-token'), false);
  assert.equal(serialized.includes('UCexpected'), false);
});

test('partial refresh credentials cannot fall back to a static token silently', () => {
  const youtube = distributionCapabilities({ YOUTUBE_ACCESS_TOKEN: 'static-token', YOUTUBE_CHANNEL_ID: 'UCexpected', YOUTUBE_CLIENT_ID: 'client-id' })[0];
  assert.equal(youtube.configuration.credentialMode, 'refresh_token');
  assert.equal(youtube.readyForPreflight, false);
  assert.deepEqual(youtube.configuration.missing, ['YOUTUBE_REFRESH_TOKEN', 'YOUTUBE_CLIENT_SECRET']);
  const configured = distributionCapabilities({
    YOUTUBE_CHANNEL_ID: 'UCexpected', YOUTUBE_CLIENT_ID: 'client-id', YOUTUBE_CLIENT_SECRET: 'secret-client', YOUTUBE_REFRESH_TOKEN: 'secret-refresh',
  })[0];
  assert.equal(configured.readyForPreflight, true);
  assert.equal(configured.publicPostingEnabled, false);
  assert.equal(JSON.stringify(configured).includes('secret-refresh'), false);
});

test('Facebook capability requires explicit API version and publishing flags', () => {
  const facebook = distributionCapabilities({ FACEBOOK_PAGE_ID: 'personal-name', FACEBOOK_PAGE_ACCESS_TOKEN: 'token', FACEBOOK_GRAPH_API_VERSION: 'latest' })[1];
  assert.equal(facebook.configuration.complete, false);
  assert.equal(facebook.readyForPreflight, false);
  assert.deepEqual(facebook.configuration.invalid, ['FACEBOOK_PAGE_ID', 'FACEBOOK_GRAPH_API_VERSION']);
  const withoutFlags = distributionCapabilities({ FACEBOOK_PAGE_ID: '1234', FACEBOOK_PAGE_ACCESS_TOKEN: 'token', FACEBOOK_GRAPH_API_VERSION: 'v25.0' })[1];
  assert.equal(withoutFlags.configuration.complete, true);
  assert.equal(withoutFlags.readyForPreflight, false);
});

test('tokens and enable flags cannot promote private TikTok or international Kwai to API publishers', () => {
  const capabilities = distributionCapabilities({
    TIKTOK_ACCESS_TOKEN: 'token', TIKTOK_ACCOUNT_ID: 'account', YTFUN_TIKTOK_PUBLISH_ENABLED: 'true',
    KWAI_ACCESS_TOKEN: 'token', KWAI_ACCOUNT_ID: 'account', YTFUN_KWAI_PUBLISH_ENABLED: 'true',
  });
  for (const entry of capabilities.slice(2)) {
    assert.equal(entry.deliveryMode, 'creator_export');
    assert.equal(entry.directPost, false);
    assert.equal(entry.readyForPreflight, false);
    assert.equal(entry.requiresCreatorPublishing, true);
    assert.equal(entry.exportSupported, true);
  }
  assert.match(capabilities[2].blockers.join(' '), /private.*app-review/);
  assert.match(capabilities[3].restrictions.join(' '), /Mainland Kuaishou.*international Kwai/);
});

test('TikTok package preserves the old export fields without claiming publication or monetization', () => {
  const input = fixture();
  const output = publicationPackage(input);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.status, 'exported');
  assert.deepEqual(output.video, input.plan.render);
  assert.equal(output.caption, input.plan.caption);
  assert.deepEqual(output.hashtags, ['AI', '#Cats']);
  assert.deepEqual(output.disclosure, { synthetic: true, isAigc: true });
  assert.equal(output.monetization.creatorRewardsDurationCandidate, true);
  assert.equal(output.monetization.eligibilityConfirmed, false);
  assert.equal(output.constraints.publicationConfirmed, false);
  assert.equal(output.captionsPath, input.episode.render.captionsPath);
  assert.deepEqual(output.captions, { path: input.episode.render.captionsPath, sha256: SRT_HASH });
  assert.ok(output.creatorActions.some((action) => /express consent/.test(action)));
});

test('packages are independent deeply frozen snapshots and serialize without opaque values', () => {
  const input = fixture();
  const output = publicationPackage(input);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.video), true);
  assert.equal(Object.isFrozen(output.hashtags), true);
  assert.equal(Object.isFrozen(output.sources[0]), true);
  input.plan.metadata.hashtags.push('Changed');
  input.plan.cadence.warnings.push('Changed');
  assert.deepEqual(output.hashtags, ['AI', '#Cats']);
  assert.deepEqual(output.cadenceWarnings, ['Respect the planned 24-hour interval.']);
  assert.throws(() => { output.video.path = 'different.mp4'; }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(output)), output);
});

test('Kwai package leaves account restrictions and disclosure controls explicitly unverified', () => {
  const output = publicationPackage(fixture({ platform: 'kwai', subtitles: false }));
  assert.equal(output.constraints.internationalPublishingApiVerified, false);
  assert.equal(output.constraints.accountUploadLimitsRequireCheck, true);
  assert.equal(output.disclosure.platformDisclosureControlVerified, false);
  assert.equal(output.monetization.eligibilityConfirmed, false);
  assert.equal('creatorRewardsDurationCandidate' in output.monetization, false);
  assert.equal('captions' in output, false);
  assert.ok(output.creatorActions.some((action) => /official Kwai app/.test(action)));
});

test('YouTube and Facebook export snapshots retain provider AI disclosure and require later provider confirmation', () => {
  const youtube = publicationPackage(fixture({ platform: 'youtube' }));
  const facebook = publicationPackage(fixture({ platform: 'facebook' }));
  assert.equal(youtube.disclosure.containsSyntheticMedia, true);
  assert.equal(facebook.disclosure.isAiGenerated, true);
  assert.equal(facebook.constraints.publicationConfirmed, false);
  assert.equal(youtube.deliveryMode, 'official_api');
});

test('unsuccessful, cross-platform and stale editorial plans cannot produce packages', () => {
  const blocked = fixture();
  blocked.plan.reasons.push('The render changed.');
  assert.throws(() => publicationPackage(blocked), /successful preflight/);
  const wrongPlatform = fixture();
  wrongPlatform.platform = 'kwai';
  assert.throws(() => publicationPackage(wrongPlatform), /intended platform/);
  const changedEpisode = fixture();
  changedEpisode.episode.title = 'A different unreviewed title';
  assert.throws(() => publicationPackage(changedEpisode), /reviewed episode fingerprint/);
  const unreviewed = fixture();
  unreviewed.episode.approval.review.renderWatched = false;
  assert.throws(() => publicationPackage(unreviewed), /reviewed episode fingerprint/);
});

test('publication packages accept structured unwatched review only with opt-in and the exact render binding', () => {
  const input = fixture();
  input.episode.approval.review = ownerAcceptedTechnicalReview(input.episode);
  assert.throws(() => publicationPackage(input), /reviewed episode fingerprint/);
  assert.equal(publicationPackage({ ...input, env: technicalReviewEnv }).status, 'exported');
  for (const mutate of [
    review => { review.originalityChecked = false; },
    review => { review.factsChecked = false; },
    review => { delete review.technicalAcceptance.reason; },
    review => { review.technicalAcceptance.renderSha256 = 'd'.repeat(64); },
    review => { review.technicalAcceptance.ownerAcceptedImperfections = false; },
  ]) {
    const changed = structuredClone(input);
    mutate(changed.episode.approval.review);
    assert.throws(() => publicationPackage({ ...changed, env: technicalReviewEnv }), /reviewed episode fingerprint/);
  }
  const changedRender = structuredClone(input);
  changedRender.episode.render.sha256 = changedRender.plan.render.sha256 = 'e'.repeat(64);
  changedRender.episode.approval.reviewHash = changedRender.plan.reviewHash = episodeReviewHash(changedRender.episode);
  assert.throws(() => publicationPackage({ ...changedRender, env: technicalReviewEnv }), /reviewed episode fingerprint/);
});

test('preflight cannot substitute unreviewed caption, hashtags or video references', () => {
  for (const mutation of [
    (plan) => { plan.caption = 'Unreviewed marketing copy'; },
    (plan) => { plan.metadata.hashtags.push('Unreviewed'); },
    (plan) => { plan.render.path = 'assets/different.mp4'; },
    (plan) => { plan.render.sha256 = 'd'.repeat(64); },
  ]) {
    const input = fixture();
    mutation(input.plan);
    assert.throws(() => publicationPackage(input), /reviewed/);
  }
});

test('nonportable paths and missing reviewed subtitle hashes are rejected', () => {
  for (const unsafe of ['/private/render.mp4', '../render.mp4', 'assets/../render.mp4', 'assets//render.mp4', 'C:\\private\\render.mp4']) {
    const input = fixture();
    input.episode.render.path = input.plan.render.path = unsafe;
    input.episode.approval.reviewHash = input.plan.reviewHash = episodeReviewHash(input.episode);
    assert.throws(() => publicationPackage(input), /MP4 reference/);
  }
  const subtitles = fixture();
  delete subtitles.episode.render.captionsSha256;
  subtitles.episode.approval.reviewHash = subtitles.plan.reviewHash = episodeReviewHash(subtitles.episode);
  assert.throws(() => publicationPackage(subtitles), /Subtitles/);
});

test('TikTok caption budget counts UTF-16 code units and rejects rather than truncates reviewed text', () => {
  const overhead = fixture({ description: '' }).plan.caption.length + 2;
  const exactLimit = fixture({ description: 'x'.repeat(2200 - overhead) });
  assert.equal(publicationPackage(exactLimit).caption.length, 2200);
  assert.throws(() => publicationPackage(fixture({ description: 'x'.repeat(2201 - overhead) })), /2200/);
  assert.throws(() => publicationPackage(fixture({ description: '🐱'.repeat(1100) })), /2200/);
});

test('duration candidate uses the existing greater-than-60 rule and never asserts program eligibility', () => {
  const sixty = publicationPackage(fixture({ durationSeconds: 60 }));
  const longer = publicationPackage(fixture({ durationSeconds: 60.1 }));
  assert.equal(sixty.monetization.creatorRewardsDurationCandidate, false);
  assert.equal(longer.monetization.creatorRewardsDurationCandidate, true);
  assert.equal(longer.monetization.eligibilityConfirmed, false);
});

test('invalid dates and unsupported platform names are rejected before persistence', () => {
  assert.throws(() => publicationPackage({ ...fixture(), createdAt: '2026-02-30T15:00:00.000Z' }), /canonical ISO/);
  assert.throws(() => publicationPackage({ ...fixture(), createdAt: 'tomorrow' }), /canonical ISO/);
  assert.throws(() => publicationPackage({ ...fixture(), platform: 'kuaishou' }), /Unsupported/);
});
