# Remote original-video production

`RemoteBatch` reserves explicitly selected 7.5-second scenes of a planned episode
before dispatch. The bounded packet binds the editorial hash, owned source video,
model, seeds, estimated costs and a 12-hour authorization window. It uses the same
spending reservations as interactive generation, so MCP cannot silently submit a
replacement for a scene with a pending outcome. Costs are estimates, never invoices.

The private compressed packet and inference-only HF token are GitHub repository
secrets. Only generic controller code and a launch containing batch ID, packet hash
and scene indices are committed. The launch path starts production on the owned
feature branch after CI review; no paid work runs for PRs or ordinary code pushes.

Each matrix job runs one HF Inference Providers request, at most four concurrently.
It verifies and extracts the first frame of the existing original video, creates no
new still image, and uploads immutable reservation and queue-receipt checkpoints
before submitting and polling. Output videos, reference frames and sanitized
receipts are retained as Actions artifacts. No tokens or personal account data are
included. Content artifacts in a public repository should be treated as accessible
to repository readers; they contain only original media intended for publication.

An interrupted or uncertain request keeps its charge barrier. Automatic job reruns
are rejected. Retrieve the existing provider request with `recoverFalVideo` through
the Hugging Face router; never submit again just because a worker timed out.
Before import, verify the Actions run and commit through GitHub, bind that identity
with `RemoteBatch.bindRun`, and pass the exact artifact to `RemoteBatch.accept`.
Import verifies batch, scene, source, reference, run, commit and MP4 hash before
committing a synthetic asset and completing the matching spending reservation.
It does not approve media or publish anything. Human-authorized editorial review,
remote assembly registration and platform publication remain separate stages.

A terminal owned Actions job can release an unsubmitted reservation only when the
verified provider step was skipped (`releaseUnsubmitted`). Failed or interrupted
provider steps cannot clear the charge barrier. Quality retakes require an exact
asset hash, observed rejection findings (`rejectAsset`) and changed direction via
`promptOverrides` plus `replaceRejectedAssetIds`. The original asset and charge
remain in the record; rejection never erases spending or implies a refund.

All tests run in GitHub Actions. Local media-production actions are not test runs,
but long rendering and batch generation belong on the remote worker.
