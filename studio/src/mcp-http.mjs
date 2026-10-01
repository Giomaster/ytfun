#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createServer } from './mcp.mjs';
import { StudioStore } from './store.mjs';
import { YouTubeDataLifecycle } from './youtube-data.mjs';
import { cloudAuthConfiguration, createCloudTokenVerifier } from './mcp-auth.mjs';

export async function loadCloudEnvironment(filename, base = process.env) {
  if (typeof filename !== 'string' || !filename.startsWith('/')) throw new Error('A private absolute environment file is required.');
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 || (info.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('The environment file must be owned, single-link and mode 0600.');
    const body = await file.readFile('utf8');
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error('The environment file exceeds its size limit.');
    return { ...base, ...parseEnv(body), YTFUN_PRIVATE_ENV_FILE: filename };
  } finally { await file.close(); }
}

/** Stateless RPC transport, shared canonical store/OAuth lifecycle; single active host. */
export function createCloudApp({ env, config = cloudAuthConfiguration(env), verifier = createCloudTokenVerifier(config),
  store = new StudioStore(env.YTFUN_STUDIO_DIR), lifecycle = new YouTubeDataLifecycle(store, { env }),
  serverFactory = createServer } = {}) {
  if (!env?.YTFUN_STUDIO_DIR?.startsWith('/')) throw new Error('An absolute persistent YTFUN_STUDIO_DIR is required.');
  if (env.YTFUN_DELIVERY_WORKER_ENABLED === 'true') throw new Error('Cloud chats own sends; the background delivery worker must be disabled.');
  const app = createMcpExpressApp({ host: '127.0.0.1', allowedHosts: [config.resource.hostname, '127.0.0.1', 'localhost'] });
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.headers.origin && req.headers.origin !== config.resource.origin && req.headers.origin !== 'https://chatgpt.com') {
      res.status(403).json({ error: 'Origin is not allowed.' }); return;
    }
    next();
  });
  app.get('/health', (_req, res) => res.json({ service: 'ytfun', transport: 'streamable-http', authenticated: true }));
  app.use(mcpAuthMetadataRouter({ oauthMetadata: config.metadata, resourceServerUrl: config.resource,
    scopesSupported: config.metadata.scopes_supported, resourceName: 'AI Meow — private studio' }));
  const authenticate = requireBearerAuth({ verifier, requiredScopes: ['ytfun/read'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.resource) });
  app.all('/mcp', authenticate, async (req, res) => {
    if (req.method !== 'POST') { res.status(405).set('Allow', 'POST').json({ error: 'Stateless MCP requires POST.' }); return; }
    let server, transport;
    const cleanup = async () => {
      await Promise.allSettled([transport?.close(), server?.close()]);
    };
    res.once('close', cleanup);
    try {
      server = serverFactory({ directory: env.YTFUN_STUDIO_DIR, env, store, youtubeLifecycle: lifecycle,
        startBackgroundWorkers: false, remoteAuth: { authInfo: req.auth, resourceUrl: config.resource.href } });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'The studio operation could not complete. Reconcile state before retrying writes.' } });
      else if (!res.writableEnded) res.end();
      await cleanup();
    }
  });
  app.use((_error, _req, res, _next) => { if (!res.headersSent) res.status(400).json({ error: 'Invalid MCP request.' }); });
  return { app, lifecycle, store, config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const env = await loadCloudEnvironment(process.env.YTFUN_PRIVATE_ENV_FILE);
    const { app, lifecycle } = createCloudApp({ env });
    const port = Number(env.YTFUN_MCP_PORT ?? 8788);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid MCP port');
    const listener = app.listen(port, '127.0.0.1', () => {
      lifecycle.start();
      console.error('ytfun authenticated MCP is listening on loopback. HTTPS ingress and cloud linking remain separate.');
    });
    const stop = () => { lifecycle.stop(); listener.close(() => { process.exitCode = 0; }); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    listener.on('error', () => { lifecycle.stop(); console.error('ytfun MCP listener could not start.'); process.exitCode = 1; });
  } catch { console.error('ytfun cloud MCP could not start; check owned private environment, OAuth issuer/client/owner/resource and persistent store configuration.'); process.exitCode = 1; }
}
