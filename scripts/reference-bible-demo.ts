// AQU-1573: the content of the reference Bible demo project, kept apart from
// the HTTP seed (scripts/dev-seed-reference-bible.ts) so a unit test can prove
// every row shows what the QA notes promise before anyone seeds it.
//
// Every verse a draft quotes is read from the committed texts
// (db/reference-bibles/*.tsv.gz, the same files the loader puts in the
// database), never typed in here, so the demo cannot drift from the Bibles a
// server holds. A row's draft is derived from the verse: copied exactly,
// copied without vowel marks, copied with one word changed, or written fresh.

import { readManifest, readVerses } from "./reference-bibles"

export const DEMO_PROJECT_ID = "019fa157-3000-7000-8000-000000001573"
export const DEMO_PROJECT_NAME = "Sermon demo — reference Bible"
/**
 * Ids are derived from a GENERATION so a re-seed always lands on rows it owns:
 * generation 0 normally, the next one only after somebody deleted the demo
 * file (a deleted file's ids can never be reused: event ids are global).
 */
export function demoFileId(generation = 0): string {
  return `019fa157-30${hex2(generation)}-7000-8000-000000000001`
}
export function demoFileEventId(generation = 0): string {
  return `019fa157-30${hex2(generation)}-7000-8000-000000000002`
}
/** How many deleted copies of the demo file a re-seed steps past before giving up. */
export const MAX_DEMO_GENERATIONS = 32
export const DEMO_FILE_NAME = "The Journey — session 1 (sample).md"

/** The extra target lane: Plain English quoting the KJV. */
export const ENGLISH_LANE = { tag: "en", name: "Plain English" } as const

export const DEMO_SETTINGS = {
  sourceLanguage: "English",
  targetLanguage: "Arabic",
  bibleResourcesEnabled: false,
  referenceBibleVersions: { "": "arb-vandyck", [ENGLISH_LANE.tag]: "eng-kjv" },
} as const

export const DEMO_BIBLE_IDS = ["arb-vandyck", "eng-kjv"] as const

/**
 * What the "Reference Bible quotes" check shows on a row:
 *   clean    nothing from the check;
 *   differs  "The quote of … does not match … word for word";
 *   missing  "The source quotes …, but the translation does not use the … wording";
 *   empty    the row is left blank for a drafting test (only "Empty translation").
 */
export type DemoExpectation = "clean" | "differs" | "missing" | "empty"

export interface DemoRow {
  /** 1-based position in the file, as the QA notes number the rows. */
  n: number
  /** Which copy of the demo file the ids belong to (see demoFileId). */
  generation: number
  cellId: string
  /** The source.cell.create event id (a target's first parent). */
  sourceEventId: string
  type: "heading" | "text"
  source: string
  /** Seeded target per lane tag ("" = Arabic, the default lane); "" = left blank. */
  targets: Record<string, string>
  expect: Record<string, DemoExpectation>
  /** One line for the QA notes: what to look at on this row. */
  note: string
}

function hex2(generation: number): string {
  if (!Number.isInteger(generation) || generation < 0 || generation >= MAX_DEMO_GENERATIONS) {
    throw new Error(`demo seed: generation ${generation} is out of range`)
  }
  return generation.toString(16).padStart(2, "0")
}
const id = (group: number, generation: number, n: number) =>
  `019fa157-3${group}${hex2(generation)}-7000-8000-${n.toString(16).padStart(12, "0")}`

/** Verse text from a committed Bible: one verse, or a range joined by spaces. */
export type VerseReader = (versionId: string, book: string, chapter: number, from: number, to?: number) => string

export function committedVerseReader(): VerseReader {
  const byVersion = new Map<string, Map<string, string>>()
  for (const entry of readManifest()) {
    if (!(DEMO_BIBLE_IDS as readonly string[]).includes(entry.id)) continue
    byVersion.set(entry.id, new Map(readVerses(entry).map((r) => [`${r.book} ${r.chapter}:${r.verse}`, r.text])))
  }
  return (versionId, book, chapter, from, to = from) => {
    const verses = byVersion.get(versionId)
    if (!verses) throw new Error(`reference Bible "${versionId}" is not in db/reference-bibles/manifest.json`)
    const out: string[] = []
    for (let v = from; v <= to; v++) {
      const text = verses.get(`${book} ${chapter}:${v}`)
      if (!text) throw new Error(`${versionId} has no ${book} ${chapter}:${v}`)
      out.push(text)
    }
    return out.join(" ")
  }
}

/** What a writer who does not type vowel marks produces from a vowelled verse. */
export function withoutVowelMarks(text: string): string {
  return text.normalize("NFC").replace(/\p{M}/gu, "").replace(/ٱ/g, "ا")
}

/** Replace exactly one word, failing loudly if the verse no longer holds it. */
function changeWord(verse: string, from: string, to: string): string {
  if (!verse.includes(from)) throw new Error(`demo seed: "${from}" is not in "${verse}"`)
  return verse.replace(from, to)
}

/** The demo file, row by row, derived from the committed Bibles. */
export function buildDemoRows(read: VerseReader = committedVerseReader(), generation = 0): DemoRow[] {
  const arb = (book: string, chapter: number, from: number, to?: number) => read("arb-vandyck", book, chapter, from, to)
  const kjv = (book: string, chapter: number, from: number, to?: number) => read("eng-kjv", book, chapter, from, to)

  // Romans 8:28 with ONE word changed: "for good" → "for the best".
  const rom828Changed = changeWord(arb("ROM", 8, 28), "لِلْخَيْرِ", "لِلصَّلَاحِ")
  const kjvRom828Changed = changeWord(kjv("ROM", 8, 28), "work together for good", "work together for the best")
  // 1 Corinthians 13:4's opening clause, as a writer without vowel marks types it.
  const loveIsPatient = withoutVowelMarks(arb("1CO", 13, 4).split(".")[0])

  const rows: Omit<DemoRow, "n" | "generation" | "cellId" | "sourceEventId">[] = [
    {
      type: "heading",
      source: "Who is God?",
      targets: { "": "من هو الله؟" },
      expect: { "": "clean" },
      note: "A heading with no reference: clean.",
    },
    {
      type: "text",
      source: "Every one of us carries a picture of God in our minds.",
      targets: { "": "كل واحد منا يحمل في ذهنه صورة عن الله." },
      expect: { "": "clean" },
      note: "Plain prose with no reference: clean.",
    },
    {
      type: "text",
      source: 'Isaiah 40:25 says, "To whom will you compare me? Or who is my equal?" says the Holy One.',
      targets: { "": "" },
      expect: { "": "empty" },
      note: "Left blank. Draft it: the draft must carry the Van Dyck wording of Isaiah 40:25, and no quote warning.",
    },
    {
      type: "text",
      source: '"For God so loved the world that he gave his one and only Son" (John 3:16).',
      targets: {
        "": `يقول الكتاب: «${arb("JHN", 3, 16)}» (يوحنا 3: 16).`,
        [ENGLISH_LANE.tag]: `"${kjv("JHN", 3, 16)}" (John 3:16).`,
      },
      expect: { "": "clean", [ENGLISH_LANE.tag]: "clean" },
      note: "The exact Bible wording (vowelled Van Dyck; KJV in Plain English): clean. Change one word to see a live warning.",
    },
    {
      type: "text",
      source: '1 Cor. 13:4–7 tells us, "Love is patient, love is kind."',
      targets: { "": `تخبرنا 1 كورنثوس 13: 4–7 قائلة: «${loveIsPatient}.»` },
      expect: { "": "clean" },
      note: "Only the opening of the passage, typed without vowel marks: clean (partial quotes and missing vowels are fine).",
    },
    {
      type: "text",
      source: 'Romans 8:28: "And we know that in all things God works for the good of those who love him."',
      targets: {
        "": `رومية 8: 28: «${rom828Changed}»`,
        [ENGLISH_LANE.tag]: `Romans 8:28: "${kjvRom828Changed}"`,
      },
      expect: { "": "differs", [ENGLISH_LANE.tag]: "differs" },
      note: "One word changed inside the quote: warns that the quote does not match word for word.",
    },
    {
      type: "text",
      source: 'The psalmist writes, "The Lord is my shepherd, I lack nothing" (Ps 23:1).',
      targets: { "": "يكتب المرنم: «الرب هو راعيّ، لن أحتاج إلى شيء» (مزمور 23: 1)." },
      expect: { "": "missing" },
      note: "A fresh translation of a quoted verse: warns that the translation does not use the Van Dyck wording.",
    },
    {
      type: "text",
      source: "Later we'll look at Philippians 4:13.",
      targets: { "": "سننظر لاحقًا في فيلبي 4: 13." },
      expect: { "": "clean" },
      note: "Only mentions a verse, quotes nothing: clean.",
    },
    {
      type: "text",
      source: "God works all things together for good, even when we cannot see it.",
      targets: { "": "الله يعمل كل الأشياء معًا للخير، حتى عندما لا نرى ذلك." },
      expect: { "": "clean" },
      note: "An allusion with no reference: clean, and drafting adds no verses.",
    },
    {
      type: "text",
      source: "Romans 5:8; John 15:13 show us how far his love goes.",
      targets: { "": "" },
      expect: { "": "empty" },
      note: "Left blank. Draft it: both Romans 5:8 and John 15:13 come from Van Dyck.",
    },
    {
      type: "text",
      source: "Read Romans 8 this week.",
      targets: { "": "" },
      expect: { "": "empty" },
      note: "Left blank. A chapter on its own is not a verse: drafting adds no verses.",
    },
    {
      type: "text",
      source: "John chapter 3, verse 16 is the verse many of us learned first.",
      targets: { "": "" },
      expect: { "": "empty" },
      note: "Left blank. Spoken form: drafting adds John 3:16 from Van Dyck.",
    },
  ]
  return rows.map((row, i) => ({
    ...row,
    n: i + 1,
    generation,
    cellId: id(1, generation, i + 1),
    sourceEventId: id(2, generation, i + 1),
  }))
}

/** Every lane tag the demo seeds targets in ("" first). */
export function demoLanes(rows: readonly DemoRow[]): string[] {
  const lanes = new Set<string>([""])
  for (const row of rows) for (const lane of Object.keys(row.targets)) lanes.add(lane)
  return [...lanes]
}

/** Deterministic id of the import-time target commit of a row in a lane. */
export function seededTargetEventId(row: DemoRow, lane: string): string {
  return id(lane === "" ? 3 : 4, row.generation, row.n)
}
