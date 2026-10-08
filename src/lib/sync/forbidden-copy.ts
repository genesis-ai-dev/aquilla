// AQU-633: human-readable copy for sync-worker 403 refusals surfaced to the
// user, so a validate that flips-then-reverts explains WHY instead of leaving a
// bare "N failed" pill. The server reason strings are stable and come from:
//   - sync-worker/src/events/authorize.ts  (enforceScopes): `lane '…' not in
//     scope for …`, `file '…' not in scope for …`, `role too low for …`
//   - sync-worker/src/events/route.ts (AQU-1788, downgrade gate): `role
//     downgraded since token was issued`
//   - sync-worker/src/events/route.ts (FRO-189): `role too low to validate …`,
//     `user '…' is not in the project's validator allowlist`,
//     `self-validation is not allowed on this project`,
//     `validating an edit before it is saved is not allowed …` (AQU-1571)
//   - sync-worker/src/events/route.ts (AQU-490 / AQU-1571, recordings):
//     `role too low to validate audio …`, `… audio validator allowlist`,
//     `validating your own recording is not allowed on this project`,
//     `validating a recording before it is saved is not allowed …`,
//     `only a maintainer can remove another user's audio validation`
import type { ForbiddenEntry } from "./outbox-flush"

/** Map one server reason to friendly copy; falls back to the raw reason so a
 *  new/unmapped server message is still shown rather than swallowed. */
export function forbiddenReasonCopy(reason: string): string {
  const r = reason.toLowerCase()
  // SUB-8: copy is PAST tense — it describes why the server refused the change
  // AT THE TIME, not current project policy (settings may have changed since;
  // asserting "self-validation is off" after it was re-enabled reads as false).
  if (r.includes("not in scope")) {
    if (r.includes("file '")) return "the file was outside your assigned scope"
    // AQU-581 review: name the language. "The language lane" left people
    // guessing which one, and whether it meant the one on screen.
    const lane = /lane '([^']*)'/.exec(reason)?.[1]
    if (lane !== undefined) {
      return lane === ""
        ? "you weren't allowed to work in the main language at the time"
        : `you weren't allowed to work in ${lane} at the time`
    }
    return "it was outside your assigned files or lanes"
  }
  if (r.includes("self-validation is not allowed")) {
    return "validating your own translation wasn't allowed (self-validation was off for this project at the time)"
  }
  if (r.includes("edit before it is saved")) {
    return "the translation hadn't been saved yet, so who wrote it couldn't be checked"
  }
  // AQU-1571: the recording refusals used to reach the banner as the raw,
  // present-tense server string. They say "recording" because the translation
  // wording above would misname what was refused.
  if (r.includes("validating your own recording")) {
    return "validating your own recording wasn't allowed (self-validation of recordings was off for this project at the time)"
  }
  if (r.includes("recording before it is saved")) {
    return "the recording hadn't been saved yet, so who made it couldn't be checked"
  }
  if (r.includes("remove another user's audio validation")) {
    return "only a maintainer could remove someone else's validation"
  }
  if (r.includes("too low to validate") || r.includes("role too low for cell.validate") || r.includes("role too low for cell.unvalidate")) {
    return "your role wasn't allowed to validate on this project"
  }
  // AQU-581 review: an EDIT refused on role used to say "…allowed to
  // validate", which is not what the person was doing.
  if (r.includes("role too low for target.")) {
    return "your role wasn't allowed to edit translations on this project"
  }
  if (r.includes("role too low")) {
    return "your role wasn't allowed to make this change on this project"
  }
  if (r.includes("validator allowlist")) {
    return "you weren't on this project's validator allowlist"
  }
  // AQU-1788: the downgrade gate's reason is an internal statement about the
  // TOKEN, not about the member — the flusher now re-mints and retries once,
  // so the reason that reaches the banner is normally the ordinary role floor
  // or "membership revoked" instead. This only fires when the retry was
  // refused on the same grounds, and must still not read as jargon.
  if (r.includes("role downgraded since token was issued")) {
    return "your access level changed while you were working, so this change wasn't saved"
  }
  // AQU-1462: a caller who may not know the lane exists. The reason carries
  // no lane name, so this copy must not invent one.
  if (r.includes("lane does not exist")) {
    return "that lane does not exist"
  }
  // AQU-1462: `lane 'Spanish' is archived`. Past tense, like the other
  // refusals — the lane may have been restored since the server said no.
  // Only a caller who may know the lane hears this reason.
  const archived = /lane '([^']*)' is archived/i.exec(reason)
  if (archived) {
    const lane = archived[1] ?? ""
    return lane === "" ? "the lane was archived" : `the ${lane} lane was archived`
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
