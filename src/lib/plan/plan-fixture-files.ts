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
 *  - a unit with no chapters at all still gets the row, the shortfall line
 *    and the link, and its inspector shows no chapter block at all rather
 *    than explaining an absence;
 *  - a person's "· ch. 12" tail stays silent when the unit has no chapters,
 *    instead of naming a time bucket or an empty key;
 *  - THE CUE SHEET. A dubbed episode records against a hidden `audio-cues`
 *    sibling whose cell count is its own, and the board has to read the
 *    takes from there — see `cuesForFile`. The undubbed episodes have no
 *    sheet and are judged on text alone;
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
  /**
   * How many cues the linked audio-cue sheet holds — the shape a dubbing
   * project really has. Absent means no sheet, which is an episode nobody is
   * dubbing and a file judged on its text alone.
   *
   * DELIBERATELY NOT `cells`. The sheet is a separate import of a separate
   * file: a cue is a line of speech where a subtitle is a line of reading, and
   * The Chosen's first episode is 646 subtitle cells against 548 cues. A
   * fixture that made them equal would pass every test while hiding the only
   * thing this fixture exists to prove.
   */
  cues?: number
  /** Only meaningful with `cues`: how many of those cues have no take. */
  shortAudio: number
  targetDateInDays?: number
  doneDaysAgo?: number
  expect: ExpectedStatus
  note: string
}

/**
 * THE SUBTITLE PROJECT — ten episodes, each its own unit. Four carry a cue
 * sheet, so the audio gate is exercised per file inside one project: an
 * episode nobody is dubbing must never be short by its whole cue count.
 */
export const VTT_FILES: FixtureFile[] = [
  {
    id: "s1e1", name: "Season 1 · Episode 1", kind: "vtt", cells: 120,
    untranslated: 0, shortText: 3, cues: 100, shortAudio: 0,
    expect: "nearly_complete",
    note: "Fully dubbed — 100 takes on 100 cues — and three subtitle cells " +
      "unvalidated. Row: '3 cells to validate'; AUD reads 100% because the " +
      "takes are counted against the CUE SHEET. Against the 120 subtitle " +
      "cells this same episode reads 83% and is never done. Assigned to alice.",
  },
  {
    id: "s1e2", name: "Season 1 · Episode 2", kind: "vtt", cells: 150,
    untranslated: 40, shortText: 70, shortAudio: 0,
    expect: "in_progress",
    note: "No cue sheet, mid-way. Judged on text alone — its 150 missing takes " +
      "must not count, because nobody is dubbing this episode.",
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
    untranslated: 0, shortText: 0, cues: 110, shortAudio: 5,
    expect: "nearly_complete",
    note: "Text finished, five of its 110 cues unrecorded. Nearly complete BY " +
      "AUDIO; the row reads '5 takes to record'. The INSPECTOR offers no 'Go to " +
      "first…' link beside it — there is no outstanding text cell to land on — " +
      "while the row's own shortfall still opens the file, which is the rule " +
      "`openPlanShortfall` states: a link that lands nearby beats one that " +
      "silently does nothing.",
  },
  {
    id: "s1e5", name: "Season 1 · Episode 5", kind: "vtt", cells: 90,
    untranslated: 0, shortText: 2, shortAudio: 0,
    targetDateInDays: -10,
    expect: "overdue",
    note: "Two cues short and ten days late. Stays in Overdue; line 2 reads " +
      "'2 cells to validate · 10 days late', and the shortfall is the LINK — " +
      "a target date used to cost a row that.",
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
    untranslated: 20, shortText: 60, cues: 170, shortAudio: 40,
    expect: "in_progress",
    note: "Dubbing under way on both mediums, three people assigned. The row " +
      "shows three avatars; the inspector lists all three with TEXT BARS ONLY " +
      "— an assignment holds subtitle cells and the takes live on the cue " +
      "sheet, so nobody's recorded count can be computed yet (Sam's later " +
      "ticket) — and no '· ch.' tail, an episode having no chapters to name.",
  },
  {
    id: "s2e2", name: "Season 2 · Episode 2", kind: "vtt", cells: 140,
    untranslated: 0, shortText: 0, cues: 120, shortAudio: 120,
    expect: "in_progress",
    note: "THE EMPTY CUE SHEET. Text finished and signed off, 120 cues imported " +
      "and not one recorded. The sheet IS the declaration that dubbing is " +
      "planned, so the row sits in In progress under an empty AUD bar and says " +
      "nothing about being finished. Without that rule it reads 'Nothing left' " +
      "in Nearly complete until the first take lands, then moves BACKWARDS. " +
      "(The 120 outstanding takes are not NAMED on the row: only a nearly-" +
      "complete row speaks its shortfall, which is the rule flagged for " +
      "re-confirmation at review.)",
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
    note: "Four cells to validate. The inspector shows NO chapter block at all " +
      "— a Word file has nothing to plan by and an explanation of that is one " +
      "more thing to read. Assigned to alice and bob, half each.",
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
    note: "Three short and six days late. Overdue, with the shortfall on line 2 " +
      "and clickable there.",
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
}

/**
 * Every cell of one file, with its state decided. Outstanding cells come first
 * in document order, which is what makes "Go to first unvalidated" land on a
 * cell a tester can predict.
 *
 * NO `recorded` HERE, and that is the shape this fixture got wrong the first
 * time. A subtitle cell is never recorded: the take belongs to a cue on the
 * sheet beside it. See `cuesForFile`.
 */
export function cellsForFile(f: FixtureFile): FixtureCell[] {
  if (f.untranslated > f.shortText || f.shortText > f.cells) {
    throw new Error(`${f.id}: outstanding counts exceed the file`)
  }
  return Array.from({ length: f.cells }, (_, i) => {
    const untranslated = i < f.untranslated
    const unvalidated = i < f.shortText
    return {
      cellId: `${f.id}-${i + 1}`,
      target: untranslated ? "" : `Ziel ${f.name} ${i + 1}`,
      validated: !unvalidated,
    }
  })
}

/** The id the cue sheet is seeded under, derived so no caller has to know it. */
export function cueSheetId(fileId: string): string {
  return `${fileId}-cues`
}

export interface FixtureCue {
  cellId: string
  recorded: boolean
}

/**
 * The cues on this file's audio sheet, or none where there is no sheet.
 *
 * Unrecorded cues come first, for the same reason unvalidated cells do: a
 * tester looking for the work should find it at the top.
 */
export function cuesForFile(f: FixtureFile): FixtureCue[] {
  if (f.cues === undefined) return []
  if (f.shortAudio > f.cues) throw new Error(`${f.id}: more unrecorded cues than cues`)
  return Array.from({ length: f.cues }, (_, i) => ({
    cellId: `${f.id}-cue-${i + 1}`,
    recorded: i >= f.shortAudio,
  }))
}

/**
 * Subtitle cell → cue, the `text-audio` links the importer's auto-linker makes.
 *
 * THE PLAN BOARD NEVER READS THESE. They are seeded because the fixture has to
 * be the real shape and not merely the shape the board happens to look at: the
 * editor follows them to play a cue's take beside its subtitle, and a fixture
 * that skipped them would be a project no editor could open. The mapping is
 * many-to-one and not total — real cue counts run well under the subtitle
 * count, and the last cells of an episode are often left unlinked.
 */
export function linksForFile(f: FixtureFile): Array<{ from: string; to: string }> {
  const cues = cuesForFile(f)
  if (cues.length === 0) return []
  const cells = cellsForFile(f)
  return cells.slice(0, cells.length - 2).map((c, i) => ({
    from: c.cellId,
    to: cues[Math.min(Math.floor((i * cues.length) / cells.length), cues.length - 1)].cellId,
  }))
}

export interface FixtureCounts {
  totalCount: number
  filledCount: number
  validatedCount: number
  audioCount: number
  audioValidatedCount: number
  /** The cue sheet's own cell count, or null where the file has no sheet. */
  audioTotalCount: number | null
}

/**
 * What the board should read for one file. No structural cells here.
 *
 * The audio pair comes off the CUE SHEET and the text pair off the file, which
 * is the whole point: these are two files' projections folded into one row.
 */
export function expectedCounts(f: FixtureFile): FixtureCounts {
  const cells = cellsForFile(f)
  const cues = cuesForFile(f)
  return {
    totalCount: cells.length,
    filledCount: cells.filter((c) => c.target !== "").length,
    validatedCount: cells.filter((c) => c.validated && c.target !== "").length,
    audioCount: cues.filter((c) => c.recorded).length,
    // AQU-490: these fixtures were written when "recorded" WAS "finished" —
    // the board judged audio on what had been recorded, because no client
    // could validate a take. Now that it judges on validation, a recorded
    // take with nobody signed off is an unfinished one, and every group claim
    // these fixtures make would be wrong for a reason that has nothing to do
    // with what they are demonstrating (grouping, denominators, the headings
    // policy). So a recorded line here is a validated one, which is what a
    // finished dubbed project actually looks like.
    audioValidatedCount: cues.filter((c) => c.recorded).length,
    audioTotalCount: f.cues ?? null,
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
