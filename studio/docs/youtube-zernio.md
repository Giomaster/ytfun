# YouTube through Zernio

Giovanni authorized this provider for YouTube on 2026-10-02 after international
Kwai was absent from Zernio's documented integrations. This is a separate route;
it neither approves the owned Google OAuth application's upload audit nor changes
the Facebook or Kwai routes. It publishes immediately and PUBLIC only. It does not
schedule private preuploads, set monetization or create playlists.

`YouTubeZernio` is default off. Its fixed API is `https://zernio.com/api/v1`.
Configure the private `ZERNIO_API_KEY`, `ZERNIO_YOUTUBE_ACCOUNT_ID` and
`YTFUN_YOUTUBE_ZERNIO_PUBLISH_ENABLED=true`, alongside the native
`YOUTUBE_CHANNEL_ID` and `YOUTUBE_CHANNEL_HANDLE`. The provider account ID is not
a YouTube channel ID. Never expose the key or signed upload URLs in logs, Git,
MCP output or media metadata.

The constructor requires explicit binding evidence:

```js
new YouTubeZernio({
  env, fetchImpl,
  binding: {
    providerAccountId, nativeAccountId, handle,
    evidenceSha256, verifiedAt, source: 'owner_confirmed',
  },
  verifyPublishedVideo: async ({ videoId, channelId }) => ({
    confirmed, videoId, channelId, privacyStatus, uploadStatus,
  }),
});
```

`source` can alternatively be `authenticated_profile`. Evidence records the actual
connected authorized channel, not a guessed native-ID field. Zernio's SocialAccount
schema guarantees no native YouTube channel ID. Fresh GET `/accounts` must return
exactly one active matching provider account with the expected channel/handle URL.
GET `/accounts/{id}/health` must confirm a valid token and posting permission without
missing required scopes. Local readiness never asserts remote authorization.

The native verifier reads the exact video's observed YouTube Data API status and
channel ownership, using an authorized read connection. It must return
`confirmed:true`, matching video/channel IDs, `privacyStatus:'public'` and
`uploadStatus:'processed'`. A provider permalink can also point to an unlisted
video, so its existence alone is insufficient. Verifier failure preserves the
provider receipt and leaves processing unresolved; it never triggers another upload.

`upload({media, caption, title, madeForKids, render, publicationId, onReceipt})`
requires the stable publication UUID, MP4 duration 1–900 seconds, exact SHA256
(`render.sha256` or `render.renderSha256`), an explicit COPPA decision, title up to
100 characters and description up to 5,000. Optional `tags` respect YouTube's
100-character individual/500-character aggregate limits. The adapter supports
buffers up to 250 MiB as an operational transport bound, not a claim about YouTube's
256-GB maximum. The conservative 15-minute profile avoids assuming phone verification.

The mutation sequence is a sanitized persisted intent, POST `/media/presign`, PUT
to a validated R2 signed destination **without bearer authorization**, then one
POST `/posts`. The request has exactly one YouTube target, `publishNow:true`,
`visibility:'public'`, explicit `madeForKids`, `containsSyntheticMedia:true` and
entertainment category 24. Short classification comes from the real duration and
aspect ratio; no synthetic Short flag is sent. The publication UUID is the stable
`Idempotency-Key`; metadata binds the publication UUID and render digest.

Signed R2 targets accept both the documented single-label endpoint and the
Cloudflare virtual-hosted form `bucket.account-id.r2.cloudflarestorage.com`, with
a bounded DNS bucket label and a 32-hex account ID. Virtual-hosted targets require
the exact key as their path; path-style targets may include one bucket segment.
Both forms require HTTPS, one valid signature, and the exact matching public
object under `media.zernio.com`. Extra subdomains, credentials, fragments and
mismatched object paths are rejected before transfer.

`onReceipt` persists phases and the provider post ID as soon as received, including
HTTP 207 platform failures. No raw provider errors, API keys, public media storage
URLs or signed URLs appear in receipts. The adapter never automatically retries a
POST or PUT. Interrupted/unknown mutation outcomes keep their reservation and
require reconciliation rather than another request. Idempotency is a provider
duplicate safeguard, not authorization to replay uncertain mutations.

`status({providerPostId, publicationId, renderSha256})` is GET only. It requires the
exact account, target count, correlation metadata, public intent, no schedule/draft,
no removal marker, published platform state, exact native video ID/permalink and
an effective publication timestamp. Native public/processed ownership is then
observed before `confirmed:true`. Upload completion, generic provider `published`
or a missing permalink never declares public delivery.

The queue must keep native channel cadence, reservations and prior unknown attempts
across route changes. Migration applies only to unstarted queued deliveries through
domain APIs; it does not re-send existing videos. OAuth account selection and provider
connection approval are completed by the owner. For a Brand Account the Google
account chooser must select its Brand identity; Zernio documents no later channel
picker. YouTube Studio-only editor permissions do not imply API ownership.

Primary references consulted 2026-10-02:

- [Zernio YouTube platform, fields, scopes and ownership](https://docs.zernio.com/platforms/youtube)
- [Create post](https://docs.zernio.com/posts/create-post)
- [Get post](https://docs.zernio.com/posts/get-post)
- [Media uploads](https://docs.zernio.com/guides/media-uploads)
- [Cloudflare R2 virtual-hosted endpoints](https://developers.cloudflare.com/r2/platform/release-notes/)
- [Idempotency](https://docs.zernio.com/guides/idempotency)
- [Public OpenAPI schemas](https://zernio.com/openapi.yaml)

The fixture tests cover identity, visibility, exact correlation, secret handling,
unknown outcomes, failed 207 receipts and native verification. They run only in
GitHub Actions CI; no local tests are authorized on this Mac.
