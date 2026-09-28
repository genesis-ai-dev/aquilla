// AQU-1278: the board-wide answers ProjectOverview derives from its reads —
// as PURE FUNCTIONS, because the review found six hundred lines of derived
// state up there that no test could reach. The memos stay upstairs; the
// judgment lives here where a test can hold it still.
//
// Pure module beside `verse-chips.ts`, same rule: no React, no fetching. It
// does import `planSectionShortfall` from the grid, which is the one shared
// judge of "is this chapter short" — a second copy here is how the row's
// chapter list and the grid's tiles would start disagreeing.

import { sectionBelongsToUnit, type PlanSection } from "@/hooks/usePlanUnitSections"
import { classifyPlanSection, numberedBookCodes } from "@/lib/plan/plan-section"
import { planUnitId, type PlanUnit } from "@/lib/plan/plan-status"
import type { UnitAssignment } from "@/lib/sync/assignments"
import { planSectionShortfall } from "./PlanChapterGrid"

/**
 * Which chapters of each unit are still short — the row's "chapters 3, 9, 41".
 *
 * Derived, not fetched: one file's section rows answer this for every unit in
 * that file, so a whole-Bible import resolves sixty-six rows from a single
 * read. A unit whose file has not arrived yet is simply absent, and the row
 * draws no chapter line rather than an empty one.
 *
 * Front matter is left OUT. The row says "chapters 12 and 40", and a book
 * title filed before chapter 1 is not a chapter — naming it here would send a
 * reader looking for a numbered tile that does not exist. The grid still
 * shows it, in its own row, labelled as what it is.
 */
export function shortChaptersByUnit(
  units: readonly PlanUnit[],
  sectionsByFile: ReadonlyMap<string, readonly PlanSection[]>,
  audioFiles: ReadonlySet<string>,
): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const unit of units) {
    const sections = sectionsByFile.get(unit.fileId)
    if (!sections) continue
    const hasAudio = audioFiles.has(unit.fileId)
    const mine = sections.filter((s) => sectionBelongsToUnit(s.key, unit.sectionKey))
    const numbered = numberedBookCodes(mine.map((s) => s.key))
    const short = mine
      .filter(
        (section) =>
          classifyPlanSection(section.key, numbered).kind !== "frontMatter" &&
          planSectionShortfall(section, hasAudio).worst > 0,
      )
      .map((section) => section.label)
    if (short.length > 0) map.set(planUnitId(unit), short)
  }
  return map
}

/** The selected unit's own section keys, for the classifier's context. */
export function unitSectionKeys(
  unit: Pick<PlanUnit, "sectionKey">,
  sections: readonly PlanSection[] | undefined,
): string[] | undefined {
  if (!sections) return undefined
  return sections
    .filter((section) => sectionBelongsToUnit(section.key, unit.sectionKey))
    .map((s) => s.key)
}

/**
 * How many of a unit's chapters nobody is assigned to — or undefined wherever
 * there is nothing honest to say.
 *
 * THREE STATES ON THE ASSIGNMENT SIDE, not two. `rows` undefined means the
 * per-unit read has not answered — in flight, failed, or refused by the org's
 * floor — and the only honest count is silence: "every chapter is unassigned"
 * is the most alarming thing this line can say, so it must never be what a
 * failed request says. An empty array is a real answer (nobody is assigned),
 * and only that one means every chapter is open.
 *
 * Undefined also when the unit has no real chapters (a media file's sections
 * are time ranges nobody plans by; zero would render "Every chapter is
 * assigned", the opposite of what an unassigned unit means), and when any
 * assignment predates per-chapter coverage on the wire (an older worker sends
 * no `chapters`, and a guess would be indefensible).
 */
export function unassignedChapterCount(
  unit: Pick<PlanUnit, "sectionKey">,
  sections: readonly PlanSection[] | undefined,
  rows: readonly UnitAssignment[] | undefined,
): number | undefined {
  if (!sections) return undefined
  const mine = sections.filter((section) => sectionBelongsToUnit(section.key, unit.sectionKey))
  const numbered = numberedBookCodes(mine.map((s) => s.key))
  // Front matter is not a chapter, so it cannot be an unassigned one — a
  // Genesis every chapter of which is spoken for would otherwise report one
  // stray chapter nobody can be given.
  const own = mine.filter(
    (s) => classifyPlanSection(s.key, numbered).kind !== "frontMatter",
  )
  if (own.length === 0) return undefined
  if (rows === undefined) return undefined
  if (rows.length === 0) return own.length
  if (rows.some((a) => a.chapters === undefined)) return undefined
  const covered = new Set(rows.flatMap((a) => (a.chapters ?? []).map((c) => c.key)))
  return own.filter((s) => !covered.has(s.key)).length
}

/**
 * Should the assignment panel draw AUDIO bars for this unit?
 *
 * Per FILE, not per project: a person assigned text in a book whose file
 * carries no recordings is not short a single take, and an audio bar on their
 * row would be a column of zeroes saying they are.
 *
 * And never on a unit that records against a CUE SHEET (`audioTotalCount`
 * non-null). An assignment holds subtitle cells; the takes live on a
 * different file's cells, so an assignee's recorded count on a dubbing
 * project is structurally zero however much of the episode they have dubbed.
 * Sam ruled this a real gap and a later ticket — text-only until then.
 */
export function assignmentsShowAudio(
  unit: Pick<PlanUnit, "fileId" | "audioTotalCount">,
  audioFiles: ReadonlySet<string>,
): boolean {
  return audioFiles.has(unit.fileId) && unit.audioTotalCount == null
}
