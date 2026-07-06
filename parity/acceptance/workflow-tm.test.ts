// Acceptance tests for workflow, glossary/termbase, TMX→index, offline
// re-import, XLSX import and project-zip rows of PARITY_MATRIX.yaml.
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import { parseTmx } from "@/lib/parsers/tmx"
import { parseXliff } from "@/lib/parsers/xliff"
import { parseXlsxToSheets } from "@/lib/parsers/spreadsheet"
import { parseCsvRows } from "@/lib/parsers/csv-bilingual"
import { exportXliff12Structured } from "@/lib/export/exporters/xliff12-structured"
import { buildProjectZip } from "@/lib/export/project-zip-export"
import { GlobalTmIndex, InMemoryGlobalTmStore } from "@/lib/global-tm/index"
import { resolveProjectEntitlements } from "@/lib/entitlements/entitlements"
import { parseTermbaseRows } from "@/lib/qa/termbase"
import { checkGlossary } from "@/lib/qa/glossary"
import { propagateTranslation } from "@/lib/workflow/autopropagation"
import { segmentStatusCounts, progressStats } from "@/lib/workflow/stats"
import { matchXliffReimport } from "@/lib/import/xliff-reimport"

const cell = (id: string, original: string, translated: string, status: CellData["status"] = "unvalidated"): CellData =>
  ({
    id,
    fileId: "f",
    original,
    translated,
    group: id,
    context: "",
    type: "text",
    status,
    validationStatus: "unvalidated",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  }) as unknown as CellData

describe("TMX → retrieval index", () => {
  it("[tm.tmx.to-index] imported TMX pairs become retrievable examples, honoring the TM-contribution flag", () => {
    const tmx = `<?xml version="1.0"?><tmx version="1.4"><header srclang="en-US"/><body>
<tu tuid="a"><tuv xml:lang="en-US"><seg>The invoice is due.</seg></tuv><tuv xml:lang="fr-FR"><seg>La facture est due.</seg></tuv></tu>
<tu tuid="b"><tuv xml:lang="en-US"><seg>Sign in to continue.</seg></tuv><tuv xml:lang="fr-FR"><seg>Connectez-vous pour continuer.</seg></tuv></tu>
</body></tmx>`
    const strings = parseTmx(tmx)
    const store = new InMemoryGlobalTmStore()
    const index = new GlobalTmIndex(store, { isEnterpriseOrg: () => false, isOptedOutProject: () => false })

    // contributing project: pairs land in the index
    const ent = resolveProjectEntitlements({ orgId: "o1", orgSettings: {}, projectSettings: {} })
    strings.forEach((s, i) =>
      index.contribute(
        { id: `tmx-${i}`, source: s.original, target: s.translated, sourceLang: "en-US", targetLang: "fr-FR", projectId: "p1", orgId: "o1" },
        { projectId: "p1", orgId: "o1", contributeToGlobalTm: ent.contributeToGlobalTm },
      ),
    )
    expect(store.size()).toBe(2)
    const hits = index.retrieve({ query: "invoice due", sourceLang: "en-US", targetLang: "fr-FR", limit: 5 })
    expect(hits[0]?.target).toBe("La facture est due.")

    // opted-out project: TMX import contributes nothing to the global scope
    const optedOut = resolveProjectEntitlements({ orgId: "o1", orgSettings: {}, projectSettings: { contributeToGlobalTm: false } })
    const wrote = index.contribute(
      { id: "x", source: "Secret", target: "Secret-fr", sourceLang: "en-US", targetLang: "fr-FR", projectId: "p2", orgId: "o1" },
      { projectId: "p2", orgId: "o1", contributeToGlobalTm: optedOut.contributeToGlobalTm },
    )
    expect(wrote).toBe(false)
    expect(store.size()).toBe(2)
  })
})

describe("offline XLIFF re-import", () => {
  it("[fmt.offline.reimport] externally translated XLIFF updates segments by unit id; unmatched units are reported", async () => {
    const cells = [
      { cellId: "c1", source: "Hello world", unitId: "u1" },
      { cellId: "c2", source: "Second segment", unitId: "u2" },
      { cellId: "c3", source: "Third one", unitId: "u3" },
    ]
    // export from Aquilla cells, "translate" externally, re-import
    const exported = await exportXliff12Structured(
      cells.map((c) => cell(c.unitId, c.source, "")),
      "en",
      "fr",
    ).text()
    const externallyTranslated = exported
      .replace('<target state="new"></target>', '<target state="translated">Bonjour le monde</target>') // u1
      .replace('<target state="new"></target>', '<target state="translated">Deuxième segment</target>') // u2 (next occurrence)
    const imported = parseXliff(externallyTranslated)
    const result = matchXliffReimport(imported, cells)
    expect(result.updates).toEqual([
      { cellId: "c1", translated: "Bonjour le monde", matchedBy: "unit-id" },
      { cellId: "c2", translated: "Deuxième segment", matchedBy: "unit-id" },
    ])
    expect(result.emptyTargets).toBe(1) // u3 came back untranslated
    expect(result.unmatched).toEqual([])

    // a unit that matches nothing is reported, not dropped
    const foreign = parseXliff(`<?xml version="1.0"?><xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2"><file source-language="en" target-language="fr" datatype="plaintext" original="x"><body><trans-unit id="zz"><source>Unknown text</source><target state="translated">Inconnu</target></trans-unit></body></file></xliff>`)
    const r2 = matchXliffReimport(foreign, cells)
    expect(r2.updates).toEqual([])
    expect(r2.unmatched).toHaveLength(1)
    expect(r2.unmatched[0].source).toBe("Unknown text")
  })
})

describe("XLSX import", () => {
  it("[fmt.xlsx.import] extracts shared-string and inline-string cells across sheets", async () => {
    const zip = new JSZip()
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`)
    zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
    zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`)
    zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
    zip.file("xl/sharedStrings.xml", `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>Shared hello</t></si><si><t>Cible</t></si></sst>`)
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>42</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Inline text &amp; entity</t></is></c></row></sheetData></worksheet>`)
    const u8 = await zip.generateAsync({ type: "uint8array" })
    const sheets = await parseXlsxToSheets(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer)
    expect(sheets).toHaveLength(1)
    expect(sheets[0].rows[0][0]).toBe("Shared hello")
    expect(sheets[0].rows[0][1]).toBe("Cible")
    expect(sheets[0].rows[1][0]).toBe("Inline text & entity")
  })
})

describe("project zip package", () => {
  it("[fmt.zip.package] multi-file project exports one zip entry per file with translated content", async () => {
    const blob = await buildProjectZip({
      files: [
        { fileId: "f1", fileName: "chapter-one.txt", cells: [cell("a", "Hello", "Bonjour")] },
        { fileId: "f2", fileName: "chapter-two.txt", cells: [cell("b", "World", "Monde")] },
      ],
      format: "xlf",
      sourceLanguage: "en",
      targetLanguage: "fr",
    })
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const names = Object.keys(zip.files).sort()
    expect(names).toEqual(["chapter-one.xlf", "chapter-two.xlf"])
    const one = await zip.file("chapter-one.xlf")?.async("string")
    const parsed = parseXliff(one ?? "")
    expect(parsed[0].original).toBe("Hello")
    expect(parsed[0].translated).toBe("Bonjour")
  })
})

describe("termbase + glossary QA", () => {
  it("[qa.termbase.import] parses a spreadsheet termbase with forbidden and notes columns into Concepts", () => {
    const rows = parseCsvRows(
      "forbidden,en-US,fr-FR,notes\n,Save,Enregistrer,UI button\nTRUE,Save,Sauvegarder,legacy term\n,Invoice,Facture,\n,,missing-source,\n",
    )
    const { concepts, skippedRows } = parseTermbaseRows(rows, "2026-07-04T00:00:00Z")
    expect(concepts).toHaveLength(2)
    const save = concepts.find((c) => c.sourceTerm === "Save")
    expect(save?.renderings).toEqual([
      { rendering: "Enregistrer", status: "preferred" },
      { rendering: "Sauvegarder", status: "forbidden" },
    ])
    expect(save?.notes).toBe("UI button")
    expect(skippedRows).toEqual([5])
  })

  it("[qa.glossary] flags missing approved renderings and forbidden terms in target", () => {
    const rows = parseCsvRows("forbidden,en,fr\n,Save,Enregistrer\nTRUE,Save,Sauvegarder\n")
    const { concepts } = parseTermbaseRows(rows)
    // missing approved rendering
    const missing = checkGlossary("Click Save twice, then Save again.", "Cliquez deux fois, puis encore.", concepts)
    expect(missing.some((i) => i.severity === "warning" && i.term === "Save")).toBe(true)
    // count rule: 2 source occurrences need ≥2 target occurrences
    const once = checkGlossary("Save then Save.", "Enregistrer une fois.", concepts)
    expect(once.some((i) => i.message.includes("2×"))).toBe(true)
    // forbidden rendering present
    const forbidden = checkGlossary("Press Save.", "Appuyez sur Sauvegarder.", concepts)
    expect(forbidden.some((i) => i.severity === "error" && i.message.includes("Sauvegarder"))).toBe(true)
    // clean translation passes
    expect(checkGlossary("Press Save.", "Appuyez sur Enregistrer.", concepts)).toEqual([])
  })
})

describe("workflow", () => {
  it("[wf.segment-status] exposes per-status segment counts for progress reporting", () => {
    const counts = segmentStatusCounts([
      { status: "empty" },
      { status: "unvalidated" },
      { status: "unvalidated" },
      { status: "validated" },
    ])
    expect(counts).toEqual({ empty: 1, unvalidated: 2, validated: 1, total: 4 })
  })

  it("[wf.progress.stats] reports raw word counts per status plus completion percentage", () => {
    const stats = progressStats([
      { source: "one two three four", translated: "", status: "empty" },
      { source: "five six", translated: "x", status: "unvalidated" },
      { source: "seven eight", translated: "y", status: "validated" },
    ])
    expect(stats.words).toEqual({ empty: 4, unvalidated: 2, validated: 2, total: 8 })
    expect(stats.completionPct).toBe(50)
  })

  it("[wf.autopropagation] confirming a translation propagates to identical sources, skipping validated cells and self", () => {
    const updates = propagateTranslation({ id: "s1", source: "Click Save.", translated: "Cliquez sur Enregistrer." }, [
      { id: "s1", source: "Click Save.", translated: "", status: "unvalidated" },
      { id: "s2", source: "click  save.", translated: "", status: "empty" },
      { id: "s3", source: "Click Save.", translated: "Vieux texte", status: "unvalidated" },
      { id: "s4", source: "Click Save.", translated: "Déjà validé", status: "validated" },
      { id: "s5", source: "Different text.", translated: "", status: "empty" },
      { id: "s6", source: "Click Save.", translated: "Cliquez sur Enregistrer.", status: "unvalidated" },
    ])
    expect(updates).toEqual([
      { id: "s2", translated: "Cliquez sur Enregistrer.", propagated: true },
      { id: "s3", translated: "Cliquez sur Enregistrer.", propagated: true },
    ])
  })
})
