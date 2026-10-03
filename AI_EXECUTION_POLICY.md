# Reusable AI execution policy

Use the block below in a project's `AGENTS.md`; point `CLAUDE.md` to that local
section. Keep repository-specific contracts, validation commands and permissions
outside the block. Independent repositories carry the block locally so a fresh
clone does not depend on this workspace. Keep these copies identical when changing
the policy. Apply an already-loaded copy once; do not reread identical guidance.

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

The policy authorizes adaptive task-scoped choices within the user's request;
the client or runtime must provide the actual controls. It does not add a model
router, guarantee correctness or enlarge a model's real context window. Verify
the effective settings when relevant. New sessions should load the updated
instructions; existing sessions may need to read them explicitly.

Evaluate this policy with comparable tasks: acceptance success, user corrections,
regressions, elapsed time and total available token usage. A shorter answer alone
is not evidence of lower total cost. No benchmark or recurring monitor is required
for ordinary tasks.
