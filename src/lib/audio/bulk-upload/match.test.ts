import { describe, expect, it } from "vitest"
import { BookNameIndex, bookKey } from "./book-names"
import { readName } from "./read-name"
import {
  CHAPTER_MIN_MEDIAN_MS,
  VERSE_MAX_MEDIAN_MS,
  needsLength,
  matchRecordings,
  planJobs,
  readRecordings,
  targetsWanted,
  type Assignment,
  type BulkInputFile,
  type MatchScope,
  type ProjectFileInfo,
  type TargetFile,
  type TargetLine,
} from "./match"

const MB = 1024 * 1024

function audio(path: string, size = 1000, lastModified?: number): BulkInputFile {
  const name = path.split("/").pop()!
  return { name, path, size, type: name.endsWith(".txt") ? "text/plain" : "audio/wav", ...(lastModified != null ? { lastModified } : {}) }
}

/** A Bible book with `chapters[c-1]` verses in chapter c, plus a title line. */
function book(fileId: string, code: string, name: string, chapters: number[], opts: { recorded?: string[] } = {}): TargetFile {
  const lines: TargetLine[] = [{ cellId: `${fileId}-title`, ref: code, text: name, structural: true, hasRecording: false }]
  chapters.forEach((count, ci) => {
    for (let v = 1; v <= count; v++) {
      const ref = `${code} ${ci + 1}:${v}`
      lines.push({ cellId: `${fileId}:${ci + 1}:${v}`, ref, text: `text of ${ref}`, structural: false, hasRecording: opts.recorded?.includes(ref) ?? false })
    }
  })
  return { fileId, name, bookCode: code, lines }
}

function doc(fileId: string, name: string, count: number): TargetFile {
  return {
    fileId,
    name,
    bookCode: null,
    lines: Array.from({ length: count }, (_, i) => ({ cellId: `${fileId}#${i + 1}`, ref: null, text: `line ${i + 1}`, structural: false, hasRecording: false })),
  }
}

function run(files: BulkInputFile[], targets: TargetFile[], scope: MatchScope, index = new BookNameIndex()) {
  const projectFiles: ProjectFileInfo[] = targets.map((t) => ({ fileId: t.fileId, name: t.name, bookCode: t.bookCode }))
  const read = readRecordings(files, { scope, index, projectFiles, maxBytes: 2048 * MB })
  const map = new Map(targets.map((t) => [t.fileId, t]))
  const assignments = matchRecordings(read, map)
  return { read, assignments, jobs: planJobs(assignments, read) }
}

const by = (assignments: Assignment[], files: BulkInputFile[], name: string) =>
  assignments.find((a) => files[a.index].name === name)!

describe("bookKey and the book table", () => {
  it("reads ordinals and Roman numerals as digits, and leaves Isaiah alone", () => {
    expect(bookKey("I Samuel")).toBe("1samuel")
    expect(bookKey("First Samuel")).toBe("1samuel")
    expect(bookKey("II Kings")).toBe("2kings")
    expect(bookKey("Isaiah")).toBe("isaiah")
    expect(bookKey("Is")).toBe("is")
  })

  it("trusts a one- or two-letter form only right before a number", () => {
    const index = new BookNameIndex()
    expect(readName("Ps 23.mp3", index).book?.code).toBe("PSA")
    expect(readName("this is take.mp3", index).book).toBeNull()
  })

  it("prefers what the project calls a book", () => {
    const index = new BookNameIndex()
    index.addProjectName("Kejadian", "GEN")
    expect(readName("Kejadian 1-1.mp3", index).book).toEqual({ code: "GEN", fromProject: true })
  })
})

describe("readName", () => {
  const index = new BookNameIndex()
  it.each([
    ["Genesis 1-1.mp3", "GEN", [1, 1]],
    ["Gen 1.1.wav", "GEN", [1, 1]],
    ["1 Samuel 3-4.mp3", "1SA", [3, 4]],
    ["1Sam_3_4.m4a", "1SA", [3, 4]],
    ["GEN 1-1.mp3", "GEN", [1, 1]],
    ["GEN_001_001.wav", "GEN", [1, 1]],
    ["01_GEN_001_001.wav", "GEN", [1, 1]],
    ["Song of Songs 2-3.mp3", "SNG", [2, 3]],
    ["创世记1章1节.mp3", "GEN", [1, 1]],
    ["创世记第一章第三节.mp3", "GEN", [1, 3]],
    ["诗篇23篇1节.mp3", "PSA", [23, 1]],
    ["ENGESV_JHN_03_16_2023.mp3", "JHN", [3, 16]],
  ])("%s", (name, code, numbers) => {
    const r = readName(name, index)
    expect(r.book?.code).toBe(code)
    expect(r.numbers.map((n) => n.value).slice(0, numbers.length)).toEqual(numbers)
  })

  it("stops the reference at the first ordinary word", () => {
    const r = readName("Genesis 1-1 ENGESV 2023.mp3", index)
    expect(r.numbers.map((n) => n.value)).toEqual([1, 1])
  })

  it("keeps a dotted reference whole when there is no extension", () => {
    expect(readName("Gen 1.1", index).numbers.map((n) => n.value)).toEqual([1, 1])
  })
})

describe("matching inside one Bible book", () => {
  const gen = book("gen", "GEN", "Genesis", [31, 25, 24])
  const scope: MatchScope = { kind: "file", fileId: "gen" }

  it("a well-named book lands every verse by name", () => {
    const files = ["Genesis 1-1.mp3", "Genesis 1-2.mp3", "Genesis 2-10.mp3"].map((n) => audio(n))
    const { assignments } = run(files, [gen], scope)
    expect(assignments.map((a) => [a.method, a.cellIds])).toEqual([
      ["name", ["gen:1:1"]],
      ["name", ["gen:1:2"]],
      ["name", ["gen:2:10"]],
    ])
  })

  it("mixed spellings all find their verse", () => {
    const files = ["Gen 1.3.mp3", "GEN_001_004.wav", "genesis 1-5.m4a", "Ge1_6.mp3", "01_GEN_001_007.wav"].map((n) => audio(n))
    const { assignments } = run(files, [gen], scope)
    expect(assignments.map((a) => a.cellIds?.[0])).toEqual(["gen:1:3", "gen:1:4", "gen:1:5", "gen:1:6", "gen:1:7"])
  })

  it("numbers alone are chapter and verse inside a book", () => {
    const files = ["1-1.mp3", "001_002.mp3", "1.3.mp3", "2:4.mp3"].map((n) => audio(n))
    const { assignments } = run(files, [gen], scope)
    expect(assignments.map((a) => [a.method, a.cellIds?.[0]])).toEqual([
      ["number", "gen:1:1"],
      ["number", "gen:1:2"],
      ["number", "gen:1:3"],
      ["number", "gen:2:4"],
    ])
  })

  it("drops a book number every file shares (01_001_001)", () => {
    const files = ["01_001_001.wav", "01_001_002.wav", "01_002_001.wav"].map((n) => audio(n))
    const { assignments } = run(files, [gen], scope)
    expect(assignments.map((a) => a.cellIds?.[0])).toEqual(["gen:1:1", "gen:1:2", "gen:2:1"])
  })

  it("a range is one recording over every verse it covers", () => {
    const files = ["Genesis 1-1-3.mp3", "Genesis 1:4-6.mp3", "1-7-8.mp3"].map((n) => audio(n))
    const { assignments, jobs } = run(files, [gen], scope)
    expect(assignments.map((a) => a.cellIds)).toEqual([
      ["gen:1:1", "gen:1:2", "gen:1:3"],
      ["gen:1:4", "gen:1:5", "gen:1:6"],
      ["gen:1:7", "gen:1:8"],
    ])
    expect(jobs.every((j) => j.kind === "range")).toBe(true)
  })

  it("a range may cross into the next chapter", () => {
    const files = [audio("Genesis 1:30-2:2.mp3")]
    const { assignments } = run(files, [gen], scope)
    expect(assignments[0].cellIds).toEqual(["gen:1:30", "gen:1:31", "gen:2:1", "gen:2:2"])
  })

  it("a chapter with no verse covers the whole chapter", () => {
    const { assignments } = run([audio("Genesis 3.mp3")], [gen], scope)
    expect(assignments[0].cellIds).toHaveLength(24)
    expect(assignments[0].read).toBe("Genesis 3")
  })

  it("parts of one verse become one job in order, whatever the suffix", () => {
    const files = ["Genesis 1-1b.mp3", "Genesis 1-1a.mp3", "Genesis 1-2 end.mp3", "Genesis 1-2 beginning.mp3", "Genesis 1-3 part 2.mp3", "Genesis 1-3 part 1.mp3", "Genesis 1-4_2.mp3", "Genesis 1-4_1.mp3"].map((n) => audio(n))
    const { jobs } = run(files, [gen], scope)
    const pieces = jobs.filter((j) => j.kind === "pieces")
    expect(pieces.map((j) => [j.cellId, j.files.map((i) => files[i].name)])).toEqual([
      ["gen:1:1", ["Genesis 1-1a.mp3", "Genesis 1-1b.mp3"]],
      ["gen:1:2", ["Genesis 1-2 beginning.mp3", "Genesis 1-2 end.mp3"]],
      ["gen:1:3", ["Genesis 1-3 part 1.mp3", "Genesis 1-3 part 2.mp3"]],
      ["gen:1:4", ["Genesis 1-4_1.mp3", "Genesis 1-4_2.mp3"]],
    ])
  })

  it("a verse letter the project has is that verse, not a part", () => {
    const split = book("gen", "GEN", "Genesis", [3])
    split.lines.push({ cellId: "gen:1:4a", ref: "GEN 1:4a", text: "4a", structural: false, hasRecording: false })
    split.lines.push({ cellId: "gen:1:4b", ref: "GEN 1:4b", text: "4b", structural: false, hasRecording: false })
    const { assignments, jobs } = run([audio("Genesis 1-4a.mp3"), audio("Genesis 1-4b.mp3")], [split], scope)
    expect(assignments.map((a) => a.cellIds?.[0])).toEqual(["gen:1:4a", "gen:1:4b"])
    expect(jobs.every((j) => j.kind === "single")).toBe(true)
  })

  it("numbered takes of one verse all upload, highest last", () => {
    const files = [audio("Genesis 1-1 take 2.mp3"), audio("Genesis 1-1 take 1.mp3")]
    const { jobs } = run(files, [gen], scope)
    expect(jobs).toEqual([{ kind: "single", fileId: "gen", cellId: "gen:1:1", files: [1, 0] }])
  })

  it("lists every file it will not upload, with a reason", () => {
    const files = [
      audio("Genesis 9-1.mp3"),
      audio("Genesis 1-40.mp3"),
      audio("Exodus 1-1.mp3"),
      audio("notes.txt"),
      audio("._Genesis 1-1.mp3"),
      audio("Genesis 1-1.mp3"),
      audio("Genesis 1-1a.mp3"),
      audio("intro.mp3"),
      { ...audio("Genesis 1-2.mp3"), size: 0 },
    ]
    const { assignments } = run(files, [gen], scope)
    expect(by(assignments, files, "Genesis 9-1.mp3").reason).toEqual({ code: "noSuchChapter", book: "Genesis", chapter: 9 })
    expect(by(assignments, files, "Genesis 1-40.mp3").reason).toEqual({ code: "noSuchVerse", ref: "Genesis 1:40" })
    expect(by(assignments, files, "Exodus 1-1.mp3").reason).toEqual({ code: "otherBook", book: "Exodus", fileName: "Genesis" })
    expect(by(assignments, files, "notes.txt").reason).toEqual({ code: "notAudio" })
    expect(by(assignments, files, "._Genesis 1-1.mp3").reason).toEqual({ code: "systemFile" })
    // A part can't share its verse with a whole recording of it.
    expect(by(assignments, files, "Genesis 1-1a.mp3").reason).toEqual({ code: "duplicate", target: "Genesis 1:1", other: "Genesis 1-1.mp3" })
    expect(by(assignments, files, "intro.mp3").reason).toEqual({ code: "noNumber" })
    expect(by(assignments, files, "Genesis 1-2.mp3").reason).toEqual({ code: "empty" })
    // Never silently dropped: one answer per file.
    expect(assignments).toHaveLength(files.length)
  })

  it("a folder with no naming scheme goes in folder order, 2 before 10", () => {
    const files = ["New Recording 10.m4a", "New Recording 2.m4a", "New Recording 1.m4a"].map((n) => audio(`Gen/${n}`))
    // "New Recording N" are numbers that find lines, so they are read by
    // number, not by order. Three of them in a book of three chapters are
    // chapters (the count rule, below): 1 and 2 are whole chapters, and there
    // is no chapter 10.
    const numbered = run(files, [gen], scope).assignments
    expect(numbered.map((a) => [files[a.index].name, a.method ?? a.reason?.code, a.read])).toEqual([
      ["New Recording 10.m4a", "noSuchChapter", undefined],
      ["New Recording 2.m4a", "number", "Genesis 2"],
      ["New Recording 1.m4a", "number", "Genesis 1"],
    ])
    const counters = ["IMG_4510.m4a", "IMG_4502.m4a", "IMG_4501.m4a"].map((n) => audio(`Gen/${n}`))
    const { assignments } = run(counters, [gen], scope)
    expect(assignments.map((a) => [counters[a.index].name, a.method, a.cellIds?.[0]])).toEqual([
      ["IMG_4510.m4a", "order", "gen:1:3"],
      ["IMG_4502.m4a", "order", "gen:1:2"],
      ["IMG_4501.m4a", "order", "gen:1:1"],
    ])
  })

  it("order moves as a whole when shifted, and says what falls off the end", () => {
    const files = ["a.m4a", "b.m4a"].map((n) => audio(`x/${n}`))
    const projectFiles = [{ fileId: "gen", name: "Genesis", bookCode: "GEN" }]
    const read = readRecordings(files, { scope, index: new BookNameIndex(), projectFiles, maxBytes: 10 * MB })
    const first = matchRecordings(read, new Map([["gen", gen]]))
    const run1 = first[0].orderRun!
    const moved = matchRecordings(read, new Map([["gen", gen]]), { orderShift: new Map([[run1, 1]]) })
    expect(moved.map((a) => a.cellIds?.[0])).toEqual(["gen:1:2", "gen:1:3"])
    const back = matchRecordings(read, new Map([["gen", gen]]), { orderShift: new Map([[run1, -1]]) })
    expect(back[0].reason).toEqual({ code: "beforeFirstLine" })
  })

  it("an order run in a chapter's folder starts at that chapter, and can start anywhere", () => {
    const files = ["IMG_4501.m4a", "IMG_4502.m4a"].map((n) => audio(`Genesis 2/${n}`))
    const projectFiles = [{ fileId: "gen", name: "Genesis", bookCode: "GEN" }]
    const read = readRecordings(files, { scope, index: new BookNameIndex(), projectFiles, maxBytes: 10 * MB })
    const first = matchRecordings(read, new Map([["gen", gen]]))
    expect(first.map((a) => [a.method, a.cellIds?.[0], a.fromFolder])).toEqual([["order", "gen:2:1", "Genesis 2"], ["order", "gen:2:2", "Genesis 2"]])
    const run = first[0].orderRun!
    const moved = matchRecordings(read, new Map([["gen", gen]]), { orderStart: new Map([[run, "gen:3:5"]]), orderShift: new Map([[run, 1]]) })
    expect(moved.map((a) => a.cellIds?.[0])).toEqual(["gen:3:6", "gen:3:7"])
  })

  it("a chosen line wins over a part's claim on it", () => {
    const files = [audio("Genesis 1-1a.mp3"), audio("Genesis 1-2.mp3")]
    const projectFiles = [{ fileId: "gen", name: "Genesis", bookCode: "GEN" }]
    const read = readRecordings(files, { scope, index: new BookNameIndex(), projectFiles, maxBytes: 10 * MB })
    const out = matchRecordings(read, new Map([["gen", gen]]), { overrides: new Map([[1, { fileId: "gen", cellId: "gen:1:1" }]]) })
    expect(out[1]).toMatchObject({ cellIds: ["gen:1:1"], chosen: true })
    expect(out[0].reason).toMatchObject({ code: "duplicate", other: "Genesis 1-2.mp3" })
  })

  it("chapter from the folder, verse from the name", () => {
    const files = ["Chapter 2/01.mp3", "Chapter 2/02.mp3"].map((n) => audio(n))
    const { assignments } = run(files, [gen], scope)
    expect(assignments.map((a) => [a.cellIds?.[0], a.fromFolder])).toEqual([["gen:2:1", "Chapter 2"], ["gen:2:2", "Chapter 2"]])
  })
})

describe("matching across a whole project", () => {
  const gen = book("gen", "GEN", "Genesis", [31, 25])
  const exo = book("exo", "EXO", "Exodus", [22])
  const sam = book("1sa", "1SA", "1 Samuel", [28, 10, 21])
  const project: MatchScope = { kind: "project" }

  it("each file finds its book by its name, across many books", () => {
    const files = ["Genesis 1-1.mp3", "Exod 1.2.mp3", "1Sam_3_4.mp3", "GEN_002_003.wav"].map((n) => audio(n))
    const { assignments, read } = run(files, [gen, exo, sam], project)
    expect(targetsWanted(read).sort()).toEqual(["1sa", "exo", "gen"])
    expect(assignments.map((a) => a.cellIds?.[0])).toEqual(["gen:1:1", "exo:1:2", "1sa:3:4", "gen:2:3"])
  })

  it("the folder names the book when the files do not", () => {
    const files = ["Exodus/1-1.mp3", "Exodus/1-2.mp3"].map((n) => audio(n))
    const { assignments } = run(files, [gen, exo], project)
    expect(assignments.map((a) => [a.cellIds?.[0], a.fromFolder])).toEqual([["exo:1:1", "Exodus"], ["exo:1:2", "Exodus"]])
  })

  it("the project's own book names (Chinese)", () => {
    const index = new BookNameIndex()
    index.addProjectName("Kitab Kejadian", "GEN")
    const files = ["创世记 1-1.mp3", "出埃及记1章2节.mp3", "Kitab Kejadian 2-1.mp3"].map((n) => audio(n))
    const { assignments } = run(files, [gen, exo], project, index)
    expect(assignments.map((a) => a.cellIds?.[0])).toEqual(["gen:1:1", "exo:1:2", "gen:2:1"])
  })

  it("book numbers in front of chapter and verse", () => {
    const files = ["01_001_001.wav", "02_001_003.wav"].map((n) => audio(n))
    const { assignments } = run(files, [gen, exo], project)
    expect(assignments.map((a) => a.cellIds?.[0])).toEqual(["gen:1:1", "exo:1:3"])
  })

  it("says when a book is not in the project, or nothing names one", () => {
    const files = [audio("Leviticus 1-1.mp3"), audio("recording.mp3")]
    const { assignments } = run(files, [gen], project)
    expect(assignments.map((a) => a.reason)).toEqual([{ code: "bookNotInProject", book: "Leviticus" }, { code: "noBook" }])
  })
})

describe("matching inside a document, plain text or subtitles", () => {
  const notes = doc("notes", "Welcome letter", 20)
  const scope: MatchScope = { kind: "file", fileId: "notes" }

  it("numbers are lines, counted from the top", () => {
    const files = ["012.mp3", "line 13.mp3", "part_003.mp3", "Welcome letter_014.mp3", "This is 15.mp3"].map((n) => audio(n))
    const { assignments } = run(files, [notes], scope)
    expect(assignments.map((a) => a.cellIds?.[0])).toEqual(["notes#12", "notes#13", "notes#3", "notes#14", "notes#15"])
  })

  it("a year every file shares is not the line", () => {
    const files = ["LOTE_2023_001.mp3", "LOTE_2023_002.mp3", "LOTE_2023_010.mp3"].map((n) => audio(n))
    const { assignments } = run(files, [notes], scope)
    expect(assignments.map((a) => a.cellIds?.[0])).toEqual(["notes#1", "notes#2", "notes#10"])
  })

  it("numbered and unnumbered files: the unnumbered are listed, not guessed", () => {
    const files = ["001.mp3", "002.mp3", "outro.mp3"].map((n) => audio(n))
    const { assignments } = run(files, [notes], scope)
    expect(assignments.map((a) => a.cellIds?.[0] ?? a.reason?.code)).toEqual(["notes#1", "notes#2", "noNumber"])
  })

  it("a line range and line parts", () => {
    const files = ["004-006.mp3", "007a.mp3", "007b.mp3", "008_1.mp3", "008_2.mp3"].map((n) => audio(n))
    const { jobs } = run(files, [notes], scope)
    expect(jobs.map((j) => [j.kind, "cellIds" in j ? j.cellIds : j.cellId])).toEqual([
      ["range", ["notes#4", "notes#5", "notes#6"]],
      ["pieces", "notes#7"],
      ["pieces", "notes#8"],
    ])
  })

  it("past the last line is a reason, not a wrap-around", () => {
    const { assignments } = run([audio("001.mp3"), audio("021.mp3")], [notes], scope)
    expect(assignments[1].reason).toEqual({ code: "noSuchLine", line: 21, count: 20 })
  })

  it("no names at all: folder order", () => {
    const files = ["b.mp3", "a.mp3", "c.mp3"].map((n) => audio(`rec/${n}`))
    const { assignments } = run(files, [notes], scope)
    expect(assignments.map((a) => [files[a.index].name, a.cellIds?.[0], a.method])).toEqual([
      ["b.mp3", "notes#2", "order"],
      ["a.mp3", "notes#1", "order"],
      ["c.mp3", "notes#3", "order"],
    ])
  })
})

// Sam, Oct 29 (question 5): two files for one line that are not its parts and
// not numbered takes both upload, as takes. The more recently modified file
// (File.lastModified) is the one that plays; on a tie, the later in folder
// order. The engine uploads a job's files in order and the last one plays.
describe("two files for one line upload as takes", () => {
  const gen = book("gen", "GEN", "Genesis", [31, 25, 24])
  const scope: MatchScope = { kind: "file", fileId: "gen" }

  it("both upload as takes of the line, and the more recently modified plays", () => {
    const files = [audio("Genesis 1-1.mp3", 1000, 2_000), audio("Genesis 1-1 copy.mp3", 1000, 1_000)]
    const { assignments, jobs } = run(files, [gen], scope)
    expect(assignments.map((a) => [a.cellIds, a.reason])).toEqual([[["gen:1:1"], undefined], [["gen:1:1"], undefined]])
    // Oldest first: the last uploaded is the one that plays.
    expect(jobs).toEqual([{ kind: "single", fileId: "gen", cellId: "gen:1:1", files: [1, 0] }])
  })

  it("on a tie, the later one in folder order plays", () => {
    const tied = [audio("Genesis 1-1 copy.mp3", 1000, 5_000), audio("Genesis 1-1.mp3", 1000, 5_000)]
    expect(run(tied, [gen], scope).jobs).toEqual([{ kind: "single", fileId: "gen", cellId: "gen:1:1", files: [1, 0] }])
    // No dates at all (files picked from somewhere that keeps none): folder order.
    const undated = [audio("b/Genesis 1-1.mp3"), audio("a/Genesis 1-1.mp3")]
    expect(run(undated, [gen], scope).jobs.map((j) => j.files)).toEqual([[1, 0]])
  })

  it("three files for one line: oldest first, newest last", () => {
    const files = [audio("Genesis 1-2.mp3", 1000, 30), audio("Genesis 1-2 copy.mp3", 1000, 10), audio("Gen 1.2.mp3", 1000, 20)]
    expect(run(files, [gen], scope).jobs).toEqual([{ kind: "single", fileId: "gen", cellId: "gen:1:2", files: [1, 2, 0] }])
  })

  it("a numbered take and a file without a number: the newest plays", () => {
    const files = [audio("Genesis 1-3 take 2.mp3", 1000, 100), audio("Genesis 1-3.mp3", 1000, 200)]
    expect(run(files, [gen], scope).jobs.map((j) => j.files)).toEqual([[0, 1]])
  })

  it("numbered takes on their own still go by their numbers, whatever their dates", () => {
    const files = [audio("Genesis 1-4 take 2.mp3", 1000, 100), audio("Genesis 1-4 take 1.mp3", 1000, 900)]
    expect(run(files, [gen], scope).jobs.map((j) => j.files)).toEqual([[1, 0]])
  })

  it("a line chosen by hand that another file has: both are takes", () => {
    const files = [audio("Genesis 1-1.mp3", 1000, 1), audio("random.mp3", 1000, 2), audio("Genesis 1-2.mp3", 1000, 3)]
    const projectFiles = [{ fileId: "gen", name: "Genesis", bookCode: "GEN" }]
    const read = readRecordings(files, { scope, index: new BookNameIndex(), projectFiles, maxBytes: 10 * MB })
    const out = matchRecordings(read, new Map([["gen", gen]]), { overrides: new Map([[1, { fileId: "gen", cellId: "gen:1:1" }]]) })
    expect(out.map((a) => a.cellIds)).toEqual([["gen:1:1"], ["gen:1:1"], ["gen:1:2"]])
    expect(planJobs(out, read).find((j) => j.kind === "single" && j.cellId === "gen:1:1")?.files).toEqual([0, 1])
  })

  it("parts and ranges still can't share a line with another file", () => {
    const files = [audio("Genesis 2-1-3.mp3"), audio("Genesis 2-2.mp3")]
    const { assignments } = run(files, [gen], scope)
    expect(by(assignments, files, "Genesis 2-2.mp3").reason).toEqual({ code: "duplicate", target: "Genesis 2:1–3", other: "Genesis 2-1-3.mp3" })
  })
})

// Sam, Oct 29 (question 4): a number alone in a Bible book ("012.mp3") is read
// by how many such files sit in the folder. About as many as the book has
// chapters: chapters. About as many as it has verses: verses, counted from the
// top. Neither: listed, not guessed. "About" is within a tenth of the book's
// count, either side (LONE_NUMBER_TOLERANCE).
describe("a number alone in a Bible book, decided by the count", () => {
  // 50 chapters of 20 verses: chapters fit 45–55 files, verses 900–1,100.
  const big = book("gen", "GEN", "Genesis", Array.from({ length: 50 }, () => 20))
  const scope: MatchScope = { kind: "file", fileId: "gen" }
  const numbered = (count: number, folder = "rec", from = 1) =>
    Array.from({ length: count }, (_, i) => audio(`${folder}/${String(from + i).padStart(4, "0")}.mp3`))
  const kinds = (assignments: Assignment[]) => new Set(assignments.map((a) => a.reason?.code ?? (a.cellIds!.length > 1 ? "chapter" : "verse")))

  it("about as many files as the book has chapters: each is a whole chapter", () => {
    const files = numbered(50)
    const { assignments, jobs } = run(files, [big], scope)
    const twelve = by(assignments, files, "0012.mp3")
    expect(twelve).toMatchObject({ method: "number", read: "Genesis 12" })
    expect(twelve.cellIds).toHaveLength(20)
    expect(twelve.cellIds![0]).toBe("gen:12:1")
    expect(jobs.every((j) => j.kind === "range")).toBe(true)
  })

  it("about as many files as the book has verses: each is a verse, counted from the top", () => {
    const files = numbered(1000)
    const { assignments } = run(files, [big], scope)
    expect(by(assignments, files, "0012.mp3")).toMatchObject({ method: "number", cellIds: ["gen:1:12"], read: "Genesis 1:12" })
    expect(by(assignments, files, "0025.mp3")).toMatchObject({ cellIds: ["gen:2:5"], read: "Genesis 2:5" })
    expect(kinds(assignments)).toEqual(new Set(["verse"]))
  })

  it("the edges: 45 to 55 files are chapters, 44 and 56 can't tell", () => {
    expect(kinds(run(numbered(45), [big], scope).assignments)).toEqual(new Set(["chapter"]))
    // 51 to 55 name chapters Genesis doesn't have; they are chapters all the same.
    expect(kinds(run(numbered(55), [big], scope).assignments)).toEqual(new Set(["chapter", "noSuchChapter"]))
    expect(kinds(run(numbered(44), [big], scope).assignments)).toEqual(new Set(["chapterOrVerse"]))
    expect(kinds(run(numbered(56), [big], scope).assignments)).toEqual(new Set(["chapterOrVerse"]))
  })

  it("the edges: 900 to 1,100 files are verses, 899 and 1,101 can't tell", () => {
    expect(kinds(run(numbered(900), [big], scope).assignments)).toEqual(new Set(["verse"]))
    expect(kinds(run(numbered(1100), [big], scope).assignments)).toEqual(new Set(["verse", "noSuchLine"]))
    expect(kinds(run(numbered(899), [big], scope).assignments)).toEqual(new Set(["chapterOrVerse"]))
    expect(kinds(run(numbered(1101), [big], scope).assignments)).toEqual(new Set(["chapterOrVerse"]))
  })

  it("neither count fits: every one is listed with the counts, not guessed", () => {
    const files = numbered(10)
    const { assignments, jobs } = run(files, [big], scope)
    expect(assignments.map((a) => a.reason)).toEqual(
      files.map(() => ({ code: "chapterOrVerse", count: 10, book: "Genesis", chapters: 50, verses: 1000 })),
    )
    expect(assignments.some((a) => a.orderRun)).toBe(false)
    expect(jobs).toEqual([])
  })

  it("counts numbers, not files: a verse in two parts counts once", () => {
    // Ruth: 4 chapters, 85 verses. 85 verses in two parts each is 170 files.
    const ruth = book("rut", "RUT", "Ruth", [22, 23, 18, 22])
    const files = Array.from({ length: 85 }, (_, i) => ["a", "b"].map((p) => audio(`Ruth/${String(i + 1).padStart(2, "0")}${p}.mp3`))).flat()
    const { assignments, jobs } = run(files, [ruth], { kind: "file", fileId: "rut" })
    expect(by(assignments, files, "23b.mp3")).toMatchObject({ cellIds: ["rut:2:1"], part: { rank: 2 } })
    expect(jobs).toHaveLength(85)
    expect(jobs.every((j) => j.kind === "pieces")).toBe(true)
  })

  it("a small book asks for every chapter: Ruth's 4 files are chapters, 3 can't tell", () => {
    const ruth = book("rut", "RUT", "Ruth", [22, 23, 18, 22])
    const rutScope: MatchScope = { kind: "file", fileId: "rut" }
    expect(kinds(run(numbered(4), [ruth], rutScope).assignments)).toEqual(new Set(["chapter"]))
    expect(kinds(run(numbered(3), [ruth], rutScope).assignments)).toEqual(new Set(["chapterOrVerse"]))
  })

  it("a name that says chapter, or a folder named for a chapter, decides it outright", () => {
    const files = [audio("rec/chapter 12.mp3"), audio("Genesis 2/05.mp3"), audio("Genesis 2/06.mp3")]
    const { assignments } = run(files, [big], scope)
    expect(by(assignments, files, "chapter 12.mp3")).toMatchObject({ read: "Genesis 12" })
    expect(by(assignments, files, "05.mp3")).toMatchObject({ cellIds: ["gen:2:5"], fromFolder: "Genesis 2" })
    expect(by(assignments, files, "06.mp3")).toMatchObject({ cellIds: ["gen:2:6"] })
  })

  it("a book with one chapter has only verses", () => {
    const jude = book("jud", "JUD", "Jude", [25])
    const { assignments } = run([audio("rec/05.mp3"), audio("rec/06.mp3")], [jude], { kind: "file", fileId: "jud" })
    expect(assignments.map((a) => a.cellIds)).toEqual([["jud:1:5"], ["jud:1:6"]])
  })

  it("when both counts fit, it can't tell", () => {
    // Three chapters of one verse each: three files fit both.
    const tiny = book("gen", "GEN", "Genesis", [1, 1, 1])
    const { assignments } = run(numbered(3), [tiny], scope)
    expect(kinds(assignments)).toEqual(new Set(["chapterOrVerse"]))
  })

  it("a book named in the name with one number is still a whole chapter (Genesis 3)", () => {
    const { assignments } = run([audio("rec/Genesis 3.mp3")], [big], scope)
    expect(assignments[0]).toMatchObject({ read: "Genesis 3" })
  })

  it("phone counters that are neither a chapter nor a verse still go in folder order", () => {
    const files = Array.from({ length: 23 }, (_, i) => audio(`rec/IMG_${4501 + i}.m4a`))
    const { assignments } = run(files, [big], scope)
    expect(assignments.every((a) => a.method === "order")).toBe(true)
    expect(by(assignments, files, "IMG_4501.m4a").cellIds).toEqual(["gen:1:1"])
  })

  it("the folder that holds the files is the level that is counted", () => {
    // Project-wide: a folder named for the book, with 50 numbered files in it.
    const files = numbered(50, "Genesis")
    const { assignments } = run(files, [big], { kind: "project" })
    expect(by(assignments, files, "0007.mp3")).toMatchObject({ read: "Genesis 7", fromFolder: "Genesis" })
  })
})

// Sam, Oct 29 (second answer): "I don't see how on Earth an entire chapter
// could be misinterpreted as a verse." When the count can't tell, the
// recordings' length decides, by the folder's median: a minute or more is
// chapters, half a minute or less is verses, and only in between does it stay
// "can't tell".
describe("when the count can't tell, the recordings' length decides", () => {
  // The whole of Ruth: 4 chapters, 85 verses. Three lone numbers fit neither.
  const ruth = book("rut", "RUT", "Ruth", [22, 23, 18, 22])
  const scope: MatchScope = { kind: "file", fileId: "rut" }
  const three = ["01.mp3", "02.mp3", "03.mp3"].map((n) => audio(`Ruth/${n}`))
  const runWith = (files: BulkInputFile[], ms: number[]) => {
    const projectFiles = [{ fileId: "rut", name: "Ruth", bookCode: "RUT" }]
    const read = readRecordings(files, { scope, index: new BookNameIndex(), projectFiles, maxBytes: 10 * MB })
    const targets = new Map([["rut", ruth]])
    const first = matchRecordings(read, targets)
    const lengths = new Map(ms.map((v, i) => [i, v]))
    return { first, read, assignments: matchRecordings(read, targets, { lengths }) }
  }

  it("asks for the lengths of the files the count can't place, and of no others", () => {
    const counters = Array.from({ length: 23 }, (_, i) => audio(`Phone/IMG_${4501 + i}.m4a`))
    const { first } = runWith([...three, ...counters, audio("Ruth/Ruth 2-1.mp3")], [])
    expect(needsLength(first)).toEqual([0, 1, 2])
  })

  it("3 of Ruth's 4 chapters, a few minutes each, are chapters 1 to 3", () => {
    const { assignments } = runWith(three, [180_000, 150_000, 200_000])
    expect(assignments.map((a) => a.read)).toEqual(["Ruth 1", "Ruth 2", "Ruth 3"])
    expect(assignments.map((a) => a.cellIds?.length)).toEqual([22, 23, 18])
    expect(assignments[0].byLength).toEqual({ as: "chapter", ms: 180_000 })
  })

  it("short recordings are verses, counted from the top", () => {
    const { assignments } = runWith(three, [8_000, 12_000, 9_000])
    expect(assignments.map((a) => a.cellIds)).toEqual([["rut:1:1"], ["rut:1:2"], ["rut:1:3"]])
    expect(assignments[2].byLength).toEqual({ as: "verse", ms: 9_000 })
  })

  it("in between, it still can't tell, and says how long they are", () => {
    const { assignments } = runWith(three, [45_000, 45_000, 45_000])
    expect(assignments[0].reason).toEqual({ code: "chapterOrVerse", count: 3, book: "Ruth", chapters: 4, verses: 85, lengthMs: 45_000 })
  })

  it("the edges: a minute is chapters, half a minute is verses, anything between can't tell", () => {
    expect(CHAPTER_MIN_MEDIAN_MS).toBe(60_000)
    expect(VERSE_MAX_MEDIAN_MS).toBe(30_000)
    expect(runWith(three, [60_000, 60_000, 60_000]).assignments[0].read).toBe("Ruth 1")
    expect(runWith(three, [30_000, 30_000, 30_000]).assignments[0].read).toBe("Ruth 1:1")
    expect(runWith(three, [59_999, 59_999, 59_999]).assignments[0].reason?.code).toBe("chapterOrVerse")
    expect(runWith(three, [30_001, 30_001, 30_001]).assignments[0].reason?.code).toBe("chapterOrVerse")
  })

  it("the median holds against one odd file: a chapter as short as Psalm 117, a verse as long as Esther 8:9", () => {
    expect(runWith(three, [14_000, 150_000, 200_000]).assignments.map((a) => a.read)).toEqual(["Ruth 1", "Ruth 2", "Ruth 3"])
    expect(runWith(three, [40_000, 9_000, 10_000]).assignments.map((a) => a.read)).toEqual(["Ruth 1:1", "Ruth 1:2", "Ruth 1:3"])
  })

  it("lengths it couldn't read change nothing", () => {
    const { assignments } = runWith(three, [])
    expect(assignments[0].reason).toEqual({ code: "chapterOrVerse", count: 3, book: "Ruth", chapters: 4, verses: 85 })
  })

  it("the count still decides first: Ruth's 4 files are chapters, however short", () => {
    const four = ["01.mp3", "02.mp3", "03.mp3", "04.mp3"].map((n) => audio(`Ruth/${n}`))
    const { assignments } = runWith(four, [5_000, 5_000, 5_000, 5_000])
    expect(assignments.map((a) => a.read)).toEqual(["Ruth 1", "Ruth 2", "Ruth 3", "Ruth 4"])
    expect(assignments[0].byLength).toBeUndefined()
  })
})

// Sam, Oct 29 (question 3): on a file whose lines have times — a subtitle or
// film file — a range's one recording would sit at the start of every line it
// covers and overlap itself on the timeline, so a range is refused there.
describe("ranges on a timed file", () => {
  const subs: TargetFile = { ...doc("subs", "Episode 1", 12), timed: true }
  const subsScope: MatchScope = { kind: "file", fileId: "subs" }

  it("a file naming a range of lines is not uploaded, with the reason; one line still is", () => {
    const files = ["001.mp3", "002-004.mp3", "005.mp3"].map((n) => audio(n))
    const { assignments, jobs } = run(files, [subs], subsScope)
    expect(by(assignments, files, "002-004.mp3").reason).toEqual({ code: "rangeOnTimedFile" })
    expect(by(assignments, files, "001.mp3").cellIds).toEqual(["subs#1"])
    expect(by(assignments, files, "005.mp3").cellIds).toEqual(["subs#5"])
    expect(jobs.some((j) => j.kind === "range")).toBe(false)
  })

  it("on a timed Bible book a verse range and a whole chapter are refused too", () => {
    const timedGen: TargetFile = { ...book("gen", "GEN", "Genesis", [31, 25, 24]), timed: true }
    const files = ["Genesis 1-1-3.mp3", "Genesis 3.mp3", "Genesis 1-4.mp3"].map((n) => audio(n))
    const { assignments } = run(files, [timedGen], { kind: "file", fileId: "gen" })
    expect(by(assignments, files, "Genesis 1-1-3.mp3").reason).toEqual({ code: "rangeOnTimedFile" })
    expect(by(assignments, files, "Genesis 3.mp3").reason).toEqual({ code: "rangeOnTimedFile" })
    expect(by(assignments, files, "Genesis 1-4.mp3").cellIds).toEqual(["gen:1:4"])
  })

  it("a range that is one line of the file (a bridged verse) is still one recording per line", () => {
    const bridged = book("gen", "GEN", "Genesis", [0])
    bridged.lines.push({ cellId: "gen:1:1-2", ref: "GEN 1:1-2", text: "1-2", structural: false, hasRecording: false })
    bridged.lines.push({ cellId: "gen:1:3", ref: "GEN 1:3", text: "3", structural: false, hasRecording: false })
    const { assignments } = run([audio("Genesis 1-1-2.mp3")], [{ ...bridged, timed: true }], { kind: "file", fileId: "gen" })
    expect(assignments[0].cellIds).toEqual(["gen:1:1-2"])
  })

  it("an untimed file still takes ranges", () => {
    const { assignments } = run([audio("002-004.mp3")], [doc("subs", "Episode 1", 12)], subsScope)
    expect(assignments[0].cellIds).toEqual(["subs#2", "subs#3", "subs#4"])
  })
})

// ETEN, Oct 29: an audio Bible folder named "MAT_1_LN619.ogg" … "MAT_32_LN760.ogg"
// (Matthew 19:1–22:32). The names never say the chapter: the first number is
// the verse within its chapter, and LN is the verse's place counted from
// Matthew 1:1 (chapters 1–18 hold 618 verses, so LN619 is 19:1).
describe("a verse's place in the book (ETEN's LN)", () => {
  const MAT = [25, 23, 17, 25, 48, 34, 29, 34, 38, 42, 30, 50, 58, 36, 39, 28, 27, 35, 30, 34, 46, 46, 39, 51, 46, 75, 66, 20]
  const names = ["MAT_1_LN619.ogg", "MAT_2_LN620.ogg", "MAT_3_LN621.ogg", "MAT_30_LN648.ogg", "MAT_1_LN649.ogg", "MAT_46_LN728.ogg", "MAT_32_LN760.ogg"]
  const want = ["mat:19:1", "mat:19:2", "mat:19:3", "mat:19:30", "mat:20:1", "mat:21:46", "mat:22:32"]
  const scope = { kind: "file", fileId: "mat" } as const
  const cells = (assignments: Assignment[]) => assignments.map((a) => a.cellIds?.[0] ?? a.reason?.code)

  it("lands each file on its verse, in any scope", () => {
    const files = names.map((n) => audio(`Files/${n}`))
    expect(cells(run(files, [book("mat", "MAT", "Matthew", MAT)], scope).assignments)).toEqual(want)
    const project = run(files, [book("mat", "MAT", "Matthew", MAT)], { kind: "project" })
    expect(cells(project.assignments)).toEqual(want)
    expect(by(project.assignments, files, "MAT_1_LN619.ogg").read).toBe("Matthew 19:1")
  })

  it("counts verses, not lines: an introduction line before 1:1 moves nothing", () => {
    const mat = book("mat", "MAT", "Matthew", MAT)
    mat.lines.splice(1, 0, { cellId: "mat-intro", ref: null, text: "About this book", structural: false, hasRecording: false })
    expect(cells(run(names.map((n) => audio(`Files/${n}`)), [mat], scope).assignments)).toEqual(want)
  })

  it("a verse the project leaves out (17:21) still counts, as the numbering does", () => {
    const mat = book("mat", "MAT", "Matthew", MAT)
    mat.lines = mat.lines.filter((l) => l.cellId !== "mat:17:21")
    expect(cells(run(names.map((n) => audio(`Files/${n}`)), [mat], scope).assignments)).toEqual(want)
  })

  it("two verses of a bridged line become its pieces, in verse order", () => {
    const mat = book("mat", "MAT", "Matthew", MAT)
    const at = mat.lines.findIndex((l) => l.cellId === "mat:19:1")
    mat.lines.splice(at, 2, { cellId: "mat:19:1-2", ref: "MAT 19:1-2", text: "1-2", structural: false, hasRecording: false })
    const files = names.slice(0, 3).map((n) => audio(`Files/${n}`))
    const { assignments, jobs } = run(files, [mat], scope)
    expect(cells(assignments)).toEqual(["mat:19:1-2", "mat:19:1-2", "mat:19:3"])
    expect(jobs).toContainEqual({ kind: "pieces", fileId: "mat", cellId: "mat:19:1-2", files: [0, 1] })
  })

  it("asks when the verse in the name and its place in the book disagree", () => {
    const { assignments } = run([audio("Files/MAT_5_LN619.ogg")], [book("mat", "MAT", "Matthew", MAT)], scope)
    expect(assignments[0].reason).toEqual({ code: "bookVerseDisagree", count: 619, verse: 5, ref: "Matthew 19:1" })
  })

  it("a place past the book's last verse is a reason", () => {
    const { assignments } = run([audio("Files/MAT_1_LN2000.ogg")], [book("mat", "MAT", "Matthew", MAT)], scope)
    expect(assignments[0].reason).toEqual({ code: "noSuchBookVerse", count: 2000, verses: 1071, book: "Matthew" })
  })
})

// The Oct 29 code review's cases, each run against the real matcher. They pin
// what a person would otherwise see land on the wrong verse, or not at all.
describe("the review's cases (Oct 29)", () => {
  const GEN = [31, 25, 24, 26, 32]
  const fileScope = (fileId: string) => ({ kind: "file", fileId }) as const
  const lineOf = (a: Assignment) => a.cellIds?.join(",") ?? a.reason?.code

  it("a chapter folder never overrides a name that gives its own chapter and verse", () => {
    const files = ["Genesis 3-5.mp3", "Genesis 3-1.mp3", "Gen 3.6.mp3", "3-7.mp3", "Genesis 1-1.mp3", "8-10.mp3"].map((n) => audio(`Genesis 3/${n}`))
    const { assignments } = run(files, [book("g", "GEN", "Genesis", GEN)], fileScope("g"))
    expect(assignments.map(lineOf)).toEqual(["g:3:5", "g:3:1", "g:3:6", "g:3:7", "g:1:1", "g:3:8,g:3:9,g:3:10"])
  })

  it("the chapter in front is never dropped as a book number when the names say the book, or mix separators", () => {
    const g = book("g", "GEN", "Genesis", GEN)
    const parts = ["Genesis 1-4_1.mp3", "Genesis 1-4_2.mp3", "Genesis 1-5_1.mp3", "Genesis 1-5_2.mp3"].map((n) => audio(n))
    expect(run(parts, [g], fileScope("g")).jobs).toEqual([
      { kind: "pieces", fileId: "g", cellId: "g:1:4", files: [0, 1] },
      { kind: "pieces", fileId: "g", cellId: "g:1:5", files: [2, 3] },
    ])
    const plain = ["1-4_1.mp3", "1-4_2.mp3", "1-5_1.mp3"].map((n) => audio(n))
    expect(run(plain, [g], fileScope("g")).assignments.map(lineOf)).toEqual(["g:1:4", "g:1:4", "g:1:5"])
    const years = ["Genesis 1-5 2023.mp3", "Genesis 1-6 2023.mp3", "Genesis 1-7 2023.mp3"].map((n) => audio(n))
    expect(run(years, [g], fileScope("g")).assignments.map(lineOf)).toEqual(["g:1:5", "g:1:6", "g:1:7"])
    // The book's own number still goes: "01_001_001" is Genesis 1:1.
    const numbered = ["01_001_001.wav", "01_001_002.wav", "01_002_001.wav"].map((n) => audio(n))
    expect(run(numbered, [g], fileScope("g")).assignments.map(lineOf)).toEqual(["g:1:1", "g:1:2", "g:2:1"])
  })

  it("a book number that means a different book in each numbering is asked about, not guessed", () => {
    const targets = [book("mat", "MAT", "Matthew", [25]), book("mrk", "MRK", "Mark", [45])]
    const files = ["41_001_001.mp3", "41_001_002.mp3", "41_001_003.mp3"].map((n) => audio(n))
    const { read, assignments } = run(files, targets, { kind: "project" })
    expect(assignments.map((a) => a.reason)).toEqual(files.map(() => ({ code: "bookNumberUnclear", first: "Mark", second: "Matthew" })))
    // Both books load, so the person can choose each file's line in either.
    expect(targetsWanted(read).sort()).toEqual(["mat", "mrk"])
    // A project with only one of them leaves no doubt.
    expect(run(files, [targets[0]], { kind: "project" }).assignments.map(lineOf)).toEqual(["mat:1:1", "mat:1:2", "mat:1:3"])
  })

  it("a range written with dashes only can cross a chapter, and a range that runs backwards is refused", () => {
    const g = book("g", "GEN", "Genesis", GEN)
    const files = ["Genesis 1-31-2-3.mp3", "Genesis 1-5-3.mp3"].map((n) => audio(n))
    const { assignments } = run(files, [g], fileScope("g"))
    expect(assignments[0].cellIds).toEqual(["g:1:31", "g:2:1", "g:2:2", "g:2:3"])
    expect(assignments[1].reason).toEqual({ code: "rangeBackwards", from: "Genesis 1:5", to: "Genesis 1:3" })
  })

  it("a second file for the same part is refused, not joined as a third piece", () => {
    const files = ["Genesis 1-1a.mp3", "Genesis 1-1b.mp3", "Genesis 1-1b copy.mp3"].map((n) => audio(n))
    const { assignments, jobs } = run(files, [book("g", "GEN", "Genesis", GEN)], fileScope("g"))
    expect(jobs).toEqual([{ kind: "pieces", fileId: "g", cellId: "g:1:1", files: [0, 1] }])
    expect(assignments[2].reason).toEqual({ code: "duplicate", target: "Genesis 1:1", other: "Genesis 1-1b.mp3" })
  })

  it("formats a browser can't play are refused, whatever type they declare", () => {
    const files: BulkInputFile[] = [
      { name: "Genesis 1-1.wma", path: "Genesis 1-1.wma", size: 1000, type: "audio/x-ms-wma" },
      { name: "Genesis 1-2.aiff", path: "Genesis 1-2.aiff", size: 1000, type: "" },
      { name: "Genesis 1-3.amr", path: "Genesis 1-3.amr", size: 1000, type: "audio/amr" },
      { name: "Genesis 1-4.mp3", path: "Genesis 1-4.mp3", size: 1000, type: "audio/mpeg" },
    ]
    const { assignments } = run(files, [book("g", "GEN", "Genesis", GEN)], fileScope("g"))
    expect(assignments.map((a) => a.reason ?? a.cellIds)).toEqual([
      { code: "unplayableFormat", ext: "wma" },
      { code: "unplayableFormat", ext: "aiff" },
      { code: "unplayableFormat", ext: "amr" },
      ["g:1:4"],
    ])
  })

  it("a folder that is just a number is that chapter", () => {
    const files = ["05.mp3", "06.mp3"].map((n) => audio(`3/${n}`))
    expect(run(files, [book("g", "GEN", "Genesis", GEN)], fileScope("g")).assignments.map(lineOf)).toEqual(["g:3:5", "g:3:6"])
  })

  it("leaving a file out of a run in folder order closes the run up", () => {
    const runOpts = (files: BulkInputFile[], targets: TargetFile[], scope: MatchScope, opts: Parameters<typeof matchRecordings>[2]) => {
      const projectFiles: ProjectFileInfo[] = targets.map((t) => ({ fileId: t.fileId, name: t.name, bookCode: t.bookCode }))
      const read = readRecordings(files, { scope, index: new BookNameIndex(), projectFiles, maxBytes: 2048 * MB })
      const assignments = matchRecordings(read, new Map(targets.map((t) => [t.fileId, t])), opts)
      return { read, assignments, jobs: planJobs(assignments, read) }
    }
    const files = ["IMG_4521.m4a", "IMG_4522.m4a", "IMG_4523.m4a", "IMG_4524.m4a"].map((n) => audio(n))
    const { assignments } = runOpts(files, [doc("d", "Welcome", 6)], fileScope("d"), { overrides: new Map([[1, "skip" as const]]) })
    expect(assignments.map(lineOf)).toEqual(["d#1", "skipped", "d#2", "d#3"])
    // A file moved by hand leaves the run too, and the rest close up.
    const moved = runOpts(files, [doc("d", "Welcome", 6)], fileScope("d"), { overrides: new Map([[0, { fileId: "d", cellId: "d#6" }]]) })
    expect(moved.assignments.map(lineOf)).toEqual(["d#6", "d#1", "d#2", "d#3"])
  })

  it("a verse's place in the book counts the book's standard chapters, so a chapter the project lacks moves nothing", () => {
    const MAT = [25, 23, 17, 25, 48, 34, 29, 34, 38, 42, 30, 50, 58, 36, 39, 28, 27, 35, 30, 34]
    const mat = book("mat", "MAT", "Matthew", MAT)
    mat.lines = mat.lines.filter((l) => !l.cellId.startsWith("mat:5:"))
    const files = ["MAT_LN620.mp3", "MAT_LN100.mp3"].map((n) => audio(n))
    const { assignments } = run(files, [mat], fileScope("mat"))
    expect(assignments[0].cellIds).toEqual(["mat:19:2"])
    // LN100 is Matthew 5:10, in the chapter this project doesn't have.
    expect(assignments[1].reason).toEqual({ code: "noSuchChapter", book: "Matthew", chapter: 5 })
  })

  it("a recording named after a document in the project goes to that document, even when the name starts like a book", () => {
    const targets = [doc("song", "Song of the week", 5), doc("mark", "Mark", 5)]
    const files = ["Song of the week 3.mp3", "Mark 3.mp3"].map((n) => audio(n))
    expect(run(files, targets, { kind: "project" }).assignments.map(lineOf)).toEqual(["song#3", "mark#3"])
  })

  it("on a bridged line, the same verse twice is two takes; different verses are its pieces", () => {
    const g = book("g", "GEN", "Genesis", [0])
    g.lines.push({ cellId: "g:1:1-2", ref: "GEN 1:1-2", text: "1-2", structural: false, hasRecording: false })
    g.lines.push({ cellId: "g:1:3", ref: "GEN 1:3", text: "3", structural: false, hasRecording: false })
    const twice = ["Genesis 1-1.mp3", "Genesis 1-1 take 2.mp3"].map((n) => audio(n))
    expect(run(twice, [g], fileScope("g")).jobs).toEqual([{ kind: "single", fileId: "g", cellId: "g:1:1-2", files: [0, 1] }])
    const two = ["Genesis 1-1.mp3", "Genesis 1-2.mp3"].map((n) => audio(n))
    expect(run(two, [g], fileScope("g")).jobs).toEqual([{ kind: "pieces", fileId: "g", cellId: "g:1:1-2", files: [0, 1] }])
  })

  it("numbers and folder order count verses, not the introduction before 1:1", () => {
    const ruth = book("ruth", "RUT", "Ruth", [22, 23, 18, 22])
    ruth.lines.splice(1, 0, ...[1, 2, 3].map((i) => ({ cellId: `ruth-intro${i}`, ref: null, text: `intro ${i}`, structural: false, hasRecording: false })))
    const verses = Array.from({ length: 85 }, (_, i) => audio(`Ruth/${String(i + 1).padStart(3, "0")}.mp3`))
    const lone = run(verses, [ruth], fileScope("ruth")).assignments
    expect([lineOf(lone[0]), lineOf(lone[22]), lineOf(lone[84])]).toEqual(["ruth:1:1", "ruth:2:1", "ruth:4:22"])
    const phone = ["IMG_4521.m4a", "IMG_4522.m4a"].map((n) => audio(n))
    expect(run(phone, [ruth], fileScope("ruth")).assignments.map(lineOf)).toEqual(["ruth:1:1", "ruth:1:2"])
  })
})
