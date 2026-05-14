// Resolve the post-login redirect target.
//
// Per AD-11 "launching context" rules, an app can hand off a return URL
// via `?return=<url>`. We accept ONLY:
//   - relative paths starting with `/` and not `//` (no protocol-relative)
//   - same-origin absolute URLs
//
// Anything else falls back to the default path. This prevents an open
// redirect into a third-party domain.

interface ResolveOptions {
  defaultPath: string
  /** Override window for tests. */
  windowImpl?: Window
}

export function resolveRedirect(opts: ResolveOptions): string {
  const w = opts.windowImpl ?? window
  const params = new URLSearchParams(w.location.search)
  const raw = params.get("return")
  if (!raw) return opts.defaultPath
  return sanitizeReturnUrl(raw, opts.defaultPath, w.location.origin)
}

export function sanitizeReturnUrl(
  raw: string,
  fallback: string,
  origin: string,
): string {
  if (!raw) return fallback
  // Reject protocol-relative (`//evil.com`) and any URL with a scheme that
  // isn't the current origin.
  if (raw.startsWith("//")) return fallback
  if (raw.startsWith("/")) return raw
  try {
    const url = new URL(raw, origin)
    if (url.origin !== origin) return fallback
    return url.pathname + url.search + url.hash
  } catch {
    return fallback
  }
}
