const APP_FALLBACK = "/app"

/** Accept only same-origin SPA destinations and never recurse into login. */
export function safeLoginNext(raw: string | null | undefined, fallback = APP_FALLBACK): string {
  if (!raw || raw === "/" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return fallback
  }

  try {
    const base = "https://aquilla.invalid"
    const parsed = new URL(raw, base)
    if (parsed.origin !== base || parsed.pathname === "/login" || parsed.pathname.startsWith("/login/")) {
      return fallback
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return fallback
  }
}

export function loginPath({
  next,
  reauth = false,
  add = false,
}: {
  next?: string | null
  reauth?: boolean
  add?: boolean
} = {}): string {
  const params = new URLSearchParams()
  if (next) params.set("next", safeLoginNext(next))
  if (reauth) params.set("reauth", "1")
  if (add) params.set("add", "1")
  const query = params.toString()
  return query ? `/login?${query}` : "/login"
}
