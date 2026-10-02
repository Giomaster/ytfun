# AGENTS.md — ytfun

## Scope and precedence

This standalone personal project inherits the machine owner rule: NEVER run any
local tests, benchmarks, mutation harnesses, smoke tests or test Docker stacks.
GitHub Actions is the test authority. Cheap static checks only: read code,
`git diff --check`, format checks and JSON/YAML parsing. Do not execute renders
or inference as validation on the laptop. Never delegate forbidden checks.
For a test-only hook use its documented skip, or `--no-verify` only when no
non-test gate exists; report the bypass. User instructions take precedence.

## AI Execution Policy

<!-- AI_EXECUTION_POLICY:BEGIN -->
Optimize total work to a verified result, including planning, coordination, retries
and human corrections. Plan both the solution and how to execute it.
Quality, required checks and authorization are constraints, not token-saving options.

- **Adaptive plan:** Establish the outcome, constraints and acceptance evidence.
  For nontrivial work, choose per-step model, reasoning effort, context package and
  budget, task size, tools, parallelism, validation and escalation conditions.
  Keep the overall direction, detail the next actionable steps and revise later
  steps from results. Simple tasks may proceed directly without separate planning
  artifacts or agents; planning overhead must earn its cost.
- **Model fit:** Choose from available models using remaining difficulty,
  uncertainty, failure impact and evidence of capability. Prefer a strong model
  when these are high or unknown. A detailed plan alone does not justify a weaker
  executor. Economical models are appropriate when they can satisfy the same
  acceptance criteria; do not enforce fixed planner/executor tiers.
- **Controls:** Within an authorized task, select suitable task-scoped models,
  effort and delegation through controls the runtime actually exposes. Honor
  explicit user restrictions. Do not change global defaults as a side effect or
  claim an unsupported switch. Context-window and compaction controls, when exposed,
  must respect actual model limits; otherwise manage the input package and task
  boundaries. A larger window does not replace durable decisions or ensure recall.
- **Context:** Give each step its objective, relevant code/contracts, dependencies,
  decisions and rationale, checks and escalation conditions. Search before broad
  reads; load applicable instructions and expand through relevant dependencies.
  Avoid loading unrelated maps, skills, logs or history. Reuse valid evidence;
  recheck volatile state and anything invalidated by edits. Budgets are estimates,
  not permission to omit necessary context or checks.
- **Tools:** Each call should resolve an uncertainty or advance the deliverable.
  Batch independent reads, filter noisy output and retain decisive errors and evidence.
  Truncated output is not full coverage. Do not repeat unchanged searches or green
  checks without a reason. Delegate only when allowed and a bounded independent
  task or distinct review justifies the extra context and coordination.
- **Feedback:** Return results, evidence, changed assumptions and unresolved issues
  from each step. Replan, expand context, split work or escalate capability when
  code contradicts the plan, a contract/architecture decision changes, impact grows
  beyond scope or attempts repeat without new evidence. Fix in-scope defects
  autonomously; ask only for materially missing decisions or authorization.
- **Validation:** Check failure modes and integration between completed parts, not
  just isolated outputs. Review the final diff for correctness, contracts, edge
  cases and unrelated edits. Preserve mandatory gates, fix findings and rerun
  affected checks. Never weaken tests, criteria or safety rules to hide a failure.
- **Boundaries:** Permission, ownership, release and production rules remain in
  force. Routine authorized reversible work needs no repeated approval; scope
  expansion or unapproved consequential actions require a user decision.
- **Continuity:** For long or interrupted work, retain a compact handoff with the
  objective, decisions, paths, evidence, unresolved issues and next action. Keep
  transient status out of durable instructions. Correct demonstrated instruction
  drift within scope; do not turn every mistake into another permanent rule.
- **Delivery:** Stop when acceptance criteria and required checks are satisfied and
  no unresolved in-scope defect remains. Report outcome, verification and material
  limitations concisely. Do not stop with required work pending to save tokens or
  continue speculative polishing. Claim token savings only from measured comparable
  tasks, including rework; label unavailable usage metrics as unavailable.
<!-- AI_EXECUTION_POLICY:END -->

## Portable general rules adapted from DaKasa

- Read the closest instructions and contracts before edits. Search first and
  load context along affected dependency edges. Reuse still-valid evidence.
- Before each commit, audit changed code, contracts, environment examples,
  instructions and docs using `.ai/playbooks/context-hygiene.md`.
- Preserve unrelated dirty work. Use an isolated checkout when scope conflicts.
- One intent per commit, English gitmoji subject, explain the reason when useful.
- Personal Git identity: Giomaster <giovanni.c.martins@gmail.com>. Never change
  global identity or add AI coauthorship. Keep signing and non-test hooks intact.
- New GitHub repositories are private and under Giomaster. This repository's
  existing visibility is not authorization to change it or expose private data.
- AWS calls use the personal profile explicitly, region us-east-1. Confirm
  account 701201544173 before sensitive actions. Never use DaKasa credentials.
  No infrastructure changes are implied by a content generation request.
- Never store credentials in source, generated media metadata, prompts or logs.
- Permission, financial cost, source rights, integration readiness, upload,
  scheduled publication and confirmed publication are separate states.
- Measure performance before optimizing in a suitable remote environment;
  record the workload and compare evidence. Do not infer speed from code alone.
- Inspect final diffs and CI at the actual PR head. Preserve gates and fix
  in-scope issues; never weaken a test to conceal a failure.
- Keep a compact handoff for unfinished work. Memory changes require a direct
  user request. Do not write transient status into durable project rules.

## Pilot-first media production

- For each new video concept, produce a low-cost pilot before investing in the
  final version. Prefer a cheaper, faster or lower-fidelity model; use short
  clips and lower resolution when they still let us assess the idea.
- Use the pilot to review the visual story, pacing, composition, character
  consistency and technical feasibility. Resolve problems in that pilot before
  spending more on higher-quality generation. A pilot is a production draft,
  not evidence that the final video has passed review or is ready to publish.
- After the pilot validates the direction, choose a stronger model when the
  expected improvement justifies its cost. A successful inexpensive result may
  be retained; a more expensive model is not a mandatory finishing step.
- Optimize the cost of approved, publishable content, including rejected attempts,
  reference images, generation, finishing and hosting. Price per call and model
  rankings alone do not establish good value. Choose the least expensive suitable
  route that meets the editorial criteria; do not lower those criteria to save money.
- The user delegates scripts within the agreed series to the agent. Prefer concepts
  with few relevant components, one readable action and a strong complete payoff
  that the selected model has demonstrated it can deliver. Reuse the economical
  validated route; do not chase model rankings or expensive upgrades without a
  concrete production defect and expected reduction in cost per approved release.
  Script autonomy does not expand account, spending or publication authorization.
- Define the visible acceptance criteria before generation: coherent action and
  object interactions, fluid motion, stable character/set identity, readable payoff
  and a complete ending. Validate one representative transition before financing
  the remaining sequence. Repeat a paid attempt only after identifying a concrete
  change in references, prompt, scene complexity or model that addresses the defect.
  Reuse approved material across long videos and complete shorts, and record the
  effective cost per approved output without assuming views or revenue.
- The user has a paid Hugging Face subscription and allows more expensive
  models with good value. Verify actual provider prices and subscription/credit
  coverage for the selected model; membership alone does not establish that an
  inference call is included. There is no fixed monthly budget by default.
- Record provider, model, prompts, available seeds/reference assets, commercial
  terms and estimated/actual costs for pilot and final versions. Preserve the
  validated direction when upgrading; model changes still require output review.
- Prefer external generation through the MCP and suitable remote providers or
  workers. Keep the conversation focused on direction and coordination. These
  rules govern media production; agent model selection follows the AI Execution
  Policy above, and the machine owner's prohibition on local tests still applies.
- AI Meow videos should communicate through images, motion and optional original
  nonverbal sound, without spoken language or on-screen text. Do not generate
  narration or subtitles for these videos unless the user changes this direction.
- For prompt-led pilots and retries, keep the cycle short: improve the video
  prompt, generate one clip and review the action. Honor an explicit request to
  skip still-image generation: use direct text-to-video when supported, or reuse
  an existing reference when the chosen image-to-video route needs it. Do not
  add new image generation or storyboards to that iteration. Review and record
  enough evidence to catch material failures without unrelated setup or polishing.

## Film direction before animation

- Apply these defaults across entertainment genres and formats, not only AI Meow's
  current scene. Establish each work's style/world bible: genre, tone, visual and
  sonic language, realistic physical grounding, impossible premises and any explicit
  creative exceptions. Scope exceptions to the relevant work/shot/behavior; an absurd
  premise is not permission for unrelated incoherence. Follow a clearly instructed
  exception without imposing the default it overrides. The intended contrast is
  inventive impossibility presented with convincing execution.
- Work as a film director before choosing a generation prompt. Use the shot sheet
  in `studio/docs/video-direction.md`: narrative purpose, initial/final states,
  camera and spatial geometry, materials, contacts and forces, ordered action,
  character performance, lighting/effects/sound, continuity and acceptance evidence.
  Define how the action happens; visual adjectives and a desired result are insufficient.
  Apply details relevant to the shot; do not invent interactions merely to fill the sheet.
- In every video, detail the relevant components deeply in each generation prompt,
  not only in the directing sheet. Identify the subjects/tools/objects that carry
  the action or payoff and specify their observable identity, shape/scale, material,
  position/orientation, initial/final states, contacts, movement and responses where
  applicable. Preserve their identity and geometry across frames and adjacent shots.
  Concentrate detail on those components while keeping the number of independently
  acting components small. Other elements may form scenery or a background that is
  easy to preserve frame by frame: stable appearance/layout and simple behavior,
  without incidental choreography or interactions. A background element that affects
  the action becomes relevant and needs its own direction; simplify or split the shot
  if its complexity exceeds the available controls. Depth of relevant detail does
  not require describing every decoration or adding more simultaneous actions.
- When using reference frames, design them from that choreography. Check camera, scale,
  identity, tool orientation, cutting plane and the positions of resulting parts.
  Every change needs a possible continuous path. Correct incompatible references
  before spending; do not hide the mismatch by adding instructions to the prompt.
  Approval of still images establishes appearance, not successful animation.
- Specify contact and material response: where a tool touches, which edge acts,
  resistance/deformation, how force affects speed, when rupture begins and how
  parts separate. Distinguish object orientation from direction of travel. Use
  unambiguous spatial descriptions and retain the original object's shape/identity.
- Make effects and acting consequences of the same action. Light, sparks, particles,
  sound and character reactions must have triggers, direction, intensity and timing.
  By default respect gravity, inertia, weight, friction, support, contact, material
  response and coherent force/light propagation. Apply a documented fictional
  departure consistently rather than silently changing the rules mid-action.
  Explosions, floating objects, transformations or disappearances may be deliberate
  storytelling choices; do not invent them as substitutes for the directed action.
- Direct the sensory experience deliberately: readable composition and silhouettes,
  satisfying rhythm/anticipation/payoff, tactile material detail, coherent lighting,
  and sound texture/dynamics synchronized with action. Choose cues appropriate to
  material, scale, genre and tone instead of adding sparks or loud effects everywhere.
  Language-free does not mean sound-free: original nonverbal effects, ambience and
  music may support the work when authorized and supported. Record sound plans even
  when the current silent renderer cannot implement them; do not claim audio exists.
- Whenever a video reveals an object's interior, make the interior more visually
  impressive than the exterior. The exterior builds anticipation; the opening must
  deliver the strongest visual payoff. Specify what is revealed and how contrast,
  luminosity, depth, material texture and motion make the reveal visibly stronger,
  with a clear held ending. "Wow" adjectives alone do not define the result. Keep
  the reveal focused on relevant components and preserve their material behavior:
  supported shells/fragments retain weight, molten liquids flow downhill and pool,
  and elastic stretching is used only for an intentionally elastic material.
  Visual spectacle never excuses spontaneous flight or an incoherent transformation.
- Plan beats at a complexity the selected model can deliver. Give a short shot
  one principal action with its causally linked development and reactions. Split
  independent choreography into additional shots with continuity and a complete
  final payoff. Preserve enough time for contact, transformation and settling;
  do not compress a whole multi-step sequence into a few seconds to reduce cost.
- Keep the full directing sheet separate from the model-specific prompt. Translate
  the relevant details into concrete observable actions in priority order, using
  supported controls/reference conditioning and a few critical exclusions.
  More words or exact timestamps do not guarantee obedience. Resolve ambiguity,
  conflicting states and excess simultaneous actions rather than accumulating rules.
- Review the actual start, contact, transformation, reaction and ending. Check
  temporal order, stable geometry/identity, coherent forces, motion and effects,
  absence of invented mechanisms/text, and continuity with adjacent shots.
  Smooth playback or a beautiful final frame cannot compensate for an incoherent action.
- Diagnose before a paid retry. Record observed defects separately from hypotheses;
  verify source files/hashes/order, integration, supported controls and the model's
  conditioning behavior as well as the prompt/direction. Do not infer that improved
  frame cadence proves the model or transport obeyed the scene. Identify a concrete
  correction, its visual success criterion and cost before the next representative
  transition. Never finance the rest or publish a rejected attempt. Actual media
  review is production work; all software tests still run only in GitHub Actions.

## Long-form videos and standalone shorts

- Plan reusable complete narrative units that can support both standalone shorts
  and a coherent long-form work. During the initial audience-building stage,
  produce and release strong independent shorts first; a completed master is not
  a prerequisite. Outside that stage, balance long-form and shorts using measured
  audience results. Length serves the story, not a duration or clip-count target.
- Design several reusable narrative units before generating expensive assets.
  Each potential short needs its own visual hook, enough context to understand
  it, a clear development and an intentional ending. The long-form story must
  remain coherent and rewarding as a whole.
- Select clips at narrative boundaries instead of splitting the master into
  equal time chunks. Give each short a complete visual payoff, held reaction,
  resolved gag or deliberately constructed seamless loop. Preserve the frames
  and sound needed for the ending to land; do not stop mid-action or rely on the
  next clip to supply a missing conclusion. A continuation invitation may follow
  a satisfying ending without replacing it.
- Re-edit derived shorts when needed: tighten the opening, supply minimal visual
  context, adjust pacing, reframe for the target aspect ratio and build a natural
  ending. Account for both master and short-form framing during shot planning so
  the subject and action survive adaptation. Keep the language-free direction.
- Apply pilot-first production to this whole plan: validate the long-form
  structure and the intended short segments cheaply before upgrading generation.
  Reuse original approved assets where appropriate, while reviewing each final
  long video and each short as its own deliverable.
- Record each short's parent video, source scenes/time ranges and edit decisions.
  Give it distinct metadata, review and publication records, and schedule all
  formats through the same channel-wide cadence. Derive as many strong shorts as
  the story supports; quality and complete endings determine the count.

## Audience first and gradual releases

- In the current pre-monetization launch phase, prioritize the number of distinct
  worthwhile complete releases over total video duration. Use the shortest
  platform-supported duration that still delivers the hook, development and a
  satisfying ending. Do not pad a short to a revenue threshold or wait for a long
  master before releasing independently reviewed shorts. Preserve the long-form
  collection as planned source material/future packaging, not a launch prerequisite.
  Rebalance quantity and duration later using audience growth and measured results.
- The first AI Meow releases aim to earn attention, engagement and returning
  viewers. Use audience evidence to improve later formats. YouTube regular videos
  must already be planned for monetization from the first release; Shorts retain
  their audience-growth priority. Views alone are not proof of eligibility or income.
- Extract the maximum number of worthwhile, distinct, complete stories from the
  approved collection. Do not multiply near-identical uploads, arbitrary cuts,
  reordered duplicates or unfinished endings to inflate the queue.
- For this launch, test at least 18 hours between publications and at most two
  new publications in any rolling 24-hour window per channel. Count shorts,
  compilations, the master and reserved sends together. Never compensate for
  missed slots with a burst. Reassess after the first ten releases per channel.
  This is an editorial experiment, not a platform optimum or protection guarantee.
- Lead with the best reviewed standalone reveals, vary the material and payoff,
  and keep a dated queue with exact asset hashes, destinations and receipts.
  Review available retention, completion, shares, follows and returning-viewer
  signals before changing the mix or cadence. Report missing analytics honestly;
  never invent results or promise viral distribution.
- Before selecting a platform's production format and whenever strategy changes,
  research its current recommendation system, supported durations/formats and
  creator guidance. Use primary platform sources and the account's actual analytics
  when available. Record dated evidence, the hypothesis being tried, the production
  decision and a review point. Revisit after each initial launch cycle or material
  platform change. Focus on relevant viewers, opening clarity, completion, viewer
  satisfaction, shares and return visits; do not invent algorithm formulas or treat
  posting frequency as a guaranteed distribution trick.
- Maximum content means distinct engaging deliverables, not a faster sending rate.
  Apply the shared 18-hour/rolling-two-post limit even when production has a large
  backlog. Reuse source production efficiently, with complete endings and meaningful
  variation; algorithm research never replaces actual quality review.

## Autonomous recurring production and release

- Giovanni delegates recurring scripts, production, editorial decisions and release
  on AI Meow accounts to one persistent thread per platform. A due release starts
  the script/production/publication cycle; maintain this after the initial ten
  releases, rather than stopping after a finite export queue. Use existing original
  media efficiently where appropriate and share production between platforms.
- Do not ask for human review or blanket publication consent on every episode.
  During launch, accept small visual/sonic imperfections; prioritize completing
  readable original entertainment over repeated perfection retakes. The agent still
  reviews the actual output, verifies provenance/account and records exact hashes.
  No human validation does not authorize invented review evidence or facts. If audio
  cannot be heard, state that limitation and the user's accepted early-stage risk;
  do not attribute an audition to Giovanni or claim actual synchronization review.
- Automations check the actual last publication/reservation and current cadence
  before sending. One network's thread never posts to another network. Coordinate
  shared production and browser access so work/costs/uploads are not duplicated.
  A due check that runs late sends at most one item, without catch-up bursts.
- Use current primary platform guidance and real analytics to select scripts,
  formats and release hypotheses. No universal best cadence, distribution or income
  is guaranteed. Keep YouTube audit requirements and TikTok/Kwai export limitations
  distinct from actual publication. Never post to a personal account.
- The user intervenes through the MCP for maintenance or exceptional situations.
  Ask only for genuinely missing login/2FA or other required user actions, once;
  do not create an approval loop. Persist receipts and next eligible time, stay
  silent when unchanged, and report confirmed publications or new actionable faults.
- These local thread automations require the Mac/Codex to be available. Label
  operation times as local plans until a provider confirms a scheduled publication.
  Record missing runs and resume safely, without claiming continuous remote service.
- Cloud conversations use the authenticated HTTP contract in
  `studio/docs/cloud-mcp.md`. Keep provider credentials server-side and validate
  the MCP grant's signature, issuer, exact resource audience, owner, client and
  scopes. Only one host may write the filesystem store. Transfer a platform's
  ownership only after its old worker stops, receipts/data reconcile and its
  cloud connection and actual publishing route are verified. Hosting an MCP does
  not complete YouTube audit or TikTok publishing; never run duplicate publishers.

## YouTube regular videos: monetization from the outline

- Every YouTube regular video must be designed for future monetization from its
  first outline, even while the channel is building its audience. Shorts are the
  exception to this revenue-first format requirement. Never confuse planning a
  monetizable work with an approved YPP channel, enabled ads or confirmed revenue.
- Prefer a useful duration of at least eight minutes when the story supports it,
  so an eligible monetized video can support mid-rolls. The planned 12-minute
  collection remains future packaging, not a launch prerequisite. Never add
  repeated footage, static padding or unfinished
  scenes to reach an ad threshold. Eight minutes is a mid-roll condition, not a
  minimum for all monetization or an approval guarantee.
- Plan cohesive chapters, materially different reveals and a clear progression.
  Provide entertainment value and an identifiable creative direction throughout;
  changing only colors, titles or clip order is not a distinct work. Review the
  whole channel's repetition as well as each video's source ownership. Do not
  claim an AI-generated collection is monetization-safe simply because it is original.
- Mark potential ad breaks only at completed reveals or chapter transitions,
  with a natural visual/audio pause. Never interrupt a cut or unresolved payoff.
  Verify channel eligibility and actual Studio settings before reporting ads enabled.
- Classify the actual YouTube upload correctly: current vertical or square videos
  up to three minutes are Shorts. The planned vertical 90-second compilations are
  therefore Shorts on YouTube, not regular videos with mid-rolls.
- Primary policy references, verified 2026-10-01:
  https://support.google.com/youtube/answer/6175006?hl=en (mid-rolls),
  https://support.google.com/youtube/answer/1311392?hl=en (originality and repetition),
  https://support.google.com/youtube/answer/15424877?hl=en-GB (Shorts classification).
  Recheck live policies and account evidence before consequential release changes.

## Studio contracts

- Every AI Meow delivery must target public visibility. Do not upload privately
  or unlisted, including audit demonstrations, as a fallback for a blocked public
  release. A blocked release stays pending; report the actual blocker. A provider
  queue or upload receipt is not a public publication: verify the final account,
  public visibility and processing before recording success. Preserve valid public
  scheduling and cadence; a planned future release is still pending until confirmed.
- YouTube and TikTok deliveries must use the owned API integration. Do not publish
  through Chrome/Studio as a fallback. Browser access for account authorization or
  protocol observation is distinct from publishing. Preserve captured REST evidence;
  endpoint names alone do not establish an authenticated working publisher.
- The authorized TikTok session REST experiment uses private cookies outside Git.
  Obtain fresh scoped upload credentials through the live session; persist legitimate
  cookie rotation privately. If session renewal is unavailable, request a new private
  cookie capture only when expired/revoked. Stop on challenges and uncertain mutations;
  never invent a login/refresh endpoint or repeat an unknown post. This is separate
  from audited official OAuth/Direct Post; follow `studio/docs/tiktok-session-rest.md`.
- `studio/` is an independent Node ESM MCP package; legacy CLI remains intact.
- `studio/README.md` describes the executable contracts and setup.
- Projects and all source media are original and synthetic. Trend sources are
  research metadata, never a permission to download or reuse source footage.
- Model/provider commercial terms and inputs must have recorded evidence.
  "AI-generated" or a Hugging Face listing alone does not prove reuse rights.
- Apply the pilot-first rule to generation costs. Prefer free usage or included
  credits when suitable; paid generation is allowed when its value is justified
  within the user's authorization. Reserve each generation and record its
  estimate/source before an external call; acknowledge paid costs per call and
  honor runtime/provider gates. Never assert a zero estimate is a bill.
- Approval is bound to content hashes and an actual review. Never fabricate
  watching a render, checking facts, or human consent.
- Cadence is calculated over channel-wide publication events and reservations,
  across projects. Editorial limits are hypotheses, not platform guarantees.
- Unknown upload outcomes need reconciliation; never retry them blindly.
- YouTube synthetic disclosure is always set. Audit and release flags apply
  to every externally visible upload including scheduled release.
- Facebook targets an explicitly authorized Page through official APIs,
  requests AI disclosure, and confirms ownership and processing before
  declaring publication. Creating a browser profile/Page does not authorize API access.
- Private TikTok self-posting MCP utilities do not satisfy Direct Post guidance.
  Export a publication package; adding a publisher needs a permitted integration
  and the required preview, privacy selection and consent experience.
- International Kwai uses creator export until a permitted publishing API is
  verified for that product/account; mainland Kuaishou access proves neither.
- Delivery queue timestamps are planned operation times, not guaranteed
  provider schedules. Recheck exact review/account/cadence at execution.
  Interrupted tasks require their own receipt or a stopped unreserved claim;
  never reconcile against an older attempt or retry an unknown remote outcome.
