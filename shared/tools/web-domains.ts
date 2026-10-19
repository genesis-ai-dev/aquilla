/**
 * Smart Extensions `read:web` (apiRev 6): which sites an extension may read
 * through the host's proxy (aquilla.web.fetch). The manifest declares the
 * domains; the user approves them; auth-worker fetches on the extension's
 * behalf after re-checking everything here. Shared so the manifest gate, the
 * SPA prompt and the worker apply the same rules.
 *
 * Wildcards: only a single leading "*." that covers subdomains of a domain
 * with at least two labels ("*.door43.org", never "*.org" or "*"). Real
 * resource hosts spread content over subdomains (a CDN or API host beside
 * the main site), and a site owner controls every subdomain of their own
 * domain, so the trust boundary the user approves is still one organisation.
 */

export const MAX_WEB_DOMAINS = 10

/** Host names that never leave the machine or the private network. */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp", ".test", ".invalid", ".example"]
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

export function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "")
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true
  if (h.includes(":")) return true
  // Integer / hex / octal IPv4 forms ("2130706433", "0x7f000001") resolve too.
  return /^(0x[0-9a-f]+|\d+)$/i.test(h)
}

/** Why a bare host name may never be fetched (null = fine). */
export function blockedHostReason(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, "")
  if (!h) return "empty host"
  if (isIpLiteral(h)) return "IP addresses are not allowed; use the site's domain name"
  if (h === "localhost" || BLOCKED_SUFFIXES.some((s) => h === s.slice(1) || h.endsWith(s))) return "local and internal hosts are not allowed"
  if (!h.includes(".")) return "single-label hosts are not allowed"
  return null
}

/** Validate one manifest domain entry ("git.door43.org" or "*.door43.org"). */
export function validateWebDomain(input: unknown): { ok: true; domain: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "a web domain must be a string" }
  const raw = input.trim().toLowerCase()
  const wildcard = raw.startsWith("*.")
  const host = wildcard ? raw.slice(2) : raw
  if (!host || /[^a-z0-9.-]/.test(host)) return { ok: false, error: `web domain ${JSON.stringify(input)} must be a plain host name (no scheme, port, path or wildcard other than a leading "*.")` }
  const labels = host.split(".")
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return { ok: false, error: `web domain ${JSON.stringify(input)} is not a valid host name` }
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return { ok: false, error: `web domain ${JSON.stringify(input)} must end in a real top-level domain` }
  const blocked = blockedHostReason(host)
  if (blocked) return { ok: false, error: `web domain ${JSON.stringify(input)}: ${blocked}` }
  if (wildcard && labels.length < 2) return { ok: false, error: `web domain ${JSON.stringify(input)}: a wildcard must cover a domain with at least two labels` }
  return { ok: true, domain: wildcard ? `*.${host}` : host }
}

/** Whether `host` is covered by the approved list (exact, or a subdomain of a "*." entry). */
export function hostAllowed(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "")
  return domains.some((d) => (d.startsWith("*.") ? h.endsWith(d.slice(1)) && h.length > d.length - 1 : h === d))
}
