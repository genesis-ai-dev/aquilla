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
  /**
   * AQU-1278: what the two audio counts are OUT OF. See `planAudioTotal` —
   * null or absent means they share `totalCount`, which is every unit but a
   * subtitle file with a linked cue sheet.
   */
  audioTotalCount?: number | null
  lastEditAt: number | null
  /** Calendar date 'YYYY-MM-DD', lane-independent. Null when unplanned. */
  targetDate: string | null
  doneAt: number | null
  doneBy: string | null
}

export type PlanUnitStatus =
  | "done"
  | "overdue"
  | "soon"
  | "nearly_complete"
  | "in_progress"
  | "not_started"

/**
 * Group order is a claim about urgency, and the order IS the answer the board
 * gives: Overdue first because it is the only group anyone acts on today,
 * Done last because it is evidence rather than work.
 *
 * AQU-1278 put Nearly complete UNDER the two date-driven groups and above the
 * rest. A blown date still outranks "a few cells left" — a unit that is both
 * stays Overdue, and its row says "Nothing left" on the second line so it is
 * still findable. What the new group buys is the case nobody could see before:
 * work that is almost finished and has no date at all.
 *
 * NOT TYPE-CHECKED. This is a plain array, so a status missing from it simply
 * never renders — and `isPlanUnitStatus` in plan-view.ts derives fold
 * persistence from it, so the fold breaks too. `plan-status.test.ts` asserts
 * every member of the union appears here exactly once; keep that test.
 */
export const PLAN_GROUP_ORDER: readonly PlanUnitStatus[] = [
  "overdue",
  "soon",
  "nearly_complete",
  "in_progress",
  "not_started",
  "done",
] as const

/**
 * AQU-1278: a unit is NEARLY COMPLETE when its worse medium is short by at most
 * six percent of its cells, or seven cells, whichever is larger. Sam's call
 * (2026-09-15): the percentage is what scales, and the seven-cell floor is what
 * lets a short book qualify at all — six percent of Philemon's twenty-five
 * cells is one and a half, so a percentage alone would mean the shortest books
 * in the Bible could never be nearly anything.
 */
export function planNearlyCompleteThreshold(totalCount: number): number {
  return Math.max(Math.ceil(totalCount * 0.06), 7)
}

/**
 * Audio is judged on RECORDED rather than validated, and the audio-validated
 * term is suppressed in the words as well as the rule.
 *
 * `cell.audio.validate` exists server-side (AQU-508) and NO CLIENT EMITS IT —
 * there is no recording-review UI, so `audioValidatedCount` is zero on every
 * project in existence. Measuring it would put every audio book permanently out
 * of reach of this group, and would make every row read "1,213 takes to
 * validate". AQU-490 is the open client half.
 *
 * WHEN AQU-490 LANDS THIS FLIPS, and nothing will fail to tell you: the numbers
 * would simply keep measuring the wrong thing. `plan-status.test.ts` pins both
 * arms of this constant so the flip has a test waiting for it.
 */
export const AUDIO_JUDGED_ON_RECORDED = true

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
 * How many cells this unit's audio is measured against.
 *
 * Normally the unit's own cells — record the book, count the book. A dubbing
 * project is the exception: its takes hang off a hidden cue sheet whose cell
 * count is nobody's business but its own, and The Chosen's first episode is
 * 646 subtitle cells against 548 cues. Measuring 548 takes against 646 cells
 * would leave a fully dubbed episode reading 85% recorded forever.
 *
 * `audioTotalCount` is null on every unit without a cue sheet, and ABSENT from
 * a worker that predates AQU-1278 — both mean "share the text denominator",
 * which is what the board did before this existed.
 */
export function planAudioTotal(
  u: Pick<PlanUnit, "totalCount" | "audioTotalCount">,
): number {
  return u.audioTotalCount ?? u.totalCount
}

/**
 * Does this unit expect recordings at all?
 *
 * A LINKED CUE SHEET IS AN EXPECTATION even with no take in it yet. That is
 * the whole point of the sheet: somebody imported an audio-cue file for this
 * episode, so the dubbing is planned, and a board that waited for the first
 * take would call the episode text-only right up until it stopped being it.
 * Below that, the older signal stands — a take exists, so recording is under
 * way.
 */
export function planUnitExpectsAudio(
  u: Pick<PlanUnit, "audioCount" | "audioTotalCount">,
): boolean {
  return (u.audioTotalCount ?? 0) > 0 || u.audioCount > 0
}

/**
 * Which FILES carry recordings. Audio expectation has to be judged per file,
 * never per project: `planHasAudio` answers "does this project track audio at
 * all", and a project holding one dubbed episode alongside sixty-five text
 * books would answer yes for every one of them. Each text book's audio
 * shortfall would then be its entire cell count, the worse medium would always
 * be audio, and NOTHING WOULD EVER BE NEARLY COMPLETE.
 *
 * Per file is the honest grain: the books of a whole-Bible audio import share
 * one file, so recording any of them marks the rest as expected too.
 *
 * Known limit, now half-closed: a file where recording has not started reads
 * as text-only unless it has a cue sheet. A subtitle file's sheet says the
 * dubbing is planned before the first take exists; a whole-Bible audio import
 * has no such declaration, so it still announces itself by being recorded.
 * Inventing an expectation from `fileKind` would guess.
 */
export function audioFileIds(units: readonly PlanUnit[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const u of units) if (planUnitExpectsAudio(u)) ids.add(u.fileId)
  return ids
}

/** Outstanding work in a unit, per medium. Every term is floored at zero. */
export interface PlanShortfall {
  toTranslate: number
  toValidate: number
  toRecord: number
  toAudioValidate: number
  /** The worse medium's outstanding cells — the number the group rule judges. */
  worst: number
}

/** Never let a difference go negative; see `planUnitShortfall`'s note on audio. */
const atLeastZero = (n: number): number => (n > 0 ? n : 0)

/**
 * What this unit still needs.
 *
 * EVERY TERM IS CLAMPED, and the audio one still is even though the hole it was
 * dug for is filled. Migration 0094 gave the projection a
 * `structural_audio_count`, so a policy that excludes headings now subtracts
 * them from `audioCount` as well as from `totalCount` and the two move
 * together. What the clamp defends is the gap before that lands: a row the
 * backfill has not reached reports its recorded headings and a shrunken
 * denominator, and unclamped `total − audio` would go negative, sail under any
 * threshold, and declare the unit nearly complete precisely because someone
 * recorded its headings. It costs one comparison; keep it.
 *
 * `hasAudio` comes from `audioFileIds`, not from the unit — see that function.
 */
export function planUnitShortfall(u: PlanUnit, hasAudio: boolean): PlanShortfall {
  // AQU-1278: every audio term counts against the CUE SHEET where there is
  // one, never the subtitle cells. See `planAudioTotal` — on a dubbing project
  // the two totals differ by a hundred cells and the text one is the wrong
  // number to subtract a take count from.
  const audioTotal = planAudioTotal(u)
  const toTranslate = atLeastZero(u.totalCount - u.filledCount)
  const toValidate = atLeastZero(u.filledCount - u.validatedCount)
  const toRecord = hasAudio ? atLeastZero(audioTotal - u.audioCount) : 0
  const toAudioValidate =
    hasAudio && !AUDIO_JUDGED_ON_RECORDED
      ? atLeastZero(u.audioCount - u.audioValidatedCount)
      : 0
  // Text's outstanding set is everything not yet validated — untranslated cells
  // are a subset of it, so this is one number, not a sum.
  const textShort = atLeastZero(u.totalCount - u.validatedCount)
  const audioShort = hasAudio
    ? AUDIO_JUDGED_ON_RECORDED
      ? toRecord
      : atLeastZero(audioTotal - u.audioValidatedCount)
    : 0
  return {
    toTranslate,
    toValidate,
    toRecord,
    toAudioValidate,
    worst: Math.max(textShort, audioShort),
  }
}

/**
 * The shortfall as the row and the inspector say it, worst-first and capped at
 * two parts — "6 to translate · 34 to validate". A structured list rather than
 * a string because the words are translated; `use-plan-note.ts` renders it.
 *
 * Translation leads validation because it is the bigger hole: a cell nobody has
 * written cannot be validated, so listing the validation debt first would name
 * a queue that is blocked on the other number.
 */
export type PlanShortfallPart =
  | { kind: "translate"; count: number }
  | { kind: "validate"; count: number }
  | { kind: "record"; count: number }
  | { kind: "audio_validate"; count: number }

export function planShortfallParts(s: PlanShortfall): PlanShortfallPart[] {
  const all: PlanShortfallPart[] = [
    { kind: "translate", count: s.toTranslate },
    { kind: "validate", count: s.toValidate },
    { kind: "record", count: s.toRecord },
    { kind: "audio_validate", count: s.toAudioValidate },
  ]
  const present = all.filter((p) => p.count > 0)
  if (present.length <= 2) return present

  // Three or four things outstanding and room for two. Medium order holds —
  // translation still leads validation, because a cell nobody has written
  // cannot be validated and naming the blocked queue first reads as the wrong
  // instruction — but it cannot be allowed to drop the medium that actually
  // put this unit where it is. A book six cells from fully translated, four
  // from fully validated and two hundred takes from recorded would otherwise
  // read "6 cells to translate · 4 cells to validate" and never mention the two
  // hundred, which is both the largest number on the row and the only one the
  // grouping used.
  //
  // So: first two in medium order, and if neither of them belongs to the worse
  // medium, the second gives way to the one that does.
  const chosen = present.slice(0, 2)
  const isAudio = (p: PlanShortfallPart) => p.kind === "record" || p.kind === "audio_validate"
  const audioIsWorse = s.worst === Math.max(s.toRecord, s.toAudioValidate) && s.worst > 0
  if (audioIsWorse && !chosen.some(isAudio)) {
    const worstAudio = present.filter(isAudio).reduce((a, b) => (b.count > a.count ? b : a))
    return [chosen[0], worstAudio]
  }
  return chosen
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
export function planUnitStatus(
  u: PlanUnit,
  now: number,
  /**
   * Files that carry recordings, from `audioFileIds` over the WHOLE board.
   * Omitted, the unit's own expectation stands in — right for a lone pill,
   * wrong for a board, which is why every board path passes the set.
   */
  audioFiles?: ReadonlySet<string>,
): PlanUnitStatus {
  if (u.doneAt != null) return "done"
  const started = planUnitHasContent(u)
  if (u.targetDate) {
    const t = Date.parse(u.targetDate)
    if (!Number.isNaN(t)) {
      if (isDeadlineOverdue(t, now)) return "overdue"
      if (t + AOE_GRACE_MS - now <= DEADLINE_SOON_WINDOW_MS) return "soon"
    }
  }
  // AQU-1278. Both guards are load-bearing. `totalCount > 0` keeps an empty
  // file out: its shortfall is zero, zero clears every threshold, and it would
  // otherwise be promoted above In progress and labelled "Nothing left" — a
  // file with nothing IN it. `planUnitHasContent` keeps out the book nobody has
  // started, which is short by everything and belongs in Not started.
  if (started && u.totalCount > 0) {
    const hasAudio = audioFiles ? audioFiles.has(u.fileId) : planUnitExpectsAudio(u)
    const { worst } = planUnitShortfall(u, hasAudio)
    // ONE THRESHOLD PER UNIT, and it is the unit's own cell count even when
    // audio is counted against a cue sheet of a different size. The row is one
    // row; "a few cells from finished" is one question about it, and a unit
    // whose text and audio each had their own bar for clearing would be nearly
    // complete by one number and not the other with nothing on screen saying
    // which. The two counts differ by a hundred or so out of six hundred, so
    // the alternative buys a threshold a handful of cells tighter.
    if (worst <= planNearlyCompleteThreshold(u.totalCount)) return "nearly_complete"
  }
  return started ? "in_progress" : "not_started"
}

/**
 * Is this unit a few cells from finished — whatever group it was filed under?
 *
 * The status and this question are deliberately not the same thing. A unit that
 * is both nearly finished AND past its date is filed under Overdue, because a
 * blown date outranks a short queue; but its row still has to say "3 cells to
 * validate" rather than going quiet, or the one book a manager could close
 * today is the one the board says least about.
 *
 * So the date is stripped and the vocabulary asked again. That keeps the 6%/7
 * threshold, the empty-file guard and the not-started guard in exactly one
 * place — the alternative is every caller re-deriving the rule, which is how
 * the row and the inspector came to disagree before this existed.
 */
export function planUnitIsNearlyComplete(
  u: PlanUnit,
  now: number,
  audioFiles?: ReadonlySet<string>,
): boolean {
  if (u.doneAt != null) return false
  return planUnitStatus({ ...u, targetDate: null }, now, audioFiles) === "nearly_complete"
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
    //
    // BOOKS AND NON-BOOKS ARE SEPARATED FIRST, and that is not tidiness. When
    // the ordinal applied only to book-vs-book and everything else fell back
    // to the label, a group holding books and files had a NON-TRANSITIVE
    // comparator: Genesis < Exodus by ordinal, Exodus < "Fdoc" by label, and
    // "Fdoc" < Genesis by label — a cycle, so the result depended on the input
    // order and on the sort implementation. Books ahead of files gives every
    // pair one consistent rule.
    const aBook = isKnownBookCode(a.sectionKey)
    const bBook = isKnownBookCode(b.sectionKey)
    if (aBook !== bBook) return aBook ? -1 : 1
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
export function planUnitNote(
  u: PlanUnit,
  now: number,
  audioFiles?: ReadonlySet<string>,
): PlanUnitNote | null {
  const status = planUnitStatus(u, now, audioFiles)
  if (status === "done") return u.doneAt != null ? { kind: "marked", at: u.doneAt } : null
  const target = targetTime(u.targetDate)
  if (status === "overdue" && target != null) {
    return { kind: "days_late", days: Math.max(1, Math.floor((now - target) / 86_400_000)) }
  }
  if (status === "soon" && target != null) {
    return { kind: "days_until", days: Math.max(0, Math.ceil((target - now) / 86_400_000)) }
  }
  // AQU-1278: `nearly_complete` is a started unit too, and it is the status a
  // planner most wants a date on. Leaving it out here blanked the note beside
  // the inspector's pill for exactly the units this feature is about.
  if ((status === "in_progress" || status === "nearly_complete") && !u.targetDate) {
    return { kind: "no_target" }
  }
  return null
}

/** i18n key per status, so the label lives beside the vocabulary it names. */
export const PLAN_STATUS_LABEL_KEY: Record<PlanUnitStatus, string> = {
  done: "org.projectOverview.plan.statusDone",
  overdue: "org.projectOverview.plan.statusOverdue",
  soon: "org.projectOverview.plan.statusSoon",
  nearly_complete: "org.projectOverview.plan.statusNearlyComplete",
  in_progress: "org.projectOverview.plan.statusInProgress",
  not_started: "org.projectOverview.plan.statusNotStarted",
}

export interface PlanGroup {
  status: PlanUnitStatus
  units: PlanUnit[]
}

/**
 * Nearly complete sorts by how little is left, closest to the finish first, so
 * the book that needs one validation sits above the one that needs ninety. Ties
 * fall through to the ordinary comparator, which keeps a dated unit ahead of an
 * undated one and Genesis ahead of Exodus.
 *
 * The ordinary comparator cannot do this on its own: it sorts by target date
 * first, so a finished book with a date in November would sort below an
 * unfinished one due tomorrow.
 */
export function sortNearlyComplete(
  units: readonly PlanUnit[],
  audioFiles: ReadonlySet<string>,
): PlanUnit[] {
  const worstOf = new Map<string, number>()
  for (const u of units) {
    worstOf.set(planUnitId(u), planUnitShortfall(u, audioFiles.has(u.fileId)).worst)
  }
  return sortUnitsInGroup(units).sort(
    (a, b) => (worstOf.get(planUnitId(a)) ?? 0) - (worstOf.get(planUnitId(b)) ?? 0),
  )
}

/**
 * Group + order for rendering. Empty groups are dropped, not rendered blank.
 *
 * PASS `audioFiles` WHEN THE LIST IS FILTERED. Derived from `units` it would be
 * derived from whatever subset the caller handed over, and audio expectation is
 * a fact about a file, not about the rows currently on screen: filtering a
 * whole-Bible board down to one text-only book would take that book's dubbed
 * siblings out of the set, stop counting the takes it is missing, and move the
 * row into Nearly complete. A search box must never change what a row MEANS.
 */
export function groupPlanUnits(
  units: readonly PlanUnit[],
  now: number,
  audioFilesOverride?: ReadonlySet<string>,
): PlanGroup[] {
  const audioFiles = audioFilesOverride ?? audioFileIds(units)
  const by = new Map<PlanUnitStatus, PlanUnit[]>()
  for (const u of units) {
    const k = planUnitStatus(u, now, audioFiles)
    const list = by.get(k)
    if (list) list.push(u)
    else by.set(k, [u])
  }
  return PLAN_GROUP_ORDER.flatMap((status) => {
    const list = by.get(status)
    if (!list || list.length === 0) return []
    return [{
      status,
      units: status === "nearly_complete"
        ? sortNearlyComplete(list, audioFiles)
        : sortUnitsInGroup(list),
    }]
  })
}

export interface PlanSummary {
  total: number
  done: number
  overdue: number
  inFlight: number
  /** AQU-1278: a few cells from finished. Counted apart from `inFlight`. */
  nearlyComplete: number
}

/**
 * The strip above the board. Deliberately unit-agnostic: "2 of 6 done".
 *
 * NOT TYPE-CHECKED — this is an if/else chain, not an exhaustive map, so a
 * status added to the union and forgotten here falls out of every pill and the
 * numbers above the board quietly shrink. `plan-status.test.ts` asserts the
 * buckets sum to the unit count; keep that test.
 */
export function planSummary(units: readonly PlanUnit[], now: number): PlanSummary {
  const audioFiles = audioFileIds(units)
  let done = 0
  let overdue = 0
  let inFlight = 0
  let nearlyComplete = 0
  for (const u of units) {
    const s = planUnitStatus(u, now, audioFiles)
    if (s === "done") done += 1
    else if (s === "overdue") overdue += 1
    else if (s === "nearly_complete") nearlyComplete += 1
    else if (s === "in_progress" || s === "soon") inFlight += 1
  }
  return { total: units.length, done, overdue, inFlight, nearlyComplete }
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

/**
 * Does this project track audio at all? Drives whether audio bars render.
 *
 * Asks `planUnitExpectsAudio`, the same question `audioFileIds` asks, and that
 * is load-bearing rather than tidy. The two decide different things — whether
 * a bar is DRAWN, and whether a unit is JUDGED on its takes — and if they
 * disagreed, a project whose cue sheets were imported before anyone started
 * recording would have every row short by its whole cue count with no audio
 * bar anywhere to say why.
 */
export function planHasAudio(units: readonly PlanUnit[]): boolean {
  return units.some(planUnitExpectsAudio)
}
