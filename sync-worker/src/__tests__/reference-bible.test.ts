// AQU-1573: resolving the reference verses a drafting prompt injects.
import { describe, expect, it } from "vitest"
import {
  resolveReferenceScripture,
  type ReferenceBibleBucket,
} from "../lib/reference-bible"

const ISA = [
  "\\id ISA",
  "\\c 40",
  "\\v 25 فَبِمَنْ تُشَبِّهُونَنِي وَأُسَاوَى، يَقُولُ الْقُدُّوسُ.",
  "\\v 26 ارْفَعُوا إِلَى الْعَلاَءِ عُيُونَكُمْ.",
].join("\n")

const ROM = ["\\id ROM", "\\c 8", "\\v 28 وَنَحْنُ نَعْلَمُ أَنَّ كُلَّ الأَشْيَاءِ تَعْمَلُ مَعًا لِلْخَيْرِ."].join("\n")

/** An R2 stand-in that records every key read, so the single-read-per-book
 *  claim is asserted rather than assumed. */
function bucket(objects: Record<string, string>): ReferenceBibleBucket & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async get(key: string) {
      reads.push(key)
      const body = objects[key]
      return body === undefined ? null : { text: async () => body }
    },
  }
}

const VANDYCK = ["arb-vandyck"]

describe("resolveReferenceScripture", () => {
  it("returns the cited verse in the project's version", async () => {
    const r2 = bucket({ "reference-bibles/arb-vandyck/ISA.usfm": ISA })
    const result = await resolveReferenceScripture(r2, {
      sourceText: 'As Isaiah 40:25 asks, "To whom will you compare me?"',
      versionIds: VANDYCK,
    })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      canonicalRef: "ISA 40:25",
      citedAs: "Isaiah 40:25",
      versionId: "arb-vandyck",
    })
    expect(result.entries[0].text).toContain("تُشَبِّهُونَنِي")
    expect(result.entries[0].versionLabel).toContain("Arabic")
    expect(result.misses).toEqual([])
  })

  it("does not consult R2 when the project names no reference Bible", async () => {
    const r2 = bucket({ "reference-bibles/arb-vandyck/ISA.usfm": ISA })
    const result = await resolveReferenceScripture(r2, {
      sourceText: "As Isaiah 40:25 asks",
      versionIds: [],
    })
    expect(result).toEqual({ citations: [], entries: [], misses: [] })
    expect(r2.reads).toEqual([])
  })

  it("does not consult R2 when the cell quotes nothing", async () => {
    const r2 = bucket({ "reference-bibles/arb-vandyck/ISA.usfm": ISA })
    const result = await resolveReferenceScripture(r2, {
      sourceText: "Chip opens the session with a story about his father.",
      versionIds: VANDYCK,
    })
    expect(result.entries).toEqual([])
    expect(r2.reads).toEqual([])
  })

  it("reads each book once however many of its verses are cited", async () => {
    const r2 = bucket({ "reference-bibles/arb-vandyck/ISA.usfm": ISA })
    const result = await resolveReferenceScripture(r2, {
      sourceText: "Isaiah 40:25 asks it and Isaiah 40:26 answers it.",
      versionIds: VANDYCK,
    })
    expect(result.entries.map((e) => e.canonicalRef)).toEqual(["ISA 40:25", "ISA 40:26"])
    expect(r2.reads).toEqual(["reference-bibles/arb-vandyck/ISA.usfm"])
  })

  it("serves several versions of the same verse, in the project's order", async () => {
    const r2 = bucket({
      "reference-bibles/arb-vandyck/ISA.usfm": ISA,
      "reference-bibles/eng-kjv/ISA.usfm": "\\c 40\n\\v 25 To whom then will ye liken me?",
    })
    const result = await resolveReferenceScripture(r2, {
      sourceText: "Isaiah 40:25",
      versionIds: ["arb-vandyck", "eng-kjv"],
    })
    expect(result.entries.map((e) => e.versionId)).toEqual(["arb-vandyck", "eng-kjv"])
  })

  // A missing reference text must be VISIBLE. Drafting without the verse while
  // the project believes its reference Bible is in force is the exact failure
  // the feature exists to prevent.
  it("reports an un-provisioned book, naming the object key an operator must upload", async () => {
    const result = await resolveReferenceScripture(bucket({}), {
      sourceText: "Isaiah 40:25",
      versionIds: VANDYCK,
    })
    expect(result.entries).toEqual([])
    expect(result.misses).toEqual([
      expect.objectContaining({
        reason: "book_not_provisioned",
        objectKey: "reference-bibles/arb-vandyck/ISA.usfm",
        canonicalRef: "ISA 40:25",
      }),
    ])
  })

  it("distinguishes a provisioned book that lacks the verse", async () => {
    const result = await resolveReferenceScripture(
      bucket({ "reference-bibles/arb-vandyck/ISA.usfm": ISA }),
      { sourceText: "Isaiah 40:99", versionIds: VANDYCK },
    )
    expect(result.misses[0]).toMatchObject({ reason: "verse_not_in_version" })
  })

  it("reports every citation as un-provisioned when the deployment has no bucket", async () => {
    const result = await resolveReferenceScripture(undefined, {
      sourceText: "Isaiah 40:25 and Romans 8:28",
      versionIds: VANDYCK,
    })
    expect(result.citations).toHaveLength(2)
    expect(result.entries).toEqual([])
    expect(result.misses.map((m) => m.reason)).toEqual([
      "book_not_provisioned",
      "book_not_provisioned",
    ])
  })

  it("treats an R2 failure as a miss rather than failing the read that asked", async () => {
    const result = await resolveReferenceScripture(
      {
        async get() {
          throw new Error("R2 unavailable")
        },
      },
      { sourceText: "Isaiah 40:25", versionIds: VANDYCK },
    )
    expect(result.misses[0]).toMatchObject({ reason: "book_not_provisioned" })
  })

  it("ignores unknown version ids stored on the project", async () => {
    const r2 = bucket({ "reference-bibles/arb-vandyck/ROM.usfm": ROM })
    const result = await resolveReferenceScripture(r2, {
      sourceText: "Romans 8:28",
      versionIds: ["arb-vandyck", "not-a-version"],
    })
    expect(result.entries.map((e) => e.versionId)).toEqual(["arb-vandyck"])
    expect(result.misses).toEqual([])
  })

  it("honours a citation limit", async () => {
    const r2 = bucket({ "reference-bibles/arb-vandyck/ISA.usfm": ISA })
    const result = await resolveReferenceScripture(r2, {
      sourceText: "Isaiah 40:25 then Isaiah 40:26",
      versionIds: VANDYCK,
      citationLimit: 1,
    })
    expect(result.citations).toHaveLength(1)
  })
})
