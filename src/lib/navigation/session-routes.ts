const PUBLIC_EXACT_PATHS = new Set([
  "/login",
  "/reset-password",
  "/verify-email",
  "/privacy-policy",
  "/onboarding",
])

const PUBLIC_PREFIXES = [
  "/join/",
  "/join-org/",
  "/link/",
  "/approve/",
  "/__dev/",
  "/__marketing/",
]

/**
 * Session storage must settle before server-backed workspace routes render.
 * Public entry/recovery routes and the offline-capable project workspace must
 * never be held hostage by an unrelated IndexedDB session failure.
 */
export function isSessionHydrationRequiredPath(pathname: string): boolean {
  if (PUBLIC_EXACT_PATHS.has(pathname)) return false
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false
  if (pathname.startsWith("/project/")) return false
  return true
}
