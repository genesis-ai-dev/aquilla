// AQU-462 — original-language (Greek/Hebrew) alignment over Macula morphology.
//
// The regression these guard: Greek and Hebrew inflect so heavily that the
// surface form in a verse is frequently a hapax for the project's corpus, and a
// co-occurrence model can say nothing about a token it has seen once. Before
// this, that word simply had no alignment. The lemma is the shared form across
// every inflection, so it still carries the statistics — and pointed Hebrew has
// to survive tokenization for any of it to matter.

import { describe, it, expect } from "vitest"
import { buildAlignmentModel, type VersPair } from "./interlinear"
import {
  alignOriginalWords,
  originalWordsToText,
  LEMMA_CONFIDENCE_DISCOUNT,
} from "./macula-align"
import { parseMaculaTsv } from "@/lib/parsers/macula"
import type { MorphWord } from "@/lib/sync/morph-read"

const word = (
  wordSeq: number,
  surface: string,
  extra: Partial<Omit<MorphWord, "wordSeq" | "surface" | "cellId">> = {},
): MorphWord => ({ cellId: "c1", wordSeq, surface, ...extra })

/** Corpus in which the LEXICAL form λογος is attested against "word", but the
 *  accusative λογον this cell uses never occurs. */
const GREEK_PAIRS: VersPair[] = [
  { source: "λογος θεου", target: "word of god" },
  { source: "λογος ζωης", target: "word of life" },
  { source: "θεου ζωης", target: "god of life" },
]

describe("alignOriginalWords", () => {
  it("falls back to the lemma when the inflected surface form is unattested", () => {
    const model = buildAlignmentModel(GREEK_PAIRS)
    const [result] = alignOriginalWords(
      [word(1, "λογον", { lemma: "λογος" })],
      "word",
      model,
    )

    expect(result.basis).toBe("lemma")
    expect(result.tgtToken).toBe("word")
    expect(result.confidence).toBeGreaterThan(0)
  })

  it("prefers a direct surface match and marks it as such", () => {
    const model = buildAlignmentModel(GREEK_PAIRS)
    const [result] = alignOriginalWords(
      [word(1, "λογος", { lemma: "λογος" })],
      "word",
      model,
    )

    expect(result.basis).toBe("surface")
    expect(result.tgtToken).toBe("word")
  })

  it("discounts a lemma link below the same link found on the surface", () => {
    const model = buildAlignmentModel(GREEK_PAIRS)
    const viaSurface = alignOriginalWords([word(1, "λογος")], "word", model)[0]
    const viaLemma = alignOriginalWords(
      [word(1, "λογον", { lemma: "λογος" })],
      "word",
      model,
    )[0]

    expect(viaLemma.confidence).toBeCloseTo(viaSurface.confidence * LEMMA_CONFIDENCE_DISCOUNT, 10)
  })

  it("keeps a word the model cannot place, rather than dropping it", () => {
    const model = buildAlignmentModel(GREEK_PAIRS)
    const results = alignOriginalWords(
      [word(1, "λογος"), word(2, "αβρααμ", { lemma: "αβρααμ", strongsG: "G11" })],
      "word",
      model,
    )

    expect(results).toHaveLength(2)
    expect(results[1]).toMatchObject({
      wordSeq: 2,
      surface: "αβρααμ",
      basis: "none",
      tgtToken: null,
      confidence: 0,
    })
  })

  it("carries the morphology through to the caller", () => {
    const model = buildAlignmentModel(GREEK_PAIRS)
    const [result] = alignOriginalWords(
      [word(1, "λογος", { lemma: "λογος", morphCode: "N-NSM", strongsG: "G3056" })],
      "word",
      model,
    )

    expect(result).toMatchObject({
      lemma: "λογος",
      morphCode: "N-NSM",
      strongs: "G3056",
    })
  })

  it("aligns pointed Hebrew as whole words, not as consonant fragments", () => {
    const model = buildAlignmentModel([
      { source: "בְּרֵאשִׁית בָּרָא אֱלֹהִים", target: "in the beginning god created" },
      { source: "בָּרָא אֱלֹהִים אוֹר", target: "god created light" },
    ])
    const results = alignOriginalWords(
      [
        word(1, "בְּרֵאשִׁית", { lemma: "רֵאשִׁית", strongsH: "H7225" }),
        word(2, "בָּרָא", { lemma: "ברא", strongsH: "H1254" }),
        word(3, "אֱלֹהִים", { lemma: "אֱלֹהִים", strongsH: "H430" }),
      ],
      "in the beginning god created",
      model,
    )

    // Every word is placed, and each surface form is treated as ONE source
    // token: with the old letters-only tokenizer these three words shredded
    // into eleven fragments and nothing lined up.
    expect(results.map((r) => r.basis)).toEqual(["surface", "surface", "surface"])
    expect(results.every((r) => r.tgtToken !== null)).toBe(true)
  })

  it("keeps word→token mapping honest when a word tokenizes into two", () => {
    const model = buildAlignmentModel([
      { source: "אֶל־הָאָרֶץ טוֹב", target: "to the land good" },
      { source: "טוֹב מְאֹד", target: "good very" },
    ])
    const results = alignOriginalWords(
      [word(1, "אֶל־הָאָרֶץ"), word(2, "טוֹב")],
      "to the land good",
      model,
    )

    // The maqqef-joined first word owns two source tokens; the second word must
    // still read its own token rather than the tail of its neighbour.
    expect(results[1].surface).toBe("טוֹב")
    expect(results[1].tgtToken).toBe("good")
  })

  it("returns unaligned words for an empty target, a missing model, or no words", () => {
    const model = buildAlignmentModel(GREEK_PAIRS)
    expect(alignOriginalWords([], "word", model)).toEqual([])
    expect(alignOriginalWords([word(1, "λογος")], "   ", model)[0].basis).toBe("none")
    expect(alignOriginalWords([word(1, "λογος")], "word", null)[0].basis).toBe("none")
  })

  it("reconstructs the verse text from the morph rows", () => {
    expect(originalWordsToText([word(1, "λογος"), word(2, "θεου")])).toBe("λογος θεου")
  })
})

// ── Producer → consumer: the real parser's rows through the real aligner ─────
//
// AGENTS.md #12: a parser test plus a synthetic aligner test does not cover
// their composition. The Macula parser is what actually produces the words this
// module consumes (import.ts copies its `MaculaWordMorph` rows straight into
// `cell_word_morph`), and the verse string the alignment model trains on is the
// parser's own space-joined reconstruction — so the two have to be exercised
// together or a change to either can silently break the mapping.

describe("Macula parser output through alignOriginalWords", () => {
  const HEBREW_TSV = [
    "ref\ttext\tlemma\tmorph\tstrongnumber",
    "GEN 1:1!1\tבְּרֵאשִׁ֖ית\tרֵאשִׁית\tHR/Ncfsa\tH7225",
    "GEN 1:1!2\tבָּרָ֣א\tבָּרָא\tHVqp3ms\tH1254",
    "GEN 1:1!3\tאֱלֹהִ֑ים\tאֱלֹהִים\tHNcmpa\tH430",
    "GEN 1:2!1\tבָּרָ֣א\tבָּרָא\tHVqp3ms\tH1254",
    "GEN 1:2!2\tאֱלֹהִ֑ים\tאֱלֹהִים\tHNcmpa\tH430",
  ].join("\n")

  it("aligns a parsed verse against a model trained on parsed verses", () => {
    const parsed = parseMaculaTsv(HEBREW_TSV)

    // The corpus the app builds: the parser's reconstructed verse as source,
    // the translator's text as target.
    const model = buildAlignmentModel([
      { source: parsed.strings[0].original, target: "in the beginning god created" },
      { source: parsed.strings[1].original, target: "god created" },
    ])

    // The morph rows exactly as import.ts hands them to the server.
    const words: MorphWord[] = parsed.morphRows[0].map((w) => ({
      cellId: "c1",
      wordSeq: w.word_seq,
      surface: w.surface,
      ...(w.lemma ? { lemma: w.lemma } : {}),
      ...(w.morph_code ? { morphCode: w.morph_code } : {}),
      ...(w.strongs_h ? { strongsH: w.strongs_h } : {}),
    }))

    const results = alignOriginalWords(words, "in the beginning god created", model)

    expect(results.map((r) => r.wordSeq)).toEqual([1, 2, 3])
    // Row N carries verse word N's own morphology — the mapping the whole
    // interlinear rests on.
    expect(results[0]).toMatchObject({ lemma: "רֵאשִׁית", strongs: "H7225", morphCode: "HR/Ncfsa" })
    expect(results[2]).toMatchObject({ lemma: "אֱלֹהִים", strongs: "H430" })
    // And the pointed surface forms are placed, not shredded into consonants.
    expect(results.every((r) => r.basis !== "none")).toBe(true)
  })
})
