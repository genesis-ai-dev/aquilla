/**
 * AQU-1278 plan-board fixture — the table, and nothing else.
 *
 * This module is pure data plus the arithmetic that turns it into cells. It
 * imports nothing: `seed-plan-fixture.ts` writes it to Postgres, and
 * `plan-fixture.test.ts` runs the shipping `planUnitStatus` over it and asserts
 * every book lands in the group its `expect` claims. Keeping the table here is
 * what makes those two agree — the seeder cannot drift from the thing that
 * proves the seeder is right.
 *
 * NOTHING IN THE FIXTURE IS HAND-COMPUTED. Each book says how many cells are
 * OUTSTANDING, because that is how the feature talks and how a reader checks
 * the screen against this table. Totals, bar fractions, badge counts, the
 * threshold and the group each row lands in are all derived from it.
 */

export const PROJECT_ID = "dev-plan-1278"
export const PROJECT_NAME = "Plan board test (AQU-1278)"
export const TEXT_FILE = "plan-1278-text"
export const AUDIO_FILE = "plan-1278-audio"
export const MEDIA_FILE = "plan-1278-media"
export const EMPTY_FILE = "plan-1278-empty"
export const LANE2 = "tpi"
export const VALIDATION_COUNT = 1

/** The statuses the fixture claims, spelled as `PlanUnitStatus` spells them. */
export type ExpectedStatus =
  | "done" | "overdue" | "soon" | "nearly_complete" | "in_progress" | "not_started"

export interface Book {
  code: string
  chapters: number
  perChapter: number
  /** Cells nobody has translated. A SUBSET of `shortText`. */
  untranslated: number
  /** Cells not validated, translated or not. */
  shortText: number
  /** Cells with no recording. Only meaningful inside the audio file. */
  shortAudio: number
  /** Chapters the shortfall is concentrated in (1-based). Empty = spread. */
  shortIn: number[]
  /** Chapters to leave with NO cells, so the grid has a real gap. */
  missingChapters?: number[]
  /** A bare "TIT"-shaped canonical ref: section key === book key. */
  bareRef?: boolean
  /** Put takes on this book's headings too — the negative-shortfall clamp. */
  audioOnHeadings?: boolean
  targetDateInDays?: number
  doneDaysAgo?: number
  expect: ExpectedStatus
  note: string
}

/**
 * THE TEXT FILE — no recordings anywhere in it.
 *
 * That is the point, not an omission. `audioFileIds` gates the audio term per
 * FILE, so a project holding one dubbed file beside sixty-five text books must
 * judge those books on text alone. Move EXO's takes into this file and every
 * book below is suddenly short by its entire cell count and nothing is ever
 * nearly complete.
 */
export const TEXT_BOOKS: Book[] = [
  {
    code: "GEN", chapters: 50, perChapter: 10,
    untranslated: 0, shortText: 3, shortAudio: 0, shortIn: [12, 40],
    missingChapters: [7],
    expect: "nearly_complete",
    note: "The headline case. Row: '3 cells to validate' over 'chapters 12 and 40'. " +
      "Grid: badge 2 on chapter 12, badge 1 on chapter 40, chapter 7 a GAP and not " +
      "a shift, front matter in the extras row under the numbered grid. One link, " +
      "reading 'Go to first unvalidated'. Assigned to two people.",
  },
  {
    code: "LEV", chapters: 27, perChapter: 10,
    untranslated: 100, shortText: 160, shortAudio: 0, shortIn: [],
    expect: "in_progress",
    note: "Mid-way. No badges on any tile and NO LINK — the decision to re-confirm at " +
      "build review. Row shows a dash and last activity. Only chapters 1-10 are " +
      "assigned, so the inspector says how much is not.",
  },
  {
    code: "NUM", chapters: 36, perChapter: 10,
    untranslated: 0, shortText: 0, shortAudio: 0, shortIn: [],
    targetDateInDays: 60,
    expect: "nearly_complete",
    note: "Nothing left, nobody marked it done, and a far-off date. Line 1 is the DATE " +
      "and line 2 is 'Nothing left'. Sorted first inside its group. The inspector " +
      "offers Mark done above the button.",
  },
  {
    code: "JOS", chapters: 24, perChapter: 10,
    untranslated: 29, shortText: 70, shortAudio: 0, shortIn: [],
    expect: "in_progress",
    note: "In flight, whole book assigned to one person PINNED TO TOK PISIN — they " +
      "appear with a language chip while the German tab is open.",
  },
  {
    code: "DEU", chapters: 34, perChapter: 10,
    untranslated: 6, shortText: 14, shortAudio: 0, shortIn: [4, 9, 17, 22, 28, 31, 33],
    expect: "nearly_complete",
    note: "Short in SEVEN chapters and assigned to SIX people. The row names three " +
      "chapters and counts the rest, and draws three avatars then +3. Narrow the " +
      "window: chips give way before the name truncates, count chip last.",
  },
  {
    code: "JON", chapters: 4, perChapter: 12,
    untranslated: 0, shortText: 2, shortAudio: 0, shortIn: [2],
    targetDateInDays: -15,
    expect: "overdue",
    note: "Nearly finished AND two weeks overdue. Stays in Overdue, because a blown " +
      "date outranks a short queue, but line 2 still says what is left. The ranking " +
      "rule, and the reason a finished-but-late book is still findable.",
  },
  {
    code: "TIT", chapters: 1, perChapter: 15, bareRef: true,
    untranslated: 0, shortText: 2, shortAudio: 0, shortIn: [1],
    expect: "nearly_complete",
    note: "Canonical refs with no chapter, so its section key and its book code are " +
      "the SAME string. Its tile belongs in the extras row, not masquerading as " +
      "chapter 1 of something.",
  },
  {
    code: "PHM", chapters: 1, perChapter: 25,
    untranslated: 0, shortText: 7, shortAudio: 0, shortIn: [1],
    expect: "nearly_complete",
    note: "Twenty-five cells, seven short. Six percent of 25 is 1.5, so only the " +
      "seven-cell floor lets this qualify at all. Raise shortText to 8 and re-run: " +
      "it must drop out of the group.",
  },
  {
    code: "RUT", chapters: 4, perChapter: 10,
    untranslated: 0, shortText: 0, shortAudio: 0, shortIn: [],
    doneDaysAgo: 3,
    expect: "done",
    note: "Marked done by a human. Unchanged by all of this.",
  },
  {
    code: "OBA", chapters: 1, perChapter: 21,
    untranslated: 21, shortText: 21, shortAudio: 0, shortIn: [],
    expect: "not_started",
    note: "Nobody has typed a word. Must read Not started, never nearly complete — " +
      "short by everything is not almost done.",
  },
]

/**
 * THE AUDIO FILE — a separate Scripture file that is being dubbed.
 *
 * Its books are judged on text AND audio; the text file's books are not. That
 * split is the per-file gate doing its job.
 */
export const AUDIO_BOOKS: Book[] = [
  {
    code: "EXO", chapters: 20, perChapter: 10,
    untranslated: 0, shortText: 0, shortAudio: 4, shortIn: [3, 7],
    targetDateInDays: 4,
    expect: "soon",
    note: "Short on AUDIO only, and due this week. Due soon takes the group because " +
      "the date outranks, and line 2 still says '4 takes to record'.",
  },
  {
    code: "LUK", chapters: 24, perChapter: 10,
    untranslated: 0, shortText: 0, shortAudio: 9, shortIn: [11, 19],
    expect: "nearly_complete",
    note: "Text finished, nine takes missing, no date. Nearly complete BY AUDIO, and " +
      "the row reads '9 takes to record'. No link: the verse detail carries no audio, " +
      "so there is no cell to send anyone to.",
  },
  {
    code: "ACT", chapters: 28, perChapter: 10,
    untranslated: 20, shortText: 60, shortAudio: 150, shortIn: [],
    expect: "in_progress",
    note: "Three things outstanding and room on the row for two. Audio is the worst " +
      "medium and the one the grouping used, so the row must read '20 cells to " +
      "translate' and the 150 takes — validation gives way, translation does not.",
  },
  {
    code: "MRK", chapters: 16, perChapter: 10, audioOnHeadings: true,
    untranslated: 0, shortText: 0, shortAudio: 0, shortIn: [],
    expect: "nearly_complete",
    note: "Every verse AND every heading recorded, with the org excluding headings " +
      "from progress. The recorded headings must leave the audio numbers with the " +
      "headings themselves, so the AUD bar reads exactly 100% and the row says " +
      "'Nothing left' — never more audio than cells. Drop the structural-audio " +
      "subtraction and this is the book that goes over 100%.",
  },
]

export const ALL_BOOKS: Book[] = [...TEXT_BOOKS, ...AUDIO_BOOKS]

const AUDIO_CODES = new Set(AUDIO_BOOKS.map((b) => b.code))

export function fileOf(code: string): string {
  return AUDIO_CODES.has(code) ? AUDIO_FILE : TEXT_FILE
}

/** Which chapters carry the shortfall, in order. */
export function shortChapters(b: Book): number[] {
  const live = Array.from({ length: b.chapters }, (_, i) => i + 1)
    .filter((n) => !(b.missingChapters ?? []).includes(n))
  return b.shortIn.length > 0 ? b.shortIn : live
}

export interface FixtureCell {
  cellId: string
  /** The canonical ref, which is what decides the section and book keys. */
  ref: string
  /** Null on purpose in one place — see the Genesis 1:1 note below. */
  type: string | null
  /** '' when nobody has translated it. */
  target: string
  validated: boolean
  recorded: boolean
}

/** Structural per AQU-1083: the cell types a policy can subtract. */
export function isStructural(type: string | null): boolean {
  return type === "heading" || type === "paratext"
}

/**
 * Every cell of one book, with its state already decided.
 *
 * Throws rather than silently under-filling: a book asking for more outstanding
 * cells than its short chapters can hold would otherwise seed a fixture whose
 * printed intent and actual data disagree.
 */
export function cellsFor(b: Book): FixtureCell[] {
  const out: FixtureCell[] = []
  const chapters = shortChapters(b)

  // Spread each shortfall over its chapters round-robin, so a book short by
  // three across two chapters gets 2 and 1 rather than 3 and 0.
  const budget = { untranslated: b.untranslated, text: b.shortText, audio: b.shortAudio }
  const claim = (key: keyof typeof budget): boolean => {
    if (budget[key] <= 0) return false
    budget[key] -= 1
    return true
  }
  const short = new Map<string, { untranslated: boolean; unvalidated: boolean; norec: boolean }>()
  for (let v = 1; v <= b.perChapter; v += 1) {
    for (const ch of chapters) {
      // `untranslated` is a SUBSET of `shortText`: a cell nobody wrote is also
      // unvalidated. So the text budget is spent first and the untranslated
      // budget only ever deepens a cell already counted as short — otherwise
      // the two would draw from the same cells twice and a book asking for
      // 21 of each would need 42 slots to hold 21 short cells.
      const unvalidated = claim("text")
      const untranslated = unvalidated && claim("untranslated")
      const norec = claim("audio")
      if (unvalidated || norec) {
        short.set(`${ch}:${v}`, { untranslated, unvalidated, norec })
      }
    }
  }
  const unplaced = budget.untranslated + budget.text + budget.audio
  if (unplaced > 0) {
    throw new Error(
      `${b.code}: ${unplaced} outstanding cells had nowhere to go — ` +
      `${chapters.length} chapters of ${b.perChapter} cells. ` +
      `Widen shortIn or lower the shortfall.`,
    )
  }

  const dubbed = AUDIO_CODES.has(b.code)
  for (let ch = 1; ch <= b.chapters; ch += 1) {
    if ((b.missingChapters ?? []).includes(ch)) continue
    const chapterRef = b.bareRef ? b.code : `${b.code} ${ch}`
    // One heading per chapter. Headings are STRUCTURAL, and Dev Org excludes
    // structural cells from progress — which is the policy this fixture is
    // meant to be read under, and the one the null-safety fix is about.
    out.push({
      cellId: `${b.code}-${ch}-h`, ref: `${chapterRef}:0`, type: "heading",
      target: `Kapitel ${ch}`, validated: true,
      recorded: dubbed && (b.audioOnHeadings ?? false),
    })
    for (let v = 1; v <= b.perChapter; v += 1) {
      const s = short.get(`${ch}:${v}`)
      out.push({
        cellId: `${b.code}-${ch}-${v}`,
        ref: `${chapterRef}:${v}`,
        // Genesis 1:1 is left UNTYPED on purpose: a spreadsheet import the
        // classifier could not label. With headings excluded it must still be
        // counted and must still appear in the chapter detail. Before the
        // null-safety fix, a chapter of untyped cells came back EMPTY under
        // that policy rather than short.
        type: b.code === "GEN" && ch === 1 && v === 1 ? null : "verse",
        target: s?.untranslated ? "" : `Zieltext ${b.code} ${ch}:${v}`,
        validated: !s?.untranslated && !s?.unvalidated,
        recorded: dubbed && !s?.norec,
      })
    }
  }

  // Genesis front matter: refs with no chapter at all, which become a section
  // keyed by the bare book code. Two paratext cells and two untyped ones, so
  // the section survives the headings policy rather than being dropped whole.
  if (b.code === "GEN") {
    for (let i = 1; i <= 4; i += 1) {
      out.push({
        cellId: `GEN-fm-${i}`, ref: "GEN", type: i <= 2 ? "paratext" : null,
        target: `Vorwort ${i}`, validated: true, recorded: false,
      })
    }
  }
  return out
}

/** The five counts a `PlanUnit` carries, under the headings-excluded policy. */
export interface FixtureCounts {
  totalCount: number
  filledCount: number
  validatedCount: number
  audioCount: number
  audioValidatedCount: number
}

/**
 * What the projection should produce for one book.
 *
 * Structural cells leave EVERY count, audio included — the policy subtracts
 * `structural_audio_count` from the recordings exactly as it subtracts
 * `structural_count` from the cells (AQU-1278, migration 0094). Before that
 * column existed the denominator shrank and the numerator did not, and MRK —
 * whose headings are all recorded — came back with more audio than cells.
 * MRK still earns its place: it is what fails if the subtraction is dropped.
 */
export function expectedCounts(b: Book): FixtureCounts {
  const content = cellsFor(b).filter((c) => !isStructural(c.type))
  return {
    totalCount: content.length,
    filledCount: content.filter((c) => c.target !== "").length,
    validatedCount: content.filter((c) => c.validated && c.target !== "").length,
    audioCount: content.filter((c) => c.recorded).length,
    audioValidatedCount: 0,
  }
}

export interface FixtureAssignment {
  id: string
  user: number
  username: string
  book: string
  label: string
  lane: string
  deadlineInDays: number | null
  /** Chapters this person holds; empty means the whole book. */
  chapters: number[]
}

export const range = (a: number, b: number): number[] =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i)

/** Dev-org users, in the order the +N overflow should drop them. */
export const PEOPLE = [
  { user: 2, name: "alice" }, { user: 3, name: "bob" }, { user: 50, name: "carol" },
  { user: 1, name: "dev" }, { user: 37, name: "dev_01" }, { user: 175, name: "John" },
]

export const ASSIGNMENTS: FixtureAssignment[] = [
  { id: "a-gen-alice", user: 2, username: "alice", book: "GEN", label: "Genesis 1–30", lane: "", deadlineInDays: 30, chapters: range(1, 30) },
  { id: "a-gen-bob", user: 3, username: "bob", book: "GEN", label: "Genesis 31–50", lane: "", deadlineInDays: null, chapters: range(31, 50) },
  // Six people on one book: the row can draw three faces, so this is both the
  // "+N" case and the chip-degradation case.
  ...PEOPLE.map((p, i) => ({
    id: `a-deu-${p.name}`, user: p.user, username: p.name, book: "DEU",
    label: `Deuteronomy ${i * 5 + 1}–${i * 5 + 5}`,
    lane: "", deadlineInDays: null, chapters: range(i * 5 + 1, i * 5 + 5),
  })),
  // Pinned to the OTHER language: listed with a chip while German is open.
  { id: "a-jos-carol", user: 50, username: "carol", book: "JOS", label: "Joshua (whole book)", lane: LANE2, deadlineInDays: 75, chapters: [] },
  // Only part of Leviticus is spoken for, so the panel says how much is not.
  { id: "a-lev-alice", user: 2, username: "alice", book: "LEV", label: "Leviticus 1–10", lane: "", deadlineInDays: null, chapters: range(1, 10) },
]

/**
 * The cells one assignment actually holds.
 *
 * A missing chapter has to be filtered HERE rather than at each caller: Genesis
 * has no chapter 7, so "Genesis 1–30" claims a range that is one chapter
 * shorter than it reads, and an `assignment_cells` row for a cell that does not
 * exist would join to nothing and quietly shrink the person's own total.
 */
export function assignedCells(a: FixtureAssignment): Array<{ fileId: string; cellId: string }> {
  const book = ALL_BOOKS.find((b) => b.code === a.book)
  if (!book) throw new Error(`assignment ${a.id} names no book: ${a.book}`)
  const chapters = (a.chapters.length > 0 ? a.chapters : range(1, book.chapters))
    .filter((ch) => !(book.missingChapters ?? []).includes(ch))
  const fileId = fileOf(book.code)
  return chapters.flatMap((ch) =>
    range(1, book.perChapter).map((v) => ({ fileId, cellId: `${book.code}-${ch}-${v}` })),
  )
}
