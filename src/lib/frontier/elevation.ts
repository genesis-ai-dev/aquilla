import { notifyElevationRequired } from "@/lib/errors/elevation-required-signal"
import { isElevationRequiredBody, UserError } from "@/lib/errors/user-error"

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
