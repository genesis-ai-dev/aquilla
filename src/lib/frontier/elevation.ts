import { notifyElevationRequired } from "@/lib/errors/elevation-required-signal"
import { isElevationRequiredBody, UserError } from "@/lib/errors/user-error"
import { loadActiveSession } from "./session-store"
import type { FrontierSession } from "./types"

/**
 * AQU-1322: call before the generic `if (!res.ok)` on any route the auth-worker
 * gates behind admin step-up (AQU-1322 part 2). On a 403 whose body says
 * "elevation required", raises the global step-up prompt and throws a UserError
 * carrying the raw body. Any other response is left untouched: the body is read
 * from a clone, so the caller can still consume `res`.
 */
export async function throwIfElevationRequired(res: Response, context?: string): Promise<void> {
  if (res.status !== 403) return
  const raw = await res.clone().text().catch(() => "")
  if (!isElevationRequiredBody(raw)) return
  notifyElevationRequired()
  throw new UserError(403, raw, context)
}

/**
 * AQU-1541: true for the UserError `throwIfElevationRequired` throws. Helpers
 * that swallow their own errors rethrow this one so the caller can show the
 * admin-code message instead of a generic failure.
 */
export function isElevationRequiredError(err: unknown): err is UserError {
  return err instanceof UserError && err.status === 403 && isElevationRequiredBody(err.raw)
}

/**
 * OPS-44: raise the step-up prompt for a request made with `jwt`, but only
 * while that JWT is the active session's. Elevation is bound to the session
 * token and the prompt verifies the ACTIVE one, so a 403 from the outbox's
 * background drain of another stored account must not open it: verifying
 * would elevate the wrong session. That account's work is retried when the
 * user switches to it. An unreadable session store raises the prompt anyway;
 * a redundant dialog is cheaper than a silent stall.
 */
export async function notifyElevationRequiredIfCurrent(
  jwt: string,
  readActive: () => Promise<FrontierSession | null> = loadActiveSession,
): Promise<void> {
  try {
    const active = await readActive()
    if (active?.jwt !== jwt) return
  } catch {
    // Fall through: staleness can't be proven.
  }
  notifyElevationRequired()
}
