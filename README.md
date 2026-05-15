# ytfun

Legal-first orchestration for YouTube trend research and rights-gated video compilation.

This project intentionally avoids scraping, stream ripping, and automatic reuse of third-party videos. The MVP uses the official YouTube Data API for metadata discovery, then requires a human-reviewed rights manifest before any local media is compiled.

## What it does now

- Discovers candidate YouTube videos by topic through the official API.
- Scores candidates across trend strength, production complexity, and revenue potential.
- Produces an editorial shortlist.
- Drafts a commentary-first script outline.
- Audits a rights manifest before compilation.
- Compiles only local files listed in the approved manifest.

## What it does not do

- It does not download videos from YouTube.
- It does not scrape YouTube pages.
- It does not bypass Content ID, ads, age gates, geo gates, or player restrictions.
- It does not auto-publish without a future explicit approval gate.

## Setup

```bash
npm install
npm run build
```

For discovery:

```bash
export YOUTUBE_API_KEY="your_api_key"
npm start -- discover --scope examples/scope.json --out data/discoveries.json
```

## Workflow

First-party Shorts from our own original videos:

```bash
npm start -- shorts-from-original --config examples/first-party-cuts.json --out-dir data/shorts/example
```

This is the preferred MVP path. The source video is ours, `sourceOrigin` is effectively `likely_original_channel`, the default visual mode is `none`, and each Short is rendered as 9:16 with the original frame preserved over a blurred background.

End-to-end episode production:

```bash
npm start -- episode --config examples/episode.json --out-dir data/episodes/example
```

An episode manifest is the production unit for one original video. It combines the source video, Shorts cuts, thumbnail variants, upload metadata, and approval state. The command renders Shorts, generates automatic thumbnails, writes a rights manifest, creates a YouTube publish queue, and saves an `episode-output.json` report.

Publish queue for YouTube:

```bash
npm start -- youtube-auth --client-secret config/youtube-oauth-client.json --token data/youtube-token.json
npm start -- publish-queue --queue examples/youtube-publish-queue.json --out data/youtube-publish-results.json
```

`publish-queue` is a dry run unless you pass `--execute`. Uploads default to `private`, require `approvedBy`, and public uploads require the extra `--allow-public` flag.

Long-form thumbnail generation:

```bash
npm start -- thumbnail --config examples/thumbnail.json --out-dir data/thumbnails/example
```

The thumbnail generator extracts a real frame from the source video, crops it to 16:9, and adds only a translucent circular foreground glow centered near the lower-right corner. A short curiosity marker such as `???`/`WOW?` or a small set of casual emoji stickers via `effectEmojis` is optional. This keeps the thumb closer to the video itself and avoids poster clutter.

When `effectEmojis` is used, the CLI downloads the matching Google Noto Emoji SVG assets on demand and caches them under `data/cache/noto-emoji/`, which is ignored by git with the rest of `data/`.

For lower-lift thumbnail production, set `autoFrame`, `autoAccent`, and/or `autoEmojis` in the thumbnail config. `autoFrame` samples `candidateTimestamps` and picks the frame with the best blend of contrast, brightness, saturation, and visual energy. `autoAccent` derives the glow color from the selected frame. `autoEmojis` chooses a small emoji pack from the variant `context`.

YouTube currently recommends 16:9 custom thumbnails for regular videos and notes that Shorts do not accept uploaded custom thumbnails like regular videos; Shorts use a selected frame instead. This generator is for the original long-form videos that produce our Shorts.

1. Discover candidates:

```bash
npm start -- discover --scope examples/scope.json --out data/discoveries.json
```

2. Create a shortlist:

```bash
npm start -- shortlist --scope examples/scope.json --discoveries data/discoveries.json --out data/shortlist.json
```

3. Draft the commentary/script outline:

```bash
npm start -- draft-script --shortlist data/shortlist.json --out data/script.md
```

4. Audit rights before editing:

```bash
npm start -- audit-manifest --manifest examples/rights-manifest.json
```

5. Compile approved local assets:

```bash
npm start -- compile --manifest examples/rights-manifest.json --out data/final.mp4
```

`compile` requires `ffmpeg` on PATH and local files that you own, licensed, or reviewed with documented permission/rationale.
The project also includes `ffmpeg-static`, so the CLI can run without a system-level ffmpeg install.

## Demo video

Create a fully synthetic owned sample video:

```bash
npm start -- demo-video --out data/demo/ytfun-scoring-demo.mp4
```

This writes generated local assets, a rights manifest, an edit plan, and the final MP4 under `data/demo/`.

Create a more realistic vertical viral-fails/cassetadas case:

```bash
npm start -- viral-fails-demo --out data/cases/cassetadas-viral/cassetadas-viral-demo.mp4
```

This renders a two-minute synthetic compilation with animated scenes, social-video overlays, replay beats, and a generated soundtrack. It is still owned test footage, not downloaded YouTube content.

Create a real licensed-footage case from local Pexels source clips and Mixkit audio/SFX:

```bash
npm start -- real-case-demo --out data/cases/real-cassetadas/real-cassetadas-demo.mp4
```

The command expects the source clips in `data/cases/real-cassetadas/sources/` and audio assets in `data/cases/real-cassetadas/audio/`, then writes a vertical edit, rights manifest, and edit plan.
By default, this uses `--visuals none`: no text, no progress bar, no watermark, just the footage framing plus audio. Use `--visuals minimal` for the earlier captioned version.

## Scoring model

Every shortlisted candidate gets a `quality` block:

- `trendScore`: how strong the trend looks from views, view velocity, engagement, freshness, and topic match.
- `editorialLiftScore`: how much the team needs to "cook" the source into a usable original video; lower is better.
- `readyToEditScore`: the inverse of editorial lift; higher means the content is closer to usable with editing, voiceover, captions, or commentary.
- `productionComplexityScore`: how hard the video appears to be to produce; lower is better.
- `productionEaseScore`: the inverted complexity score used in the final calculation.
- `revenuePotentialScore`: monetization potential from niche value, brand-safety, sponsor fit, and demand signals.
- `finalScore`: weighted opportunity score.
- `verdict`: `greenlight`, `review`, or `skip`.

The verdict is a business/editorial verdict, not legal clearance. Rights review still happens later through the manifest audit.

Shortlisted candidates also get a `sourceOrigin` diagnostic. It identifies whether the video looks channel-original, UGC with credit, found-footage aggregation, licensed/permissioned, transformative commentary, or unknown. This does not block a candidate by itself; it tells the editor what provenance evidence to collect.

Default final score:

```text
final = trendScore * 0.45 + revenuePotentialScore * 0.35 + productionEaseScore * 0.20
```

You can tune weights, verdict thresholds, production keywords, and revenue terms in `examples/scope.json`.

Production complexity is intentionally format-sensitive: original animation, 3D, VFX, and motion-capture style work are scored as expensive formats, while edited commentary, reaction, recap, interview/podcast clips, screen recordings, and voiceover-led shorts are treated as more viable for an early content studio.

The rule of thumb is: the less the team has to cook the content, the more viable it is. A strong raw clip, credited UGC submission, podcast moment, screen recording, or already-clear viral moment can be easier to turn into a polished short than a blank-page animation or scripted production.

## Design principle

No clip enters because it is merely entertaining. A clip enters because it supports a specific editorial point in an original video.
