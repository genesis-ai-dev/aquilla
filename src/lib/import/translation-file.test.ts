/**
 * AQU-2544: a translation in any file the source import reads.
 *
 * WHY each group matters:
 *  - Sam: "txt is not supported as import into target. We should be able to
 *    support almost anything." A file the review has no reader of its own for
 *    is read with the source import's own dispatch, parser and cell unit, so a
 *    source file and its translation in the same format come out cut the same
 *    way. Most tests here run a source file and its translation through the
 *    REAL source import, on the project default (Sentence), and check every
 *    line gets its own translation.
 *  - The review found the first build put every line after a source's first
 *    long paragraph on the wrong translation, ticked: the splitter cuts a
 *    translation by its own length. Pairing is paragraph by paragraph now; a
 *    paragraph that cuts differently is shared out over its lines, flagged,
 *    and nothing after it shifts.
 *  - A file's content, not its name, picks its reader: USFM in a .txt goes to
 *    the USFM reader, records in a .txt to the column mapping, JSON is refused.
 *  - A row that is only its line's source text (an untranslated template, an
 *    export's untranslated line) starts unticked.
 */

import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import { getHeapStatistics } from "node:v8"
import { buildBulkCellsWithSpeakers, prepareImportFile } from "@/lib/import"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { plainTextStructuredBody } from "@/lib/export/plaintext-structured"
import {
  linesAreVerses,
  matchTargetRowsByOrder,
  parsedLinesToTargetRows,
  shareOut,
  type FileTargetCellRef,
  type FileTargetMatchResult,
} from "@/lib/import-file-target"
import { fileTargetCellRef } from "./cell-refs"
import { FILE_TARGET_EXTENSIONS, isFileTargetFileName } from "./translation-destination"
import { readTranslationFile, translationFileType } from "./translation-file"

const PROJECT = { projectId: "proj-2544" }
/** The project default: no cell unit set reads as Sentence. */
const SENTENCE = undefined

function file(content: BlobPart, name: string): File {
  return new File([content], name)
}

/** The open file's lines as the app has them after importing `source`: the
 *  cells the import sends (`buildBulkCellsWithSpeakers`), stored, and read
 *  back by the real cell store, the way the review is handed them. So a line
 *  has only what the app stores: its paragraph start and a PO entry's context
 *  from its metadata, and a group only when it is a scripture address. */
async function sourceLines(source: File, cellUnit?: "sentence" | "paragraph"): Promise<FileTargetCellRef[]> {
  const prepared = await prepareImportFile(source, { ...PROJECT, cellUnit })
  const { cells } = buildBulkCellsWithSpeakers(prepared.results.flatMap((result) => result.strings), {
    fileName: source.name,
    fileType: prepared.fileType,
  })
  const store = new CellStore()
  store.setRuntime({ projectId: PROJECT.projectId, fileId: "open-file", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(cells.map((cell, i): CellRow => ({
    cellId: `line-${i + 1}`, side: "source", value: cell.value, valueHtml: cell.valueHtml ?? null, type: cell.type ?? "text",
    canonicalRef: cell.canonicalRef ?? null, anchorCellId: i === 0 ? null : `line-${i}`, eventId: `se-${i + 1}`,
    sourceEventId: null, lastEditor: "tester", lastEditAt: 1, validated: false, wordCount: 1, metadata: cell.metadata ?? null,
  })))
  return store.getAllSummaries().map(fileTargetCellRef)
}

/** The pieces the source import cuts a file into. */
async function piecesOf(f: File, cellUnit?: "sentence" | "paragraph"): Promise<string[]> {
  return (await prepareImportFile(f, { ...PROJECT, cellUnit })).results.flatMap((r) => r.strings).map((s) => s.original)
}

/** Incoming text by the line it landed on. */
function filled(result: FileTargetMatchResult): Record<string, string> {
  return Object.fromEntries(result.matched.map((m) => [m.cellId, m.incomingText]))
}

async function translate(translation: File, lines: FileTargetCellRef[], cellUnit?: "sentence" | "paragraph") {
  return matchTargetRowsByOrder((await readTranslationFile(translation, { ...PROJECT, cellUnit })).rows, lines)
}

async function texts(f: File, cellUnit?: "sentence" | "paragraph"): Promise<string[]> {
  return (await readTranslationFile(f, { ...PROJECT, cellUnit })).rows.map((row) => row.text)
}

function docx(paragraphs: string[]): Promise<ArrayBuffer> {
  const body = paragraphs
    .map((p) => p.startsWith("# ")
      ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${p.slice(2)}</w:t></w:r></w:p>`
      : `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join("")
  const zip = new JSZip()
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`)
  return zip.generateAsync({ type: "arraybuffer" })
}

// The review's fixture (AQU-2544 review): a story with two paragraphs long
// enough for the Sentence setting to cut them, and its Spanish translation.
const EN_LONG1 = "The rain had stopped before dawn, and the road was still dark with water. " +
  "Anna packed the last of the bread into her bag and tied it shut. " +
  "Her brother waited by the gate, stamping his feet against the cold. " +
  "Neither of them spoke about the letter that had come the night before. " +
  "They both knew what it meant, and they both knew there was no going back. " +
  "When the sun finally rose over the hills, they were already two miles from home."
const ES_LONG1 = "La lluvia había cesado antes del amanecer, y el camino seguía oscuro por el agua. " +
  "Ana guardó el último trozo de pan en su bolsa y la ató con fuerza. " +
  "Su hermano esperaba junto a la puerta, golpeando el suelo con los pies para combatir el frío. " +
  "Ninguno de los dos habló de la carta que había llegado la noche anterior. " +
  "Ambos sabían lo que significaba, y ambos sabían que no había vuelta atrás. " +
  "Cuando por fin salió el sol sobre las colinas, ya estaban a tres kilómetros de casa."
const EN_LONG2 = "At the river they found the ferryman asleep in his boat. " +
  "Anna woke him gently and asked the price of the crossing. " +
  "He named a sum far larger than they carried, then looked at their faces and named a smaller one. " +
  "They crossed in silence while the current pulled at the hull."
const ES_LONG2 = "En el río encontraron al barquero dormido en su bote. " +
  "Ana lo despertó con suavidad y le preguntó cuánto costaba cruzar. " +
  "Él pidió una suma mucho mayor de la que llevaban, luego miró sus rostros y pidió una menor. " +
  "Cruzaron en silencio mientras la corriente tiraba del casco."
const EN_DOC = ["# The Road North", "Morning came early.", EN_LONG1, "They walked on.", EN_LONG2, "The end."]
const ES_DOC = ["# El camino al norte", "La mañana llegó temprano.", ES_LONG1, "Siguieron caminando.", ES_LONG2, "Fin."]

describe("a Word translation on the Sentence setting", () => {
  it("fills all 9 lines of a 6-paragraph story whose long paragraphs were cut into 3 and 2", async () => {
    const lines = await sourceLines(file(await docx(EN_DOC), "road.docx"), SENTENCE)
    expect(lines).toHaveLength(9)
    const translation = file(await docx(ES_DOC), "camino.docx")
    const result = await translate(translation, lines, SENTENCE)
    expect(Object.values(filled(result))).toEqual(await piecesOf(translation, SENTENCE))
    expect(filled(result)["line-9"]).toBe("Fin.")
    expect(result.matched.every((m) => !m.flag)).toBe(true)
    expect(result.countMismatch).toBeUndefined()
    expect(result.uncovered).toEqual([])
  })

  it("shares out a paragraph that cuts into one more piece, and one that cuts into one fewer, and shifts nothing", async () => {
    const s = "Esta frase traducida es bastante más larga que la original porque el idioma usa más palabras para lo mismo."
    const t1 = [s, s.replace("Esta", "Otra"), s.replace("Esta", "Una"), s.replace("Esta", "La")].join(" ")
    const t2 = "En el río, el barquero dormía. Ana lo despertó. Pidió mucho, luego menos. Cruzaron."
    const lines = await sourceLines(file(await docx(["Morning came early.", EN_LONG1, "They walked on.", EN_LONG2, "The end."]), "a.docx"), SENTENCE)
    expect(lines).toHaveLength(8)
    const translation = file(await docx(["La mañana llegó temprano.", t1, "Siguieron caminando.", t2, "Fin."]), "b.docx")
    expect(await piecesOf(translation, SENTENCE)).toHaveLength(8)
    const result = await translate(translation, lines, SENTENCE)
    const got = filled(result)
    expect(got["line-1"]).toBe("La mañana llegó temprano.")
    expect(got["line-5"]).toBe("Siguieron caminando.")
    expect(got["line-8"]).toBe("Fin.")
    // Every line of each odd paragraph is filled, in order, and flagged.
    expect([got["line-2"], got["line-3"], got["line-4"]].join(" ")).toBe(t1)
    expect([got["line-6"], got["line-7"]].join(" ")).toBe(t2)
    const flagged = result.matched.filter((m) => m.flag === "sharedOut").map((m) => m.cellId)
    expect(flagged).toEqual(["line-2", "line-3", "line-4", "line-6", "line-7"])
    // Cut at the translation's own sentence ends.
    expect(got["line-6"]).toBe("En el río, el barquero dormía.")
    expect(result.countMismatch).toBeUndefined()
    // Rows are numbered by the file's paragraphs, as the person counts them:
    // the 4th paragraph is "Row 4", not the splitter's 6th piece.
    expect(result.matched.map((m) => m.rowIndex)).toEqual([0, 1, 1, 1, 2, 3, 3, 4])
  })

  it("puts a paragraph cut into more pieces than its one line back together on that line, unflagged", async () => {
    const lines = await sourceLines(file(await docx(["Morning came early.", "They walked on."]), "a.docx"), SENTENCE)
    const translation = file(await docx(["La mañana llegó temprano.", ES_LONG2]), "b.docx")
    expect(await piecesOf(translation, SENTENCE)).toHaveLength(3)
    const result = await translate(translation, lines, SENTENCE)
    expect(filled(result)["line-2"]).toBe(ES_LONG2)
    expect(result.matched.every((m) => !m.flag)).toBe(true)
  })

  it("lines up a .txt written one paragraph per line with a Word source, paragraph for paragraph", async () => {
    const lines = await sourceLines(file(await docx(EN_DOC), "road.docx"), SENTENCE)
    const translation = file(ES_DOC.map((p) => p.replace(/^# /, "")).join("\n") + "\n", "camino.txt")
    const result = await translate(translation, lines, SENTENCE)
    expect(result.countMismatch).toBeUndefined()
    // Each paragraph's lines hold that paragraph's translation, in order.
    const byLine = filled(result)
    expect(byLine["line-1"]).toBe("El camino al norte")
    expect(["line-3", "line-4", "line-5"].map((id) => byLine[id]).join(" ")).toBe(ES_LONG1)
    expect(["line-7", "line-8"].map((id) => byLine[id]).join(" ")).toBe(ES_LONG2)
    expect(byLine["line-9"]).toBe("Fin.")
  })

  it("says how many paragraphs each side has when one is missing", async () => {
    const lines = await sourceLines(file(await docx(EN_DOC), "road.docx"), SENTENCE)
    const result = await translate(file(await docx(ES_DOC.filter((p) => p !== "Siguieron caminando.")), "c.docx"), lines, SENTENCE)
    expect(result.countMismatch).toEqual({ rows: 5, lines: 6, paragraphs: true })
    expect(filled(result)["line-1"]).toBe("El camino al norte")
  })

  it("falls back to matching in order, counting rows, for lines imported before paragraphs were stored", async () => {
    const lines = (await sourceLines(file(await docx(EN_DOC), "road.docx"), SENTENCE))
      .map(({ paragraphStart: _, ...line }) => line)
    const result = await translate(file(await docx(ES_DOC), "camino.docx"), lines, SENTENCE)
    expect(result.countMismatch).toBeUndefined()
    expect(result.matched).toHaveLength(9)
  })
})

describe("a .txt translation", () => {
  const EN8 = [
    "In the beginning God created the heavens and the earth.",
    "The earth was without form and void.",
    "Darkness was over the face of the deep.",
    "The Spirit of God was hovering over the waters.",
    "And God said, Let there be light, and there was light.",
    "God saw that the light was good.",
    "He separated the light from the darkness.",
    "God called the light day, and the darkness he called night.",
  ]
  const ES8 = [
    "En el principio Dios creó los cielos y la tierra.",
    "La tierra estaba desordenada y vacía.",
    "Las tinieblas cubrían la faz del abismo.",
    "El Espíritu de Dios se movía sobre la faz de las aguas.",
    "Y dijo Dios: Sea la luz; y fue la luz.",
    "Y vio Dios que la luz era buena.",
    "Y separó Dios la luz de las tinieblas.",
    "Y llamó Dios a la luz Día, y a las tinieblas llamó Noche.",
  ]

  // Question 51: on Sentence, a .txt with no blank lines is one paragraph per
  // line, so a file written one sentence per line and its translation written
  // the same way line up line for line.
  it("lines up a one-sentence-per-line file and its translation 1:1 on Sentence, nothing shared out", async () => {
    const lines = await sourceLines(file(EN8.join("\n") + "\n", "genesis.txt"), SENTENCE)
    expect(lines).toHaveLength(8)
    const result = await translate(file(ES8.join("\n") + "\n", "genesis-es.txt"), lines, SENTENCE)
    expect(Object.values(filled(result))).toEqual(ES8)
    expect(result.matched.some((m) => m.flag)).toBe(false)

    const three = await sourceLines(file("In the beginning\nAnd the earth\nAnd God said\n", "a.txt"), SENTENCE)
    expect(filled(await translate(file("Au commencement\nEt la terre\nEt Dieu dit\n", "a-fr.txt"), three, SENTENCE)))
      .toEqual({ "line-1": "Au commencement", "line-2": "Et la terre", "line-3": "Et Dieu dit" })
  })

  it("lines up 300 sentences 1:1 on Sentence, however their lengths drift", async () => {
    const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ")
    const en: string[] = []
    const es: string[] = []
    for (let i = 0; i < 300; i++) {
      en.push(`S${i} ${words(5 + (i * 7) % 12, "e")}.`)
      // The translation runs shorter, then longer, than its source.
      es.push(`S${i} ${words(Math.max(2, Math.round((5 + (i * 7) % 12) * (i < 150 ? 0.8 : 1.5))), "s")}.`)
    }
    const lines = await sourceLines(file(en.join("\n") + "\n", "long.txt"), SENTENCE)
    expect(lines).toHaveLength(300)
    const result = await translate(file(es.join("\n") + "\n", "long-es.txt"), lines, SENTENCE)
    expect(Object.values(filled(result))).toEqual(es)
    expect(result.matched.some((m) => m.flag)).toBe(false)
  })

  it("fills line 1, 2, 3 from one translation per line on the Paragraph setting", async () => {
    const lines = await sourceLines(file("In the beginning\nAnd the earth\nAnd God said\n", "a.txt"), "paragraph")
    const result = await translate(file("Au commencement\r\nEt la terre\r\nEt Dieu dit\r\n", "a-fr.txt"), lines, "paragraph")
    expect(filled(result)).toEqual({ "line-1": "Au commencement", "line-2": "Et la terre", "line-3": "Et Dieu dit" })
  })

  it("reads blank lines, wrapped lines, a byte-order mark and UTF-16 as the source parser does", async () => {
    expect(await texts(file("Au commencement, Dieu\ncréa le ciel.\n\n\nEt la terre\n", "a.txt"), "paragraph"))
      .toEqual(["Au commencement, Dieu créa le ciel.", "Et la terre"])
    expect(await texts(file(new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), "Un\r\nDeux\r\n"]), "b.txt"), "paragraph"))
      .toEqual(["Un", "Deux"])
    const utf16 = new Uint16Array([0xfeff, ..."Un\nDeux".split("").map((c) => c.charCodeAt(0))])
    expect(await texts(file(utf16, "c.txt"), "paragraph")).toEqual(["Un", "Deux"])
  })

  it("comes back onto the same lines after an export, and an untranslated line's source comes back as itself", async () => {
    const lines = await sourceLines(file("One\n\nTwo\n\nThree\n", "a.txt"), "paragraph")
    const exported = plainTextStructuredBody(lines.map((line, i) => ({
      translated: ["Un", "", "Trois"][i], source: line.original, group: `g${i}`,
    })))
    const result = await translate(file(exported, "a-export.txt"), lines, "paragraph")
    expect(filled(result)).toEqual({ "line-1": "Un", "line-2": "Two", "line-3": "Trois" })
    // The export wrote the untranslated line's source; it is said, and left unticked.
    expect(result.matched.find((m) => m.cellId === "line-2")?.sameAsSource).toBe(true)
    expect(result.matched.find((m) => m.cellId === "line-1")?.sameAsSource).toBeUndefined()
  })
})

describe("the file's content picks its reader", () => {
  it("reads USFM, subtitles and JSON saved as .txt as what they are", async () => {
    expect((await translationFileType(file("\\id GEN\n\\c 1\n\\v 1 Au commencement\n", "gen.txt"))).type).toBe("usfm")
    expect((await translationFileType(file("1\n00:00:01,000 --> 00:00:02,000\nUn\n", "ep.txt"))).type).toBe("srt")
    expect((await translationFileType(file('{"greeting": "Bonjour"}', "fr.txt"))).type).toBe("json")
  })

  it("reads a .txt of tab-separated records as a spreadsheet, and comma-separated ones only under a header", async () => {
    const tsv = "ref\ttext\nGEN 1:1\tAu commencement\nGEN 1:2\tEt la terre\n"
    expect(await translationFileType(file(tsv, "gen.txt"))).toEqual({ type: "tsv", text: tsv })
    const csv = "reference,translation\nGEN 1:1,Au commencement\nGEN 1:2,Et la terre\n"
    expect((await translationFileType(file(csv, "gen.txt"))).type).toBe("csv")
    // Prose whose every line holds one comma is still prose.
    const prose = "In the beginning, God created.\nAnd the earth, formless.\nAnd God said, light.\n"
    expect((await translationFileType(file(prose, "gen.txt"))).type).toBe("txt")
  })

  it("reads a Word file by its name, and names nothing it doesn't know", async () => {
    expect((await translationFileType(file(await docx(["Un"]), "a.docx"))).type).toBe("docx")
    expect((await translationFileType(file("x", "notes.rtf"))).type).toBeNull()
  })
})

describe("a bilingual file pairs by its own source text", () => {
  it("places a PO file's translations by msgid past an entry the file doesn't have", async () => {
    const lines = await sourceLines(file('msgid "Open"\nmsgstr ""\n\nmsgid "Save"\nmsgstr ""\n\nmsgid "Close"\nmsgstr ""\n', "app.pot"))
    const po = 'msgid "Open"\nmsgstr "Ouvrir"\n\nmsgid "Help"\nmsgstr "Aide"\n\n' +
      'msgid "Save"\nmsgstr ""\n\nmsgid "Close"\nmsgstr "Fermer"\n'
    const result = await translate(file(po, "fr.po"), lines)
    expect(result.alignedBy).toBe("source")
    expect(filled(result)).toEqual({ "line-1": "Ouvrir", "line-3": "Fermer" })
    expect(result.orphans.map((o) => [o.text, o.reason])).toEqual([["Aide", "sourceNotInFile"]])
  })

  it("keeps two PO entries with the same msgid apart by their context", async () => {
    const pot = 'msgctxt "menu"\nmsgid "Open"\nmsgstr ""\n\nmsgctxt "door"\nmsgid "Open"\nmsgstr ""\n'
    const lines = await sourceLines(file(pot, "app.pot"))
    const door = 'msgctxt "door"\nmsgid "Open"\nmsgstr "Ouverte"\n'
    const menu = 'msgctxt "menu"\nmsgid "Open"\nmsgstr "Ouvrir"\n'
    // By msgid alone the door's translation took the menu's line.
    expect(filled(await translate(file(door, "fr.po"), lines))).toEqual({ "line-2": "Ouverte" })
    expect(filled(await translate(file(`${menu}\n${door}`, "fr.po"), lines))).toEqual({ "line-1": "Ouvrir", "line-2": "Ouverte" })
    // Out of order, one is placed and the other listed, never swapped.
    const reversed = await translate(file(`${door}\n${menu}`, "fr.po"), lines)
    expect(filled(reversed)).toEqual({ "line-1": "Ouvrir" })
    expect(reversed.orphans.map((o) => o.text)).toEqual(["Ouverte"])
  })

  it("starts an untranslated template's rows as its source text, said and unticked", async () => {
    const lines = await sourceLines(file('msgid "Open"\nmsgstr ""\n\nmsgid "Save"\nmsgstr ""\n', "app.pot"))
    const result = await translate(file('msgid "Open"\nmsgstr ""\n\nmsgid "Save"\nmsgstr ""\n', "fr.pot"), lines)
    expect(result.matched.map((m) => [m.incomingText, m.sameAsSource])).toEqual([["Open", true], ["Save", true]])
  })

  it("reads a file with no translation of its own as the translation itself", () => {
    expect(parsedLinesToTargetRows([{ original: "Ouvrir", translated: "", paragraphStart: true }, { original: " ", translated: "" }]))
      .toEqual([{ text: "Ouvrir", paragraphStart: true }])
    expect(parsedLinesToTargetRows([{ original: "Open", translated: "Ouvrir" }, { original: "Save", translated: "" }]))
      .toEqual([{ text: "Ouvrir", source: "Open" }, { text: "", source: "Save" }])
  })
})

describe("sharing a paragraph out over its lines", () => {
  const lengths = [40, 40, 40]

  it("cuts at the translation's own sentence ends, in every script", () => {
    expect(shareOut("Un deux trois. Quatre cinq six! Sept huit neuf?", lengths))
      .toEqual(["Un deux trois.", "Quatre cinq six!", "Sept huit neuf?"])
    expect(shareOut("هل أنت هنا؟ نعم أنا هنا؟ وأين هو؟", lengths)).toEqual(["هل أنت هنا؟", "نعم أنا هنا؟", "وأين هو؟"])
    expect(shareOut("राम घर गया। सीता आई। वे खुश थे।", lengths)).toEqual(["राम घर गया।", "सीता आई।", "वे खुश थे।"])
    expect(shareOut("我们回家了。天很黑。我们很累。", lengths)).toEqual(["我们回家了。", "天很黑。", "我们很累。"])
    expect(shareOut("Նա եկավ։ Մենք գնացինք։ Ամեն ինչ լավ էր։", lengths)).toEqual(["Նա եկավ։", "Մենք գնացինք։", "Ամեն ինչ լավ էր։"])
  })

  it("keeps a closing quote with its sentence", () => {
    expect(shareOut("He said, “Go.” She went. They waited.", lengths)).toEqual(["He said, “Go.”", "She went.", "They waited."])
  })

  it("cuts at clause marks when there are too few sentence ends, then between words", () => {
    expect(shareOut("Un, deux, trois", lengths)).toEqual(["Un,", "deux,", "trois"])
    expect(shareOut("uno dos tres", lengths)).toEqual(["uno", "dos", "tres"])
  })

  it("keeps each piece about in proportion to its source line", () => {
    const [first, second] = shareOut("Uno. Dos. Tres. Cuatro. Cinco. Seis. Siete. Ocho.", [10, 40])
    expect(first).toBe("Uno. Dos.")
    expect(second).toBe("Tres. Cuatro. Cinco. Seis. Siete. Ocho.")
  })

  it("leaves the last lines empty only when the translation has fewer words than lines", () => {
    expect(shareOut("Fin.", lengths)).toEqual(["Fin."])
    expect(shareOut("Fin total", lengths)).toEqual(["Fin", "total"])
  })

  // AQU-2544 review round 2: the first search kept a number for every line and
  // every cut point (200 KB took 4.2 s and ~47 million numbers; 1 MB would
  // take minutes and several GB). It walks the lines once now.
  it("shares a 1 MB paragraph over 2,000 lines in under a second, without growing memory", () => {
    const sentence = "Y dijo Dios que la luz era buena y separó la luz de las tinieblas para siempre."
    const text = Array(Math.ceil((1024 * 1024) / (sentence.length + 1))).fill(sentence).join(" ")
    const lines = Array(2000).fill(text.length / 2000)
    const heapBefore = getHeapStatistics().used_heap_size
    const started = performance.now()
    const pieces = shareOut(text, lines)
    const took = performance.now() - started
    const grew = getHeapStatistics().used_heap_size - heapBefore
    expect(took).toBeLessThan(1000)
    expect(grew).toBeLessThan(150 * 1024 * 1024)
    expect(pieces).toHaveLength(2000)
    expect(pieces.join(" ")).toBe(text)
    expect(pieces.every((piece) => piece.endsWith("."))).toBe(true)
  })

  it("never starts a piece with closing punctuation written apart, as French spacing does", () => {
    const pieces = shareOut("« Viens ! » Puis il partit . Elle resta ; il revint !", [12, 12, 12])
    expect(pieces).toEqual(["« Viens ! »", "Puis il partit .", "Elle resta ; il revint !"])
    expect(pieces.every((piece) => /^[\p{L}\p{N}«]/u.test(piece))).toBe(true)
  })

  it("flags the short paragraph's rows when its last lines stay empty", async () => {
    const lines: FileTargetCellRef[] = ["The very end of it all.", "Truly.", "Finally."].map((original, i) => ({
      cellId: `line-${i + 1}`, fileId: "f", sourceEventId: `se-${i}`, targetEventId: undefined, translated: "", original,
      ...(i === 0 ? { paragraphStart: true } : {}),
    }))
    const result = matchTargetRowsByOrder([{ text: "Fin.", paragraphStart: true }], lines)
    expect(result.matched.map((m) => [m.cellId, m.incomingText, m.flag, m.sharedOutShort])).toEqual([
      ["line-1", "Fin.", "sharedOut", true],
    ])
    expect(result.uncovered.map((u) => u.cellId)).toEqual(["line-2", "line-3"])
  })
})

describe("lines that are verses, and how rows are named", () => {
  const line = (canonicalRef: string | undefined, i: number): FileTargetCellRef => ({
    cellId: `line-${i + 1}`, fileId: "f", sourceEventId: `se-${i}`, targetEventId: undefined, translated: "",
    original: `Line ${i + 1}`, canonicalRef,
  })

  it("calls a file verses only when every line is a verse or a heading among them", () => {
    expect(linesAreVerses(["GEN 1:1", "GEN 1:s1:1", "GEN 1:2"].map(line))).toBe(true)
    expect(linesAreVerses(["GEN 1:1", undefined, undefined].map(line))).toBe(false)
    expect(linesAreVerses([])).toBe(false)
  })

  it("never names a row by a line's generated paragraph id, as imports before July 21 stored it", () => {
    const lines = ["3f2a1c9e-7b6d-4e21-9a0b-5c8d7e6f1a2b", "GEN 1:2"].map(line)
    const result = matchTargetRowsByOrder([{ text: "Un" }, { text: "Deux" }], lines)
    expect(result.matched.map((m) => m.ref)).toEqual(["", "GEN 1:2"])
  })
})

describe("what the translation review accepts", () => {
  it("takes every format the source import reads without a question first", () => {
    for (const ext of ["txt", "docx", "md", "markdown", "html", "htm", "pptx", "idml", "po", "pot", "properties",
      "xlf", "xliff", "tmx", "usfm", "sfm", "usf", "usx", "csv", "tsv", "xlsx", "vtt", "srt", "sbv"]) {
      expect(FILE_TARGET_EXTENSIONS).toContain(ext)
    }
  })

  it("refuses JSON and EPUB (their source import asks a question first), media, and unknown types", () => {
    for (const name of ["strings.json", "app.arb", "book.epub", "clip.mp3", "film.mp4", "notes.rtf", "notes"]) {
      expect(isFileTargetFileName(name)).toBe(false)
    }
  })
})
