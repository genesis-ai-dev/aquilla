import { describe, it, expect } from "vitest"
import {
  buildGlosser,
  btSeedsFromAlignmentSeeds,
  ALIGNMENT_SEED_BT_WEIGHT,
  type BtSeed,
} from "./bt-glosser"
import type { AlignmentSeed } from "./interlinear"

// ── Deterministic gloss on known pairs ───────────────────────────────────────

describe("buildGlosser — basic alignment", () => {
  it("glosses a target word that appeared in a known pair", () => {
    const pairs = [
      { source: "In the beginning", target: "Au commencement" },
      { source: "God created", target: "Dieu créa" },
    ]
    const glosser = buildGlosser(pairs)

    // "Dieu" aligned with "God" → gloss should include "god"
    const result = glosser.gloss("Dieu créa")
    expect(result.toLowerCase()).toContain("god")
  })

  it("returns literal tokens when no model data matches", () => {
    const glosser = buildGlosser([])
    const result = glosser.gloss("unknown word")
    // No pairs → returns tokenized literal
    expect(result).toBe("unknown word")
  })

  it("produces deterministic output for the same input", () => {
    const pairs = [
      { source: "the word", target: "le mot" },
      { source: "in the beginning", target: "au commencement" },
    ]
    const glosser = buildGlosser(pairs)
    const r1 = glosser.gloss("le mot")
    const r2 = glosser.gloss("le mot")
    expect(r1).toBe(r2)
  })

  it("uses bigram context when available", () => {
    const pairs = [
      { source: "the light", target: "la lumière" },
      { source: "the darkness", target: "les ténèbres" },
    ]
    const glosser = buildGlosser(pairs)
    // "lumière" should map to "light"
    const result = glosser.gloss("la lumière")
    expect(result.toLowerCase()).toContain("light")
  })
})

// ── Seed weighting ────────────────────────────────────────────────────────────

describe("buildGlosser — seed weighting", () => {
  it("positive seed boosts the alignment", () => {
    const pairs = [
      { source: "word", target: "mot" },
    ]
    const seeds: BtSeed[] = [
      { source: "scripture", target: "mot", weight: 10 },
    ]
    const glosser = buildGlosser(pairs, seeds)
    // "scripture" seed has weight 10×5=50; "word" corpus has weight ~1
    // so "scripture" should win
    const result = glosser.gloss("le mot")
    expect(result.toLowerCase()).toContain("scripture")
  })

  it("negative seed penalizes a forbidden alignment", () => {
    const pairs = [
      { source: "darkness", target: "ténèbres" },
    ]
    const seeds: BtSeed[] = [
      { source: "darkness", target: "ténèbres", weight: -100 },
    ]
    const glosser = buildGlosser(pairs, seeds)
    // Score for "darkness" → "ténèbres" should go negative → fall back to literal
    const result = glosser.gloss("ténèbres")
    // With negative score, best candidate is filtered out → literal token returned
    expect(result.toLowerCase()).toContain("ténèbres")
  })

  it("zero-weight seed is ignored", () => {
    const pairs = [{ source: "god", target: "dieu" }]
    const seeds: BtSeed[] = [{ source: "deity", target: "dieu", weight: 0 }]
    const glosser = buildGlosser(pairs, seeds)
    const result = glosser.gloss("dieu")
    // Zero seed is a no-op — corpus alignment should survive
    expect(result.toLowerCase()).toContain("god")
  })
})

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("buildGlosser — edge cases", () => {
  it("returns empty string for empty input", () => {
    const glosser = buildGlosser([{ source: "a", target: "b" }])
    expect(glosser.gloss("")).toBe("")
  })

  it("returns empty string for whitespace-only input", () => {
    const glosser = buildGlosser([])
    expect(glosser.gloss("   ")).toBe("")
  })

  it("handles a single-word corpus gracefully", () => {
    const glosser = buildGlosser([{ source: "yes", target: "oui" }])
    const result = glosser.gloss("oui")
    expect(result.toLowerCase()).toBe("yes")
  })

  it("does not throw on a large input with no pairs", () => {
    const glosser = buildGlosser([])
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ")
    expect(() => glosser.gloss(long)).not.toThrow()
  })

  it("handles pairs with empty source or target gracefully", () => {
    const pairs = [
      { source: "", target: "something" },
      { source: "else", target: "" },
      { source: "good", target: "bon" },
    ]
    const glosser = buildGlosser(pairs)
    // Empty pairs are skipped; "bon" → "good" should still work
    expect(glosser.gloss("bon").toLowerCase()).toContain("good")
  })

  it("handles repeated pairs (multiple observations reinforce alignment)", () => {
    const pairs = Array.from({ length: 10 }, () => ({
      source: "light",
      target: "luz",
    }))
    const glosser = buildGlosser(pairs)
    const result = glosser.gloss("luz")
    expect(result.toLowerCase()).toBe("light")
  })

  it("does not throw when pairs array is empty and seeds are provided", () => {
    const seeds: BtSeed[] = [{ source: "grace", target: "gracia", weight: 5 }]
    const glosser = buildGlosser([], seeds)
    expect(() => glosser.gloss("gracia")).not.toThrow()
    const result = glosser.gloss("gracia")
    expect(result.toLowerCase()).toContain("grace")
  })
})

// ── BUG-BT-5: runaway repetition guard ───────────────────────────────────────

describe("buildGlosser — repetition guard (BUG-BT-5)", () => {
  /**
   * Regression: the statistical glosser used to produce runaway output like
   * "regent university serves regent university serves regent university serves…"
   * (~30×) because every target token mapped to the same winning source phrase
   * from the corpus.
   *
   * This test builds a corpus that biases "regent university" as the top-scored
   * alignment for almost every target token, then asserts the output is bounded
   * and does not contain long consecutive repetition.
   */
  it("does not produce runaway repetition when one phrase dominates the model", () => {
    // Build a corpus where "regent university" appears as source for MANY
    // different target words — this is exactly the scenario that caused runaway.
    const pairs = Array.from({ length: 20 }, () => ({
      source: "regent university",
      target: "regent university serves as a center of christian thought",
    }))

    const glosser = buildGlosser(pairs)
    const target = "regent university serves as a center of christian thought"
    const inputTokenCount = target.split(/\s+/).length // 9 tokens

    const result = glosser.gloss(target)
    const outputTokens = result.split(/\s+/).filter(Boolean)

    // Length cap: must be ≤ ~2× input + 10
    const maxAllowedTokens = inputTokenCount * 2 + 10
    expect(outputTokens.length).toBeLessThanOrEqual(maxAllowedTokens)

    // Repetition break: no single phrase should appear more than 2× in a row
    // (check every consecutive window of 3 tokens — if all three are the same
    // two-word phrase "regent university" that's 6 identical tokens in a row)
    const phrase = "regent university"
    const phraseWords = phrase.split(" ")
    let consecutiveMatches = 0
    let maxConsecutiveMatches = 0
    for (let i = 0; i <= outputTokens.length - phraseWords.length; i++) {
      const window = outputTokens.slice(i, i + phraseWords.length).join(" ")
      if (window === phrase) {
        consecutiveMatches++
        maxConsecutiveMatches = Math.max(maxConsecutiveMatches, consecutiveMatches)
      } else {
        consecutiveMatches = 0
      }
    }
    // At most MAX_CONSECUTIVE_REPEATS (2) consecutive occurrences of the phrase
    expect(maxConsecutiveMatches).toBeLessThanOrEqual(2)
  })

  it("output length is bounded to ~2× input token count", () => {
    // Corpus with many pairs all mapping to the same short source phrase,
    // simulating a highly skewed alignment model.
    const pairs = Array.from({ length: 30 }, (_, i) => ({
      source: "foo bar",
      target: `word${i} token${i} extra${i}`,
    }))

    const glosser = buildGlosser(pairs)
    // A long input where most tokens map to the same "foo bar" phrase
    const target = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")
    const inputTokenCount = 40

    const result = glosser.gloss(target)
    const outputTokens = result.split(/\s+/).filter(Boolean)

    expect(outputTokens.length).toBeLessThanOrEqual(inputTokenCount * 2 + 10)
  })

  it("keeps a dominant phrase suppressed instead of letting an interrupting literal reset the cooldown", () => {
    // Regression (AQU-203 follow-up): the repetition guard reset its cooldown
    // counter against whatever literal token it fell back to. A single
    // interrupting literal then let the SAME dominant phrase win again on the
    // very next token, producing "the the X the the X the the X..." — a
    // stutter broken only by isolated single-word interruptions, still live
    // on dev after PR #538.
    //
    // Every distinct target word below aligns strongly to the same one-word
    // source "the", so each target token individually re-triggers the
    // dominant alignment — exactly the shape that exposed the reset bug.
    const targetWords = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"]
    const pairs = targetWords.flatMap((word) =>
      Array.from({ length: 5 }, () => ({ source: "the", target: word })),
    )

    const glosser = buildGlosser(pairs)
    const result = glosser.gloss(targetWords.join(" "))
    const outputTokens = result.split(/\s+/).filter(Boolean)

    const theCount = outputTokens.filter((t) => t === "the").length
    // Once the cooldown breaks the run, "the" must not keep winning again on
    // later tokens — it should appear only for the initial run before the
    // guard first fires, not resurface after every interrupting literal.
    expect(theCount).toBeLessThanOrEqual(2)
  })

  it("breaks a two-phrase alternating cycle, not just a single repeated phrase", () => {
    // Regression: the single-phrase guard only ever compared the candidate to
    // the ONE immediately preceding phrase, so it never caught two phrases
    // that are each other's dominant winner taking turns — "cat dog cat dog
    // cat dog…" — since no single phrase repeats three times *in a row*.
    // This is exactly what happened on dev: two Bible-heavy source words
    // (e.g. "the lord"/"said") so dominant they kept winning the argmax back
    // and forth for every alternating target token, still stuttering after
    // the interrupting-literal fix above.
    const groupA = ["mrowa1", "mrowa2", "mrowa3", "mrowa4"]
    const groupB = ["zarb1", "zarb2", "zarb3", "zarb4"]
    const pairs = [
      ...groupA.flatMap((w) => Array.from({ length: 10 }, () => ({ source: "cat", target: w }))),
      ...groupB.flatMap((w) => Array.from({ length: 10 }, () => ({ source: "dog", target: w }))),
    ]
    const glosser = buildGlosser(pairs)

    const targetWords: string[] = []
    for (let i = 0; i < 6; i++) {
      targetWords.push(groupA[i % groupA.length])
      targetWords.push(groupB[i % groupB.length])
    }

    const result = glosser.gloss(targetWords.join(" "))
    const outputTokens = result.split(/\s+/).filter(Boolean)

    // "cat" and "dog" alternating must not run past the same
    // MAX_CONSECUTIVE_REPEATS cap a single repeated phrase is held to: at
    // most 2 full [cat, dog] cycles (4 tokens) before the guard breaks it.
    let consecutiveCatDog = 0
    let maxConsecutiveCatDog = 0
    for (let i = 0; i + 1 < outputTokens.length; i += 2) {
      if (outputTokens[i] === "cat" && outputTokens[i + 1] === "dog") {
        consecutiveCatDog++
        maxConsecutiveCatDog = Math.max(maxConsecutiveCatDog, consecutiveCatDog)
      } else {
        consecutiveCatDog = 0
      }
    }
    expect(maxConsecutiveCatDog).toBeLessThanOrEqual(2)
  })
})

// ── Phrase-boundary duplicate words ("the the heaven", "was was without") ────

describe("buildGlosser — phrase-boundary de-duplication", () => {
  /**
   * Regression: reported from dev.aquilla.app as "the English gets duplicated
   * on key words or connecting words" in back-translations from other
   * languages. Root cause verified against this exact corpus: the decoder
   * picks the best-scoring source phrase for each target n-gram window
   * independently, so two ADJACENT windows can each legitimately resolve to
   * a source phrase that borders the same word — e.g. one window's winning
   * phrase is "god created the" (ends "the") and the very next window's is
   * "the heaven and" (starts "the"), concatenating to "created the the
   * heaven and". This is a property of phrase-based decoding, not of any
   * particular language (confirmed here with two English translations, KJV
   * and WEB, on both sides).
   */
  const genesisPairs = [
    { source: "In the beginning God created the heaven and the earth.",
      target: "In the beginning, God created the heavens and the earth." },
    { source: "And the earth was without form, and void; and darkness was upon the face of the deep. And the Spirit of God moved upon the face of the waters.",
      target: "The earth was formless and empty. Darkness was on the surface of the deep and God's Spirit was hovering over the surface of the waters." },
    { source: "And God said, Let there be light: and there was light.",
      target: "God said, Let there be light, and there was light." },
    { source: "And God saw the light, that it was good: and God divided the light from the darkness.",
      target: "God saw the light, and saw that it was good. God divided the light from the darkness." },
    { source: "And God called the light Day, and the darkness he called Night. And the evening and the morning were the first day.",
      target: "God called the light Day, and the darkness he called Night. There was evening and there was morning, the first day." },
    { source: "And God said, Let there be a firmament in the midst of the waters, and let it divide the waters from the waters.",
      target: "God said, Let there be an expanse in the middle of the waters, and let it divide the waters from the waters." },
    { source: "And God made the firmament, and divided the waters which were under the firmament from the waters which were above the firmament: and it was so.",
      target: "God made the expanse, and divided the waters which were under the expanse from the waters which were above the expanse, and it was so." },
    { source: "And God called the firmament Heaven. And the evening and the morning were the second day.",
      target: "God called the expanse sky. There was evening and there was morning, a second day." },
    { source: "And God said, Let the waters under the heaven be gathered together unto one place, and let the dry land appear: and it was so.",
      target: "God said, Let the waters under the sky be gathered together to one place, and let the dry land appear, and it was so." },
    { source: "And God called the dry land Earth; and the gathering together of the waters called he Seas: and God saw that it was good.",
      target: "God called the dry land earth, and the gathering together of the waters he called seas. God saw that it was good." },
  ]

  it("never emits the same word twice in a row from adjacent independently-chosen phrases", () => {
    const glosser = buildGlosser(genesisPairs)

    for (const { target } of genesisPairs.slice(0, 5)) {
      const outputTokens = glosser.gloss(target).split(/\s+/).filter(Boolean)
      for (let i = 1; i < outputTokens.length; i++) {
        expect(outputTokens[i], `adjacent duplicate in gloss of "${target}": ...${outputTokens[i - 1]} ${outputTokens[i]}...`)
          .not.toBe(outputTokens[i - 1])
      }
    }
  })

  it("still passes through a genuinely repeated target word via literal fallback", () => {
    // The de-dup only trims a model-selected phrase's own boundary overlap —
    // it must never silently drop a word the target text actually repeats.
    const glosser = buildGlosser([{ source: "unrelated", target: "unrelated" }])
    expect(glosser.gloss("mystery mystery mystery")).toBe("mystery mystery mystery")
  })
})

// ── AQU-203: function words must not win the argmax ──────────────────────────

describe("buildGlosser — frequency normalization (AQU-203)", () => {
  /**
   * Regression: ranking on RAW co-occurrence made the winner for any target
   * phrase whichever source phrase was most frequent in the corpus overall.
   * Function words co-occur with everything, so "the" beat the content word
   * that actually aligned. Reported from Project 503, Genesis 1:1: a Spanish
   * target back-translated as "the God created the, the, the".
   *
   * This corpus is the shape that produced it — "the" appears in more pairs
   * (and more times per pair) than "god", so raw counts put "the" ahead of
   * "god" as the gloss for "dios" (9 observations vs 5).
   */
  const corpus = [
    {
      source: "In the beginning God created the heavens and the earth",
      target: "En el principio Dios creó los cielos y la tierra",
    },
    {
      source: "And God said let there be light and there was light",
      target: "Y Dios dijo sea la luz y fue la luz",
    },
    {
      source: "And God saw the light that it was good",
      target: "Y Dios vio la luz que era buena",
    },
    {
      source: "And God called the light day and the darkness he called night",
      target: "Y Dios llamó a la luz día y a las tinieblas llamó noche",
    },
    {
      source: "And the earth was without form and void",
      target: "Y la tierra estaba desordenada y vacía",
    },
    {
      source: "And the Spirit of God moved upon the face of the waters",
      target: "Y el Espíritu de Dios se movía sobre la faz de las aguas",
    },
    {
      source: "And the evening and the morning were the first day",
      target: "Y fue la tarde y la mañana el primer día",
    },
  ]

  it("glosses a content word to its aligned source, not to the most frequent function word", () => {
    const glosser = buildGlosser(corpus)
    // "dios" co-occurs with "god" in 5 pairs and with "the" in 4 — but "the"
    // occurs multiple times per sentence, so raw counting picked "the".
    expect(glosser.gloss("dios")).toBe("god")
  })

  it("back-translates a corpus sentence without collapsing into function words", () => {
    const glosser = buildGlosser(corpus)
    const result = glosser.gloss("En el principio Dios creó los cielos y la tierra")
    const tokens = result.split(/\s+/).filter(Boolean)

    // The content words must survive.
    expect(result).toContain("god")
    expect(result).toContain("beginning")

    // And the output must not be mostly one function word: the reported bug
    // ("the God created the, the, the") was >40% "the".
    const theCount = tokens.filter((t) => t === "the").length
    expect(theCount).toBeLessThan(tokens.length / 3)
  })

  it("does not let a phrase that co-occurs with everything win a specific alignment", () => {
    // "ubiquitous" appears in every source; "cat" only in the pair with "gato".
    const pairs = [
      { source: "ubiquitous cat", target: "gato" },
      { source: "ubiquitous dog", target: "perro" },
      { source: "ubiquitous bird", target: "pájaro" },
      { source: "ubiquitous fish", target: "pez" },
    ]
    const glosser = buildGlosser(pairs)
    // The specific content word must be present, and the phrase that co-occurs
    // with every target must not win on its own.
    expect(glosser.gloss("gato")).toContain("cat")
    expect(glosser.gloss("gato")).not.toBe("ubiquitous")
    expect(glosser.gloss("perro")).toContain("dog")
    expect(glosser.gloss("perro")).not.toBe("ubiquitous")
  })

  it("counts a repeated source phrase once per pair, not once per occurrence", () => {
    // "of" appears 3× in the first source and 0× elsewhere; "book" appears once.
    // Per-occurrence counting made "of" a 3× stronger candidate than "book".
    const pairs = [
      { source: "the book of the son of the king of israel", target: "libro" },
      { source: "of of of", target: "otro" },
    ]
    const glosser = buildGlosser(pairs)
    expect(glosser.gloss("libro")).not.toBe("of")
  })
})

// The model collapses each target phrase's candidates to its single argmax for
// memory (the decoder only ever reads the best-scoring source). These guard
// that the argmax actually survives the collapse — i.e. the WINNER is kept, not
// an arbitrary or last-seen candidate. A regression here = collapse keeping the
// wrong entry, which single-candidate corpora wouldn't catch.
describe("buildGlosser — argmax survives candidate collapse", () => {
  it("keeps the most-reinforced source when a target word has competing candidates", () => {
    // "casa" co-occurs with "house" in 3 pairs but with "home" in only 1.
    // After collapse, glossing "casa" must yield the argmax ("house").
    const pairs = [
      { source: "house", target: "casa" },
      { source: "house", target: "casa" },
      { source: "house", target: "casa" },
      { source: "home", target: "casa" },
    ]
    const glosser = buildGlosser(pairs)
    expect(glosser.gloss("casa")).toBe("house")
  })

  it("a positive seed can flip the surviving argmax", () => {
    // Corpus favors "house"; a strong positive seed for "home" should win.
    const pairs = [
      { source: "house", target: "casa" },
      { source: "house", target: "casa" },
    ]
    const seeds: BtSeed[] = [{ source: "home", target: "casa", weight: 5 }]
    const glosser = buildGlosser(pairs, seeds)
    expect(glosser.gloss("casa")).toBe("home")
  })
})

// ── AQU-207: confirmed interlinear alignments feed the statistical BT ─────────

describe("btSeedsFromAlignmentSeeds — AQU-207 adapter", () => {
  it("maps srcToken/tgtToken positionally without swapping orientation", () => {
    // Both types are source-language → target-language. A swap here would make
    // every confirmation train the glosser backwards.
    expect(btSeedsFromAlignmentSeeds([{ srcToken: "word", tgtToken: "mot", weight: 1 }])).toEqual([
      { source: "word", target: "mot", weight: ALIGNMENT_SEED_BT_WEIGHT },
    ])
  })

  it("carries the sign through so an invalidation penalizes", () => {
    const [seed] = btSeedsFromAlignmentSeeds([{ srcToken: "word", tgtToken: "mot", weight: -1 }])
    expect(seed.weight).toBe(-ALIGNMENT_SEED_BT_WEIGHT)
  })

  it("drops zero-weight and blank-token seeds", () => {
    expect(
      btSeedsFromAlignmentSeeds([
        { srcToken: "word", tgtToken: "mot", weight: 0 },
        { srcToken: "  ", tgtToken: "mot", weight: 1 },
        { srcToken: "word", tgtToken: "", weight: 1 },
      ]),
    ).toEqual([])
  })
})

describe("AQU-207 — a confirmed alignment measurably influences BT output", () => {
  // These pass the producer's real output (the AlignmentSeed shape that
  // InterlinearAlignmentPanel.onSeedChange emits, persisted as
  // ProjectRecord.alignmentSeeds) through the immediate consumer (buildGlosser),
  // which is the composition the regression escaped at: the seeds were persisted
  // and fed back into interlinear.ts's own model, but never reached the glosser,
  // so confirming an alignment left the BT the user reads unchanged.

  it("confirming an alignment changes the gloss for that target token", () => {
    const pairs = [{ source: "word", target: "mot" }]
    const before = buildGlosser(pairs, [])
    expect(before.gloss("mot")).toBe("word")

    // Exactly what the panel emits on Confirm.
    const confirmed: AlignmentSeed[] = [{ srcToken: "scripture", tgtToken: "mot", weight: 1 }]
    const after = buildGlosser(pairs, btSeedsFromAlignmentSeeds(confirmed))
    expect(after.gloss("mot")).toBe("scripture")
  })

  it("invalidating an alignment demotes it below the runner-up", () => {
    const pairs = [
      { source: "word", target: "mot" },
      { source: "word", target: "mot" },
      { source: "term", target: "mot" },
    ]
    const before = buildGlosser(pairs, [])
    expect(before.gloss("mot")).toBe("word")

    // Exactly what the panel emits on Invalidate.
    const invalidated: AlignmentSeed[] = [{ srcToken: "word", tgtToken: "mot", weight: -1 }]
    const after = buildGlosser(pairs, btSeedsFromAlignmentSeeds(invalidated))
    expect(after.gloss("mot")).toBe("term")
  })

  it("leaves the gloss untouched when there are no confirmations", () => {
    const pairs = [{ source: "word", target: "mot" }]
    expect(buildGlosser(pairs, btSeedsFromAlignmentSeeds([])).gloss("mot")).toBe(
      buildGlosser(pairs, []).gloss("mot"),
    )
  })
})
