# Project Brief

## Product

`ytfun` is a semi-autonomous content studio for trend discovery, editorial planning, rights review, and local compilation of commentary-led videos.

## Legal-first constraints

- Use official YouTube APIs for discovery and metadata.
- Store source attribution and review notes for every selected clip.
- Require a rights basis before compilation.
- Keep human approval between shortlist, edit plan, and publish.
- Treat fair use as a review rationale, not a blanket permission.

## Pipeline

1. Scope definition: topics, queries, excluded terms, region, language, and scoring thresholds.
2. Discovery: YouTube Data API `search.list` plus `videos.list`.
3. Shortlist: score candidates across trend strength, production complexity, and revenue potential.
4. Script: generate a commentary-first outline.
5. Rights audit: validate each local asset and its evidence.
6. Compile: assemble only local approved assets.
7. Publish: future module, private-by-default, human-confirmed OAuth upload.

## Verdict model

The bot should decide from three business questions:

- Is it trending enough to deserve attention?
- Is it simple enough to create without burning the budget?
- Is it likely to be faturavel enough to pay for production and infrastructure?

The implementation stores these as `quality.trendScore`, `quality.productionComplexityScore`, and `quality.revenuePotentialScore`, then emits a `finalScore` and `verdict`.

Production complexity is format-aware. Original animation, 3D, VFX, motion capture, and Blender-heavy work are treated as high-complexity formats. Edited commentary, reactions, podcast clips, interview clips, screen recordings, recaps, rankings, and voiceover-led shorts are treated as more production-friendly formats.

Add a separate "editorial lift" lens: the less the team has to cook the content, the more viable it is. Low-lift candidates already have a clear moment, useful clip structure, usable context, or obvious commentary angle. High-lift candidates require heavy recreation, scripting, animation, investigation, or expensive post-production.

## Provenance model

Many successful channels work with clips, frames, UGC submissions, licensed footage, credited reposts, or commentary over found footage. The system should not assume every source video was created by the publishing channel.

For each candidate, store `sourceOrigin` as a diagnostic:

- `likely_original_channel`
- `likely_ugc_with_credit`
- `likely_found_footage_aggregation`
- `likely_licensed_or_permissioned`
- `likely_transformative_commentary`
- `unknown`

This is not a legal verdict. It is a triage layer that tells the editor what evidence to collect before using a clip.

## Near-term roadmap

- Add OAuth upload with a mandatory private default and approval record.
- Add creator permission intake templates.
- Add Creative Commons license checks from API metadata.
- Add an editorial dashboard.
- Add transcript/commentary generation once a model provider is selected.
- Add per-video claim/risk history after manual review.
