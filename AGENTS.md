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

## AI Meow: policy and specific APIs

The sole editorial contract is studio/docs/ai-meow-operation.md. Read it for
media/release work; technical documents define only their specific API contracts.
Load the role's relevant state selectively. History is evidence, not authority.
Do not copy editorial decisions into other instructions or saved prompts.

Runtime records bind exact files, rights, provenance, costs, review hashes and
account/provider identity. Never fabricate consent, playback, audition or public
publication. Use Studio/Production/Publisher and transactional records, not manual
canonical-store edits. Recover unknown external operations by read-only evidence,
without blind retries, deleting reservations or migrating started deliveries.
Generation and heavy assembly are remote; tests are exclusively GitHub Actions.
Use fragment composition for independent packages; deriveShort and collection
workers retain their specialized contracts without defining editorial prerequisites.

AI Meow's current technical routes: Facebook Graph; TikTok/YouTube opted-in
Zernio; Kwai manual exports. Their specific contracts are in studio/docs/.
Keep credentials outside source/prompts/logs. Local sessions remain on this Mac;
cloud transport does not authorize migration or a second publishing writer.
Changes to active chat prompts, schedules or runtimes require the owner's explicit
request. Prepare and verify changes separately until that request is given.
