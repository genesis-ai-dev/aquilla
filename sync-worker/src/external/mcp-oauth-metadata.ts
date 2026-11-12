// OAuth discovery for the Agent API MCP server (ChatGPT plugin, Claude, Codex).
//
// An MCP client that connects without a token gets a 401 whose
// `WWW-Authenticate` header names this server's RFC 9728 protected-resource
// metadata. That document names the identity worker as the authorization
// server; the client then reads the identity worker's RFC 8414 metadata and
// runs the authorization-code + PKCE flow (auth-worker/src/routes/mcp-oauth.ts).
// The access token it receives is an ordinary `aqk_` API credential, so the
// MCP route validates it exactly like a pasted token.
//
// Two URL shapes reach the metadata, because the worker is mounted under a
// path prefix in deployed environments (`api.aquilla.app/sync/*`):
//
//   <base>/.well-known/oauth-protected-resource/api/v1/external/mcp
//     — under the /sync mount; this is the URL the 401 advertises, so it works
//       on the existing zone route.
//   <origin>/.well-known/oauth-protected-resource/sync/api/v1/external/mcp
//     — the RFC 9728 default location, for clients that skip the header. It
//       needs the `api.*.aquilla.app/.well-known/oauth-protected-resource/*`
//       zone route (wrangler.toml).

import type { ExternalEnv } from './types'

export const MCP_PATH = '/api/v1/external/mcp'
export const PROTECTED_RESOURCE_WELL_KNOWN = '/.well-known/oauth-protected-resource'

/** Autonomy modes double as OAuth scopes: `ask` stages work for a human to
 *  approve, `act` may commit. The consent page lets the human pick either. */
export const MCP_OAUTH_SCOPES = ['act'] as const

/** Strip a trailing slash so URL joins never double up. */
function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/** Public URL of this worker's root, including any mount prefix (`/sync`). */
export function publicBaseFrom(requestUrl: string, mountPrefix: string): string {
  return `${new URL(requestUrl).origin}${mountPrefix}`
}

/** The MCP endpoint as clients address it — the OAuth `resource` value. */
export function mcpResourceUrl(publicBase: string): string {
  return `${trimSlash(publicBase)}${MCP_PATH}`
}

/** The metadata URL the 401 advertises (served under the mount prefix). */
export function protectedResourceMetadataUrl(publicBase: string): string {
  return `${trimSlash(publicBase)}${PROTECTED_RESOURCE_WELL_KNOWN}${MCP_PATH}`
}

/** RFC 6750 §3 challenge. `resource_metadata` is RFC 9728 §5.1; `scope` tells
 *  the client what to request by default (the safe mode). */
export function mcpWwwAuthenticate(
  publicBase: string,
  error?: { code: 'invalid_token'; description: string },
): string {
  const parts = [
    `resource_metadata="${protectedResourceMetadataUrl(publicBase)}"`,
    'scope="act"',
  ]
  if (error) {
    parts.unshift(`error="${error.code}"`, `error_description="${error.description.replace(/"/g, "'")}"`)
  }
  return `Bearer ${parts.join(', ')}`
}

/** `api.aquilla.app` / `api.<env>.aquilla.app`: the shared API host, where a
 *  bare root path belongs to no single worker. */
function isZoneRoot(url: URL): boolean {
  return /^api(\.[a-z0-9-]+)?\.aquilla\.app$/.test(url.hostname)
}

/** The identity worker's public base, which is the OAuth issuer. */
export function authorizationServerIssuer(env: Pick<ExternalEnv, 'AUTH_WORKER_URL'>): string | null {
  return env.AUTH_WORKER_URL ? trimSlash(env.AUTH_WORKER_URL) : null
}

/**
 * Serve RFC 9728 protected-resource metadata for the MCP endpoint. Returns
 * null for any other path so the caller can keep routing.
 *
 * `request` is the prefix-stripped request; `mountPrefix` is what was stripped
 * ("" when the worker is reached directly).
 */
export function handleMcpProtectedResourceRequest(
  request: Request,
  env: Pick<ExternalEnv, 'AUTH_WORKER_URL'>,
  mountPrefix: string,
): Response | null {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(PROTECTED_RESOURCE_WELL_KNOWN)) return null
  const resourcePath = url.pathname.slice(PROTECTED_RESOURCE_WELL_KNOWN.length)

  // Under the mount: /.well-known/oauth-protected-resource/api/v1/external/mcp.
  // At the origin root (zone route, nothing stripped): the suffix carries the
  // mount itself, e.g. /sync/api/v1/external/mcp.
  // A bare /.well-known/oauth-protected-resource under the mount (or on a
  // direct worker URL) is unambiguous too: this worker serves one resource.
  let publicBase: string
  if (resourcePath === MCP_PATH || (resourcePath === '' && (mountPrefix !== '' || !isZoneRoot(url)))) {
    publicBase = publicBaseFrom(request.url, mountPrefix)
  } else if (mountPrefix === '' && resourcePath.endsWith(MCP_PATH)) {
    const prefix = resourcePath.slice(0, -MCP_PATH.length)
    if (!/^(\/[a-z0-9-]+)+$/.test(prefix)) return null
    publicBase = `${url.origin}${prefix}`
  } else {
    return null
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Response.json(
      { error: { code: 'validation_failed', message: 'protected-resource metadata is GET only' } },
      { status: 405, headers: { Allow: 'GET, HEAD' } },
    )
  }

  const issuer = authorizationServerIssuer(env)
  if (!issuer) {
    return Response.json(
      { error: { code: 'job_failed', message: 'AUTH_WORKER_URL not configured' } },
      { status: 500 },
    )
  }

  return Response.json(
    {
      resource: mcpResourceUrl(publicBase),
      authorization_servers: [issuer],
      scopes_supported: [...MCP_OAUTH_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Aquilla',
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  )
}
