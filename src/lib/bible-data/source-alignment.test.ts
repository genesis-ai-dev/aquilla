import { describe, expect, it } from "vitest"
import { tokenSpans } from "@/lib/completion/tokenize"
import { contentHash } from "@/lib/dcs/content-hash"
import { bridgeJhn4, bridgeJhn4Text } from "./__fixtures__/bridge-jhn4"
import { addNameLinks, alignSourceBook, NAME_MATCH_MIN } from "./source-alignment"
import type { BkpWord } from "./pack-types"
import { TINT_SOLID_MIN } from "./bridge-compose"

const verses = bridgeJhn4()
const text = bridgeJhn4Text(verses)
const cells = verses.map((verse) => ({ cellId: verse.ref, refs: [verse.ref], text: verse.bsb }))
// Trained on John 4 alone (54 verses): the product trains on the open book,
// and a chapter is the hard end of that.
const book = alignSourceBook(text, cells)!

/** A word's links in a verse, as the BSB words they land on, best first. */
function landsOn(ref: string, wordId: string): string[] {
  const verse = verses.find((v) => v.ref === ref)!
  const spans = tokenSpans(verse.bsb)
  return book.cells
    .find((cell) => cell.cellId === ref)!
    .links.filter((link) => link.wordId === wordId)
    .sort((a, b) => b.conf - a.conf)
    .map((link) => spans[link.token].raw)
}

describe("Bridge 1 on John 4 (BSB), golden links checked by hand", () => {
  // JHN 4:7, BSB: "When a Samaritan woman came to draw water, Jesus said to
  // her, “Give Me a drink.”" Who's Who tints these three words; if the
  // alignment loses them, the Samaritan woman's thread and Jesus's thread go
  // dark on a gateway-language source.
  it("puts αὐτῇ on “her” (with “to”, as Clear's manual alignment does)", () => {
    expect(landsOn("JHN 4:7", "n43004007009")).toEqual(["her", "to"])
  })

  it("puts Ἰησοῦς on “Jesus”", () => {
    expect(landsOn("JHN 4:7", "n43004007011")[0]).toBe("Jesus")
  })

  it("puts μοι on “Me” (BSB capitalizes the pronoun when Jesus speaks of himself)", () => {
    expect(landsOn("JHN 4:7", "n43004007013")[0]).toBe("Me")
  })

  it("draws solid pronoun links that agree with Clear's manual alignment at least 85% of the time", () => {
    // The ticket's bar for pronoun tints: below 85%, they must ship dotted.
    // Solid means confidence ≥ TINT_SOLID_MIN; this is the same measurement
    // as scripts/bridge-align-eval.ts, on the checked-in chapter.
    let solid = 0
    let right = 0
    for (const verse of verses) {
      const aligned = book.cells.find((cell) => cell.cellId === verse.ref)!
      for (const word of verse.words) {
        if (word.class !== "pron" || word.type !== "personal") continue
        for (const link of aligned.links) {
          if (link.wordId !== word.id || link.conf < TINT_SOLID_MIN) continue
          solid++
          if (word.gold.includes(link.token)) right++
        }
      }
    }
    expect(solid).toBeGreaterThan(20)
    expect(right / solid).toBeGreaterThanOrEqual(0.85)
  })

  it("stamps each cell with the hash of the text it aligned, and counts the cells it trained on", () => {
    const cell = book.cells.find((c) => c.cellId === "JHN 4:7")!
    // The server compares this with cells.content_hash: a later edit turns the links off.
    expect(cell.sourceHash).toBe(contentHash(verses.find((v) => v.ref === "JHN 4:7")!.bsb))
    expect(book.trainedPairs).toBe(54)
  })

  it("leaves out a cell whose verse the pack does not have", () => {
    const withExtra = [...cells, { cellId: "extra", refs: ["JHN 99:1"], text: "Not in the pack." }]
    const result = alignSourceBook(text, withExtra)!
    expect(result.cells.map((cell) => cell.cellId)).not.toContain("extra")
    expect(result.trainedPairs).toBe(54)
  })

  it("stops when asked, so a cancelled run writes nothing", () => {
    expect(alignSourceBook(text, cells, { shouldStop: () => true })).toBeNull()
  })
})

describe("the proper-noun constraint", () => {
  const word = (lemma: string, cls = "noun", type = "proper"): BkpWord => ({
    text: lemma,
    after: " ",
    lemma,
    gloss: "",
    class: cls,
    type,
    morph: "",
  })

  it("links a name the statistics missed to the capitalized word spelled like it", () => {
    const spans = tokenSpans("Philip found Nathanael and told him")
    const links = addNameLinks([word("Φίλιππος"), word("εὑρίσκω", "verb", ""), word("Ναθαναήλ")], spans, [
      { src: 0, tgt: 0, conf: 0.9 },
    ])
    expect(links).toContainEqual({ src: 2, tgt: 2, conf: 1 })
  })

  it("does not take a word another Greek word holds, or one that only looks a little alike", () => {
    const spans = tokenSpans("He said to the Jews")
    // "Jews" is held by Ἰουδαῖοι; it also looks like Ἰησοῦς (0.8), which must not steal it.
    const held = [{ src: 1, tgt: 4, conf: 0.9 }]
    expect(addNameLinks([word("Ἰησοῦς"), word("Ἰουδαῖος", "adj", "substantive")], spans, held)).toEqual(held)
    // Nothing capitalized is spelled closely enough like Ἀνδρέας here.
    const andrew = addNameLinks([word("Ἀνδρέας")], tokenSpans("He brought Simon"), [])
    expect(andrew).toEqual([])
    expect(NAME_MATCH_MIN).toBeGreaterThan(0.5)
  })

  it("never fires on a script it cannot compare", () => {
    expect(addNameLinks([word("Ἰησοῦς")], tokenSpans("यीशु ने कहा"), [])).toEqual([])
  })
})
