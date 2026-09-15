/**
 * changeset-review.ts — pure display/gating logic shared by the two
 * ChangesetCard variants (AQU-926). Kept out of the component files so the
 * cards stay fast-refreshable and the gating ladder is unit-testable without
 * rendering.
 */

import type { ChangesetItem } from "./run-state"
import type { ChangesetApproval, ChangesetApprovalSummary } from "./changeset-api"
import { ChangesetApiError } from "./changeset-api"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import { t as standaloneT } from "@/lib/i18n/standalone"
import { messageForStatus } from "@/lib/errors/user-error"
import { KIND_TIER } from "@/components/agent/cards/registry"

/** Server statuses after which a changeset can no longer be acted on.
 *  `superseded` (COMMAND-REGISTRY-P1 §1) is terminal like the rest — but it is
 *  the one HEALTHY member: the plan's end-state already exists because a
 *  person did the work by hand, so there is nothing left to approve. */
const TERMINAL_STATUSES = new Set([
  "committed",
  "discarded",
  "stale",
  "superseded",
  "expired",
])

export function isTerminalChangesetStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** Terminal statuses that are a good outcome rather than a failure — the plan
 *  landed (`committed`) or was already true (`superseded`). Never merge these
 *  into the `stale`/`expired` accounting: those two exist to warn, and a
 *  healthy row inflating them is exactly the signal loss P1 §1 forbids. */
const HEALTHY_STATUSES = new Set(["committed", "superseded"])

/** Status vocabulary for the card chip.
 *
 *  The shipped labels stay English literals: they are the legacy card's
 *  original hardcoded strings, matched verbatim by e2e/RTL selectors, and
 *  several of them ("Approved", "Expired") already exist as catalog values on
 *  other surfaces — keying them means reviewed `DUPLICATE_EXCEPTIONS` entries,
 *  which is an i18n-coverage pass of its own, not this change.
 *  `superseded` is new, so it goes through the catalog like every other new
 *  string here. */
export function changesetStatusLabel(
  t: TFunction,
  status: string,
  approvedLocally: boolean,
): string {
  switch (status) {
    case "committing":
      return "Applying"
    case "committed":
      return "Committed"
    case "discarded":
      return "Discarded"
    case "stale":
      return "Stale"
    case "superseded":
      return t("agent.changeset.statusSuperseded")
    case "expired":
      return "Expired"
    default:
      return approvedLocally ? "Approved" : "Pending review"
  }
}

export function changesetStatusVariant(
  status: string,
  approvedLocally: boolean,
): "default" | "secondary" | "outline" {
  if (HEALTHY_STATUSES.has(status) || approvedLocally) return "default"
  if (isTerminalChangesetStatus(status)) return "outline"
  return "secondary"
}

/** Extra chip classes that carry the status TONE, where the variant alone
 *  can't. Only `superseded` needs one today: it is a healthy end-state, so it
 *  must not read as a problem like `stale`, and it must not read as work this
 *  card did like `committed`. Emerald is the card's existing success colour
 *  (the commit receipt line uses it). */
export function changesetStatusBadgeClass(status: string): string {
  return status === "superseded"
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
    : ""
}

/**
 * AQU-820: the returned string is rendered verbatim, so it is always ours and
 * keyed — the server's `error.message` is untranslated and often a raw
 * diagnostic. The status alone distinguishes the three cases worth naming;
 * anything that isn't an HTTP failure (network drop, timeout) reads as a
 * connectivity problem.
 *
 * Shared by every review surface (the /approve/:id page and the AQU-841
 * approvals queue) so one changeset failure never reads two different ways.
 */
export function messageForChangesetError(err: unknown): string {
  if (!(err instanceof ChangesetApiError)) {
    return "Couldn't reach the server. Check your connection and try again."
  }
  if (err.status === 403) return standaloneT("error.changeset.notAuthorized")
  if (err.status === 404) return standaloneT("error.changeset.notFound")
  if (err.status === 409) return standaloneT("error.changeset.notApprovable")
  return messageForStatus(err.status, "", "changeset").message
}

/** Turn `translationsAdded` / `translations_added` into "Translations added". */
export function humanizeSummaryKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** The scalar `key: value` facts of a summary — everything that isn't one of
 *  the structured blocks a caller renders on its own (warnings, per-key
 *  settings previews, the per-kind event breakdown). */
export function summaryFactEntries(
  summary: ChangesetApprovalSummary,
): [string, string | number][] {
  const { warnings: _w, settingsChanges: _s, events: _e, ...facts } = summary
  return Object.entries(facts).filter(
    (entry): entry is [string, string | number] =>
      typeof entry[1] === "number" || typeof entry[1] === "string",
  )
}

/**
 * True when a staged changeset carries testimony-tier work.
 *
 * COMMAND-REGISTRY §5: testimony (validation, endorsement) needs a per-item
 * human click and is "exempt from accept-all" — so a bulk-approve surface must
 * be able to LEAVE these rows out rather than sweeping them up. The summary's
 * own `testimony` marks are authoritative (§2); `KIND_TIER` is the fallback for
 * summaries staged before the mark existed.
 *
 * A summary that itemizes no events answers `false`: bulk approval of an
 * un-itemized plan is the existing /approve/:id behaviour, and inventing a
 * testimony flag for it would block plans the gate never blocked.
 */
export function requiresPerItemConfirmation(summary: ChangesetApprovalSummary): boolean {
  return (summary.events ?? []).some(
    (ev) => ev.testimony === true || KIND_TIER[ev.kind] === "testimony",
  )
}

/** One testimony line the reviewer must individually confirm. */
export interface TestimonyEntry {
  key: string
  /** Technical identifier line (event/command kind, optionally × count) —
   *  rendered font-mono and untranslated, like ProposalCard's kind badges. */
  label: string
}

/**
 * Which lines need per-item confirmation before Approve & apply enables
 * (COMMAND-REGISTRY §5 — testimony is never bulk-approved). Summary marks are
 * authoritative (§2: `summary.events[].testimony`); the frame's tier/kinds are
 * the fallback for approval payloads that don't itemize events.
 */
export function testimonyEntriesFor(
  item: Pick<ChangesetItem, "summary" | "tier" | "kinds">,
  approval: ChangesetApproval | null,
): TestimonyEntry[] {
  const events = approval?.summary.events ?? []
  const marked = events.filter(
    (ev) => ev.testimony === true || KIND_TIER[ev.kind] === "testimony",
  )
  if (marked.length > 0) {
    return marked.map((ev) => ({ key: `event:${ev.kind}`, label: `${ev.kind} × ${ev.count}` }))
  }
  if (item.tier === "testimony") {
    // The whole changeset is testimony-tier: every itemizable line confirms.
    if (events.length > 0) {
      return events.map((ev) => ({ key: `event:${ev.kind}`, label: `${ev.kind} × ${ev.count}` }))
    }
    if (item.kinds && item.kinds.length > 0) {
      return item.kinds.map((kind) => ({ key: `kind:${kind}`, label: kind }))
    }
    return [{ key: "changeset", label: item.summary }]
  }
  // Not testimony-tier overall, but the frame may still name testimony kinds.
  return (item.kinds ?? [])
    .filter((kind) => KIND_TIER[kind] === "testimony")
    .map((kind) => ({ key: `kind:${kind}`, label: kind }))
}
