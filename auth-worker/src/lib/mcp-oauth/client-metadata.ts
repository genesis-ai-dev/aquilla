// OAuth Client ID Metadata Documents (CIMD) for MCP hosts.
//
// An MCP host identifies itself with an HTTPS URL as its client_id (ChatGPT
// uses https://chatgpt.com/oauth/client.json). The authorization server fetches
// that URL and trusts the redirect URIs it lists. This replaces dynamic client
// registration: nothing is stored, and the client's identity is the domain
// that serves the document — which is what the consent page shows the human.
//
// Spec: draft-ietf-oauth-client-id-metadata-document, adopted by the MCP
// authorization spec (2025-11-25) as the preferred registration mechanism.

/** Cap on the metadata document. The draft recommends a small limit; real
 *  documents are a few hundred bytes. */
const MAX_DOCUMENT_BYTES = 16 * 1024
const FETCH_TIMEOUT_MS = 5000
const MAX_CLIENT_NAME = 100

export interface ResolvedClient {
  clientId: string
  /** Self-declared display name. Never shown without `host`. */
  clientName: string
  /** Hostname that served the document — the verified part of the identity. */
  host: string
  redirectUris: string[]
}

export type ClientResult =
  | { ok: true; client: ResolvedClient }
  | { ok: false; error: "invalid_client"; description: string }

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>

function fail(description: string): ClientResult {
  return { ok: false, error: "invalid_client", description }
}

/** A client_id must be an HTTPS URL with a path, no fragment, no userinfo, and
 *  no dot segments (draft §3). */
export function isClientIdUrl(clientId: string): boolean {
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  if (url.username || url.password || url.hash) return false
  if (url.pathname === "/" || url.pathname === "") return false
  if (url.pathname.split("/").some((seg) => seg === "." || seg === "..")) return false
  // The parsed form must be the literal string: no normalisation games.
  return url.href === clientId
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

/** Redirect URIs must be absolute, fragment-free, and HTTPS (loopback http is
 *  allowed for desktop and CLI clients, per OAuth 2.1 §8.4.2). */
export function isAcceptableRedirectUri(value: unknown): value is string {
  if (typeof value !== "string") return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.hash) return false
  if (url.protocol === "https:") return true
  return url.protocol === "http:" && isLoopback(url.hostname)
}

async function readCapped(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "0")
  if (declared > MAX_DOCUMENT_BYTES) return null
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) return null
  return new TextDecoder().decode(bytes)
}

/**
 * Fetch and validate a client's metadata document. Redirects are refused (the
 * document must live at the client_id itself), the body is size-capped, and the
 * document must name itself.
 */
export async function resolveClient(clientId: string, fetcher: Fetcher = fetch): Promise<ClientResult> {
  if (!isClientIdUrl(clientId)) {
    return fail("client_id must be an https URL to a client metadata document")
  }
  let response: Response
  try {
    response = await fetcher(clientId, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "Aquilla-OAuth/1.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    return fail("client metadata document could not be fetched")
  }
  if (response.status !== 200) return fail(`client metadata document returned HTTP ${response.status}`)

  const text = await readCapped(response)
  if (text === null) return fail("client metadata document is too large")
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return fail("client metadata document is not JSON")
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return fail("client metadata document is not a JSON object")
  }
  const record = doc as Record<string, unknown>
  if (record.client_id !== clientId) return fail("client metadata document does not name this client_id")

  const redirectUris = record.redirect_uris
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(isAcceptableRedirectUri)) {
    return fail("client metadata document needs https redirect_uris")
  }

  const host = new URL(clientId).hostname
  const declaredName = typeof record.client_name === "string" ? record.client_name.trim() : ""
  return {
    ok: true,
    client: {
      clientId,
      clientName: (declaredName || host).slice(0, MAX_CLIENT_NAME),
      host,
      redirectUris: redirectUris as string[],
    },
  }
}
