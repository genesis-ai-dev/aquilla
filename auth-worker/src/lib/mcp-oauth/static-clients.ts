// Pre-registered confidential OAuth clients. Zapier cannot publish a Client ID
// Metadata Document: it identifies itself with a static client_id + secret and
// a fixed redirect URI per app (docs/ZAPIER.md). Its tokens are bound to the
// external REST API, not MCP, and the consent page lets the human pick the
// autonomy mode and access level instead of the MCP hosts' fixed `act`.

import type { Env } from "../../types"
import type { ResolvedClient } from "./client-metadata"

type Bindings = Env

export interface StaticClient extends ResolvedClient {
  secret: string
}

/** The configured Zapier client, or null when this environment has none. */
export function zapierClient(
  env: Pick<Bindings, "ZAPIER_CLIENT_ID" | "ZAPIER_CLIENT_SECRET" | "ZAPIER_REDIRECT_URI">,
): StaticClient | null {
  const clientId = env.ZAPIER_CLIENT_ID?.trim()
  const secret = env.ZAPIER_CLIENT_SECRET?.trim()
  const redirect = env.ZAPIER_REDIRECT_URI?.trim()
  if (!clientId || !secret || !redirect) return null
  return { clientId, clientName: "Zapier", host: "zapier.com", redirectUris: [redirect], secret }
}

export function staticClientFor(
  env: Pick<Bindings, "ZAPIER_CLIENT_ID" | "ZAPIER_CLIENT_SECRET" | "ZAPIER_REDIRECT_URI">,
  clientId: string,
): StaticClient | null {
  const zapier = zapierClient(env)
  return zapier && zapier.clientId === clientId ? zapier : null
}

/** Constant-time over the SHA-256 digests, so length leaks nothing either. */
export async function secretMatches(presented: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ])
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}
