/**
 * AQU-2544: a translation in any file the source import reads.
 *
 * WHY each group matters:
 *  - Sam: "txt is not supported as import into target. We should be able to
 *    support almost anything." A file the review has no reader of its own for
 *    is read with the source import's own dispatch and parser, so a source
 *    file and its translation in the same format come out with the same lines
 *    — that is the whole promise, so most tests here run a source file and its
 *    translation through the REAL source import and check the lines pair up.
 *  - A .txt written one translation per line must fill line 1, 2, 3…; the
 *    plain-text rule (blank lines, wrapped lines, CRLF, a byte-order mark, a
 *    trailing newline) is the source parser's, and is pinned here.
 *  - The target column exported as text must come back onto the same lines.
 *  - A bilingual file pairs by its own source text, which survives a reorder.
 *  - USFM or subtitles saved as .txt must not come in this way: their markers
 *    would land in the translation and they'd be matched by order. They are
 *    sent to their own reader by renaming.
 */

import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import { prepareImportFile } from "@/lib/import"
import { plainTextStructuredBody } from "@/lib/export/plaintext-structured"
import { matchTargetRowsByOrder, parsedLinesToTargetRows, type FileTargetCellRef } from "@/lib/import-file-target"
import { FILE_TARGET_EXTENSIONS, isFileTargetFileName } from "./translation-destination"
import { readTranslationFile } from "./translation-file"

const PROJECT = { projectId: "proj-2544" }

function file(content: BlobPart, name: string): File {
  return new File([content], name)
}

/** The open file's lines, as the source import makes them from `source`. */
async function sourceLines(source: File, cellUnit?: "sentence" | "paragraph"): Promise<FileTargetCellRef[]> {
  const prepared = await prepareImportFile(source, { ...PROJECT, cellUnit })
  return prepared.results.flatMap((result) => result.strings).map((s, i) => ({
    cellId: `line-${i + 1}`,
    fileId: "open-file",
    sourceEventId: `se-${i + 1}`,
    targetEventId: undefined,
    translated: "",
    canonicalRef: undefined,
    original: s.original,
  }))
}

/** Incoming text by the line it landed on. */
function filled(result: ReturnType<typeof matchTargetRowsByOrder>): Record<string, string> {
  return Object.fromEntries(result.matched.map((m) => [m.cellId, m.incomingText]))
}

async function texts(f: File): Promise<string[]> {
  return (await readTranslationFile(f, PROJECT)).rows.map((row) => row.text)
}

function docx(paragraphs: string[]): Promise<ArrayBuffer> {
  const body = paragraphs
    .map((p) => p === "" ? "<w:p/>" : p.startsWith("# ")
      ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${p.slice(2)}</w:t></w:r></w:p>`
      : `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join("")
  const zip = new JSZip()
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`)
  return zip.generateAsync({ type: "arraybuffer" })
}

describe("a .txt translation", () => {
  it("fills line 1, 2, 3… from a file written one translation per line", async () => {
    const lines = await sourceLines(file("In the beginning\nAnd the earth\nAnd God said\n", "genesis.txt"), "paragraph")
    const { rows, format } = await readTranslationFile(file("Au commencement\nEt la terre\nEt Dieu dit\n", "genese.txt"), PROJECT)
    const result = matchTargetRowsByOrder(rows, lines)
    expect(filled(result)).toEqual({ "line-1": "Au commencement", "line-2": "Et la terre", "line-3": "Et Dieu dit" })
    expect(result.countMismatch).toBeUndefined()
    expect(format).toBe("txt")
  })

  it("fills what it can in order, and says so, when the counts differ", async () => {
    const lines = await sourceLines(file("One\nTwo\nThree\n", "a.txt"), "paragraph")
    const result = matchTargetRowsByOrder((await readTranslationFile(file("Un\nDeux\n", "a-fr.txt"), PROJECT)).rows, lines)
    expect(filled(result)).toEqual({ "line-1": "Un", "line-2": "Deux" })
    expect(result.countMismatch).toEqual({ rows: 2, lines: 3 })
    expect(result.uncovered.map((u) => u.cellId)).toEqual(["line-3"])
  })

  it("reads blank lines as paragraph breaks and rejoins the lines of a wrapped paragraph", async () => {
    expect(await texts(file("Au commencement, Dieu\ncréa le ciel.\n\n\nEt la terre\n", "a.txt")))
      .toEqual(["Au commencement, Dieu créa le ciel.", "Et la terre"])
  })

  it("is not thrown by CRLF, a byte-order mark, a trailing blank line or a UTF-16 file", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf])
    expect(await texts(file(new Blob([bom, "Un\r\nDeux\r\nTrois\r\n\r\n"]), "a.txt"))).toEqual(["Un", "Deux", "Trois"])
    const utf16 = new Uint16Array([0xfeff, ..."Un\nDeux".split("").map((c) => c.charCodeAt(0))])
    expect(await texts(file(utf16, "b.txt"))).toEqual(["Un", "Deux"])
  })

  it("never cuts a long translation into sentences, whatever the project's cell unit", async () => {
    const long = Array(12).fill("Une phrase assez longue pour dépasser la limite.").join(" ")
    expect(long.length).toBeGreaterThan(200)
    expect(await texts(file(`${long}\nCourt.\n`, "a.txt"))).toEqual([long, "Court."])
  })

  it("comes back onto the same lines after the target column is exported as text", async () => {
    const lines = await sourceLines(file("One\n\nTwo\n\nThree\n", "a.txt"), "paragraph")
    const exported = plainTextStructuredBody(lines.map((line, i) => ({
      translated: ["Un", "", "Trois"][i], source: line.original, group: `g${i}`,
    })))
    const result = matchTargetRowsByOrder((await readTranslationFile(file(exported, "a-export.txt"), PROJECT)).rows, lines)
    // An untranslated line exports its source text, so it comes back as that.
    expect(filled(result)).toEqual({ "line-1": "Un", "line-2": "Two", "line-3": "Trois" })
    expect(result.countMismatch).toBeUndefined()
  })

  it("says the counts differ when the source import cut one paragraph into several lines", async () => {
    // Sentence cells share their paragraph's group, and the export rejoins
    // them; a translation can't be cut back at the same places.
    const exported = plainTextStructuredBody([
      { translated: "Un.", source: "One.", group: "p1" },
      { translated: "Deux.", source: "Two.", group: "p1" },
      { translated: "Trois.", source: "Three.", group: "p2" },
    ])
    const lines: FileTargetCellRef[] = ["One.", "Two.", "Three."].map((original, i) => ({
      cellId: `line-${i + 1}`, fileId: "f", sourceEventId: `se-${i}`, targetEventId: undefined, translated: "", original,
    }))
    const result = matchTargetRowsByOrder((await readTranslationFile(file(exported, "a.txt"), PROJECT)).rows, lines)
    expect(result.countMismatch).toEqual({ rows: 2, lines: 3 })
  })

  it("sends USFM or subtitles saved as .txt to their own reader, by name", async () => {
    await expect(readTranslationFile(file("\\id GEN\n\\c 1\n\\v 1 Au \\nd commencement\\nd*\n", "gen.txt"), PROJECT))
      .rejects.toThrow("This file holds USFM. Rename it to end in .usfm, then import it again.")
    await expect(readTranslationFile(file("1\n00:00:01,000 --> 00:00:02,000\nUn\n", "ep.txt"), PROJECT))
      .rejects.toThrow("Rename it to end in .srt")
  })

  it("refuses an empty file the way the source import does", async () => {
    await expect(readTranslationFile(file("", "empty.txt"), PROJECT)).rejects.toThrow("empty.txt is empty.")
  })
})

describe("a Word translation of a Word source", () => {
  it("fills paragraph for paragraph, skipping empty paragraphs on both sides", async () => {
    const source = file(await docx(["# Chapter one", "In the beginning.", "", "And the earth was formless."]), "book.docx")
    const lines = await sourceLines(source)
    expect(lines.map((line) => line.original)).toEqual(["Chapter one", "In the beginning.", "And the earth was formless."])
    const translation = file(await docx(["# Chapitre un", "", "Au commencement.", "Et la terre était informe."]), "livre.docx")
    const { rows, format } = await readTranslationFile(translation, PROJECT)
    const result = matchTargetRowsByOrder(rows, lines)
    expect(filled(result)).toEqual({
      "line-1": "Chapitre un",
      "line-2": "Au commencement.",
      "line-3": "Et la terre était informe.",
    })
    expect(result.countMismatch).toBeUndefined()
    expect(format).toBe("docx")
  })
})

describe("a bilingual file pairs by its own source text", () => {
  it("places a PO file's translations by msgid past an entry the file doesn't have, and leaves an untranslated entry's line alone", async () => {
    const lines = await sourceLines(file('msgid "Open"\nmsgstr ""\n\nmsgid "Save"\nmsgstr ""\n\nmsgid "Close"\nmsgstr ""\n', "app.pot"))
    const po = 'msgid "Open"\nmsgstr "Ouvrir"\n\nmsgid "Help"\nmsgstr "Aide"\n\n' +
      'msgid "Save"\nmsgstr ""\n\nmsgid "Close"\nmsgstr "Fermer"\n'
    const { rows, format } = await readTranslationFile(file(po, "fr.po"), PROJECT)
    const result = matchTargetRowsByOrder(rows, lines)
    expect(result.alignedBy).toBe("source")
    expect(filled(result)).toEqual({ "line-1": "Ouvrir", "line-3": "Fermer" })
    expect(result.orphans.map((o) => [o.text, o.reason])).toEqual([["Aide", "sourceNotInFile"]])
    expect(format).toBe("po")
  })

  it("does the same for an XLIFF file missing one of the file's lines", async () => {
    const lines: FileTargetCellRef[] = ["Title", "Hello world", "Goodbye"].map((original, i) => ({
      cellId: `line-${i + 1}`, fileId: "f", sourceEventId: `se-${i}`, targetEventId: undefined, translated: "", original,
    }))
    const xliff = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2"><file source-language="en" target-language="fr"><body>
<trans-unit id="a"><source>Hello world</source><target>Bonjour le monde</target></trans-unit>
<trans-unit id="b"><source>Goodbye</source><target>Au revoir</target></trans-unit>
</body></file></xliff>`
    const result = matchTargetRowsByOrder((await readTranslationFile(file(xliff, "fr.xlf"), PROJECT)).rows, lines)
    expect(filled(result)).toEqual({ "line-2": "Bonjour le monde", "line-3": "Au revoir" })
  })

  it("reads a file that carries no translation of its own as the translation itself", () => {
    expect(parsedLinesToTargetRows([{ original: "Ouvrir", translated: "" }, { original: " ", translated: "" }]))
      .toEqual([{ text: "Ouvrir" }])
    expect(parsedLinesToTargetRows([{ original: "Open", translated: "Ouvrir" }, { original: "Save", translated: "" }]))
      .toEqual([{ text: "Ouvrir", source: "Open" }, { text: "", source: "Save" }])
  })
})

describe("every other format the source import reads, through the same path", () => {
  it("reads Markdown, HTML and Java properties as their source imports do", async () => {
    expect(await texts(file("# Titre\n\nUn paragraphe.\n\n- Un point\n", "a.md"))).toEqual(["Titre", "Un paragraphe.", "Un point"])
    expect(await texts(file("<html><body><h1>Titre</h1><p>Un paragraphe.</p><script>x()</script></body></html>", "a.html")))
      .toEqual(["Titre", "Un paragraphe."])
    expect(await texts(file("greeting=Bonjour\nfarewell=Au revoir\n", "fr.properties"))).toEqual(["Bonjour", "Au revoir"])
  })

  it("reads a PowerPoint deck slide by slide", async () => {
    const zip = new JSZip()
    for (const [name, text] of [["slide1.xml", "Bienvenue"], ["slide2.xml", "Merci"]]) {
      zip.file(`ppt/slides/${name}`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`)
    }
    const { rows, format } = await readTranslationFile(file(await zip.generateAsync({ type: "arraybuffer" }), "deck.pptx"), PROJECT)
    expect(rows.map((row) => row.text)).toEqual(["Bienvenue", "Merci"])
    expect(format).toBe("pptx")
  })
})

describe("what the translation review accepts", () => {
  it("takes every format the source import reads without a question first", () => {
    for (const ext of ["txt", "docx", "md", "markdown", "html", "htm", "pptx", "idml", "po", "pot", "properties", "xlf", "xliff", "tmx"]) {
      expect(FILE_TARGET_EXTENSIONS).toContain(ext)
    }
    for (const ext of ["usfm", "sfm", "usf", "csv", "tsv", "xlsx", "vtt", "srt", "sbv"]) {
      expect(FILE_TARGET_EXTENSIONS).toContain(ext)
    }
  })

  it("refuses JSON and EPUB (their source import asks a question first), USX, media, and unknown types", () => {
    for (const name of ["strings.json", "app.arb", "book.epub", "JON.usx", "clip.mp3", "film.mp4", "notes.rtf", "notes"]) {
      expect(isFileTargetFileName(name)).toBe(false)
    }
  })
})
