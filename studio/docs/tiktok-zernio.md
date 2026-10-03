# TikTok through Zernio

This route is explicitly authorized by Giovanni. It is a separate adapter from
the captured TikTok session REST lane and remains disabled until configured.
Account creation, connection, credentials, delivery reservations, publication
submission and confirmed public visibility are separate states. This document
describes the adapter contract, not a new editorial policy.

## Connection and account binding

Private environment keys:

```dotenv
YTFUN_TIKTOK_ZERNIO_PUBLISH_ENABLED=false
YTFUN_TIKTOK_STANDING_AUTHORITY_SHA256=
ZERNIO_API_KEY=
ZERNIO_TIKTOK_ACCOUNT_ID=
TIKTOK_ACCOUNT_ID=
TIKTOK_ACCOUNT_HANDLE=
```

`ZERNIO_TIKTOK_ACCOUNT_ID` is Zernio's 24-character account identifier. It must
never replace the native numeric `TIKTOK_ACCOUNT_ID` used by the channel ledger.
Use only the fixed API origin `https://zernio.com/api/v1`; keep the API key private.
Constructor input `binding` records the explicit connection evidence:

```js
{
  providerAccountId, nativeAccountId, handle,
  evidenceSha256, verifiedAt,
  source: 'owner_confirmed' // or 'authenticated_profile'
}
```

All three identity fields must match the private configuration. The account API
does not promise the native UID, so the binding comes from an actual authorized
connection/identity observation, not from treating a provider ID as that UID.
`readiness()` is local and reports remote authorization as unverified.
`verifyAccount()` reads accounts and creator information, checking the unique
active TikTok account, exact handle, public privacy option, quota availability,
duration ceiling and interaction capabilities. It returns native `accountId`,
`providerAccountId`, `handle`, `maxDurationSeconds` and `interactionSettings`.

## Submission contract

```js
await adapter.upload({
  media, caption, render, publicationId, onReceipt,
  attestation, interactionSettings
});
```

`media` is the exact MP4 Buffer, up to the Studio's operational ceiling of
250 MiB. `render` supplies duration (3–600 seconds), width, height and `format`.
The actual creator duration limit may be lower. TikTok documents a larger file
limit; that does not enlarge this adapter's memory profile.

`interactionSettings` must explicitly contain boolean `allow_comment`,
`allow_duet` and `allow_stitch`. A disabled creator setting cannot be enabled.
Provider defaults are not substituted for user choices.

Zernio requires confirmation of preview and express consent. Preserve truthful
provider-specific evidence, separate from acceptance of AI imperfections:

```js
{
  renderSha256, contentPreviewConfirmed: true, expressConsentGiven: true,
  evidenceSha256, recordedAt,
  previewWitness: 'owner', consentSource: 'owner_explicit'
}
```

The owner-preview variant above remains supported. A separately enabled delegated
variant represents an actual preview by an authorized agent acting under the
owner's standing publishing authority:

```js
{
  renderSha256, contentPreviewConfirmed: true, expressConsentGiven: true,
  evidenceSha256, recordedAt,
  previewWitness: 'authorized_agent',
  consentSource: 'owner_standing_authority',
  previewActorId: 'codex:<thread-uuid>',
  previewMethod: 'visual_playback',
  authorityEvidenceSha256
}
```

`evidenceSha256` identifies the real playback observation, while
`authorityEvidenceSha256` identifies the owner's explicit standing delegation.
The latter must equal `YTFUN_TIKTOK_STANDING_AUTHORITY_SHA256` in the publishing
process; an absent or different value blocks delegated recording/submission.
Historical records remain structurally readable when the opt-in is disabled.
The domain binds both variants to the native account, episode review and exact
render. Publication records preserve the witness/source and evidence digests;
private proof text and authority fields are not sent as post metadata.

The digest is compared with the actual submitted bytes. An editorial approval
with `renderWatched: false` does not establish this confirmation. Record actual
visual playback separately, including whether audio was heard. Never assert that
the owner watched, that the agent heard audio, or that playback occurred when it
did not. AI imperfections remain accepted; preview does not create an aesthetic
rejection or per-video human approval step.

Zernio's TikTok/OpenAPI documentation requires preview and express consent but
does not define this local witness field or explicitly waive preview for agents.
Its privacy policy documents assistants acting on the user's behalf, and its
MCP documentation supports autonomous agents. The delegated variant is an
interpretation of that documented agency under an explicit owner authorization,
not a claimed TikTok/Zernio exemption or permission to mark unobserved files.

The caller reserves a publication UUID before upload; that same UUID is the
`Idempotency-Key` and metadata correlation. The adapter obtains a presigned URL,
validates its HTTPS R2 storage host and exact pairing with the Zernio media key,
accepting a single-label storage host with the direct key or one bucket-path
prefix. A virtual-hosted `bucket.<32-hex-account>.r2.cloudflarestorage.com`
requires the direct key only; additional host labels or path prefixes are rejected.
It transfers via PUT without the API bearer token, then creates a single TikTok
target with `publishNow: true`. The request explicitly uses public visibility,
AI disclosure, `draft: false` and `isAdsOnly: false`. There is no Inbox/private
fallback or internal mutation retry.

## Receipts and reconciliation

The caller must persist each awaited `onReceipt` notification. Notifications
precede mutations, and a returned `providerPostId` is notified before status
lookup. Receipts contain only stable correlation/identity IDs, hashes, phase,
status and fixed diagnostic codes. Signed upload URLs, API keys, media URLs and
provider error bodies never appear in receipts.

```js
await adapter.status({ providerPostId, publicationId, renderSha256, postId });
```

`status()` performs GETs only. It verifies the exact provider post, correlation
metadata, sole TikTok target and current account. It then checks the public
TikTok page for the exact native UID, handle, post ID, public visibility and AI
label. A generic provider `published` state, unresolved URL, draft, other account,
removed target or unavailable public evidence remains unconfirmed. Creator quota
and the publishing feature flag do not prevent read-only reconciliation.

Unknown mutation outcomes retain their reservations. Provider idempotency has
a finite retention window and is not permission to blindly resend. If no post ID
was returned, retain the publication correlation and recover the original
provider result before considering any mutation. Do not migrate/reset historical
session REST attempts just because this new route is configured.

## Primary references

Consulted 2026-10-02; recheck when changing provider contracts:

- [TikTok publishing and creator information](https://docs.zernio.com/platforms/tiktok)
- [Account response contract](https://docs.zernio.com/accounts/list-accounts)
- [Media transfer](https://docs.zernio.com/guides/media-uploads)
- [Post creation](https://docs.zernio.com/posts/create-post)
- [Post reconciliation](https://docs.zernio.com/posts/get-post)
- [Idempotency](https://docs.zernio.com/guides/idempotency)
- [Public OpenAPI](https://zernio.com/openapi.yaml)
- [Assistant agency and account-wide authorization, sections 5.1–5.2](https://my.zernio.com/privacy-policy)
- [Autonomous agents with MCP](https://docs.zernio.com/mcp)

Tests live in `studio/test/tiktok-zernio.test.mjs`. Run them in GitHub Actions
only; no local tests on this Mac.
