// AQU-633: human-readable copy for sync-worker 403 refusals surfaced to the
// user, so a validate that flips-then-reverts explains WHY instead of leaving a
// bare "N failed" pill. The server reason strings are stable and come from:
//   - sync-worker/src/events/authorize.ts  (enforceScopes): `lane '…' not in
//     scope for …`, `file '…' not in scope for …`, `role too low for …`
//   - sync-worker/src/events/route.ts (FRO-189): `role too low to validate …`,
//     `user '…' is not in the project's validator allowlist`,
//     `self-validation is not allowed on this project`
import type { ForbiddenEntry } from "./outbox-flush"

/** Map one server reason to friendly copy; falls back to the raw reason so a
 *  new/unmapped server message is still shown rather than swallowed. */
export function forbiddenReasonCopy(reason: string): string {
  const r = reason.toLowerCase()
  if (r.includes("not in scope")) {
    if (r.includes("file '")) return "this file isn't in your assigned scope"
    if (r.includes("lane '")) return "this language lane isn't in your assigned scope"
    return "it's outside your assigned files or lanes"
  }
  if (r.includes("self-validation is not allowed")) {
    return "you can't validate a cell you translated (self-validation is off for this project)"
  }
  if (r.includes("too low to validate") || r.includes("role too low")) {
    return "your role can't validate on this project"
  }
  if (r.includes("validator allowlist")) {
    return "you're not on this project's validator allowlist"
  }
  return reason
}

/** One-line banner summary for a batch of forbidden entries. Reports the
 *  dominant reason + count so the user sees the WHY at the point of action. */
export function forbiddenBannerMessage(entries: ForbiddenEntry[]): string {
  if (entries.length === 0) return ""
  const counts = new Map<string, number>()
  for (const e of entries) {
    const copy = forbiddenReasonCopy(e.reason)
    counts.set(copy, (counts.get(copy) ?? 0) + 1)
  }
  const [dominant] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  const n = entries.length
  const noun = n === 1 ? "change wasn't saved" : "changes weren't saved"
  return `${n} ${noun} — ${dominant}.`
}
