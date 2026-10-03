import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { runCheck } from "./reference-quote"
import type { BuiltinCheckContext } from "../check-context"
import type { ReferenceQuoteLookup } from "@/lib/reference-bible/quote-check"
import { findScriptureReferences, parseCanonicalRef } from "@/lib/reference-bible/reference-finder"
import { extractUsfmVerses } from "@/lib/reference-bible/usfm-verses"

// AQU-1573: the rule-engine adapter over the shared quote check, against real
// Van Dyck text (src/lib/reference-bible/__fixtures__).
const rows = extractUsfmVerses(
  readFileSync(path.join(__dirname, "../../reference-bible/__fixtures__/arb-vd-sample.usfm"), "utf8"),
)
const verse = (book: string, chapter: number, v: number) =>
  rows.find((r) => r.book === book && r.chapter === chapter && r.verse === v)!.text
const lookup: ReferenceQuoteLookup = (canonical) => {
  const ref = parseCanonicalRef(canonical)
  if (!ref) return undefined
  const texts = rows
    .filter((r) => r.book === ref.book && r.chapter === ref.chapter && r.verse >= ref.verseStart && r.verse <= ref.verseEnd)
    .map((r) => r.text)
  return texts.length ? texts : undefined
}
const ctx: BuiltinCheckContext = { referenceBible: { versionName: "Van Dyck", lookup } }

const ROM828 = verse("ROM", 8, 28)
const JHN316 = verse("JHN", 3, 16)

describe("reference-quote built-in check (AQU-1573)", () => {
  it("finds nothing without a reference Bible in the context", () => {
    const source = "Romans 8:28: \"And we know that in all things God works for the good\""
    const changed = ROM828.replace("لِلْخَيْرِ", "لِلصَّلَاحِ")
    expect(runCheck(source, changed)).toBeNull()
    expect(runCheck(source, changed, {})).toBeNull()
  })

  it("passes an exact quote", () => {
    expect(runCheck("\"For God so loved the world\" (John 3:16)", `«${JHN316}»`, ctx)).toBeNull()
  })

  it("flags a changed word as a target span and names the verse and the Bible", () => {
    const source = "Romans 8:28: \"And we know that in all things God works for the good\""
    const draft = `«${ROM828.replace("لِلْخَيْرِ", "لِلصَّلَاحِ")}»`
    const result = runCheck(source, draft, ctx)
    expect(result).not.toBeNull()
    expect(Array.isArray(result)).toBe(false)
    const { spans, params } = result as Exclude<typeof result, null | unknown[]>
    expect(params).toEqual({ kind: "differs", refs: "Romans 8:28", version: "Van Dyck" })
    expect(spans).toHaveLength(1)
    expect(spans[0].side).toBe("target")
    expect(spans[0].matchedText).toContain("لِلصَّلَاحِ")
    expect(draft.slice(spans[0].start, spans[0].end)).toBe(spans[0].matchedText)
  })

  it("flags a fresh translation of a visibly quoted verse as a source span over the reference", () => {
    const source = "The psalmist writes, \"The Lord is my shepherd, I lack nothing\" (Ps 23:1)."
    const result = runCheck(source, "يكتب المرنم: «الرب هو راعيّ، لن أحتاج إلى شيء» (مز 23: 1).", ctx)
    const { spans, params } = result as { spans: { side: string; start: number; end: number; matchedText: string }[]; params: Record<string, string> }
    expect(params).toEqual({ kind: "missing", refs: "Psalm 23:1", version: "Van Dyck" })
    expect(spans).toEqual([{ side: "source", start: source.indexOf("Ps 23:1"), end: source.indexOf("Ps 23:1") + 7, matchedText: "Ps 23:1" }])
  })

  it("names a changed quote and a fresh one apart when one cell has both", () => {
    const source =
      "Romans 8:28: \"And we know that in all things God works for the good.\" " +
      "The psalmist writes, \"The Lord is my shepherd, I lack nothing\" (Ps 23:1)."
    const changed = ROM828.replace("لِلْخَيْرِ", "لِلصَّلَاحِ")
    const draft = `رومية 8: 28: «${changed}» يكتب المرنم: «الرب هو راعيّ، لن أحتاج إلى شيء» (مزمور 23: 1).`
    const { spans, params } = runCheck(source, draft, ctx) as { spans: { side: string; matchedText: string }[]; params: Record<string, string> }
    expect(params).toEqual({ kind: "both", refs: "Romans 8:28", missingRefs: "Psalm 23:1", version: "Van Dyck" })
    expect(spans.map((s) => s.side)).toEqual(["target", "source"])
    expect(spans[0].matchedText).toContain("لِلصَّلَاحِ")
    expect(spans[1].matchedText).toBe("Ps 23:1")
  })

  it("stays quiet when the source only mentions a verse", () => {
    expect(runCheck("Later we'll look at Philippians 4:13.", "سننظر لاحقًا في فيلبي 4: 13.", ctx)).toBeNull()
  })

  it("skips a verse that has not loaded yet", () => {
    const pending: BuiltinCheckContext = { referenceBible: { versionName: "Van Dyck", lookup: () => undefined } }
    const source = "Romans 8:28: \"And we know that in all things God works for the good\""
    expect(runCheck(source, "ترجمة جديدة تمامًا لا علاقة لها بالآية", pending)).toBeNull()
  })

  it("uses the caller's memoised references and skips sources with none", () => {
    const references = vi.fn((text: string) => findScriptureReferences(text))
    const memo: BuiltinCheckContext = { referenceBible: { versionName: "Van Dyck", lookup, references } }
    expect(runCheck("Plain prose with no reference 12 times.", "نص عادي", memo)).toBeNull()
    expect(references).toHaveBeenCalledTimes(1)
    // No digit at all: not even the memo is consulted.
    expect(runCheck("Who is God?", "من هو الله؟", memo)).toBeNull()
    expect(references).toHaveBeenCalledTimes(1)
  })
})
