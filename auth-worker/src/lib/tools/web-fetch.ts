// aquilla.web.fetch, server side (apiRev 6). The extension's sandbox keeps
// `connect-src 'none'`; the host asks this worker to GET a URL on the
// extension's behalf. Everything a hostile extension (or a hostile site it
// points at) could abuse is checked here, not in the browser:
//
//   - https only, port 443, no userinfo; GET only; no cookies, credentials or
//     auth headers forwarded (a fixed, minimal header set).
//   - The host must be on the extension's declared + user-approved domain list
//     (and on the optional deployment-wide allowlist), re-checked on EVERY
//     redirect hop (redirect: "manual", at most MAX_REDIRECTS).
//   - SSRF: IP literals, local/internal names and any name that RESOLVES to a
//     private, loopback, link-local, CGNAT, multicast or reserved address are
//     refused (DNS over HTTPS, before each hop).
//   - 15 s timeout, 12 MB body cap (streamed, aborted past the cap), text/JSON
//     content types only.
// Pure apart from the injected fetch/resolve, so every rule is unit-tested.

import { blockedHostReason, hostAllowed, isIpLiteral } from "../../../../shared/tools/web-domains"

export const WEB_FETCH_TIMEOUT_MS = 15_000
// Aligned ULT books reach ~5.2 MB (JER); 12 MB covers every book with room to spare.
export const WEB_FETCH_MAX_BYTES = 12 * 1024 * 1024
export const WEB_FETCH_MAX_REDIRECTS = 3
/** Per user, per 15-minute window (auth_rate_limit_events). */
export const WEB_FETCH_MAX_PER_WINDOW = 300

export class WebFetchError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
    this.name = "WebFetchError"
  }
}

export type Resolver = (host: string) => Promise<string[]>

export interface WebFetchDeps {
  fetch: typeof fetch
  resolve: Resolver
}

export interface WebFetchResult {
  status: number
  contentType: string
  body: unknown
  /** The final URL after redirects. */
  url: string
  bytes: number
}

const TEXT_TYPES = /^(text\/[a-z0-9.+-]+|application\/(json|[a-z0-9.-]+\+json|xml|[a-z0-9.-]+\+xml|x-ndjson|tab-separated-values))$/i

// ── Address checks ────────────────────────────────────────────────────────

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip)
  if (n === null) return true
  return V4_BLOCKED.some(([base, bits]) => {
    const b = v4ToInt(base) as number
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return ((n & mask) >>> 0) === ((b & mask) >>> 0)
  })
}

/** Whether a resolved address is anything but public unicast. */
export function isPrivateAddress(ip: string): boolean {
  const a = ip.trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) return v4Blocked(a)
  if (!a.includes(":")) return true
  // IPv4-mapped / -compatible / NAT64 forms carry an IPv4 address at the end.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (tail && (a.startsWith("::ffff:") || a.startsWith("::") || a.startsWith("64:ff9b:"))) return v4Blocked(tail[1])
  // The same forms written in hex ("::ffff:a00:1", "64:ff9b::7f00:1"): refuse outright.
  if (a.startsWith("::") || a.startsWith("64:ff9b:")) return true
  if (a === "::" || a === "::1") return true
  const first = parseInt(a.split(":")[0] || "0", 16)
  if (Number.isNaN(first)) return true
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (first === 0x2001 && a.startsWith("2001:db8")) return true // documentation
  return false
}

/** DNS over HTTPS (Cloudflare's resolver): A + AAAA for one name. */
export function dohResolver(fetchImpl: typeof fetch): Resolver {
  return async (host) => {
    const ask = async (type: "A" | "AAAA") => {
      const res = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { Accept: "application/dns-json" },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new WebFetchError("dns_failed", `could not resolve ${host}`, 502)
      const body = (await res.json()) as { Answer?: { type: number; data: string }[] }
      return (body.Answer ?? []).filter((r) => r.type === 1 || r.type === 28).map((r) => r.data)
    }
    const [a, aaaa] = await Promise.all([ask("A"), ask("AAAA")])
    return [...a, ...aaaa]
  }
}

// ── URL checks ────────────────────────────────────────────────────────────

/** Parse and check one URL against the approved domains (no network). */
export function checkWebUrl(raw: string, domains: readonly string[], deploymentAllow: readonly string[] | null): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WebFetchError("invalid_url", "the URL is not valid")
  }
  if (url.protocol !== "https:") throw new WebFetchError("invalid_url", "only https URLs can be fetched")
  if (url.username || url.password) throw new WebFetchError("invalid_url", "URLs with credentials are not allowed")
  if (url.port && url.port !== "443") throw new WebFetchError("invalid_url", "only the default https port is allowed")
  const host = url.hostname.toLowerCase()
  const blocked = blockedHostReason(host)
  if (blocked) throw new WebFetchError("host_blocked", blocked, 403)
  if (!hostAllowed(host, domains)) throw new WebFetchError("host_not_allowed", `${host} is not one of the sites this extension may read (${domains.join(", ") || "none"})`, 403)
  if (deploymentAllow && !hostAllowed(host, deploymentAllow)) throw new WebFetchError("host_not_allowed", `${host} is not allowed on this Aquilla deployment`, 403)
  return url
}

async function assertPublic(host: string, resolve: Resolver): Promise<void> {
  if (isIpLiteral(host)) throw new WebFetchError("host_blocked", "IP addresses are not allowed", 403)
  const addrs = await resolve(host)
  if (addrs.length === 0) throw new WebFetchError("dns_failed", `${host} does not resolve`, 502)
  const bad = addrs.find(isPrivateAddress)
  if (bad) throw new WebFetchError("host_blocked", `${host} resolves to a private or reserved address`, 403)
}

async function readCapped(res: Response, cap: number): Promise<{ text: string; bytes: number }> {
  const declared = Number(res.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > cap) throw new WebFetchError("too_large", `the response is larger than ${cap / 1024 / 1024} MB`, 413)
  if (!res.body) return { text: "", bytes: 0 }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > cap) {
      await reader.cancel().catch(() => {})
      throw new WebFetchError("too_large", `the response is larger than ${cap / 1024 / 1024} MB`, 413)
    }
    chunks.push(value)
  }
  const all = new Uint8Array(bytes)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return { text: new TextDecoder().decode(all), bytes }
}

/** GET `raw` for an extension whose approved sites are `domains`. */
export async function proxyWebFetch(
  input: { url: string; as: "text" | "json"; domains: readonly string[]; deploymentAllow: readonly string[] | null },
  deps: WebFetchDeps,
): Promise<WebFetchResult> {
  let url = checkWebUrl(input.url, input.domains, input.deploymentAllow)
  const signal = AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS)
  for (let hop = 0; ; hop++) {
    await assertPublic(url.hostname, deps.resolve)
    let res: Response
    try {
      const doFetch = deps.fetch
      res = await doFetch(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        // A fixed header set: nothing of the user's (cookies, Authorization) ever leaves.
        headers: { Accept: "text/plain, text/*, application/json;q=0.9, */*;q=0.1", "User-Agent": "Aquilla-Extensions/1 (+https://aquilla.app)" },
      })
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) throw new WebFetchError("timeout", "the site took too long to answer", 504)
      console.warn("[tools/web-fetch] upstream error:", err instanceof Error ? `${err.name}: ${err.message}` : String(err))
      throw new WebFetchError("fetch_failed", "the site could not be reached", 502)
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= WEB_FETCH_MAX_REDIRECTS) throw new WebFetchError("too_many_redirects", "the site redirected too many times", 502)
      url = checkWebUrl(new URL(res.headers.get("location") as string, url).toString(), input.domains, input.deploymentAllow)
      continue
    }
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
    if (res.ok && !TEXT_TYPES.test(contentType)) {
      await res.body?.cancel().catch(() => {})
      throw new WebFetchError("unsupported_type", `only text and JSON can be fetched (got ${contentType || "no content type"})`, 415)
    }
    const { text, bytes } = await readCapped(res, WEB_FETCH_MAX_BYTES)
    let body: unknown = text
    if (input.as === "json" && res.ok) {
      try {
        body = JSON.parse(text)
      } catch {
        throw new WebFetchError("invalid_json", "the response is not valid JSON", 502)
      }
    }
    return { status: res.status, contentType, body, url: url.toString(), bytes }
  }
}

/** TOOLS_WEB_ALLOWED_DOMAINS: an optional deployment-wide allowlist (comma-separated,
 *  same syntax as manifest.web). Unset = any domain a user approves. The org-level
 *  allowlist this is the hook for would replace it with a per-org setting. */
export function deploymentAllowlist(value: string | undefined): string[] | null {
  const list = (value ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
  return list.length ? list : null
}
