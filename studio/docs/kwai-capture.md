# International Kwai endpoint evidence

AI Meow needs a verified route for automatically publishing to international
Kwai. The current MCP exports a publication package; that export does not post
anything. A request seen in the public profile, a successful login or a mainland
Kuaishou endpoint does not establish an international Kwai publishing contract.

This document defines the offline evidence step for an empirical integration.
The inspector makes no HTTP requests, performs no login, uploads no media and
does not change publisher capabilities. It is not a Kwai publisher.

## Capture scope

Observe only the authorized account and the actual official application's
workflow. Identify which interface performs the operation before choosing a
capture environment. Public-profile browsing alone provides no upload evidence.
Capture is a separate activity: this script neither controls Chrome nor
intercepts phone traffic. Do not install interception certificates, enable
device debugging or change account security as an implied step of running it.

Use a narrow capture window. Record the action being observed and its outcome
separately from the raw HAR. An upload or publication is a real external action
and must meet the episode's existing review, account and execution requirements.
Do not make a real post merely to exercise this inspector. No CAPTCHA bypass,
credential extraction, alternate-account access or stealth is part of this work.

HAR files can contain credentials, signed upload URLs, account identifiers and
private payloads even when browser export options omit some sensitive headers.
Keep raw captures only in a private temporary location with restricted access.
Never commit them or put them in `outputs/`, Desktop, the AI Meow media folder,
cloud-synced folders, issue attachments, chat messages or logs. Do not paste a raw
request as evidence. Delete the raw file after the needed private inspection.

## Offline inventory

From the repository root, use the exact hostnames already observed in that
capture. There is no implicit host or wildcard selection:

```sh
node studio/scripts/inspect-kwai-har.mjs /private/location/capture.har --host www.kwai.com
```

`www.kwai.com` is an example of selecting the known public host, not an asserted
upload endpoint. Additional observed Kwai/media hosts need their own repeated
`--host` option. The supported domain families are `kwai.com`, `kwai.net`,
`kwai-pro.com`, `kwaipros.com`, `cutmotions.com` and `kwaicdn.com`. The separate
host `kste.ksapisrv.com` is also permitted; the `ksapisrv.com` family and its
other hosts are not permitted. Selection still matches only the exact configured
hostname, including for the supported families. A newly observed family or
single host requires a reviewed change to the inspector before it can be
included. This list does not assert that any family implements publishing.

A mobile CONNECT capture observed destinations `az2-api-akpro.kwaipros.com`
and `kste.ksapisrv.com`. The Kwai APK's `networkSecurityConfig` also declares
`kwaipros.com`. These observations justify accepting those destinations for
explicit offline inspection. They do not prove a publication route or
unambiguous attribution of captured traffic to a specific app/account. CONNECT
destinations alone do not expose the HTTP routes, methods or payloads inside a
TLS connection; the inspector still requires the actual supported HTTP entries
in a HAR. No endpoint, request signature or publisher behavior is inferred from
these hostnames.

The command prints a JSON inventory to stdout only after the whole capture has
been parsed and validated. It never prints the input filename. Failure prints a
fixed error without request contents. The only reported observations are:

- Exact explicitly selected host and a path template using a fixed vocabulary.
- HTTP method, response status, known content types and HAR byte counts.
- Recognized request/query field names and counts of redacted names.
- Counts of identical observations and selected/excluded entries.

Opaque path segments become `:segment`, numeric segments become `:id`, and
recognized media filenames become `:file`. Field names outside the fixed
vocabulary are redacted, including names that could themselves carry a secret.
Headers, cookies, query values, payload values, response bodies, full URLs,
redirect URLs, timestamps and IP addresses are never emitted. MIME parameters
are stripped. Response JSON is not inspected. JSON request bodies larger than
128 KiB are not inspected; bounded traversal can omit deeper fields and marks
the observation accordingly. The report is deliberately incomplete.

Limits: a regular, non-symlink UTF-8 HAR file of at most 20 MiB, HAR version 1.1
or 1.2, at most 2,000 entries and 20 explicitly selected hosts. Selected requests
must use HTTPS without URL credentials or nonstandard ports. Malformed inputs
fail closed. No dependency installation is needed.

The script is an offline data-processing command, not a test runner. Its tests
are written under `studio/test/kwai-capture.test.mjs` and run only in GitHub
Actions; the machine owner forbids all local test executions. Local verification
of source changes is limited to cheap static checks such as `node --check` and
`git diff --check`.

## Evidence required before a publisher

An inventory can suggest candidate routes; it cannot prove their purpose or
make undocumented APIs stable. The sanitized report always sets
`provesPublication: false`. Before implementing a live publisher, document the
observed upload initialization, transfer and finalization sequence, account
identity checks, bounded authentication lifecycle, required AI disclosure,
privacy fields and the actual publication-status query. Specify the exact
allowed hosts and how secret values remain outside source and logs.

A successful transfer, an exported package and a confirmed published post are
separate states. A publisher must persist the receipt before another request,
bind it to the exact reviewed episode/account, and reconcile an ambiguous
outcome without replaying a possibly completed publication. The existing
delivery queue's cadence and crash-reconciliation contracts still apply.

If the official application never exposes a usable browser upload flow, a
browser-only capture cannot answer how phone publishing works. Choose and
authorize the required observation environment separately. If required signing,
attestation or account checks cannot be reproduced through a supported route,
report that limitation instead of fabricating a working API. Platform terms
and compatibility remain separate from technical endpoint discovery.
