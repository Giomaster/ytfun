# Context hygiene before commits

Adapted from DaKasa's diff-scoped context hygiene playbook. Start from changed
files, follow affected dependencies and contracts, and reuse valid evidence.

1. Inspect staged and unstaged paths, then review their diffs.
2. Check whether behavior invalidates instructions, README, environment examples,
   schemas, provider terms, resource names, state transitions or CI commands.
3. Verify referenced paths and links. Distinguish implemented behavior from
   roadmap and unverified operational state.
4. Inspect integration failure modes: concurrent writers, reservations, partial
   network outcomes, review hash invalidation and publication receipts.
5. Fix drift in the affected docs; do not invent conventions from guesses.
6. Run cheap static checks locally and obtain test verdicts in GitHub Actions.
7. Report the inspected scope and any unresolved limitation.

DaKasa-specific monorepo bootstrap, Go CLI generation, outbox, migration,
cluster/mobile gates and corporate identity are not copied into this standalone
Node project. Personal account binding and the owner's no-local-tests rule apply.
