# Persistent delivery queue

The MCP can enqueue an already-reviewed episode for YouTube, Facebook, TikTok
and international Kwai. YouTube and Facebook use the implemented official API
publishers. TikTok and Kwai create reviewed publication packages and still need
creator publication. `completed` means the delivery operation returned a known
receipt; its `outcome` distinguishes uploaded, processing, scheduled, published
and exported. It never establishes monetization eligibility.

## Tools and worker

1. Inspect `ytfun_distribution_capabilities` and `ytfun_publish_plan`.
2. Enqueue with `ytfun_delivery_enqueue`, the exact `expectedReviewHash`,
   explicit privacy and `dueAt` such as `2026-10-02T12:00:00.000Z`.
   YouTube also requires an explicit `madeForKids` choice. Facebook uses public
   visibility. Creator exports use private package visibility; final privacy
   is selected in the platform's permitted posting flow.
3. `ytfun_delivery_run_due` previews the next due item with `execute=false`.
   `execute=true` performs one due operation. `ytfun_delivery_list` reads the
   durable records. `ytfun_delivery_cancel` cancels an unstarted task.
4. On a persistent MCP host, the operator can explicitly set
   `YTFUN_DELIVERY_WORKER_ENABLED=true`. The dispatcher checks every 30 seconds
   and handles one task at a time. The default is disabled. This change does
   not provision a server, install a daemon, create a recurring Codex task or
   configure account credentials. Production/inference are separate jobs.

The queue plans cadence at the requested due time and checks it again at actual
execution. Pending queue items do not reserve provider slots; if two queued
items collide, the first accepted upload reserves cadence and the next is
blocked. A queue timestamp is not a provider-confirmed release schedule.
YouTube native `publishAt` remains available through its existing publisher.
Changing actual upload time requires cancelling and enqueueing an unstarted
task. No scheduler guesses a new time after a cadence rejection.

Enqueueing binds the reviewed content hash, render hash, target platform and
account ID. Changes require a new review/task. Assets, provider permissions,
release enablement and actual account identity are checked again before upload.
Credentials remain in the host secret environment and are never saved in the
queue. The process must remain alive; a closed stdio host is not an autonomous
remote worker. Use a private durable filesystem with a single host as described
in the studio README.

## Interrupted outcomes

The worker durably claims `running` before invoking a publisher. There are no
automatic upload retries. Unknown outcomes and thrown delivery failures become
`attention`, and cannot be re-enqueued as another attempt. A process crash may
leave `running`, which blocks the dispatcher until operator reconciliation.
Local completion writes can retry contention; remote calls are not repeated.

If validation blocks the operation before the publisher is invoked, the task
records `phase=preflight`; it can be cancelled safely after inspecting the
blocker. For any possibly attempted delivery, first inspect provider receipts
and use the platform sync tool. Only then can `ytfun_delivery_reconcile` close
a running/attention task by linking its exact known receipt, recording operator
evidence and requiring confirmation that the original worker stopped. Each
publisher reservation carries the delivery ID, so older attempts cannot be
mistaken for the interrupted one. A stopped claim with no reservation can be
closed as cancelled without invoking a publisher; publishers reserve before
mutating provider media. This
tool never guesses success, resets unknown tasks or deletes provider media.
An unknown session without a receipt still requires provider/operator work.

Creating accounts, configuring OAuth apps, acquiring credentials, API approval,
worker deployment, a reviewed episode and confirmed publication are separate
states. No live publication or credential connection is part of the mocked CI
validation for this implementation.
