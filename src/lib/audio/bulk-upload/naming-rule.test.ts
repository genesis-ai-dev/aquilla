import { describe, expect, it } from "vitest"
import * as shared from "../../../../shared/recording-naming-rule"
import { BOOK_CODES, BookNameIndex } from "./book-names"
import { matchRecordings, readRecordings, type Assignment, type BulkInputFile, type MatchScope, type TargetFile, type TargetLine } from "./match"
import {
  applyNamingRule,
  compileRule,
  compileTemplate,
  isSavableRule,
  judgeRule,
  nameShape,
  parseNamingRule,
  projectOutline,
  ruleEligible,
  sampleNames,
  shapesOf,
  whyNotSavable,
  type NamingRule,
} from "./naming-rule"
import { askForNamingRule, loadSavedNamingRules, NamingRuleError } from "./naming-rule-client"

const MAT = [25, 23, 17, 25, 48, 34, 29, 34, 38, 42, 30, 50, 58, 36, 39, 28, 27, 35, 30, 34, 46, 46, 39, 51, 46, 75, 66, 20]

function audio(path: string): BulkInputFile {
  const name = path.split("/").pop()!
  return { name, path, size: 1000, type: "audio/ogg" }
}

function book(fileId: string, code: string, name: string, chapters: number[]): TargetFile {
  const lines: TargetLine[] = []
  chapters.forEach((count, ci) => {
    for (let v = 1; v <= count; v++) lines.push({ cellId: `${fileId}:${ci + 1}:${v}`, ref: `${code} ${ci + 1}:${v}`, text: "", structural: false, hasRecording: false })
  })
  return { fileId, name, bookCode: code, lines }
}

/** The rule's names through AQU-981's own matcher, as the preview does it. */
function landAll(
  rule: NamingRule,
  paths: string[],
  targets: TargetFile[],
  opts: { scope?: MatchScope; overrides?: ReadonlyMap<number, { fileId: string; cellId: string } | "skip">; projectBooks?: { name: string; code: string }[] } = {},
) {
  const made = new Map<number, string>()
  const files = paths.map((p, i) => {
    const f = audio(p)
    const name = applyNamingRule(rule, f.name)
    if (name) made.set(i, name)
    return name ? { ...f, name, path: name } : f
  })
  const projectFiles = targets.map((t) => ({ fileId: t.fileId, name: t.name, bookCode: t.bookCode }))
  const read = readRecordings(files, { scope: opts.scope ?? { kind: "project" }, index: new BookNameIndex(), projectFiles, maxBytes: 1 << 30 })
  const assignments = matchRecordings(read, new Map(targets.map((t) => [t.fileId, t])), { overrides: opts.overrides })
  const at = new Map(targets.flatMap((t) => t.lines.map((l, i) => [`${t.fileId}\u0000${l.cellId}`, i] as const)))
  const where = {
    pathOf: (i: number) => paths[i],
    lineIndex: (fileId: string, cellId: string) => at.get(`${fileId}\u0000${cellId}`),
    projectBooks: opts.projectBooks ?? [],
  }
  return { made, assignments, names: (i: number) => audio(paths[i]).name, where }
}

function land(rule: NamingRule, paths: string[], targets: TargetFile[], scope: MatchScope = { kind: "project" }) {
  return landAll(rule, paths, targets, { scope }).assignments.map((a) => a.cellIds?.[0] ?? a.reason?.code)
}

describe("a template is safe text, never the assistant's own expression", () => {
  it("compiles placeholders and literal text into one anchored match", () => {
    const c = compileTemplate({ pattern: "{book}-ch{chapter}_v{verse}" })!
    expect(c.names).toEqual(["book", "chapter", "verse"])
    expect(c.re.test("Mt-ch19_v01")).toBe(true)
    expect(c.re.test("Mt-ch19_v01 copy")).toBe(false)
  })

  it("treats every other character as text, so nothing in a pattern can run as an expression", () => {
    const c = compileTemplate({ pattern: "(.*)+{verse}" })!
    expect(c.re.test("(.*)+12")).toBe(true)
    expect(c.re.test("aaaa12")).toBe(false)
  })

  it("refuses two numbers side by side, an unknown placeholder, and a pattern with none", () => {
    expect(compileTemplate({ pattern: "{chapter}{verse}" })).toBeNull()
    expect(compileTemplate({ pattern: "{book}{any}" })).toBeNull()
    expect(compileTemplate({ pattern: "{script}_{verse}" })).toBeNull()
    expect(compileTemplate({ pattern: "plain text" })).toBeNull()
    expect(compileTemplate({ pattern: `${"x".repeat(121)}{verse}` })).toBeNull()
  })

  it("reads a letter run on to a number as its part, never a second number", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book} {chapter}-{verse}{part}" }] })!
    expect(applyNamingRule(rule, "Mat 19-4a.mp3")).toBe("Mat 19:4 part a.mp3")
    expect(applyNamingRule(rule, "Mat 19-121.mp3")).toBeNull()
  })
})

describe("the answer is checked before anything uses it", () => {
  it("keeps a usable rule, with book codes in upper case and keys without case", () => {
    expect(parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Mt: "mat" }, explanation: "Mt is Matthew" }))
      .toEqual({ version: 1, templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { mt: "MAT" }, explanation: "Mt is Matthew" })
  })

  it("refuses an unknown book, a bad template, too many templates and a chapter out of range", () => {
    expect(parseNamingRule({ templates: [{ pattern: "{verse}" }], book: "XYZ" })).toBeNull()
    expect(parseNamingRule({ templates: [{ pattern: "{chapter}{verse}" }] })).toBeNull()
    expect(parseNamingRule({ templates: [{ pattern: "{verse}" }, { pattern: "{line}" }, { pattern: "{take}" }] })).toBeNull()
    expect(parseNamingRule({ templates: [{ pattern: "{verse}" }], chapter: 0 })).toBeNull()
    expect(parseNamingRule("not a rule")).toBeNull()
  })
})

describe("a rule's names land through AQU-981's own matching", () => {
  const mat = [book("mat", "MAT", "Matthew", MAT)]

  it("an invented naming: Mt-ch19_v01 lands on Matthew 19:1", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Mt: "MAT" } })!
    expect(land(rule, ["Files/Mt-ch19_v01.ogg", "Files/Mt-ch19_v30.ogg", "Files/Mt-ch22_v32.ogg"], mat))
      .toEqual(["mat:19:1", "mat:19:30", "mat:22:32"])
  })

  it("ETEN's naming as a rule: the book-wide count, cross-checked by the verse", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}_{verse}_LN{verseInBook}" }] })!
    expect(applyNamingRule(rule, "MAT_1_LN619.ogg")).toBe("MAT_1_LN619.ogg")
    expect(land(rule, ["Files/MAT_1_LN619.ogg", "Files/MAT_32_LN760.ogg", "Files/MAT_5_LN619.ogg"], mat))
      .toEqual(["mat:19:1", "mat:22:32", "bookVerseDisagree"])
  })

  it("reads the file name only: the assistant never sees the folders, so an answer naming one is unusable (review, Oct 30)", () => {
    expect(parseNamingRule({ templates: [{ pattern: "v{verse}", folder: "Kapitola {chapter}" }], book: "MAT" })).toBeNull()
    expect(compileTemplate({ pattern: "v{verse}", folder: "Kapitola {chapter}" } as never)).toBeNull()
  })

  it("a verse the book doesn't have is refused by the matcher, not placed", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Mt: "MAT" } })!
    expect(land(rule, ["Files/Mt-ch19_v99.ogg"], mat)).toEqual(["noSuchVerse"])
  })

  it("a take number stays a take", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}_take{take}" }], books: { Mt: "MAT" } })!
    expect(applyNamingRule(rule, "Mt-ch19_v01_take2.ogg")).toBe("MAT 19:1 take 2.ogg")
  })

  it("a name no template fits is left as it was", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }] })!
    expect(applyNamingRule(rule, "notes.ogg")).toBeNull()
  })
})

describe("what goes to the assistant: a sample and an outline, the same every time", () => {
  it("keeps every name of a small folder, sorted by code point, the same on every machine (review, Oct 30)", () => {
    expect(sampleNames(["b10.mp3", "b2.mp3", "b1.mp3"])).toEqual(["b1.mp3", "b10.mp3", "b2.mp3"])
    expect(sampleNames(["á.mp3", "b.mp3", "B.mp3", "a.mp3"])).toEqual(["B.mp3", "a.mp3", "b.mp3", "á.mp3"])
  })

  it("takes 30 of 142, the first and last, a spread, and the odd ones out", () => {
    const names = Array.from({ length: 141 }, (_, i) => `Mt-ch19_v${String(i + 1).padStart(3, "0")}.ogg`).concat("intro (old).ogg")
    const sample = sampleNames(names)
    expect(sample).toHaveLength(30)
    expect(sample).toContain("Mt-ch19_v001.ogg")
    expect(sample).toContain("Mt-ch19_v141.ogg")
    expect(sample).toContain("intro (old).ogg")
    expect(sampleNames([...names].reverse())).toEqual(sample)
  })

  it("names each book with its verses per chapter, and other files by name only", () => {
    const outline = projectOutline([{ fileId: "m", name: "Matthew", bookCode: "MAT" }, { fileId: "w", name: "Welcome letter", bookCode: null }])
    expect(outline).toContain("MAT (Matthew): verses per chapter 25,23,17")
    expect(outline).toContain('File: "Welcome letter"')
  })

  it("keeps a team's rule under the names' shape, digits blanked and the extension left out (review, Oct 30)", () => {
    expect(nameShape("MAT_1_LN619.ogg")).toBe("mat_#_ln#")
    expect(nameShape("MAT_1_LN619.mp3")).toBe(nameShape("MAT_1_LN619.ogg"))
    expect(shapesOf(["a1.mp3", "a22.ogg", "b.mp3"])).toEqual(["a#", "b"])
  })

  it("breaks a tie between shapes by code point, not by the machine's language (review, Oct 30)", () => {
    // A locale puts "á" before "b"; code point order puts it after.
    expect(shapesOf(["á1.mp3", "b1.mp3"])).toEqual(["b#", "á#"])
    expect(shapesOf(["Z1.ogg", "y1.ogg"])).toEqual(["y#", "z#"])
  })
})

describe("a rule can't reach the app's own code by its names (review, Oct 30)", () => {
  it("refuses a placeholder named after an object built-in, without throwing", () => {
    for (const pattern of ["{constructor}", "{toString}", "v{verse}_{hasOwnProperty}", "{valueOf}", "{__proto__}"]) {
      expect(() => parseNamingRule({ templates: [{ pattern }] })).not.toThrow()
      expect(parseNamingRule({ templates: [{ pattern }] })).toBeNull()
      expect(compileTemplate({ pattern })).toBeNull()
    }
  })

  it("reads a book word named after a built-in as text, never as the app's own function", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}_{chapter}_{verse}" }], books: { Mt: "MAT" } })!
    expect(applyNamingRule(rule, "constructor_1_2.mp3")).toBe("constructor 1:2.mp3")
    expect(applyNamingRule(rule, "Mt_1_2.mp3")).toBe("MAT 1:2.mp3")
  })

  it("drops one unusable saved entry and keeps the rest", async () => {
    const good = { templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Mt: "MAT" } }
    const rules = { "mt-ch#_v#.ogg": good, "x#.ogg": { templates: [{ pattern: "{constructor}" }] }, "y#.ogg": "junk" }
    const fetchImpl = (async () => new Response(JSON.stringify({ rules }), { status: 200 })) as unknown as typeof fetch
    const saved = await loadSavedNamingRules({ projectId: "p", identityToken: "t", fetchImpl })
    expect([...saved.rules.keys()]).toEqual(["mt-ch#_v#.ogg"])
  })

  it("passes on whether the server lets this person keep and forget the team's rules, and nothing it didn't say (Sam, Oct 30)", async () => {
    const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    expect((await loadSavedNamingRules({ projectId: "p", identityToken: "t", fetchImpl: answer({ rules: {}, canKeep: true }) })).canKeep).toBe(true)
    expect((await loadSavedNamingRules({ projectId: "p", identityToken: "t", fetchImpl: answer({ rules: {}, canKeep: false }) })).canKeep).toBe(false)
    expect((await loadSavedNamingRules({ projectId: "p", identityToken: "t", fetchImpl: answer({ rules: {} }) })).canKeep).toBeNull()
    expect((await loadSavedNamingRules({ projectId: "p", identityToken: "t", fetchImpl: answer({ rules: {}, canKeep: "yes" }) })).canKeep).toBeNull()
    expect((await loadSavedNamingRules({ projectId: "p", identityToken: "t", fetchImpl: answer({ error: "x" }, 403) })).canKeep).toBeNull()
  })

  it("counts an answer that breaks the compiler as unusable, not as a crash", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ rule: { templates: [{ pattern: "{constructor}" }] } }), { status: 200 })) as unknown as typeof fetch
    const asked = askForNamingRule({ projectId: "p", identityToken: "t", fetchImpl, names: ["a.ogg"], outline: "" })
    await expect(asked).rejects.toBeInstanceOf(NamingRuleError)
    await expect(asked).rejects.toMatchObject({ problem: "unusable" })
  })
})

describe("the client and the server check a rule with one module (review, Oct 30)", () => {
  it("is the shared module itself", () => {
    expect(parseNamingRule).toBe(shared.parseNamingRule)
    expect(compileTemplate).toBe(shared.compileTemplate)
    expect(isSavableRule).toBe(shared.isSavableRule)
  })

  it("knows the same 66 book codes as the bulk upload", () => {
    expect([...shared.USFM_BOOK_CODES].sort()).toEqual([...new Set(BOOK_CODES)].sort())
  })

  it("trims a long explanation, reads a null one as none, and drops an empty folder", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "v{verse}", folder: "" }], book: "MAT", chapter: 1, explanation: "x".repeat(400) })!
    expect(rule.explanation).toHaveLength(300)
    expect(rule.templates).toEqual([{ pattern: "v{verse}" }])
    expect(parseNamingRule({ templates: [{ pattern: "v{verse}" }], book: "MAT", chapter: 1, explanation: null })).not.toBeNull()
  })

  it("keeps the project outline under the server's limit, by characters as well as lines", () => {
    // Every book, then documents with long names: 80 lines would be far past it.
    const books = [...new Set(BOOK_CODES)].map((code) => ({ fileId: code, name: code, bookCode: code }))
    const documents = Array.from({ length: 40 }, (_, i) => ({ fileId: `d${i}`, name: `Study notes ${i} ${"x".repeat(200)}`, bookCode: null }))
    const outline = projectOutline([...books, ...documents])
    expect(outline.length).toBeLessThanOrEqual(8_000)
    expect(outline.split("\n").every((line) => /^[1-4]?[A-Z]{2,3} \(|^File: /.test(line))).toBe(true)
  })
})

describe("a rule reads names safely and the same way every time (review, Oct 30)", () => {
  it("reads names the same whatever their Unicode form: accents composed or not, and full-width digits", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "Capítulo {chapter} versículo {verse}" }], book: "MAT" })!
    expect(applyNamingRule(rule, "Capítulo 5 versículo 3.mp3")).toBe("MAT 5:3.mp3")
    expect(applyNamingRule(rule, "Capítulo 5 versículo 3.mp3".normalize("NFD"))).toBe("MAT 5:3.mp3")
    const decomposed = parseNamingRule({ templates: [{ pattern: "Capítulo {chapter} versículo {verse}".normalize("NFD") }], book: "MAT" })!
    expect(applyNamingRule(decomposed, "Capítulo 5 versículo 3.mp3")).toBe("MAT 5:3.mp3")
    const v = parseNamingRule({ templates: [{ pattern: "v{verse}" }], book: "MAT", chapter: 1 })!
    expect(applyNamingRule(v, "v１２.mp3")).toBe("MAT 1:12.mp3")
  })

  it("refuses a number straight after a part, which could split one number in two", () => {
    expect(compileTemplate({ pattern: "{part}{verse}" })).toBeNull()
    expect(compileTemplate({ pattern: "v{verse}_{part}{take}" })).toBeNull()
    expect(compileTemplate({ pattern: "v{verse}{part}_t{take}" })).not.toBeNull()
  })

  it("allows at most two pieces of text to ignore, so no name can take long to read", () => {
    expect(compileTemplate({ pattern: "{any}a{any}a{any}a{verse}" })).toBeNull()
    expect(parseNamingRule({ templates: [{ pattern: "{any}a{any}a{any}a{any}a{any}a{verse}" }], book: "MAT", chapter: 1 })).toBeNull()
    const rule = parseNamingRule({ templates: [{ pattern: "{any}a{any}a{verse}" }], book: "MAT", chapter: 1 })!
    const started = performance.now()
    for (const n of [100, 150, 200]) applyNamingRule(rule, `${"a".repeat(n)}.mp3`)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it("compiles a rule's templates once, not once per name", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Mt: "MAT" } })!
    expect(compileRule(rule)).toBe(compileRule(rule))
  })
})

describe("which rules the team keeps (review, Oct 30)", () => {
  it("keeps a rule only when the names themselves say the book and the chapter, or the book and the verse in the book", () => {
    expect(isSavableRule(parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Mt: "MAT" } })!)).toBe(true)
    expect(isSavableRule(parseNamingRule({ templates: [{ pattern: "{book}_{verse}_LN{verseInBook}" }] })!)).toBe(true)
  })

  it("never keeps a rule that relies on a book, chapter or file it was told", () => {
    // Sam's Matthew 5 memos must not land next week's Mark 2 memos on Matthew 5.
    expect(isSavableRule(parseNamingRule({ templates: [{ pattern: "New Recording {verse}" }], book: "MAT", chapter: 5 })!)).toBe(false)
    expect(isSavableRule(parseNamingRule({ templates: [{ pattern: "{book} v{verse}" }], chapter: 5 })!)).toBe(false)
    expect(isSavableRule(parseNamingRule({ templates: [{ pattern: "IMG_{line}" }], file: "Welcome letter" })!)).toBe(false)
    expect(isSavableRule(parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }, { pattern: "intro {verse}" }], books: { Mt: "MAT" } })!)).toBe(false)
  })
})

describe("which names go to the assistant (review, Oct 30)", () => {
  const unplaced = (code: NonNullable<Assignment["reason"]>["code"]): Assignment => ({ index: 0, reason: { code } as NonNullable<Assignment["reason"]> })

  it("sends the names none of the app's readings understood", () => {
    for (const code of ["noBook", "noNumber", "tooManyNumbers", "chapterOrVerse"] as const) {
      expect(ruleEligible(unplaced(code))).toBe(true)
    }
  })

  it("leaves out what the app refused on purpose, what the person skipped, and what isn't a recording", () => {
    // A book the project doesn't have, a chapter or line past the end
    // (review, Oct 30): read, and refused on purpose, like a missing verse.
    for (const code of [
      "noSuchVerse", "otherBook", "duplicate", "bookVerseDisagree", "rangeBackwards", "skipped", "notAudio", "unplayableFormat", "systemFile", "empty", "tooLarge",
      "bookNotInProject", "noSuchChapter", "noSuchLine", "pastLastLine", "beforeFirstLine",
    ] as const) {
      expect(ruleEligible(unplaced(code))).toBe(false)
    }
    expect(ruleEligible({ index: 0, method: "name", fileId: "mat", cellIds: ["mat:1:1"] })).toBe(false)
  })
})

describe("whether a rule placed the names it was asked about (review, Oct 30)", () => {
  const mat = [book("mat", "MAT", "Matthew", MAT)]
  const chapterVerse = () => parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Mt: "MAT" } })!
  const judge = (rule: NamingRule, landed: ReturnType<typeof landAll>) =>
    judgeRule(rule, new Set(landed.made.keys()), landed.made, landed.assignments, landed.names, landed.where)

  it("keeps a rule that placed every name by reading it", () => {
    const rule = chapterVerse()
    const j = judge(rule, landAll(rule, ["Files/Mt-ch19_v01.ogg", "Files/Mt-ch19_v02.ogg"], mat))
    expect([...j.placed]).toEqual([0, 1])
    expect(j.failures).toEqual([])
    expect(j.keep).toBe(true)
  })

  it("doesn't count names placed by folder order as placed by the rule", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "IMG_{line}" }], file: "Welcome letter" })!
    const letter: TargetFile = { fileId: "wl", name: "Welcome letter", bookCode: null, lines: Array.from({ length: 10 }, (_, i) => ({ cellId: `wl${i}`, ref: null, text: `t${i}`, structural: false, hasRecording: false })) }
    const j = judge(rule, landAll(rule, ["Files/IMG_4521.ogg", "Files/IMG_4522.ogg", "Files/IMG_4523.ogg"], [letter, ...mat]))
    expect(j.placed.size).toBe(0)
    expect(j.failures).toHaveLength(3)
    expect(j.keep).toBe(false)
  })

  it("doesn't keep a rule that placed only some names, and sends back only the ones it missed", () => {
    const rule = chapterVerse()
    const j = judge(rule, landAll(rule, ["Files/Mt-ch19_v01.ogg", "Files/Mt-ch19_v02.ogg", "Files/Mt-ch19_v99.ogg"], mat))
    expect(j.placed.size).toBe(2)
    expect(j.failures).toEqual([{ name: "Mt-ch19_v99.ogg", made: "MAT 19:99.ogg", reason: "noSuchVerse" }])
    expect(j.keep).toBe(false)
  })

  it("doesn't keep a rule when the person chose a line by hand or skipped a file, and sends neither back", () => {
    const rule = chapterVerse()
    const paths = ["Files/Mt-ch19_v01.ogg", "Files/Mt-ch19_v02.ogg", "Files/Mt-ch19_v03.ogg"]
    const chose = judge(rule, landAll(rule, paths, mat, { overrides: new Map([[1, { fileId: "mat", cellId: "mat:19:9" }]]) }))
    expect(chose.placed.size).toBe(2)
    expect(chose.failures).toEqual([])
    expect(chose.keep).toBe(false)
    const skipped = judge(rule, landAll(rule, paths, mat, { overrides: new Map([[2, "skip" as const]]) }))
    expect(skipped.placed.size).toBe(2)
    expect(skipped.failures).toEqual([])
    expect(skipped.keep).toBe(false)
  })

  it("doesn't keep a rule that relies on a constant, though its files are placed", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "sermon_{verse}" }], book: "MAT", chapter: 20 })!
    const j = judge(rule, landAll(rule, ["Files/sermon_01.ogg", "Files/sermon_02.ogg"], mat))
    expect(j.placed.size).toBe(2)
    expect(j.keep).toBe(false)
  })

  it("doesn't keep a rule that puts two files on one line: a take and a verse swapped", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}{chapter}-{take}_t{verse}" }], books: { Mt: "MAT" } })!
    const landed = landAll(rule, ["Files/Mt5-1_t1.ogg", "Files/Mt5-2_t1.ogg", "Files/Mt5-3_t1.ogg"], mat)
    expect(landed.assignments.map((a) => a.cellIds?.[0])).toEqual(["mat:5:1", "mat:5:1", "mat:5:1"])
    const j = judge(rule, landed)
    expect(j.placed.size).toBe(3)
    expect(j.keep).toBe(false)
  })

  // Sam, Oct 30: pieces of one verse are what the bulk upload expects (AQU-981
  // rule 4), so they no longer stop a rule being kept. The same verse twice
  // with nothing telling the files apart still does.
  const pieces = () => parseNamingRule({
    templates: [{ pattern: "{book}-ch{chapter}_v{verse}{part}" }, { pattern: "{book}-ch{chapter}_v{verse}" }],
    books: { Mt: "MAT" },
  })!

  it("keeps a pieces naming placed in full: 4a and 4b are two pieces of one verse", () => {
    const rule = pieces()
    const landed = landAll(rule, ["Files/Mt-ch19_v03.ogg", "Files/Mt-ch19_v04a.ogg", "Files/Mt-ch19_v04b.ogg"], mat)
    expect(landed.assignments.map((a) => [a.cellIds?.[0], a.part?.rank])).toEqual([["mat:19:3", undefined], ["mat:19:4", 1], ["mat:19:4", 2]])
    const j = judge(rule, landed)
    expect(j.placed.size).toBe(3)
    expect(j.keep).toBe(true)
  })

  it("still doesn't keep a rule that puts the same verse twice with no part", () => {
    // The pieces read with their part ignored: two takes of Matthew 19:4.
    const rule = parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}_{any}" }], books: { Mt: "MAT" } })!
    const landed = landAll(rule, ["Files/Mt-ch19_v04_first.ogg", "Files/Mt-ch19_v04_second.ogg"], mat)
    expect(landed.assignments.map((a) => [a.cellIds?.[0], a.part])).toEqual([["mat:19:4", undefined], ["mat:19:4", undefined]])
    const j = judge(rule, landed)
    expect(j.placed.size).toBe(2)
    expect(j.keep).toBe(false)
  })

  it("doesn't keep a rule that names one part twice: the second file isn't placed", () => {
    const rule = pieces()
    const landed = landAll(rule, ["Files/Mt-ch19_v04a.ogg", "Files/Mt-ch19_v4a.ogg"], mat)
    const j = judge(rule, landed)
    expect(j.placed.size).toBe(1)
    expect(j.keep).toBe(false)
  })

  describe("a joined line (Matthew 19:4-5 as one line)", () => {
    const joined = (): TargetFile => {
      const file = book("mat", "MAT", "Matthew", MAT)
      const at = file.lines.findIndex((l) => l.ref === "MAT 19:4")
      file.lines.splice(at, 2, { cellId: "mat:19:4-5", ref: "MAT 19:4-5", text: "", structural: false, hasRecording: false })
      return file
    }

    it("keeps a rule whose verses 4 and 5 land on it as its two pieces, as AQU-981 joins them", () => {
      const rule = chapterVerse()
      const landed = landAll(rule, ["Files/Mt-ch19_v03.ogg", "Files/Mt-ch19_v04.ogg", "Files/Mt-ch19_v05.ogg"], [joined()])
      expect(landed.assignments.map((a) => [a.cellIds?.[0], a.part?.rank])).toEqual([["mat:19:3", undefined], ["mat:19:4-5", 4], ["mat:19:4-5", 5]])
      const j = judge(rule, landed)
      expect(j.placed.size).toBe(3)
      expect(j.keep).toBe(true)
    })

    it("still doesn't keep a rule that puts verse 4 on it twice: two takes of the line", () => {
      const rule = parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}_{any}" }], books: { Mt: "MAT" } })!
      const landed = landAll(rule, ["Files/Mt-ch19_v04_first.ogg", "Files/Mt-ch19_v04_second.ogg"], [joined()])
      expect(landed.assignments.map((a) => [a.cellIds?.[0], a.part])).toEqual([["mat:19:4-5", undefined], ["mat:19:4-5", undefined]])
      const j = judge(rule, landed)
      expect(j.placed.size).toBe(2)
      expect(j.keep).toBe(false)
    })
  })
})

// ── The second review (Oct 30): each of these could put recordings on the
// wrong lines and keep that rule for the whole organization. ─────────────────

describe("a book word that names no book is a constant in disguise (review, Oct 30)", () => {
  const project = [book("mat", "MAT", "Matthew", MAT), book("mrk", "MRK", "Mark", [45, 28, 35, 41, 43, 56, 37, 38, 50, 52, 33, 44, 37, 72, 47, 20])]
  const sermons = () => parseNamingRule({ templates: [{ pattern: "{book}_{chapter}_{verse}" }], books: { sermon: "MAT" } })!

  it("uses books {sermon: MAT} for this week's folder, and never keeps it for next week's Mark sermons", () => {
    const rule = sermons()
    expect(rule).not.toBeNull()
    expect(isSavableRule(rule)).toBe(false)
    const landed = landAll(rule, ["Files/sermon_05_01.ogg", "Files/sermon_05_02.ogg", "Files/sermon_05_03.ogg"], project)
    expect(landed.assignments.map((a) => a.cellIds?.[0])).toEqual(["mat:5:1", "mat:5:2", "mat:5:3"])
    const j = judgeRule(rule, new Set(landed.made.keys()), landed.made, landed.assignments, landed.names, landed.where)
    expect(j.placed.size).toBe(3)
    expect(j.keep).toBe(false)
  })

  it("keeps a book word the app's table reads as that book, or a short form of its code or English name", () => {
    for (const [word, code] of [["Mt", "MAT"], ["Matt", "MAT"], ["Matthew", "MAT"], ["Mk", "MRK"], ["Mrk", "MRK"], ["Jn", "JHN"], ["1Co", "1CO"], ["1 Cor", "1CO"], ["Gen", "GEN"], ["太", "MAT"]] as const) {
      const rule = parseNamingRule({ templates: [{ pattern: "{book}_{chapter}_{verse}" }], books: { [word]: code } })
      expect(rule, word).not.toBeNull()
      expect(isSavableRule(rule!), word).toBe(true)
    }
  })

  it("counts a word that only shares letters with the book, or a single letter, as a constant", () => {
    for (const [word, code] of [["sermon", "MAT"], ["track", "MAT"], ["tm", "MAT"], ["M", "MAT"], ["Mta", "MAT"]] as const) {
      const rule = parseNamingRule({ templates: [{ pattern: "{book}_{chapter}_{verse}" }], books: { [word]: code } })!
      expect(isSavableRule(rule), word).toBe(false)
    }
  })

  it("keeps a word the project's own book files use for that book, as the server reads them too", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}_{chapter}_{verse}" }], books: { Mateo: "MAT" } })!
    expect(isSavableRule(rule)).toBe(false)
    expect(isSavableRule(rule, { projectBooks: [{ name: "Mateo", code: "MAT" }] })).toBe(true)
    expect(isSavableRule(rule, { projectBooks: [{ name: "Mateo", code: "MRK" }] })).toBe(false)
  })

  it("is one shared check, so the server keeps and hands back only what the browser would", () => {
    expect(shared.bookWordNames("Mt", "MAT")).toBe(true)
    expect(shared.bookWordNames("sermon", "MAT")).toBe(false)
  })
})

describe("names the app refused on purpose never go to the assistant (review, Oct 30)", () => {
  const matthewOnly = [book("mat", "MAT", "Matthew", MAT)]

  it("a Mark folder dropped on a Matthew project is read, refused as a book the project lacks, and not sent", () => {
    const paths = ["Mark/Mark 1-1.mp3", "Mark/Mark 1-2.mp3", "Mark/Mark 1-3.mp3"]
    const files = paths.map(audio)
    const read = readRecordings(files, { scope: { kind: "project" }, index: new BookNameIndex(), projectFiles: [{ fileId: "mat", name: "Matthew", bookCode: "MAT" }], maxBytes: 1 << 30 })
    const assignments = matchRecordings(read, new Map(matthewOnly.map((t) => [t.fileId, t])))
    expect(assignments.map((a) => a.reason?.code)).toEqual(["bookNotInProject", "bookNotInProject", "bookNotInProject"])
    expect(assignments.filter(ruleEligible)).toEqual([])
  })

  it("refuses an answer mapping a word the app reads as one book to another: {Mark: MAT}", () => {
    expect(parseNamingRule({ templates: [{ pattern: "{book} {chapter}-{verse}" }], books: { Mark: "MAT" } })).toBeNull()
    expect(parseNamingRule({ templates: [{ pattern: "{book} {chapter}-{verse}" }], books: { Mk: "MAT" } })).toBeNull()
    expect(parseNamingRule({ templates: [{ pattern: "{book} {chapter}-{verse}" }], books: { Mark: "MRK" } })).not.toBeNull()
  })
})

describe("a recording of several verses (review, Oct 30)", () => {
  const mat = [book("mat", "MAT", "Matthew", MAT)]
  const ranges = ["Files/Mt-ch19_v01-03.ogg", "Files/Mt-ch19_v04-06.ogg", "Files/Mt-ch19_v07-09.ogg"]

  it("refuses a placeholder that appears twice in one template, which would keep only the last value", () => {
    expect(compileTemplate({ pattern: "{book}-ch{chapter}_v{verse}-{verse}" })).toBeNull()
    expect(parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}-{verse}" }], books: { Mt: "MAT" } })).toBeNull()
    // Text to ignore may still come twice: it is never a value.
    expect(compileTemplate({ pattern: "{any}_{book}-ch{chapter}_v{verse}_{any}" })).not.toBeNull()
  })

  it("{toVerse} ends the range: Mt-ch19_v01-03 is one recording over Matthew 19:1-3", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}-{toVerse}" }], books: { Mt: "MAT" } })!
    expect(rule).not.toBeNull()
    expect(applyNamingRule(rule, "Mt-ch19_v01-03.ogg")).toBe("MAT 19:1-3.ogg")
    const landed = landAll(rule, ranges, mat)
    expect(landed.assignments.map((a) => a.cellIds)).toEqual([
      ["mat:19:1", "mat:19:2", "mat:19:3"], ["mat:19:4", "mat:19:5", "mat:19:6"], ["mat:19:7", "mat:19:8", "mat:19:9"],
    ])
    const j = judgeRule(rule, new Set(landed.made.keys()), landed.made, landed.assignments, landed.names, landed.where)
    expect(j.keep).toBe(true)
  })

  it("refuses {toVerse} with no {verse} to start from, or beside a verse counted through the book", () => {
    expect(compileTemplate({ pattern: "{book}-ch{chapter}_to{toVerse}" })).toBeNull()
    expect(compileTemplate({ pattern: "{book}_{verseInBook}-{toVerse}" })).toBeNull()
  })

  it("doesn't keep a rule that drops each range's end: every file on its first verse, far apart", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}-{any}" }], books: { Mt: "MAT" } })!
    const landed = landAll(rule, ranges, mat)
    expect(landed.assignments.map((a) => a.cellIds)).toEqual([["mat:19:1"], ["mat:19:4"], ["mat:19:7"]])
    const j = judgeRule(rule, new Set(landed.made.keys()), landed.made, landed.assignments, landed.names, landed.where)
    expect(j.placed.size).toBe(3)
    expect(j.keep).toBe(false)
  })
})

describe("a rule is kept only when where it put the files looks like a reading (review, Oct 30)", () => {
  const mat = [book("mat", "MAT", "Matthew", MAT)]
  const judged = (rule: NamingRule, paths: string[], targets: TargetFile[] = mat) => {
    const landed = landAll(rule, paths, targets)
    return { landed, j: judgeRule(rule, new Set(landed.made.keys()), landed.made, landed.assignments, landed.names, landed.where) }
  }

  it("doesn't keep Matthew 5:1-20 read with the chapter and the verse swapped: in order, but scattered over twenty chapters", () => {
    const paths = Array.from({ length: 20 }, (_, i) => `Files/Mt-ch05_v${String(i + 1).padStart(2, "0")}.ogg`)
    const { landed, j } = judged(parseNamingRule({ templates: [{ pattern: "{book}-ch{verse}_v{chapter}" }], books: { Mt: "MAT" } })!, paths)
    expect(landed.assignments.slice(0, 3).map((a) => a.cellIds?.[0])).toEqual(["mat:1:5", "mat:2:5", "mat:3:5"])
    expect(j.placed.size).toBe(20)
    expect(j.keep).toBe(false)
  })

  it("keeps the same folder read the right way round", () => {
    const paths = Array.from({ length: 20 }, (_, i) => `Files/Mt-ch05_v${String(i + 1).padStart(2, "0")}.ogg`)
    expect(judged(parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Mt: "MAT" } })!, paths).j.keep).toBe(true)
  })

  it("doesn't keep a rule whose files, in name order, run backwards through the lines", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_n{any}_v{verse}" }], books: { Mt: "MAT" } })!
    const { landed, j } = judged(rule, ["Files/Mt-ch19_n1_v03.ogg", "Files/Mt-ch19_n2_v02.ogg", "Files/Mt-ch19_n3_v01.ogg"])
    expect(landed.assignments.map((a) => a.cellIds?.[0])).toEqual(["mat:19:3", "mat:19:2", "mat:19:1"])
    expect(j.placed.size).toBe(3)
    expect(j.keep).toBe(false)
  })

  it("doesn't keep a rule that leaves more lines between its files than it fills", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Mt: "MAT" } })!
    expect(judged(rule, ["Files/Mt-ch19_v01.ogg", "Files/Mt-ch19_v05.ogg", "Files/Mt-ch19_v10.ogg"]).j.keep).toBe(false)
    // Half of the lines from the first to the last is enough.
    expect(judged(rule, ["Files/Mt-ch19_v01.ogg", "Files/Mt-ch19_v02.ogg", "Files/Mt-ch19_v04.ogg"]).j.keep).toBe(true)
  })

  it("counts takes and pieces on one line as in order, and reads each book on its own", () => {
    const pieces = parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}{part}" }, { pattern: "{book}-ch{chapter}_v{verse}" }], books: { Mt: "MAT", Mk: "MRK" } })!
    const two = [...mat, book("mrk", "MRK", "Mark", [45, 28])]
    expect(judged(pieces, ["Files/Mk-ch01_v01.ogg", "Files/Mk-ch01_v02.ogg", "Files/Mt-ch19_v01.ogg", "Files/Mt-ch19_v02a.ogg", "Files/Mt-ch19_v02b.ogg"], two).j.keep).toBe(true)
  })

  it("puts the files in folder order by their whole path, as the matcher does", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Mt: "MAT" } })!
    expect(judged(rule, ["B/Mt-ch19_v01.ogg", "A/Mt-ch19_v02.ogg"]).j.keep).toBe(false)
    expect(judged(rule, ["A/Mt-ch19_v01.ogg", "B/Mt-ch19_v02.ogg"]).j.keep).toBe(true)
  })
})

// Sam, Oct 30: the preview says whether a naming will be kept, and why not.
describe("why a rule isn't kept", () => {
  const mat = [book("mat", "MAT", "Matthew", MAT)]
  const why = (answer: unknown, paths: string[]) => {
    const rule = parseNamingRule(answer)!
    const landed = landAll(rule, paths, mat)
    return judgeRule(rule, new Set(landed.made.keys()), landed.made, landed.assignments, landed.names, landed.where)
  }
  const chapterVerse = { templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Mt: "MAT" } }

  it("gives no reason for a rule that is kept", () => {
    const j = why(chapterVerse, ["Files/Mt-ch19_v01.ogg", "Files/Mt-ch19_v02.ogg"])
    expect(j.keep).toBe(true)
    expect(j.notKept).toEqual([])
  })

  it("says a book or chapter it was told, or names that don't say them, as \"fixed\"", () => {
    expect(why({ templates: [{ pattern: "sermon_{verse}" }], book: "MAT", chapter: 20 }, ["Files/sermon_01.ogg", "Files/sermon_02.ogg"]).notKept).toEqual(["fixed"])
    expect(whyNotSavable(parseNamingRule({ templates: [{ pattern: "IMG_{line}" }], file: "Welcome letter" })!)).toBe("fixed")
    expect(whyNotSavable(parseNamingRule({ templates: [{ pattern: "line {line}" }] })!)).toBe("fixed")
  })

  it("says a book word that names no book as \"bookWord\"", () => {
    const j = why({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Sermon: "MAT" } }, ["Files/Sermon-ch20_v01.ogg", "Files/Sermon-ch20_v02.ogg"])
    expect(j.placed.size).toBe(2)
    expect(j.notKept).toEqual(["bookWord"])
    expect(whyNotSavable(parseNamingRule(chapterVerse)!)).toBeNull()
  })

  it("says names it didn't place as \"notAllPlaced\"", () => {
    expect(why(chapterVerse, ["Files/Mt-ch19_v01.ogg", "Files/Mt-ch19_v02.ogg", "Files/Mt-ch19_v99.ogg"]).notKept).toEqual(["notAllPlaced"])
  })

  it("says two files on one line as \"sharedLine\"", () => {
    const j = why({ templates: [{ pattern: "{book}{chapter}-{take}_t{verse}" }], books: { Mt: "MAT" } }, ["Files/Mt5-1_t1.ogg", "Files/Mt5-2_t1.ogg", "Files/Mt5-3_t1.ogg"])
    expect(j.notKept).toEqual(["sharedLine"])
  })

  it("says files out of order or scattered as \"scattered\"", () => {
    const swapped = { templates: [{ pattern: "{book}-ch{verse}_v{chapter}" }], books: { Mt: "MAT" } }
    expect(why(swapped, ["Files/Mt-ch05_v01.ogg", "Files/Mt-ch05_v02.ogg", "Files/Mt-ch05_v03.ogg", "Files/Mt-ch05_v04.ogg"]).notKept).toEqual(["scattered"])
  })

  it("gives every reason that holds, in the order the preview says them", () => {
    const j = why({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Sermon: "MAT" } }, ["Files/Sermon-ch19_v01.ogg", "Files/Sermon-ch19_v20.ogg", "Files/Sermon-ch19_v99.ogg"])
    expect(j.notKept).toEqual(["bookWord", "notAllPlaced", "scattered"])
  })
})
