// Says once, out loud, when a merged PR has waited HOLD_NUDGE_HOURS for a
// person. The release cut workflow runs it on the hour against the plan it
// just made and posts the line to the release channel.
//
// Why it exists. A held PR is listed on every cut's notes, and nobody reads
// the notes of a cut that did nothing: on 2026-11-19 the line had 47 merged
// PRs behind it, the oldest two days old, no release that day, and no signal
// anywhere but the run summary. HOLD_NUDGE_HOURS had been exported from
// release-plan.mjs since the planner was written and read by nothing.
//
// Stateless on purpose: a PR is named in the hour its wait crosses the
// limit and never again, so the channel gets one line per PR, not one per
// hour. The total and the oldest ride along on that line, which is what
// tells a reader whether this is one PR or a stopped line.
//
// Usage: node scripts/release-hold-nudge.mjs <plan.json> [--now=<iso>]
// Prints the message, or nothing when no PR crossed the limit this hour.
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { HOLD_NUDGE_HOURS, entryLabel } from "./release-plan.mjs"

const HOUR = 3_600_000

function age(hours) {
  return hours >= 48 ? `${Math.round(hours / 24)} d` : `${Math.round(hours)} h`
}

/**
 * The line to post for `plan` at `now`, or null. `windowHours` is how often
 * the caller runs: a PR is named when its wait is in [limit, limit + window).
 */
export function holdNudge(plan, now, { limitHours = HOLD_NUDGE_HOURS, windowHours = 1 } = {}) {
  const at = Date.parse(now)
  const waits = (plan.held ?? [])
    .filter((pr) => pr.mergedAt !== undefined)
    .map((pr) => ({ ...pr, hours: (at - Date.parse(pr.mergedAt)) / HOUR }))
    .filter((pr) => Number.isFinite(pr.hours))
  const crossed = waits.filter((pr) => pr.hours >= limitHours && pr.hours < limitHours + windowHours)
  if (!crossed.length) return null
  const over = waits.filter((pr) => pr.hours >= limitHours)
  const oldest = over.reduce((a, b) => (b.hours > a.hours ? b : a))
  const named = crossed.map((pr) => `${entryLabel(pr)} (${pr.why})`).join(", ")
  const total = over.length > crossed.length ? ` ${over.length} merged changes have now waited that long; the oldest is ${entryLabel(oldest)}, ${age(oldest.hours)}.` : ""
  return `⏳ Held ${limitHours} h, not in production: ${named}.${total} A green gate or the \`release:approved\` label puts a PR on the next cut; a direct commit waits for a person to pick it.`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [planPath] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
  const nowArg = process.argv.find((arg) => arg.startsWith("--now="))
  const plan = JSON.parse(readFileSync(planPath, "utf8"))
  const line = holdNudge(plan, nowArg ? nowArg.slice(6) : new Date().toISOString())
  if (line) console.log(line)
}
