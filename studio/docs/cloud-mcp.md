# Authenticated cloud MCP and publisher migration

`src/mcp-http.mjs` supplies a stateless Streamable HTTP endpoint for persistent
ChatGPT conversations. This implements transport and resource authorization;
it does **not** establish a hosted server, link ChatGPT, migrate existing data,
approve a YouTube audit or add TikTok automatic publishing.

## Separate grants

1. The owner authorizes ChatGPT to use ytfun with a Cognito managed-login public
   OAuth client: authorization code + S256 PKCE, refresh token and resource binding.
2. ytfun retains the existing Hugging Face, YouTube and Facebook credentials on
   its private server. They never appear in MCP tool output, URLs, chats or Git.
3. A valid MCP token must have a trusted RS256 signature, exact issuer, the exact
   MCP URL in `aud`, an allowed `client_id`, an explicitly allowed owner `sub`,
   `token_use=access`, `iat`, `exp` and the requested scopes. An ID token, access
   token meant for another resource, or token for another owner cannot operate
   this single-owner studio. Missing or expired grants return a sanitized OAuth
   challenge. No anonymous fallback or shared static bearer secret is provided.

Scopes: `ytfun/read` for reads, `ytfun/write` for editorial/production operations,
`ytfun/publish` for official sends and delivery authorization/execution. The HTTP
endpoint requires read permission; tool handlers independently check their own
scope before touching the store/providers. Auth policies are exposed in tool
metadata. All state resources require an authenticated read grant.

Use a pre-registered public Cognito client with no client secret; configure the
**exact callback URL displayed by ChatGPT**, not an assumed callback. The Cognito
managed-login flow must receive `resource=<exact YTFUN_MCP_RESOURCE_URL>` to bind
the access token audience. Do not loosen audience checking to client-ID-only
when linking fails. No ID-token or M2M grant substitutes for the owner grant.

Primary references checked 2026-10-01:
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/build/app-quickstart
- https://learn.chatgpt.com/docs/extend/mcp
- https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html
- https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html

## Runtime contract

Install the locked `studio/` dependencies remotely with `pnpm install
--frozen-lockfile --ignore-scripts`. Launch `node src/mcp-http.mjs` with only
`YTFUN_PRIVATE_ENV_FILE=/absolute/private/ytfun.env` in the service environment.
The file must be an owned single-link regular file with mode0600, outside Git.
Set all `YTFUN_MCP_*` values in the private file using `.env.example` as the
non-secret specification. Never put provider keys in a startup command or service
logs. The service reads credentials; it does not shell-source the file.

Bind to loopback8788, with authenticated, stable HTTPS ingress. Requests are
bounded by the SDK JSON parser's100KiB limit; split large operations rather than
send unbounded payloads. Host and browser Origin are checked. `/health` reports
only transport type; OAuth discovery is public and studio data is protected.
The server shares one OAuth lifecycle/store across requests and never starts a
delivery worker per request. Set `YTFUN_DELIVERY_WORKER_ENABLED=false`: platform
conversations own sends. Store locking and Publisher preflight remain in force.
`ytfun_cloud_profile` reports configured account IDs and exact integration limits
without asserting a fresh platform login or a confirmed publication.

The current filesystem store requires one active host and a durable private
volume. Do not deploy multiple writable replicas, a serverless ephemeral directory
or an autoscaled copy. Original assets use relative stored paths, allowing the
whole verified directory to be moved without editing canonical JSON/hashes.
Remote rendering/inference remains remote; NEVER run tests on the owner's Mac.

## Transfer one publisher at a time

1. Finish CI at the exact deployment commit, prepare a private persistent host
   and authenticated HTTPS endpoint. Preserve receipts and unknown attempts.
2. Connect the cloud chats and call `ytfun_cloud_profile`/`ytfun_overview` read-only.
   A linked chat is not proof that its social publisher works.
3. Pause the corresponding local recurring automation, confirm its active run
   has stopped and reconcile in-flight deliveries. Stop old MCP writers before
   transferring the same YouTube grant to a separate canonical store.
4. Snapshot the canonical store and assets under its exclusive lock, with file
   hashes; transfer the snapshot and owned0600 environment privately. Import a
   validated byte-identical snapshot through store migration tooling, never by
   assembling/editing state JSON. Reject missing or changed source/render files.
   Copy no live lock, temporary partial file or browser credentials incidentally.
5. Verify the remote snapshot, account identity, current approval hashes, actual
   receipts and18h/max2rolling24 cadence. Resume mutations on only the new host.
6. Activate the matching cloud heartbeat only after its actual tool access and
   publisher path are verified; record the transition. Until then, preserve the
   single working local owner. Never enable both as a fallback race.

Moving a chat does not move a local Chrome profile. Facebook has an official API
publisher. YouTube OAuth works independently of the public-upload compliance
audit; keep the audit guard unless there is actual approval evidence. Its authorized
Studio fallback needs its own working browser session. TikTok currently exports a
package; its authorized normal Studio fallback also needs an authenticated browser
and actual receipt. Do not label those exports or a hosted MCP as automatic
TikTok posts. Kwai remains manual.

## Snapshot tooling

`node scripts/studio-snapshot.mjs export --source /private/current-store
--destination /private/new-snapshot` obtains the actual canonical writer lock,
copies verified assets/renders/captions and the unchanged state bytes, and returns
the state SHA256. It refuses an existing destination and preserves a live lock.
It changes no canonical JSON and carries existing receipts/unknown paid attempts.

After stopping the old writers, privately transfer the snapshot and use
`node scripts/studio-snapshot.mjs import --source /private/snapshot --destination
/private/new-store --expected-state-sha256 <recorded hash>`. Import verifies the
canonical hash, every required file, size, path and digest; missing, changed,
duplicate or symbolic sources fail closed. It never overwrites an existing store
and removes its own partial target on failure. Credentials are intentionally
outside this snapshot and require a separate private owned0600 transfer. A source
asset that is missing must be reconciled, never omitted to make migration pass.
