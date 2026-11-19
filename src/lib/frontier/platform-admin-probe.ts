import { getAdminMe } from "@/lib/frontier/admin"

/**
 * One shared "is this session a platform admin?" probe (AQU-2654).
 *
 * `usePlatformAdmin` is read by the org sidebar, the org switcher and the org
 * route gate, and every org page mounts its own sidebar — so each route change
 * used to send `GET /api/v2/admin/me` two to five times and commit once per
 * answer. The answer is a property of the session, not of the component that
 * asks: concurrent callers share one request, and a settled answer is reused
 * for a short while so moving between pages does not ask again.
 *
 * Keyed on the JWT, so a refreshed or switched session never reads the
 * previous one's answer. Failures are not kept. UX gate only — the worker
 * enforces the real boundary on every /api/v2/admin/* call.
 */
export const PLATFORM_ADMIN_TTL_MS = 60_000

let settled: { jwt: string; isAdmin: boolean; at: number } | null = null
let inFlight: { jwt: string; promise: Promise<boolean> } | null = null

/** The settled answer for this JWT, or undefined when it has to be asked. */
export function peekPlatformAdmin(jwt: string): boolean | undefined {
  if (!settled || settled.jwt !== jwt) return undefined
  if (Date.now() - settled.at >= PLATFORM_ADMIN_TTL_MS) return undefined
  return settled.isAdmin
}

export function probePlatformAdmin(jwt: string): Promise<boolean> {
  const known = peekPlatformAdmin(jwt)
  if (known !== undefined) return Promise.resolve(known)
  if (inFlight?.jwt === jwt) return inFlight.promise
  const entry = {
    jwt,
    promise: getAdminMe(jwt).then(
      (isAdmin) => {
        if (inFlight === entry) inFlight = null
        settled = { jwt, isAdmin, at: Date.now() }
        return isAdmin
      },
      (error: unknown) => {
        if (inFlight === entry) inFlight = null
        throw error
      },
    ),
  }
  inFlight = entry
  return entry.promise
}

/** Forget everything — tests, and anything that changes who is an admin. */
export function resetPlatformAdminProbe(): void {
  settled = null
  inFlight = null
}
