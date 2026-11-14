// Google service-account access tokens for the Drive folder sync.
//
// The sync reads folders that a project lead SHARED with the service account,
// so it needs no user OAuth and no restricted `drive.readonly` user grant
// (which would need Google's app verification). The token is a JWT signed
// RS256 with the account's private key, exchanged at Google's token endpoint
// (RFC 7523). WebCrypto only — no Node APIs — so it runs in a Worker.

export interface ServiceAccountKey {
  client_email: string
  private_key: string
  token_uri?: string
}

const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'
/** Refresh this long before Google's expiry, so a token never dies mid-sync. */
const EXPIRY_MARGIN_MS = 60_000

/** Parse `GOOGLE_SERVICE_ACCOUNT_JSON`. Throws a message that names the secret. */
export function parseServiceAccountKey(raw: string | undefined): ServiceAccountKey {
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON')
  }
  const key = parsed as Partial<ServiceAccountKey>
  if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string') {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON needs client_email and private_key')
  }
  return { client_email: key.client_email, private_key: key.private_key, token_uri: key.token_uri }
}

function base64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  let binary = ''
  for (const b of data) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  const binary = atob(body)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out.buffer
}

/** The signed assertion Google exchanges for an access token. Exported for tests. */
export async function signServiceAccountJwt(key: ServiceAccountKey, nowSeconds: number): Promise<string> {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: DRIVE_READONLY_SCOPE,
      aud: key.token_uri ?? DEFAULT_TOKEN_URI,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  )
  const signingInput = `${header}.${claims}`
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(key.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput))
  return `${signingInput}.${base64url(new Uint8Array(signature))}`
}

const cache = new Map<string, { token: string; expiresAt: number }>()

/** A Drive read-only access token for the service account, cached per isolate. */
export async function serviceAccountAccessToken(
  key: ServiceAccountKey,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string> {
  const hit = cache.get(key.client_email)
  if (hit && hit.expiresAt - EXPIRY_MARGIN_MS > now()) return hit.token
  const assertion = await signServiceAccountJwt(key, Math.floor(now() / 1000))
  const response = await fetchFn(key.token_uri ?? DEFAULT_TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Google token exchange failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const body = (await response.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) throw new Error('Google token exchange returned no access_token')
  cache.set(key.client_email, { token: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 })
  return body.access_token
}

/** Test seam: forget cached tokens. */
export function resetServiceAccountTokenCacheForTests(): void {
  cache.clear()
}
