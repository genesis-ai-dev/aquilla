// Same shape as apps/login/src/redirect.ts. Copied (not re-exported)
// because cross-app imports are forbidden by AD-11; the redirect helper
// will graduate to packages/api-client/ once a second cross-cutting
// helper makes that move worth a package boundary.

interface ResolveOptions {
  defaultPath: string
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
