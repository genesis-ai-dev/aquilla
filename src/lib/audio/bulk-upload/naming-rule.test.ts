import { describe, expect, it } from "vitest"
import { BookNameIndex } from "./book-names"
import { matchRecordings, readRecordings, type BulkInputFile, type MatchScope, type TargetFile, type TargetLine } from "./match"
import {
  applyNamingRule,
  compileTemplate,
  nameShape,
  parseNamingRule,
  projectOutline,
  sampleNames,
  shapesOf,
  type NamingRule,
} from "./naming-rule"

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
function land(rule: NamingRule, paths: string[], targets: TargetFile[], scope: MatchScope = { kind: "project" }) {
  const files = paths.map((p) => {
    const f = audio(p)
    const folder = p.split("/").slice(-2, -1)[0] ?? ""
    const made = applyNamingRule(rule, f.name, folder)
    return made ? { ...f, name: made, path: made } : f
  })
  const projectFiles = targets.map((t) => ({ fileId: t.fileId, name: t.name, bookCode: t.bookCode }))
  const read = readRecordings(files, { scope, index: new BookNameIndex(), projectFiles, maxBytes: 1 << 30 })
  return matchRecordings(read, new Map(targets.map((t) => [t.fileId, t]))).map((a) => a.cellIds?.[0] ?? a.reason?.code)
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

  it("the chapter from the folder: Kapitola 19/v01.mp3", () => {
    const rule = parseNamingRule({ templates: [{ pattern: "v{verse}", folder: "Kapitola {chapter}" }], book: "MAT" })!
    expect(land(rule, ["Mt/Kapitola 19/v01.mp3", "Mt/Kapitola 20/v34.mp3"], mat)).toEqual(["mat:19:1", "mat:20:34"])
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
  it("keeps every name of a small folder, sorted", () => {
    expect(sampleNames(["b10.mp3", "b2.mp3", "b1.mp3"])).toEqual(["b1.mp3", "b2.mp3", "b10.mp3"])
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

  it("keeps a team's rule under the names' shape, digits blanked", () => {
    expect(nameShape("MAT_1_LN619.ogg")).toBe("mat_#_ln#.ogg")
    expect(shapesOf(["a1.mp3", "a22.mp3", "b.mp3"])).toEqual(["a#.mp3", "b.mp3"])
  })
})
