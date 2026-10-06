// AQU-1695 — Translation helps: the pack 1.1 `notes` and `terms` layers.
//
// What these tests protect, on real pack 1.1.0 data for John:
//   • only a note whose quote the pack found in ONE place is "anchored": its
//     words are the ones a translator will see highlighted. An ambiguous
//     note's words may be the wrong ones, and an unanchored or quote-less note
//     has none, so they are listed without highlights;
//   • a note or question on several verses reaches every verse it covers,
//     and a cell that covers several verses sees each one once;
//   • key terms are read per word, and a malformed item is skipped, never
//     thrown on (the client checks only each file's envelope).

import { describe, expect, it } from "vitest"
import {
  AMBIGUOUS_NOTE_4_51,
  QUESTION_4_9,
  QUOTELESS_NOTE_4_11,
  RANGE_NOTE_1_40,
  RANGE_QUESTION_4_14,
  RQUESTION_NOTE_4_9,
  SPLIT_NOTE_4_9,
  UNANCHORED_NOTE_5_12,
  jhn4Notes11,
  jhn4Terms11,
} from "./__fixtures__/jhn4-pack11"
import {
  buildNotesIndex,
  noteParagraphs,
  noteRange,
  notesFor,
  questionRange,
  questionsFor,
  refRange,
  termsOfWord,
} from "./helps-index"
import { parseLayer, type BkpNotesLayer, type BkpTermsLayer } from "./pack-types"

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id)
const index = buildNotesIndex(jhn4Notes11())
const noteById = (id: string) => {
  const note = jhn4Notes11().notes.find((candidate) => candidate.id === id)
  if (!note) throw new Error(`no note ${id}`)
  return note
}

describe("which notes are highlighted", () => {
  it("anchors JHN 4:9's three notes, in the pack's order, each on its own words", () => {
    const { anchored, other } = notesFor(index, ["JHN 4:9"])
    expect(ids(anchored)).toEqual(["tn:211088", RQUESTION_NOTE_4_9, SPLIT_NOTE_4_9])
    expect(other).toEqual([])
    // The rhetorical question spans 11 words; "οὐ & συνχρῶνται" two words that do not touch.
    expect(anchored[1].words).toHaveLength(11)
    expect(anchored[2].words).toEqual(["n43004009019", "n43004009021"])
  })

  it("never highlights an ambiguous, an unanchored or a quote-less note", () => {
    // Ambiguous: the pack picked one of several places for αὐτοῦ, which may be the wrong one.
    const at451 = notesFor(index, ["JHN 4:51"])
    expect(ids(at451.other)).toEqual([AMBIGUOUS_NOTE_4_51])
    expect(noteById(AMBIGUOUS_NOTE_4_51).words).toEqual(["n43004051003"])
    // Unanchored: UGNT word order that SBLGNT does not have.
    expect(ids(notesFor(index, ["JHN 5:12"]).other)).toEqual([UNANCHORED_NOTE_5_12])
    // No quote at all: General Information about "Sir".
    const at411 = notesFor(index, ["JHN 4:11"])
    expect(ids(at411.other)).toEqual([QUOTELESS_NOTE_4_11])
    expect(ids(at411.anchored)).toEqual(["tn:211097", "tn:211099"])
  })

  it("does not highlight an 'anchored' note that has no words", () => {
    const layer: BkpNotesLayer = {
      book: "JHN",
      notes: [{ id: "tn:1", ref: "JHN 4:9", anchor: "anchored", words: [], text: "Broken data." }],
      questions: [],
    }
    const { anchored, other } = notesFor(buildNotesIndex(layer), ["JHN 4:9"])
    expect(anchored).toEqual([])
    expect(ids(other)).toEqual(["tn:1"])
  })
})

describe("notes and questions on several verses", () => {
  it("shows a range note on every verse it covers, and on no other", () => {
    expect(ids(notesFor(index, ["JHN 1:41"]).other)).toEqual([RANGE_NOTE_1_40])
    expect(ids(notesFor(index, ["JHN 1:42"]).other)).toEqual([RANGE_NOTE_1_40])
    expect(notesFor(index, ["JHN 1:39"]).other).toEqual([])
    expect(notesFor(index, ["JHN 1:43"]).other).toEqual([])
    expect(noteRange(noteById(RANGE_NOTE_1_40))).toBe("JHN 1:40–42")
    expect(noteRange(noteById(RQUESTION_NOTE_4_9))).toBeNull()
  })

  it("gives a range question to each of its verses, once to a cell that holds both", () => {
    expect(ids(questionsFor(index, ["JHN 4:14"]))).toEqual([RANGE_QUESTION_4_14])
    expect(ids(questionsFor(index, ["JHN 4:15"]))).toEqual([RANGE_QUESTION_4_14])
    expect(ids(questionsFor(index, ["JHN 4:14", "JHN 4:15"]))).toEqual([RANGE_QUESTION_4_14])
    const [range] = questionsFor(index, ["JHN 4:14"])
    expect(questionRange(range)).toBe("JHN 4:14–15")
    const [single] = questionsFor(index, ["JHN 4:9"])
    expect(single.id).toBe(QUESTION_4_9)
    expect(questionRange(single)).toBeNull()
  })

  it("writes a range short, across chapters too", () => {
    expect(refRange("JHN 4:14", "JHN 4:15")).toBe("JHN 4:14–15")
    expect(refRange("JHN 4:54", "JHN 5:2")).toBe("JHN 4:54–5:2")
    expect(refRange("JHN 4:9", "JHN 4:9")).toBe("JHN 4:9")
  })
})

describe("a note's text", () => {
  it("splits paragraphs the pack kept as a backslash and an n", () => {
    // Pack 1.1.0 writes these two characters, not a line break (44 notes in John).
    expect(noteById(RANGE_NOTE_1_40).text).toContain("\\n\\n")
    expect(noteParagraphs(noteById(RANGE_NOTE_1_40).text)).toEqual([
      "General Information:",
      "Verses [40–42] give background information about Andrew and how he brought his brother Peter to Jesus.",
    ])
    expect(noteParagraphs("One.\nTwo.")).toEqual(["One.", "Two."])
  })
})

describe("key terms", () => {
  const terms = jhn4Terms11()

  it("reads the terms each word carries, and none for an untagged word", () => {
    // Σαμαρίτιδος and Ἰουδαῖος in JHN 4:9; λέγει carries none.
    expect(termsOfWord(terms, "n43004009007").map(({ id, term }) => [id, term.title, term.source])).toEqual([
      ["tw:samaria", "Samaria", "tw"],
    ])
    expect(termsOfWord(terms, "n43004009010").map(({ term }) => term.title)).toEqual(["Jew"])
    expect(termsOfWord(terms, "n43004009001")).toEqual([])
    // ζῶν in JHN 4:10 carries three ACAI keyterms.
    expect(termsOfWord(terms, "n43004010030").map(({ id }) => id)).toEqual([
      "keyterm:InnerSelf",
      "keyterm:Life",
      "keyterm:Live.2",
    ])
  })

  it("skips a term id the dictionary lacks and a term without a title", () => {
    const broken: BkpTermsLayer = {
      book: "JHN",
      words: { n43004009007: ["tw:samaria", "tw:missing", "tw:untitled"] },
      terms: {
        "tw:samaria": { title: "Samaria", source: "tw", strongs: ["4540"] },
        "tw:untitled": { title: "", source: "tw", strongs: [] },
      },
    }
    expect(termsOfWord(broken, "n43004009007").map(({ id }) => id)).toEqual(["tw:samaria"])
  })
})

describe("the pack client's envelope check for the 1.1 layers", () => {
  it("accepts the 1.1 files and keeps fields it does not know", () => {
    const raw = { ...JSON.parse(JSON.stringify(jhn4Notes11())), addedLater: { x: 1 } }
    expect(parseLayer("notes", "JHN", raw)).toMatchObject({ addedLater: { x: 1 } })
    expect(parseLayer("terms", "JHN", jhn4Terms11())).not.toBeNull()
  })

  it("rejects a notes file without its questions, and a terms file whose words are a list", () => {
    expect(parseLayer("notes", "JHN", { book: "JHN", notes: [] })).toBeNull()
    expect(parseLayer("terms", "JHN", { book: "JHN", words: [], terms: {} })).toBeNull()
    expect(parseLayer("notes", "MRK", jhn4Notes11())).toBeNull()
  })

  it("skips a malformed note or question instead of throwing", () => {
    const raw: unknown = {
      book: "JHN",
      notes: [null, { id: "tn:1", ref: "JHN 4:9" }, { id: "tn:2", ref: "JHN 4:9", text: "Kept." }],
      questions: [{ id: "tq:1", refs: [], q: "?", a: "!" }, { id: "tq:2", refs: ["JHN 4:9"], q: "Kept?", a: "Yes." }],
    }
    const layer = parseLayer("notes", "JHN", raw)
    if (!layer) throw new Error("the envelope is fine")
    const built = buildNotesIndex(layer)
    expect(ids(notesFor(built, ["JHN 4:9"]).other)).toEqual(["tn:2"])
    expect(ids(questionsFor(built, ["JHN 4:9"]))).toEqual(["tq:2"])
  })
})
