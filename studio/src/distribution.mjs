import { episodeReviewHash } from './domain.mjs';

const CHECKED_AT = '2026-09-30';
const PLATFORMS = ['youtube', 'facebook', 'tiktok', 'kwai'];
const SOURCES = {
  youtube: [
    ['Video upload and audit restrictions', 'https://developers.google.com/youtube/v3/docs/videos/insert'],
  ],
  facebook: [
    ['Facebook Reels publishing', 'https://developers.facebook.com/docs/video-api/guides/reels-publishing/'],
    ['Meta SDK Reels AI-disclosure field', 'https://github.com/facebook/facebook-python-business-sdk/blob/788f363d15b1269ab5efb7cd00fb5e3b133cd99b/facebook_business/adobjects/page.py#L4842-L4866'],
    ['Meta SDK general Page Video upload and AI-disclosure fields', 'https://github.com/facebook/facebook-python-business-sdk/blob/788f363d15b1269ab5efb7cd00fb5e3b133cd99b/facebook_business/adobjects/page.py#L4961-L5078'],
    ['Meta Video ownership, processing and permalink fields', 'https://github.com/facebook/facebook-python-business-sdk/blob/788f363d15b1269ab5efb7cd00fb5e3b133cd99b/facebook_business/adobjects/advideo.py'],
  ],
  tiktok: [
    ['App review requirements', 'https://developers.tiktok.com/doc/app-review-guidelines'],
    ['Direct Post intended use and creator controls', 'https://developers.tiktok.com/doc/content-sharing-guidelines'],
    ['Upload-to-Inbox prerequisites', 'https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content'],
    ['Caption and AI-disclosure fields', 'https://developers.tiktok.com/doc/content-posting-api-reference-direct-post'],
    ['Media transfer limits', 'https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide'],
  ],
  kwai: [
    ['International Kwai creator tools', 'https://www.kwai.com/creators/create'],
    ['International Kwai monetization', 'https://www.kwai.com/creators/earn'],
    ['Mainland Kuaishou publishing API (separate product)', 'https://open.kuaishou.com/platformDocs/openAbility/contentManagement/createAVideo.html'],
  ],
};

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function sources(platform) {
  return SOURCES[platform].map(([title, url]) => ({ title, url, checkedAt: platform === 'facebook' ? '2026-10-01' : CHECKED_AT }));
}

function missingVariables(env, names) {
  return names.filter((name) => !nonempty(env[name]));
}

/** Configuration hints only: no API calls, credential values, or authorization verdicts. */
export function distributionCapabilities(env = {}) {
  const refreshNames = ['YOUTUBE_REFRESH_TOKEN', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'];
  const refreshSelected = refreshNames.some((name) => nonempty(env[name]));
  const youtubeRequired = ['YOUTUBE_CHANNEL_ID', ...(refreshSelected ? refreshNames : ['YOUTUBE_ACCESS_TOKEN'])];
  const youtubeMissing = missingVariables(env, youtubeRequired);
  const facebookRequired = ['FACEBOOK_PAGE_ID', 'FACEBOOK_PAGE_ACCESS_TOKEN', 'FACEBOOK_GRAPH_API_VERSION'];
  const facebookMissing = missingVariables(env, facebookRequired);
  const facebookInvalid = [
    ...(nonempty(env.FACEBOOK_PAGE_ID) && !/^\d+$/.test(env.FACEBOOK_PAGE_ID) ? ['FACEBOOK_PAGE_ID'] : []),
    ...(nonempty(env.FACEBOOK_GRAPH_API_VERSION) && !/^v\d+\.0$/.test(env.FACEBOOK_GRAPH_API_VERSION) ? ['FACEBOOK_GRAPH_API_VERSION'] : []),
  ];
  const youtubePublic = env.YTFUN_YOUTUBE_PUBLIC_ENABLED === 'true' && env.YTFUN_YOUTUBE_AUDIT_CONFIRMED === 'true';
  const facebookPublic = env.YTFUN_FACEBOOK_PUBLISH_ENABLED === 'true' && env.YTFUN_FACEBOOK_APP_REVIEW_CONFIRMED === 'true';
  return deepFreeze([
    {
      platform: 'youtube', deliveryMode: 'official_api', directPost: true, exportSupported: true,
      requiresCreatorPublishing: false, authorizationVerified: false,
      configuration: { complete: youtubeMissing.length === 0, missing: youtubeMissing, credentialMode: refreshSelected ? 'refresh_token' : 'access_token' },
      readyForPreflight: youtubeMissing.length === 0, publicPostingEnabled: youtubePublic,
      blockers: [
        ...youtubeMissing.map((name) => `Configure ${name}.`),
        'The publisher must verify current OAuth scopes and the intended YouTube channel.',
        ...(!youtubePublic ? ['Public or scheduled release requires YTFUN_YOUTUBE_PUBLIC_ENABLED=true and YTFUN_YOUTUBE_AUDIT_CONFIRMED=true.'] : []),
      ],
      restrictions: ['Upload, processing, scheduled release and confirmed public publication are separate states.'],
      sources: sources('youtube'),
    },
    {
      platform: 'facebook', deliveryMode: 'official_api', directPost: true, exportSupported: true,
      requiresCreatorPublishing: false, authorizationVerified: false,
      configuration: { complete: facebookMissing.length === 0 && facebookInvalid.length === 0, missing: facebookMissing, invalid: facebookInvalid },
      readyForPreflight: facebookMissing.length === 0 && facebookInvalid.length === 0 && facebookPublic,
      publicPostingEnabled: facebookPublic,
      blockers: [
        ...facebookMissing.map((name) => `Configure ${name}.`),
        ...facebookInvalid.map((name) => `Correct the format of ${name}.`),
        'The publisher must verify Page identity, current token permissions and publishing eligibility.',
        ...(!facebookPublic ? ['Facebook publishing requires YTFUN_FACEBOOK_PUBLISH_ENABLED=true and YTFUN_FACEBOOK_APP_REVIEW_CONFIRMED=true.'] : []),
      ],
      restrictions: [
        'Short/default episodes use Page Reels with the conservative 4–60 second profile; explicit long episodes use the separate Page Video API with a studio limit of 4–900 seconds.',
        'The provider duration limit for the general Page Video API is unverified; server acceptance is required, and the Facebook UI announcement does not establish Reels API limits.',
        'Uploads are limited to 250 MiB; Page Video chunks are limited to 8 MiB. Personal-profile publishing is not supported.',
      ],
      sources: sources('facebook'),
    },
    {
      platform: 'tiktok', deliveryMode: env.YTFUN_TIKTOK_SESSION_PUBLISH_ENABLED === 'true' ? 'experimental_session_rest' : 'creator_export',
      directPost: env.YTFUN_TIKTOK_SESSION_PUBLISH_ENABLED === 'true', exportSupported: true,
      requiresCreatorPublishing: env.YTFUN_TIKTOK_SESSION_PUBLISH_ENABLED !== 'true', authorizationVerified: false,
      readyForPreflight: env.YTFUN_TIKTOK_SESSION_PUBLISH_ENABLED === 'true' &&
        /^\d+$/.test(env.TIKTOK_ACCOUNT_ID ?? '') && Boolean(env.TIKTOK_ACCOUNT_HANDLE && env.TIKTOK_SESSION_FILE?.startsWith('/')),
      configuration: { complete: env.YTFUN_TIKTOK_SESSION_PUBLISH_ENABLED !== 'true' ||
        Boolean(env.TIKTOK_ACCOUNT_ID && env.TIKTOK_ACCOUNT_HANDLE && env.TIKTOK_SESSION_FILE), missing: [] },
      blockers: [
        'This private account-management utility does not meet TikTok app-review or Direct Post intended-use requirements.',
        'Upload-to-Inbox also requires an approved app and creator-authorized video.upload scope; it leaves publication to the creator and is not implemented here.',
      ],
      restrictions: [
        'A permitted integration must provide creator preview, editable metadata, privacy selection and express upload consent.',
        'Caption limit: 2200 UTF-16 code units; actual account duration limits must be checked in TikTok.',
        'The separately enabled session REST lane is experimental, not an audited official Direct Post integration. It pauses on expired sessions, challenges and uncertain mutations.',
      ],
      sources: sources('tiktok'),
    },
    {
      platform: 'kwai', deliveryMode: 'creator_export', directPost: false, exportSupported: true,
      requiresCreatorPublishing: true, authorizationVerified: false, readyForPreflight: false,
      configuration: { complete: true, missing: [] },
      blockers: ['No supported public publishing API for international Kwai accounts was verified in the official sources reviewed.'],
      restrictions: [
        'Mainland Kuaishou user_video_publish APIs do not establish support for international Kwai accounts.',
        'Account-specific upload limits, available disclosure controls and monetization requirements must be checked in Kwai.',
      ],
      sources: sources('kwai'),
    },
  ]);
}

function relativeMediaPath(value, extension) {
  return nonempty(value) && !value.includes('\\') && !value.startsWith('/') &&
    !/^[a-z]:/i.test(value) && value.split('/').every((part) => part && part !== '.' && part !== '..') &&
    value.toLowerCase().endsWith(extension);
}

function fingerprint(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function creatorActions(platform) {
  const actions = [
    'Review the exact video, subtitles and editable caption.',
    'Confirm the intended channel or account and the planned publication time.',
  ];
  if (platform === 'tiktok') return [...actions,
    'Select privacy and interaction settings in TikTok or a permitted integration.',
    'Enable the AI-generated content disclosure and review any commercial-content declarations.',
    'Give express consent before uploading, then publish through TikTok or a permitted compatible integration.',
    'Confirm the published post URL and account; an exported file or Inbox draft is not a published post.',
  ];
  if (platform === 'kwai') return [...actions,
    'Import the reviewed video through the official Kwai app or available creator upload interface.',
    'Check the account upload limits, privacy settings and any commercial-content declarations.',
    'Disclose AI generation using available platform controls; if the caption needs editing, obtain a fresh editorial review.',
    'Complete publication in Kwai and confirm the public post URL and account.',
  ];
  return [...actions,
    'Select audience, visibility and any commercial-content declarations for this upload.',
    'Retain the AI-generated content disclosure when submitting through the supported publisher.',
    'Confirm processing and public visibility with the provider before recording a published result.',
  ];
}

/**
 * Snapshot a successful editorial/file preflight. The caller verifies file contents,
 * licenses and cadence immediately before this pure builder; no filesystem or API calls occur here.
 */
export function publicationPackage({ platform, plan, episode, createdAt }) {
  if (!PLATFORMS.includes(platform)) throw new Error('Unsupported publication platform.');
  if (plan?.platform !== platform || (plan.readyToExport !== true && plan.ready !== true) ||
      !Array.isArray(plan.reasons) || plan.reasons.length !== 0) {
    throw new Error('Publication package requires a successful preflight for the intended platform.');
  }
  const review = episode?.approval?.review;
  if (!episode || plan.episodeId !== episode.id || plan.projectId !== episode.projectId ||
      !fingerprint(plan.reviewHash) || plan.reviewHash !== episodeReviewHash(episode) ||
      episode.approval?.reviewHash !== plan.reviewHash || !nonempty(episode.approval?.approvedAt) ||
      review?.originalityChecked !== true || review?.factsChecked !== true || review?.renderWatched !== true || !nonempty(review?.reviewedBy)) {
    throw new Error('Publication package requires the current reviewed episode fingerprint.');
  }
  if (!relativeMediaPath(plan.render?.path, '.mp4') || !fingerprint(plan.render?.sha256) ||
      !Number.isFinite(plan.render?.durationSeconds) || plan.render.durationSeconds <= 0 ||
      episode.render?.synthetic !== true || episode.render.path !== plan.render.path ||
      episode.render.sha256 !== plan.render.sha256 || episode.render.durationSeconds !== plan.render.durationSeconds) {
    throw new Error('Publication package requires the exact reviewed synthetic MP4 reference.');
  }
  if (typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
      !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    throw new Error('createdAt must be a canonical ISO UTC timestamp.');
  }
  if (typeof plan.caption !== 'string' || !Array.isArray(plan.metadata?.hashtags) || !plan.metadata.hashtags.every(nonempty)) {
    throw new Error('Publication package requires reviewed caption text and hashtag metadata.');
  }
  const reviewedHashtags = episode.metadata?.hashtags ?? [];
  const reviewedDescription = episode.metadata?.description ?? '';
  if (!Array.isArray(reviewedHashtags) || !reviewedHashtags.every(nonempty) || typeof reviewedDescription !== 'string') {
    throw new Error('Episode metadata is invalid.');
  }
  const hashtagText = reviewedHashtags.map((tag) => tag.startsWith('#') ? tag : `#${tag}`).join(' ');
  const fullDescription = [reviewedDescription, hashtagText].filter(nonempty).join('\n\n');
  const reviewedCaption = [episode.title, fullDescription].filter(nonempty).join('\n\n');
  if (plan.caption !== reviewedCaption || plan.metadata.title !== episode.title || plan.metadata.description !== fullDescription ||
      plan.metadata.hashtags.length !== reviewedHashtags.length || plan.metadata.hashtags.some((tag, index) => tag !== reviewedHashtags[index])) {
    throw new Error('Caption and hashtags must match the reviewed episode metadata.');
  }
  if (platform === 'tiktok' && plan.caption.length > 2200) throw new Error('TikTok caption exceeds 2200 UTF-16 code units.');
  if (!Array.isArray(plan.cadence?.warnings) || !plan.cadence.warnings.every(nonempty)) {
    throw new Error('Publication package requires cadence warnings from preflight.');
  }
  const creatorOnly = platform === 'tiktok' || platform === 'kwai';
  const packageData = {
    schemaVersion: 1, platform, episodeId: episode.id, projectId: episode.projectId,
    reviewHash: plan.reviewHash, createdAt, status: 'exported',
    deliveryMode: creatorOnly ? 'creator_export' : 'official_api',
    video: { path: plan.render.path, sha256: plan.render.sha256, durationSeconds: plan.render.durationSeconds },
    caption: plan.caption, hashtags: [...plan.metadata.hashtags],
    disclosure: {
      synthetic: true,
      ...(platform === 'tiktok' ? { isAigc: true } : {}),
      ...(platform === 'youtube' ? { containsSyntheticMedia: true } : {}),
      ...(platform === 'facebook' ? { isAiGenerated: true } : {}),
      ...(platform === 'kwai' ? { platformDisclosureControlVerified: false } : {}),
    },
    creatorActions: creatorActions(platform),
    monetization: {
      ...(platform === 'tiktok' ? { creatorRewardsDurationCandidate: plan.render.durationSeconds > 60 } : {}),
      eligibilityConfirmed: false,
    },
    cadenceWarnings: [...plan.cadence.warnings],
    constraints: {
      requiresCreatorPublishing: creatorOnly,
      metadataEditable: true,
      changedContentRequiresNewReview: true,
      publicationConfirmed: false,
      ...(platform === 'tiktok' ? { captionMaxUtf16CodeUnits: 2200, durationLimitRequiresAccountCheck: true } : {}),
      ...(platform === 'kwai' ? { internationalPublishingApiVerified: false, accountUploadLimitsRequireCheck: true } : {}),
    },
    sources: sources(platform),
  };
  if (episode.render.captionsPath !== undefined) {
    if (!relativeMediaPath(episode.render.captionsPath, '.srt') || !fingerprint(episode.render.captionsSha256)) {
      throw new Error('Subtitles require the reviewed relative SRT path and SHA-256 fingerprint.');
    }
    packageData.captions = { path: episode.render.captionsPath, sha256: episode.render.captionsSha256 };
    packageData.captionsPath = episode.render.captionsPath;
  }
  return deepFreeze(packageData);
}
