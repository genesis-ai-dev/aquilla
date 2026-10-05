// AQU-1573: the reference-verses block and where the three copilot prompt
// builders put it. A sermon cell that cites "Isaiah 40:25" must reach the
// model with the Van Dyck wording and a MUST-copy instruction; a cell that
// cites nothing must produce the exact prompt it always did.

import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  buildBatchPrompt,
  buildParagraphPrompt,
  buildPrompt,
  buildReferenceVersesBlock,
  DEFAULT_SYSTEM_PROMPT,
} from "./completion-service"
import {
  MAX_REFERENCE_BLOCK_CHARS,
  MAX_REFERENCE_BLOCK_VERSES,
  REFERENCE_VERSES_HEADING,
  type ReferenceBlockPassage,
} from "./prompt-build"
import { extractUsfmVerses } from "../reference-bible/usfm-verses"
import { formatLabel, parseCanonicalRef } from "../reference-bible/reference-finder"

const VD = extractUsfmVerses(
  readFileSync(path.join(__dirname, "../reference-bible/__fixtures__/arb-vd-sample.usfm"), "utf8"),
)

/** A passage as the server's lookup returns it, from the real Van Dyck chapters. */
function passage(canonical: string): ReferenceBlockPassage {
  const ref = parseCanonicalRef(canonical)!
  const verses = VD.filter(
    (r) =>
      r.book === ref.book &&
      (r.chapter > ref.chapter || (r.chapter === ref.chapter && r.verse >= ref.verseStart)) &&
      (r.chapter < ref.endChapter || (r.chapter === ref.endChapter && r.verse <= ref.verseEnd)),
  ).map(({ chapter, verse, text }) => ({ chapter, verse, text }))
  return { canonical, label: formatLabel(ref), verses }
}

// Byte for byte as eBible publishes it (its mark order is not NFC's).
const ISA_40_25 = passage("ISA 40:25").verses[0].text
const VAN_DYCK = { versionName: "Van Dyck", languageName: "Arabic" }

describe("buildReferenceVersesBlock", () => {
  it("labels the Bible, says MUST copy, and lists a single verse on one line", () => {
    expect(ISA_40_25.normalize("NFC")).toBe("«فَبِمَنْ تُشَبِّهُونَنِي فَأُسَاوِيَهُ؟» يَقُولُ ٱلْقُدُّوسُ.".normalize("NFC"))
    const block = buildReferenceVersesBlock({ ...VAN_DYCK, passages: [passage("ISA 40:25")] })
    const lines = block.split("\n")
    expect(lines[0]).toBe(`${REFERENCE_VERSES_HEADING}Van Dyck (Arabic) (MUST follow):`)
    expect(lines[1]).toContain("copy the matching words from this Bible exactly")
    expect(lines[1]).toContain("If the source only names a reference without quoting it, translate the source as usual.")
    expect(lines[1].endsWith(" Keep each reference (chapter and verse numbers) in the translation.")).toBe(true)
    expect(lines[2]).toBe(`- Isaiah 40:25 [ISA 40:25]: ${ISA_40_25}`)
    expect(lines).toHaveLength(3)
  })

  // AQU-1573 walk: the vowel-mark allowance is for a pointed Bible only.
  it("allows leaving out vowel marks for the vowelled Van Dyck, and not for the King James Version", () => {
    const vd = buildReferenceVersesBlock({ ...VAN_DYCK, passages: [passage("ISA 40:25")] })
    expect(vd.split("\n")[1]).toContain("You may leave out vowel marks to match the rest of your translation.")
    const kjv = buildReferenceVersesBlock({
      versionName: "King James Version",
      languageName: "English",
      passages: [{
        canonical: "PSA 23:1",
        label: "Psalm 23:1",
        verses: [{ chapter: 23, verse: 1, text: "The LORD is my shepherd; I shall not want." }],
      }],
    })
    const instruction = kjv.split("\n")[1]
    expect(instruction).not.toContain("vowel")
    expect(instruction).toContain("do not change, add or drop words inside the quotation. If the source only names")
  })

  it("lists a range verse by verse under its label", () => {
    const block = buildReferenceVersesBlock({ ...VAN_DYCK, passages: [passage("JHN 3:16-17")] })
    const lines = block.split("\n").slice(2)
    expect(lines[0]).toBe("- John 3:16–17 [JHN 3:16-17]:")
    expect(lines[1]).toBe(`  3:16 ${passage("JHN 3:16").verses[0].text}`)
    expect(lines[2]).toBe(`  3:17 ${passage("JHN 3:17").verses[0].text}`)
    expect(lines).toHaveLength(3)
  })

  it("is empty when nothing is cited, and leaves the language out when unknown", () => {
    expect(buildReferenceVersesBlock({ ...VAN_DYCK, passages: [] })).toBe("")
    expect(buildReferenceVersesBlock({ versionName: "KJV", passages: [passage("ISA 40:25")] }).split("\n")[0]).toBe(
      `${REFERENCE_VERSES_HEADING}KJV (MUST follow):`,
    )
  })

  it("says when the server cut a long passage", () => {
    const block = buildReferenceVersesBlock({ ...VAN_DYCK, passages: [{ ...passage("ISA 40:1-3"), truncated: true }] })
    expect(block.split("\n").at(-1)).toBe("  (the rest of this passage is not shown)")
  })

  it(`stops at ${MAX_REFERENCE_BLOCK_VERSES} verses and counts the references it left out`, () => {
    // ISA 40 has 31 verses: 30 + 10 fill the budget; the third passage is left out.
    const block = buildReferenceVersesBlock({
      ...VAN_DYCK,
      passages: [passage("ISA 40:1-30"), passage("JHN 3:1-10"), passage("ROM 8:28")],
    })
    expect(block.match(/^ {2}\d+:\d+ /gm)).toHaveLength(MAX_REFERENCE_BLOCK_VERSES)
    expect(block).not.toContain("[ROM 8:28]")
    expect(block.split("\n").at(-1)).toBe(
      "(1 more cited reference is not listed, to keep this request short; translate it as usual.)",
    )
  })

  it(`cuts a passage mid-way at ${MAX_REFERENCE_BLOCK_CHARS} characters of verse text`, () => {
    const long = "ا".repeat(2500)
    const block = buildReferenceVersesBlock({
      ...VAN_DYCK,
      passages: [
        { canonical: "PSA 119:1-3", label: "Psalm 119:1–3", verses: [1, 2, 3].map((verse) => ({ chapter: 119, verse, text: long })) },
        passage("ISA 40:25"),
      ],
    })
    expect(block.match(/^ {2}119:\d+ /gm)).toHaveLength(2)
    expect(block).toContain("  (the rest of this passage is not shown)")
    expect(block).toContain("(1 more cited reference is not listed")
    expect(block).not.toContain("[ISA 40:25]")
  })
})

const BASE = { sourceLanguage: "English", targetLanguage: "Arabic", systemPrompt: DEFAULT_SYSTEM_PROMPT }
const BLOCK = buildReferenceVersesBlock({ ...VAN_DYCK, passages: [passage("ISA 40:25")] })
const STYLE = ["Keep sentences short."]
const ADDENDUM = "Output contract: keep [1] markers."

describe("the copilot prompt builders carry the block", () => {
  it("buildPrompt: after the style rules, before the addendum; byte-identical without it", () => {
    const opts = {
      ...BASE,
      sourceText: 'Isaiah 40:25 says, "To whom will you compare me?"',
      examples: [],
      styleInstructions: STYLE,
      systemAddendum: ADDENDUM,
    }
    const without = buildPrompt(opts)
    const withBlock = buildPrompt({ ...opts, referenceBlock: BLOCK })
    const sys = withBlock[0].content
    expect(sys).toContain(ISA_40_25)
    expect(sys.indexOf("Keep sentences short.")).toBeLessThan(sys.indexOf(REFERENCE_VERSES_HEADING))
    expect(sys.indexOf(REFERENCE_VERSES_HEADING)).toBeLessThan(sys.indexOf(ADDENDUM))
    expect(sys.replace(`\n\n${BLOCK}`, "")).toBe(without[0].content)
    expect(withBlock[1]).toEqual(without[1])
    expect(buildPrompt({ ...opts, referenceBlock: "" })).toEqual(without)
  })

  it("buildBatchPrompt: same placement; byte-identical without it", () => {
    const opts = {
      ...BASE,
      cells: [{ source: "Isaiah 40:25 says so." }, { source: "Amen." }],
      examples: [],
      styleInstructions: STYLE,
      systemAddendum: ADDENDUM,
    }
    const without = buildBatchPrompt(opts)
    const sys = buildBatchPrompt({ ...opts, referenceBlock: BLOCK })[0].content
    expect(sys.indexOf("Keep sentences short.")).toBeLessThan(sys.indexOf(REFERENCE_VERSES_HEADING))
    expect(sys.indexOf(REFERENCE_VERSES_HEADING)).toBeLessThan(sys.indexOf(ADDENDUM))
    expect(sys.replace(`\n\n${BLOCK}`, "")).toBe(without[0].content)
  })

  it("buildParagraphPrompt: same placement; byte-identical without it", () => {
    const opts = {
      ...BASE,
      cells: [{ cellId: "c1", source: "Isaiah 40:25 says so." }],
      examples: [],
      styleInstructions: STYLE,
      systemAddendum: ADDENDUM,
    }
    const without = buildParagraphPrompt(opts)
    const sys = buildParagraphPrompt({ ...opts, referenceBlock: BLOCK })[0].content
    expect(sys.indexOf("Keep sentences short.")).toBeLessThan(sys.indexOf(REFERENCE_VERSES_HEADING))
    expect(sys.indexOf(REFERENCE_VERSES_HEADING)).toBeLessThan(sys.indexOf(ADDENDUM))
    expect(sys.replace(`\n\n${BLOCK}`, "")).toBe(without[0].content)
  })
})
