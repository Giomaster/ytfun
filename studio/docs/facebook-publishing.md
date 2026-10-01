# Facebook Page Reels delivery

Evidence checked on **2026-10-01**. This adapter publishes original, reviewed
MP4 Reels to one explicitly configured Facebook **Page** through Meta's API.
Creating a Page in the browser does not create a Meta developer app, grant OAuth
permissions, or enroll the Page in monetization.

## Operator setup

Keep credentials in the runtime secret environment, never in source, publication
records, exported packages, prompts, or logs.

| Variable | Meaning |
| --- | --- |
| `FACEBOOK_PAGE_ID` | Numeric ID of the intended AI Meow Page. |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | OAuth token that acts as that Page. A personal User token is insufficient. |
| `FACEBOOK_GRAPH_API_VERSION` | Explicit supported version such as `v26.0`; no implicit latest version. Verify the selected version against the app dashboard. |
| `YTFUN_FACEBOOK_PUBLISH_ENABLED` | Must be exactly `true` to submit a public Reel. |
| `YTFUN_FACEBOOK_APP_REVIEW_CONFIRMED` | Must be exactly `true` after the operator verifies the app's permissions, access level, and applicable review requirements. This flag is an attestation, not a remote verification. |
| `YTFUN_MAX_UPLOAD_BYTES` | Optional positive byte ceiling up to 250 MiB. Default: 250 MiB, a studio operational limit. |

Before enabling delivery, verify the relevant Page posting permissions in the
Meta dashboard: `pages_manage_posts`, `pages_read_engagement`, and
`pages_show_list` for discovering managed Pages/obtaining the Page token. The
authorizing person must have the Page content creation task. Confirm whether the
app's actual access model requires App Review, advanced access, business
verification or Live mode; a flag or successful identity lookup does not prove
any of these. The canonical [Pages setup guide](https://developers.facebook.com/docs/pages-api/getting-started/)
and [permission reference](https://developers.facebook.com/docs/permissions/)
returned HTTP 429 during this research, so activation requires reviewing them
in the operator's Meta app context.

`readiness()` is an offline configuration check. `verifyAccount()` performs
`GET /{version}/me?fields=id` and requires the returned ID to equal
`FACEBOOK_PAGE_ID`. It does not introspect the token's scopes or expiry.

## Delivery contract

```js
import { FacebookReels, validateFacebookReel } from './facebook.mjs';

const facebook = new FacebookReels({ env, fetchImpl });
const requirements = validateFacebookReel({
  durationSeconds: render.durationSeconds,
  width: 1080, height: 1920, framesPerSecond: 30, format: 'mp4',
});
// Publisher verifies the file/hash and current editorial approval, checks
// requirements, and durably reserves the account's cadence before this call.
const result = await facebook.upload({
  media: reviewedBuffer,
  caption: approvedCaption,
  synthetic: true,
  onReceipt: async (receipt) => persistReservedPublication(receipt),
});
```

The caller must pass render metadata obtained from its trusted render pipeline
to `validateFacebookReel`; it is a metadata check, not a decoder. The current
conservative delivery profile is **4–60 seconds**, exact **9:16**, at least
**540×960**, at least **23 fps**, and MP4. The studio's 1080×1920 at 30 fps
renderer meets this profile when the duration also qualifies. Longer studio
episodes need a separate reviewed cut. Meta's accessible official collection
states these dimensions and duration; its examples use old API versions. We do
not assume that changing limits in Facebook's consumer UI also change this API.
[Meta Reels collection](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api?entity=request-23987686-0b79260c-96bd-49de-875b-6076213785fc).

The adapter makes this fixed sequence:

1. Verify the Page identity, then initialize `/{page-id}/video_reels` with
   `upload_phase=start`.
2. Call `onReceipt` with the new `videoId` **before** sending media. Transfer the
   bytes to the exact returned `https://rupload.facebook.com/video-upload/{version}/{videoId}`
   path using `Authorization: OAuth`, `offset: 0`, and `file_size`.
3. Persist the accepted transfer, then finish the same Page edge with
   `video_state=PUBLISHED`, the approved caption in `description`, and
   `is_ai_generated=true`. Persist accepted submission as `processing`.
4. Query status once; later reconciliation is a separate read-only call.

The finish operation starts encoding/publication. Its `success:true` does not
prove a visible publication. [Meta's official status request](https://www.postman.com/meta/facebook/request/dtugkus/3-optional-get-upload-session-status).

AI disclosure support is present in Meta's generated `Page.create_video_reel`
parameter contract, pinned to [SDK commit 788f363, dated 2026-08-25](https://github.com/facebook/facebook-python-business-sdk/blob/788f363d15b1269ab5efb7cd00fb5e3b133cd99b/facebook_business/adobjects/page.py).
The adapter always requests disclosure. This is not evidence that a particular
UI label has appeared; that still requires inspection of the finished Reel.

## Receipts and reconciliation

`upload()` returns a nonsecret receipt with `videoId` when known, `status`,
`phase`, `confirmed`, and fixed diagnostics when needed. The optional callback
is necessary in the Publisher integration for durable progress. A failed
callback stops subsequent mutations. No returned upload URL, token, caption or
raw provider body is persisted by the adapter.

`status({videoId})` verifies the current Page identity again, then reads
`id,status,from,published`. It requires matching video and owner IDs. The
generated [Meta Video object](https://github.com/facebook/facebook-python-business-sdk/blob/788f363d15b1269ab5efb7cd00fb5e3b133cd99b/facebook_business/adobjects/advideo.py)
lists these fields. Missing ownership or unfamiliar phases produce `unknown`.

| Receipt | Meaning |
| --- | --- |
| `uploaded` | Transfer accepted or upload complete; publication is not confirmed. |
| `processing` | A known phase is running, or publication submission has been accepted. |
| `published` | Owned video, all three phases complete, and `published:true`. |
| `failed` | Definite initialization rejection or a verified error phase. |
| `unknown` | Ambiguous remote outcome, incomplete evidence, or uncertain receipt persistence. |

The Publisher owns deduplication and durable reservations across processes. It
must treat `processing` and `unknown` as occupied reservations. It must preserve
previous confirmed state when a later read returns `unknown`, and never start a
new upload merely because a status read failed. An unknown session without a
video ID requires operator reconciliation against the Page.

This initial adapter has **no automatic POST retries**, scheduler, draft mode,
transfer resume, or automatic finish retry. Every call is bounded: 30 seconds
for Graph operations, 180 seconds for the media transfer, 64 KiB for response
JSON. Redirects are disabled. Returned upload URLs allow only the exact official
host/path matching the pinned version and issued video ID.

The canonical [Reels guide](https://developers.facebook.com/docs/video-api/guides/reels-publishing/)
and [Page Reel reference](https://developers.facebook.com/docs/graph-api/reference/page/video_reels/)
also returned HTTP 429. The implemented flow is supported by Meta's own
accessible collection and SDK; no account authorization, live upload,
publication, or monetization result has been claimed from mocked evidence.

## Validation

`studio/test/facebook.test.mjs` covers identity mismatch, unsafe upload targets,
receipt persistence before mutations, AI disclosure, duplicate-preventing
unknown outcomes, phase/ownership checks, malformed or oversized responses,
and input limits with mocked fetch only. Run it **only in GitHub Actions CI**.
No local tests, uploads, or media inference are part of this work.
