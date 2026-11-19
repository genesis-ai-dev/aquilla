/** Fixed native return contract. No bearer credentials or arbitrary redirects. */
export function parseDesktopGoogleCallback(value: string): { state: string; code?: string; error?: string } | null {
  try {
    if (value.length > 512) return null
    const url = new URL(value)
    if (url.protocol !== "aquilla:" || url.hostname !== "auth" || url.pathname !== "/google" || url.port || url.username || url.password || url.search) return null
    const params = new URLSearchParams(url.hash.slice(1))
    if ([...params].length !== 2 || params.getAll("state").length !== 1) return null
    const state = params.get("state")!, code = params.get("code"), error = params.get("error")
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return null
    if (code && /^[a-f0-9]{64}$/.test(code)) return { state, code }
    if (error && ["cancelled", "invalid_request", "provider_failed"].includes(error)) return { state, error }
    return null
  } catch { return null }
}
