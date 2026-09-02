/**
 * AQU-1092…1098: the status vocabulary for planning units.
 *
 * A PLANNING UNIT is the row a project manager plans by. Usually that is a
 * file — an episode, a document, a one-book file. Where a file subdivides
 * into parts that carry STABLE CANONICAL IDENTITY, each part is its own unit
 * instead: today that means the Bible books inside a whole-Bible import,
 * keyed by book code. Identity is the whole reason for that restriction. A
 * Done mark has to find its unit again next week, and a book code survives a
 * re-import byte-for-byte where a heading string does not.
 *
 * Nothing here says "book". The unit varies by project, so the vocabulary
 * cannot name it — see `planUnitLabel`.
 */
import {
  AOE_GRACE_MS,
  DEADLINE_SOON_WINDOW_MS,
  isDeadlineOverdue,
} from "@/lib/frontier/portfolio"
import { getBookName, isKnownBookCode, getBookOrdinal } from "@/lib/file-labeling/bible-book-names"

/** One row of the plan: progress for the active lane plus the PM's marks. */
export interface PlanUnit {
  fileId: string
  fileName: string
  /** '' for a file-grain unit, else a stable sub-file key (a Bible book code). */
  sectionKey: string
  totalCount: number
  filledCount: number
  validatedCount: number
  audioCount: number
  audioValidatedCount: number
  lastEditAt: number | null
  /** Calendar date 'YYYY-MM-DD', lane-independent. Null when unplanned. */
  targetDate: string | null
  doneAt: number | null
  doneBy: string | null
}

export type PlanUnitStatus = "done" | "overdue" | "soon" | "in_progress" | "not_started"

/**
 * Group order is a claim about urgency, and the order IS the answer the board
 * gives: Overdue first because it is the only group anyone acts on today,
 * Done last because it is evidence rather than work.
 */
export const PLAN_GROUP_ORDER: readonly PlanUnitStatus[] = [
  "overdue",
  "soon",
  "in_progress",
  "not_started",
  "done",
] as const

/** Stable id for a unit — the storage key, and the React key. */
export function planUnitId(u: Pick<PlanUnit, "fileId" | "sectionKey">): string {
  return `${u.fileId}:${u.sectionKey}`
}

/**
 * What a unit is called. A book code becomes its English book name; anything
 * else is the file's own name. Never a code the reader has to decode.
 */
export function planUnitLabel(u: Pick<PlanUnit, "fileName" | "sectionKey">): string {
  if (!u.sectionKey) return u.fileName
  return getBookName(u.sectionKey) ?? u.sectionKey
}

/** Has anyone put anything into this unit yet, in the lane being viewed? */
export function planUnitHasContent(u: Pick<PlanUnit, "filledCount" | "audioCount">): boolean {
  return u.filledCount > 0 || u.audioCount > 0
}

/**
 * Done is an explicit human mark and outranks everything — a unit can read
 * Done while its bars sit below 100%, which is the point: the mark records a
 * judgment the percentages cannot make.
 *
 * Overdue/soon come from the target date under the same Anywhere-on-Earth
 * rule the project deadline uses, so a unit and its project never disagree
 * about what "late" means. In progress vs not started is derived from content
 * IN THE ACTIVE LANE: a book with Spanish text and no French is under way in
 * one lane and untouched in the other, and a PM on the French tab wants the
 * French truth.
 */
export function planUnitStatus(u: PlanUnit, now: number): PlanUnitStatus {
  if (u.doneAt != null) return "done"
  const started = planUnitHasContent(u)
  if (u.targetDate) {
    const t = Date.parse(u.targetDate)
    if (!Number.isNaN(t)) {
      if (isDeadlineOverdue(t, now)) return "overdue"
      if (t + AOE_GRACE_MS - now <= DEADLINE_SOON_WINDOW_MS) return "soon"
    }
  }
  return started ? "in_progress" : "not_started"
}

/**
 * Within a group the soonest deadline is the most urgent, so target date
 * ascending; undated units sort last (they carry no claim about when), then
 * by label so the order is stable between renders.
 */
export function sortUnitsInGroup(units: readonly PlanUnit[]): PlanUnit[] {
  return [...units].sort((a, b) => {
    if (a.targetDate !== b.targetDate) {
      if (!a.targetDate) return 1
      if (!b.targetDate) return -1
      return a.targetDate < b.targetDate ? -1 : 1
    }
    // Same date (or both undated): canonical book order where both are books,
    // so Genesis precedes Exodus rather than sorting alphabetically.
    const aBook = isKnownBookCode(a.sectionKey)
    const bBook = isKnownBookCode(b.sectionKey)
    if (aBook && bBook) {
      const d = getBookOrdinal(a.sectionKey) - getBookOrdinal(b.sectionKey)
      if (d !== 0) return d
    }
    return planUnitLabel(a).localeCompare(planUnitLabel(b))
  })
}

/**
 * The one line that sits beside a unit's status — in the row under the date,
 * and in the inspector beside the pill. Shared so the two surfaces can never
 * word the same fact differently.
 *
 * It always answers the question the status raises but cannot itself answer:
 * Done raises "when was that decided", Overdue raises "how late", Due soon
 * raises "how long have I got", and a started unit with no date raises "is
 * anyone planning this". Everything else has nothing to add, and says nothing.
 */
export type PlanUnitNote =
  | { kind: "marked"; at: number }
  | { kind: "days_late"; days: number }
  | { kind: "days_until"; days: number }
  | { kind: "no_target" }

function targetTime(targetDate: string | null): number | null {
  if (!targetDate) return null
  const t = Date.parse(targetDate)
  return Number.isNaN(t) ? null : t
}

/**
 * Distances are measured from the DATE the manager typed, not from the
 * Anywhere-on-Earth instant it expires. The grace period decides *when* a unit
 * turns overdue; it must not also shift the number the reader sees, or a unit
 * whose target was the 10th would report being late since the 11th. A unit can
 * never read "0 days late", because it does not become overdue until the grace
 * period has already carried it past a full day.
 */
export function planUnitNote(u: PlanUnit, now: number): PlanUnitNote | null {
  const status = planUnitStatus(u, now)
  if (status === "done") return u.doneAt != null ? { kind: "marked", at: u.doneAt } : null
  const target = targetTime(u.targetDate)
  if (status === "overdue" && target != null) {
    return { kind: "days_late", days: Math.max(1, Math.floor((now - target) / 86_400_000)) }
  }
  if (status === "soon" && target != null) {
    return { kind: "days_until", days: Math.max(0, Math.ceil((target - now) / 86_400_000)) }
  }
  if (status === "in_progress" && !u.targetDate) return { kind: "no_target" }
  return null
}

/** i18n key per status, so the label lives beside the vocabulary it names. */
export const PLAN_STATUS_LABEL_KEY: Record<PlanUnitStatus, string> = {
  done: "org.projectOverview.plan.statusDone",
  overdue: "org.projectOverview.plan.statusOverdue",
  soon: "org.projectOverview.plan.statusSoon",
  in_progress: "org.projectOverview.plan.statusInProgress",
  not_started: "org.projectOverview.plan.statusNotStarted",
}

export interface PlanGroup {
  status: PlanUnitStatus
  units: PlanUnit[]
}

/** Group + order for rendering. Empty groups are dropped, not rendered blank. */
export function groupPlanUnits(units: readonly PlanUnit[], now: number): PlanGroup[] {
  const by = new Map<PlanUnitStatus, PlanUnit[]>()
  for (const u of units) {
    const k = planUnitStatus(u, now)
    const list = by.get(k)
    if (list) list.push(u)
    else by.set(k, [u])
  }
  return PLAN_GROUP_ORDER.flatMap((status) => {
    const list = by.get(status)
    return list && list.length > 0 ? [{ status, units: sortUnitsInGroup(list) }] : []
  })
}

export interface PlanSummary {
  total: number
  done: number
  overdue: number
  inFlight: number
}

/** The strip above the board. Deliberately unit-agnostic: "2 of 6 done". */
export function planSummary(units: readonly PlanUnit[], now: number): PlanSummary {
  let done = 0
  let overdue = 0
  let inFlight = 0
  for (const u of units) {
    const s = planUnitStatus(u, now)
    if (s === "done") done += 1
    else if (s === "overdue") overdue += 1
    else if (s === "in_progress" || s === "soon") inFlight += 1
  }
  return { total: units.length, done, overdue, inFlight }
}

/** A whole-number percentage, floored at 0 while a denominator is still zero. */
export function planPct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

/** What the reader has narrowed the board to. Both are ephemeral by design. */
export interface PlanFilter {
  /** Free text; matched against the unit's label and its section key. */
  query?: string
  /** Only units nobody has given a target date and nobody has marked done. */
  needsDateOnly?: boolean
}

/**
 * Does this unit still need a date from a planner?
 *
 * A unit already marked Done is excluded even with no date on it. The filter
 * exists to be a scheduling to-do list, and something finished is not on it.
 */
export function planUnitNeedsDate(u: Pick<PlanUnit, "targetDate" | "doneAt">): boolean {
  return u.targetDate == null && u.doneAt == null
}

/**
 * Narrow the board.
 *
 * The query matches the unit's DISPLAY LABEL and its section key, so both
 * "Genesis" and "GEN" find Genesis — a PM who knows the book codes should not
 * have to spell the name out. Case-insensitive, trimmed, and an empty or
 * whitespace-only query passes everything through, matching how every other
 * filter box in this app behaves.
 *
 * The file name is deliberately NOT matched. On a whole-Bible import every one
 * of the sixty-six book units shares one file name, so typing it would select
 * all of them at once and look like the filter had failed.
 */
export function filterPlanUnits(units: readonly PlanUnit[], filter: PlanFilter): PlanUnit[] {
  const q = (filter.query ?? "").trim().toLowerCase()
  const needsDateOnly = filter.needsDateOnly === true
  if (!q && !needsDateOnly) return [...units]
  return units.filter((u) => {
    if (needsDateOnly && !planUnitNeedsDate(u)) return false
    if (!q) return true
    return (
      planUnitLabel(u).toLowerCase().includes(q) ||
      u.sectionKey.toLowerCase().includes(q)
    )
  })
}

/** Does this project track audio at all? Drives whether audio bars render. */
export function planHasAudio(units: readonly PlanUnit[]): boolean {
  return units.some((u) => u.audioCount > 0)
}
