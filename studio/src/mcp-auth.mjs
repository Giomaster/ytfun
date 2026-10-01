import { createRemoteJWKSet, jwtVerify } from 'jose';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export const MCP_SCOPES = Object.freeze(['ytfun/read', 'ytfun/write', 'ytfun/publish']);

function httpsUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTPS URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an absolute HTTPS URL without credentials, query or fragment.`);
  }
  return url;
}

/** The MCP grant is separate from all provider credentials. No anonymous mode. */
export function cloudAuthConfiguration(env) {
  const resource = httpsUrl(env.YTFUN_MCP_RESOURCE_URL, 'YTFUN_MCP_RESOURCE_URL');
  if (resource.pathname !== '/mcp') throw new Error('YTFUN_MCP_RESOURCE_URL must end in /mcp.');
  const issuer = httpsUrl(env.YTFUN_MCP_ISSUER, 'YTFUN_MCP_ISSUER').href.replace(/\/$/, '');
  const clients = (env.YTFUN_MCP_CLIENT_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const subjects = (env.YTFUN_MCP_OWNER_SUBJECTS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (!clients.length || !subjects.length || [...clients, ...subjects].some(x => !/^[A-Za-z0-9_-]{1,200}$/.test(x))) {
    throw new Error('Explicit OAuth client IDs and owner subject IDs are required.');
  }
  const authorizationEndpoint = httpsUrl(env.YTFUN_MCP_AUTHORIZATION_ENDPOINT, 'YTFUN_MCP_AUTHORIZATION_ENDPOINT').href;
  const tokenEndpoint = httpsUrl(env.YTFUN_MCP_TOKEN_ENDPOINT, 'YTFUN_MCP_TOKEN_ENDPOINT').href;
  const jwksUrl = new URL(`${issuer}/.well-known/jwks.json`);
  return { resource, issuer, clients, subjects, jwksUrl, metadata: {
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...MCP_SCOPES],
  } };
}

/** Cognito user access tokens must have RFC 8707 resource binding, not ID-token aud. */
export function createCloudTokenVerifier(config, { keySet = createRemoteJWKSet(config.jwksUrl, {
  timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
}) } = {}) {
  return { async verifyAccessToken(token) {
    try {
      if (typeof token !== 'string' || token.length > 16_384) throw new Error('Invalid token');
      const { payload } = await jwtVerify(token, keySet, {
        issuer: config.issuer, audience: config.resource.href, algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'client_id', 'scope', 'token_use'],
      });
      if (payload.token_use !== 'access' || !config.clients.includes(payload.client_id) ||
          !config.subjects.includes(payload.sub) || typeof payload.scope !== 'string' ||
          !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) || payload.iat > Date.now() / 1000 + 30) {
        throw new Error('Invalid token');
      }
      return { token, clientId: payload.client_id, scopes: payload.scope.split(' ').filter(Boolean),
        expiresAt: payload.exp, resource: config.resource, extra: { subject: payload.sub } };
    } catch {
      // Never return JWTs, JOSE/provider diagnostics, subjects or signing material.
      throw new InvalidTokenError('The MCP access grant is missing, expired or unauthorized.');
    }
  } };
}

export function requiredToolScope(name, { readOnly = false } = {}) {
  if (readOnly) return 'ytfun/read';
  if (['ytfun_youtube_publish', 'ytfun_facebook_publish', 'ytfun_delivery_enqueue', 'ytfun_delivery_run_due'].includes(name)) return 'ytfun/publish';
  return 'ytfun/write';
}

export function toolAuthorizationFailure(authInfo, scope, resourceUrl) {
  if (authInfo?.scopes?.includes(scope)) return null;
  const metadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', resourceUrl).href;
  return { isError: true, content: [{ type: 'text', text: 'This MCP grant does not authorize the requested operation.' }],
    _meta: { 'mcp/www_authenticate': [`Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${metadataUrl}"`] } };
}
