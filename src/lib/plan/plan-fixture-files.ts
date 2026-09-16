/**
 * AQU-1278 plan-board fixtures for FILE-GRAIN projects — the other two shapes
 * the board has to plan: a subtitle project where every episode is a VTT file,
 * and a document project of Word, PowerPoint, plain text, Markdown and
 * InDesign files. The Bible fixture (`plan-fixture.ts`) covers book units;
 * these cover the units that are a whole file each.
 *
 * Same discipline as its sibling: each file says how many cells are
 * OUTSTANDING, everything else is derived, and `plan-fixture-files.test.ts`
 * runs the shipping `planUnitStatus` over the table so a claim that stops
 * being true fails by name.
 *
 * What these two projects prove that the Bible one cannot:
 *  - a unit with no chapters at all still gets the row, the shortfall line,
 *    the link and the assignment block, and the inspector says WHY there is
 *    no grid — one sentence for a media file, another for a document;
 *  - a person's "· ch. 12" tail stays silent when the unit has no chapters,
 *    instead of naming a time bucket or an empty key;
 *  - the audio term is judged per FILE inside one project — the dubbed
 *    episodes are short on takes, the undubbed ones are judged on text alone;
 *  - the seven-cell floor makes a five-cell README "nearly complete" at 60%,
 *    which is the tiny-file edge Sam still has to rule on.
 */

export const VTT_PROJECT_ID = "dev-plan-1278-vtt"
export const VTT_PROJECT_NAME = "Plan board test: subtitles (AQU-1278)"
export const DOCS_PROJECT_ID = "dev-plan-1278-docs"
export const DOCS_PROJECT_NAME = "Plan board test: documents (AQU-1278)"
export const LANE2 = "tpi"
export const VALIDATION_COUNT = 1

export type ExpectedStatus =
  | "done" | "overdue" | "soon" | "nearly_complete" | "in_progress" | "not_started"

export interface FixtureFile {
  /** Also the file id's tail and the cell id prefix. */
  id: string
  name: string
  /** `files.kind` as the importer writes it: 'vtt', 'docx', 'pptx', 'txt', 'md', 'idml'. */
  kind: string
  cells: number
  /** Cells nobody has translated. A subset of `shortText`. */
  untranslated: number
  /** Cells not validated, translated or not. */
  shortText: number
  /** Only meaningful when `dubbed`: cells with no take. */
  shortAudio: number
  /** Every cell carries a take (minus `shortAudio`). Only VTT files. */
  dubbed?: boolean
  targetDateInDays?: number
  doneDaysAgo?: number
  expect: ExpectedStatus
  note: string
}

/**
 * THE SUBTITLE PROJECT — nine episodes, each its own unit. Three are dubbed,
 * so the audio gate is exercised per file inside one project: an undubbed
 * episode must never be short by its whole cue count.
 */
export const VTT_FILES: FixtureFile[] = [
  {
    id: "s1e1", name: "Season 1 · Episode 1", kind: "vtt", cells: 120,
    untranslated: 0, shortText: 3, shortAudio: 0, dubbed: true,
    expect: "nearly_complete",
    note: "Dubbed, three cues unvalidated. Row: '3 cells to validate'; the inspector " +
      "has no grid and says the sections are time ranges. The link still works: " +
      "it lands on the first unvalidated cue. Assigned to alice.",
  },
  {
    id: "s1e2", name: "Season 1 · Episode 2", kind: "vtt", cells: 150,
    untranslated: 40, shortText: 70, shortAudio: 0,
    expect: "in_progress",
    note: "Not dubbed, mid-way. Judged on text alone — its 150 missing takes " +
      "must not count, because this file has no recordings to be short of.",
  },
  {
    id: "s1e3", name: "Season 1 · Episode 3", kind: "vtt", cells: 100,
    untranslated: 0, shortText: 0, shortAudio: 0,
    expect: "nearly_complete",
    note: "Nothing left, undated, nobody marked it done. 'Nothing left' over " +
      "'not marked done'; the inspector offers Mark done above the button.",
  },
  {
    id: "s1e4", name: "Season 1 · Episode 4", kind: "vtt", cells: 130,
    untranslated: 0, shortText: 0, shortAudio: 5, dubbed: true,
    expect: "nearly_complete",
    note: "Text finished, five takes missing. Nearly complete BY AUDIO, row " +
      "reads '5 takes to record', and NO link — the cue detail carries no audio.",
  },
  {
    id: "s1e5", name: "Season 1 · Episode 5", kind: "vtt", cells: 90,
    untranslated: 0, shortText: 2, shortAudio: 0,
    targetDateInDays: -10,
    expect: "overdue",
    note: "Two cues short and ten days late. Stays in Overdue; line 2 still " +
      "says '2 cells to validate · 10 days late'.",
  },
  {
    id: "s1e6", name: "Season 1 · Episode 6", kind: "vtt", cells: 110,
    untranslated: 0, shortText: 0, shortAudio: 0,
    targetDateInDays: 3,
    expect: "soon",
    note: "Finished and due in three days. Due soon wins the group; line 2 says " +
      "'Nothing left · in 3 days'.",
  },
  {
    id: "s1e7", name: "Season 1 · Episode 7", kind: "vtt", cells: 80,
    untranslated: 80, shortText: 80, shortAudio: 0,
    expect: "not_started",
    note: "Untouched. Not started, never nearly complete.",
  },
  {
    id: "s1e8", name: "Season 1 · Episode 8", kind: "vtt", cells: 60,
    untranslated: 0, shortText: 0, shortAudio: 0,
    doneDaysAgo: 2,
    expect: "done",
    note: "Marked done two days ago.",
  },
  {
    id: "s2e1", name: "Season 2 · Episode 1", kind: "vtt", cells: 200,
    untranslated: 20, shortText: 60, shortAudio: 40, dubbed: true,
    expect: "in_progress",
    note: "Dubbed and in flight on both mediums, three people assigned. The row " +
      "shows three avatars; the inspector lists all three with their own bars " +
      "and no '· ch.' tail, because an episode has no chapters to name.",
  },
]

/**
 * THE DOCUMENT PROJECT — nothing here has a chapter, a verse or a timestamp.
 * Every unit is a file, every inspector has no grid, and every row still has to
 * say what is left and offer the link.
 */
export const DOCS_FILES: FixtureFile[] = [
  {
    id: "route", name: "northern-route.docx", kind: "docx", cells: 120,
    untranslated: 0, shortText: 4, shortAudio: 0,
    expect: "nearly_complete",
    note: "Four cells to validate. The inspector must say the file has no " +
      "sections to plan by — NOT that its sections are time ranges. Assigned " +
      "to alice and bob, half each.",
  },
  {
    id: "briefing", name: "route-briefing.pptx", kind: "pptx", cells: 40,
    untranslated: 15, shortText: 25, shortAudio: 0,
    expect: "in_progress",
    note: "A slide deck mid-way. In progress, no link.",
  },
  {
    id: "glossary", name: "glossary.txt", kind: "txt", cells: 200,
    untranslated: 0, shortText: 0, shortAudio: 0,
    expect: "nearly_complete",
    note: "Nothing left, undated: 'Nothing left' over 'not marked done'.",
  },
  {
    id: "readme", name: "README.md", kind: "md", cells: 5,
    untranslated: 2, shortText: 2, shortAudio: 0,
    expect: "nearly_complete",
    note: "THE TINY-FILE EDGE. Five cells, two untranslated — 60% done — and it " +
      "is 'nearly complete' because the seven-cell floor clears it. Sam has " +
      "not ruled on this yet; the fixture keeps it visible until he does.",
  },
  {
    id: "appendix", name: "appendix.docx", kind: "docx", cells: 90,
    untranslated: 0, shortText: 3, shortAudio: 0,
    targetDateInDays: -6,
    expect: "overdue",
    note: "Three short and six days late. Overdue, with the shortfall on line 2.",
  },
  {
    id: "cover", name: "cover-letter.docx", kind: "docx", cells: 30,
    untranslated: 0, shortText: 1, shortAudio: 0,
    targetDateInDays: 2,
    expect: "soon",
    note: "One cell short, due the day after tomorrow. Due soon, '1 cell to " +
      "validate · in 2 days'.",
  },
  {
    id: "notes", name: "field-notes.txt", kind: "txt", cells: 50,
    untranslated: 50, shortText: 50, shortAudio: 0,
    expect: "not_started",
    note: "Untouched.",
  },
  {
    id: "index", name: "index.md", kind: "md", cells: 25,
    untranslated: 0, shortText: 0, shortAudio: 0,
    doneDaysAgo: 5,
    expect: "done",
    note: "Marked done.",
  },
  {
    id: "catalog", name: "catalog.idml", kind: "idml", cells: 150,
    untranslated: 10, shortText: 30, shortAudio: 0,
    expect: "in_progress",
    note: "An InDesign file, as the board sees one: a file-grain unit with " +
      "plain cells. SEEDED, not imported — a real IDML import goes through the " +
      "roundtrip package and carries story metadata this fixture does not " +
      "pretend to; what the board reads is identical.",
  },
]

export interface FixtureCell {
  cellId: string
  /** '' when nobody has translated it. */
  target: string
  validated: boolean
  recorded: boolean
}

/**
 * Every cell of one file, with its state decided. Outstanding cells come first
 * in document order, which is what makes "Go to first unvalidated" land on a
 * cell a tester can predict.
 */
export function cellsForFile(f: FixtureFile): FixtureCell[] {
  if (f.untranslated > f.shortText || f.shortText > f.cells || f.shortAudio > f.cells) {
    throw new Error(`${f.id}: outstanding counts exceed the file`)
  }
  return Array.from({ length: f.cells }, (_, i) => {
    const untranslated = i < f.untranslated
    const unvalidated = i < f.shortText
    return {
      cellId: `${f.id}-${i + 1}`,
      target: untranslated ? "" : `Ziel ${f.name} ${i + 1}`,
      validated: !unvalidated,
      recorded: (f.dubbed ?? false) && i >= f.shortAudio,
    }
  })
}

export interface FixtureCounts {
  totalCount: number
  filledCount: number
  validatedCount: number
  audioCount: number
  audioValidatedCount: number
}

/** What the projection should produce for one file. No structural cells here. */
export function expectedCounts(f: FixtureFile): FixtureCounts {
  const cells = cellsForFile(f)
  return {
    totalCount: cells.length,
    filledCount: cells.filter((c) => c.target !== "").length,
    validatedCount: cells.filter((c) => c.validated && c.target !== "").length,
    audioCount: cells.filter((c) => c.recorded).length,
    audioValidatedCount: 0,
  }
}

export interface FixtureAssignment {
  id: string
  user: number
  username: string
  file: string
  label: string
  lane: string
  deadlineInDays: number | null
  /** 1-based inclusive cell range; null = the whole file. */
  range: [number, number] | null
}

export const VTT_ASSIGNMENTS: FixtureAssignment[] = [
  { id: "va-s1e1-alice", user: 2, username: "alice", file: "s1e1", label: "Season 1 · Episode 1", lane: "", deadlineInDays: 20, range: null },
  { id: "va-s2e1-alice", user: 2, username: "alice", file: "s2e1", label: "Episode 1 · lines 1–70", lane: "", deadlineInDays: null, range: [1, 70] },
  { id: "va-s2e1-bob", user: 3, username: "bob", file: "s2e1", label: "Episode 1 · lines 71–140", lane: "", deadlineInDays: null, range: [71, 140] },
  { id: "va-s2e1-carol", user: 50, username: "carol", file: "s2e1", label: "Episode 1 · lines 141–200", lane: LANE2, deadlineInDays: 45, range: [141, 200] },
]

export const DOCS_ASSIGNMENTS: FixtureAssignment[] = [
  { id: "da-route-alice", user: 2, username: "alice", file: "route", label: "northern-route · first half", lane: "", deadlineInDays: 14, range: [1, 60] },
  { id: "da-route-bob", user: 3, username: "bob", file: "route", label: "northern-route · second half", lane: "", deadlineInDays: null, range: [61, 120] },
  { id: "da-briefing-carol", user: 50, username: "carol", file: "briefing", label: "route-briefing", lane: "", deadlineInDays: null, range: null },
]

/** The cells one assignment holds. */
export function assignedCells(a: FixtureAssignment, files: readonly FixtureFile[]): string[] {
  const file = files.find((f) => f.id === a.file)
  if (!file) throw new Error(`assignment ${a.id} names no file: ${a.file}`)
  const [from, to] = a.range ?? [1, file.cells]
  if (to > file.cells) throw new Error(`assignment ${a.id} reaches past the end of ${a.file}`)
  return Array.from({ length: to - from + 1 }, (_, i) => `${file.id}-${from + i}`)
}
