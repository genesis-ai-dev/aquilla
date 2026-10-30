// Where a hand-set milestone lands in a file's divisions. (AQU-2308)
//
// Kept out of `milestone-navigation.ts` on purpose: that module is the
// read-time derivation of divisions the FILE supplied (or the app invented),
// and it is already at its size budget. This module answers the one question
// hand-set milestones add on top — given the divisions a file already has,
// what does a named start→end range DO to them — and the dialog reuses the
// same answer to refuse a range before it is ever written.
//
// Two placements, and which one applies is read off the divisions the range
// covers rather than chosen by the person setting it:
//
//   * **replace** — every division under the range is one the APP invented
//     ("Part N", a 5-minute bucket, an AI section). The app made those up
//     because the file offered nothing; a person naming that stretch is
//     strictly better information, so the hand-set milestone takes their
//     place and becomes a top-level entry. This is the "Part 1 · The storm ·
//     Part 2" result.
//   * **nest** — the range lies wholly inside ONE division the file supplied
//     (a Scripture chapter, a heading section, a slide, an IDML story). That
//     division is real structure from the document and is never moved,
//     renamed, removed, or re-counted; the milestone shows as a named
//     sub-entry under it, in the nested-row style long IDML stories use.
//
// Anything else — a range crossing a boundary the file supplied — is refused
// by the dialog, and skipped here if it reaches the store another way.

import type { FileMilestone, ResolvedMilestoneSpan } from "../../../db/shared/file-milestones"
import { resolveMilestoneSpans } from "../../../db/shared/file-milestones"
import type { ImportMilestone, ImportMilestoneKind } from "../../../shared/import-contract"

/** Divisions the app made up because the file offered none. */
export function isAppInventedMilestoneKind(kind: ImportMilestoneKind | undefined): boolean {
  return kind === "part" || kind === "time-range" || kind === "ai-section"
}

export type UserMilestonePlacement =
  | {
    mode: "replace"
    milestone: ImportMilestone
    record: FileMilestone
    startIndex: number
    endIndex: number
  }
  | {
    mode: "nest"
    milestone: ImportMilestone
    record: FileMilestone
    startIndex: number
    endIndex: number
    /** The file-supplied division this milestone is listed under. */
    parentKey: string
  }

export interface UserMilestonePlan {
  placements: readonly UserMilestonePlacement[]
  /** Indices a `replace` placement now owns — the AI overlay must not re-cut them. */
  replacedIndices: ReadonlySet<number>
}

/**
 * The navigator identity of one hand-set milestone.
 *
 * `label` is the name exactly as typed — it is content, so it is never
 * localized or reformatted.
 *
 * `shortLabel` is the compact picker badge, and it is deliberately NOT a
 * number. Every other kind's badge is its ordinal, and the navigator's search
 * treats a numeric query as an exact badge match
 * (`milestoneMatchesSearch`) — so numbering hand-set milestones would make
 * typing "2" match both "Part 2" and the second hand-set division, and would
 * put a row reading "1" directly beside a "Part 2". A hand-set milestone
 * always has a name, which is what a person reads and searches for, so the
 * badge only has to say "a person set this": the marker `section` already
 * establishes the pattern with "§".
 *
 * `ordinal` is accepted (and unused in the badge) because callers number the
 * placements in file order anyway and a future slice may want it.
 */
export const USER_MILESTONE_BADGE = "◆"

export function userMilestoneIdentity(record: FileMilestone, _ordinal: number): ImportMilestone {
  return {
    key: `user:${record.id}`,
    kind: "user",
    label: record.name,
    shortLabel: USER_MILESTONE_BADGE,
  }
}

/**
 * Classify every hand-set milestone against the divisions already resolved for
 * the file.
 *
 * `resolved[i]` is the division cell `order[i]` belongs to BEFORE hand-set
 * milestones are applied. Overlaps are settled first by the shared rule
 * (earliest start wins), so the placements returned never overlap each other.
 */
export function planUserMilestones(
  order: readonly string[],
  resolved: readonly (ImportMilestone | undefined)[],
  userMilestones: readonly FileMilestone[],
): UserMilestonePlan {
  if (userMilestones.length === 0) {
    return { placements: [], replacedIndices: new Set() }
  }

  const spans = resolveMilestoneSpans(order, userMilestones)
  const placements: UserMilestonePlacement[] = []
  const replacedIndices = new Set<number>()

  spans.forEach((span, position) => {
    const mode = placementModeFor(resolved, span)
    if (mode === null) return
    const milestone = userMilestoneIdentity(span.milestone, position + 1)
    if (mode.mode === "replace") {
      for (let index = span.startIndex; index <= span.endIndex; index += 1) {
        replacedIndices.add(index)
      }
      placements.push({
        mode: "replace",
        milestone,
        record: span.milestone,
        startIndex: span.startIndex,
        endIndex: span.endIndex,
      })
      return
    }
    placements.push({
      mode: "nest",
      milestone,
      record: span.milestone,
      startIndex: span.startIndex,
      endIndex: span.endIndex,
      parentKey: mode.parentKey,
    })
  })

  return { placements, replacedIndices }
}

function placementModeFor(
  resolved: readonly (ImportMilestone | undefined)[],
  span: ResolvedMilestoneSpan,
): { mode: "replace" } | { mode: "nest"; parentKey: string } | null {
  let everyOneInvented = true
  let soleKey: string | undefined
  let mixedKeys = false

  for (let index = span.startIndex; index <= span.endIndex; index += 1) {
    const division = resolved[index]
    if (!isAppInventedMilestoneKind(division?.kind)) everyOneInvented = false
    const key = division?.key
    if (soleKey === undefined) soleKey = key
    else if (soleKey !== key) mixedKeys = true
  }

  // Replace takes precedence over nest: a run of app-invented divisions may
  // well span two of them (a milestone from line 50 to line 70 eats the tail
  // of "Part 1" and the head of "Part 2"), and crossing a boundary the APP
  // invented is exactly what a person is allowed to do.
  if (everyOneInvented) return { mode: "replace" }
  // Wholly inside one division the file supplied: nest under it.
  if (!mixedKeys && soleKey !== undefined) return { mode: "nest", parentKey: soleKey }
  // Crosses a boundary the file supplied. The dialog refuses this; reaching
  // here means a record arrived by another route, and skipping it is what
  // keeps the navigator from showing a division that straddles a chapter.
  return null
}

// ── What the dialog refuses, before anything is written ───────────────────

export type UserMilestoneRefusal =
  | { reason: "blank-name" }
  | { reason: "no-range" }
  /** The end anchor sits before the start anchor in file order. */
  | { reason: "backwards" }
  /** Would straddle a division the file supplied; `divisionLabel` names it. */
  | { reason: "crosses-division"; divisionLabel: string }
  /** Would overlap an existing hand-set milestone; `milestoneName` names it. */
  | { reason: "overlaps"; milestoneName: string }

export interface UserMilestoneDraft {
  /** Omitted when checking a new milestone; set when editing one in place, so
   *  a milestone never reports overlapping itself. */
  id?: string
  name: string
  startCellId: string
  endCellId: string
}

/**
 * Why this draft cannot be saved, or `null` when it can.
 *
 * Checked in the order a person meets the problems: a missing name or range
 * first, then the two structural refusals. Both of those name what they clash
 * with, because "that overlaps something" without saying what is not an
 * answer a maintainer can act on.
 */
export function refusalForUserMilestone(
  order: readonly string[],
  resolved: readonly (ImportMilestone | undefined)[],
  existing: readonly FileMilestone[],
  draft: UserMilestoneDraft,
  normalizeName: (value: unknown) => string | null,
): UserMilestoneRefusal | null {
  if (normalizeName(draft.name) === null) return { reason: "blank-name" }
  if (!draft.startCellId || !draft.endCellId) return { reason: "no-range" }

  const startIndex = order.indexOf(draft.startCellId)
  const endIndex = order.indexOf(draft.endCellId)
  if (startIndex < 0 || endIndex < 0) return { reason: "no-range" }
  if (endIndex < startIndex) return { reason: "backwards" }

  // Overlap is checked against the records as stored, excluding the draft's
  // own row when it is an edit.
  for (const other of existing) {
    if (draft.id !== undefined && other.id === draft.id) continue
    const otherStart = order.indexOf(other.startCellId)
    const otherEnd = order.indexOf(other.endCellId)
    if (otherStart < 0 || otherEnd < otherStart) continue
    if (startIndex <= otherEnd && otherStart <= endIndex) {
      return { reason: "overlaps", milestoneName: other.name }
    }
  }

  // Same two-question classification planUserMilestones uses, so the dialog
  // can never refuse something the derivation would have accepted (or the
  // other way round).
  const divisions: (ImportMilestone | undefined)[] = []
  for (let index = startIndex; index <= endIndex; index += 1) divisions.push(resolved[index])

  const everyOneInvented = divisions.every((d) => isAppInventedMilestoneKind(d?.kind))
  if (everyOneInvented) return null

  const firstKey = divisions[0]?.key
  const straddled = divisions.find((d) => d?.key !== firstKey)
  if (straddled === undefined) return null

  // Name the division the range runs INTO, which is the boundary the person
  // has to respect. When what it runs into is an app-invented neighbour, the
  // division it STARTED in is the file-supplied one, so name that instead.
  const named = isAppInventedMilestoneKind(straddled?.kind) ? divisions[0] : straddled
  return {
    reason: "crosses-division",
    divisionLabel: named?.label ?? named?.key ?? "",
  }
}
