// AQU-2383: the untouched-export soak.
//
// One rule, checked across a small corpus rather than per exporter: a target
// lane with no committed translation exports the stored upload BYTE for byte.
// A rebuild that happens to carry the same words is not good enough — the
// complaint this rule answers is quote style, attribute order, CRLF folded to
// LF, a dropped byte-order mark and a re-zipped package, all on a file nobody
// had translated yet.
//
// Each case therefore asserts on bytes, and each format that claims the rule
// in `UNTOUCHED_EXPORT_FIDELITY` has a case here. The negative controls at the
// end matter as much as the positives: an exporter that returned the upload
// unconditionally would pass every byte assertion above while silently
// dropping real translations.
//
// This suite runs in `pnpm test`, so it runs on every pull request through
// ci.yml's `unit` job. The `.txt` route needs a stored blob and a database, so
// its byte identity is proven in the worker's own suite
// (`sync-worker/src/__tests__/export-route-plaintext.test.ts`); the last block
// here holds the registry in `fidelity.ts` to the same account, so a format
// cannot claim the rule without a test behind the claim.
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { parseUsfmLossless, serializeUsfmLossless } from "@/lib/parsers/usfm-lossless"
import { exportDocx } from "./exporters/docx"
import { exportPptx } from "./exporters/pptx"
import {
  UNTOUCHED_EXPORT_FIDELITY,
  exportsUntouchedByteIdentical,
  untouchedExportFidelity,
  formatsWithoutByteIdenticalExport,
} from "./byte-fidelity"
import type { CellData } from "@/hooks/useCells"

const BOM = "﻿"
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

const bytesOf = async (blob: Blob): Promise<Uint8Array> =>
  new Uint8Array(await blob.arrayBuffer())

function cell(id: string, original: string, translated: string, group: string): CellData {
  return {
    id,
    fileId: "f1",
    original,
    translated,
    context: "Paragraph",
    group,
    type: "text",
    status: translated ? "unvalidated" : "empty",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  }
}

// ─── the USFM corpus: envelope variants of one document ──────────────────────

describe("untouched USFM export is byte-identical", () => {
  const corpus: ReadonlyArray<readonly [string, string]> = [
    ["LF, trailing newline", "\\id GEN\n\\c 1\n\\v 1 In the beginning.\n\\v 2 And the earth.\n"],
    ["CRLF, trailing newline", "\\id GEN\r\n\\c 1\r\n\\v 1 In the beginning.\r\n\\v 2 And the earth.\r\n"],
    ["byte-order mark + LF", `${BOM}\\id GEN\n\\c 1\n\\v 1 In the beginning.\n`],
    ["byte-order mark + CRLF", `${BOM}\\id GEN\r\n\\c 1\r\n\\v 1 In the beginning.\r\n`],
    ["no trailing newline", "\\id GEN\n\\c 1\n\\v 1 In the beginning."],
    ["blank lines preserved", "\\id GEN\n\n\\c 1\n\n\\v 1 In the beginning.\n"],
  ]

  for (const [name, source] of corpus) {
    it(name, () => {
      // An empty export plan is what a lane with no translations produces.
      const out = serializeUsfmLossless(parseUsfmLossless(source), {}, {})
      expect(out).toBe(source)
    })
  }
})

// ─── the zip corpus: packages that must not be re-zipped ─────────────────────

async function makeDocx(): Promise<ArrayBuffer> {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}">
  <w:body><w:p><w:r><w:t>First paragraph</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body>
</w:document>`
  const zip = new JSZip()
  zip.file("word/document.xml", xml)
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
  )
  return zip.generateAsync({ type: "arraybuffer" })
}

function slideXml(shapesXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree>${shapesXml}</p:spTree></p:cSld></p:sld>`
}

async function makePptx(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file(
    "ppt/slides/slide1.xml",
    slideXml(
      `<p:sp><p:txBody><a:p><a:r><a:t>Slide one title</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:sp><p:txBody><a:p><a:r><a:t>Slide one body</a:t></a:r></a:p></p:txBody></p:sp>`,
    ),
  )
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
  )
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  )
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="${P_NS}"/>`,
  )
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
  )
  return zip.generateAsync({ type: "arraybuffer" })
}

describe("untouched DOCX export is byte-identical", () => {
  it("returns the uploaded package when no cell carries a translation", async () => {
    const original = await makeDocx()
    const result = await exportDocx(original, [
      cell("c1", "First paragraph", "", "g1"),
      cell("c2", "Second paragraph", "", "g2"),
    ])
    expect(result.injected).toBe(0)
    expect(await bytesOf(result.blob)).toEqual(new Uint8Array(original))
  })

  it("returns the uploaded package when there are no cells at all", async () => {
    const original = await makeDocx()
    const result = await exportDocx(original, [])
    expect(await bytesOf(result.blob)).toEqual(new Uint8Array(original))
  })

  it("still rewrites the package once a translation exists", async () => {
    const original = await makeDocx()
    const result = await exportDocx(original, [
      cell("c1", "First paragraph", "Primer párrafo", "g1"),
      cell("c2", "Second paragraph", "", "g2"),
    ])
    expect(result.injected).toBe(1)
    const out = await bytesOf(result.blob)
    expect(out).not.toEqual(new Uint8Array(original))
    // …and the translation really is in there.
    const xml = await (await JSZip.loadAsync(out)).file("word/document.xml")!.async("string")
    expect(xml).toContain("Primer párrafo")
  })
})

describe("untouched PPTX export is byte-identical", () => {
  it("returns the uploaded deck when no cell carries a translation", async () => {
    const original = await makePptx()
    const result = await exportPptx(original, [
      cell("c1", "Slide one title", "", "g1"),
      cell("c2", "Slide one body", "", "g2"),
    ])
    expect(result.injected).toBe(0)
    expect(await bytesOf(result.blob)).toEqual(new Uint8Array(original))
  })

  it("still rewrites the deck once a translation exists", async () => {
    const original = await makePptx()
    const result = await exportPptx(original, [
      cell("c1", "Slide one title", "Título", "g1"),
      cell("c2", "Slide one body", "", "g2"),
    ])
    expect(result.injected).toBe(1)
    const out = await bytesOf(result.blob)
    expect(out).not.toEqual(new Uint8Array(original))
    const xml = await (await JSZip.loadAsync(out)).file("ppt/slides/slide1.xml")!.async("string")
    expect(xml).toContain("Título")
  })
})

// ─── the registry must not out-claim the tests ───────────────────────────────

describe("the byte-fidelity registry", () => {
  // Formats whose byte fidelity is proven somewhere other than this file, and
  // where. A "byte-identical" claim must appear in this soak or in here.
  const COVERED_ELSEWHERE: Record<string, string> = {
    txt: "sync-worker/src/__tests__/export-route-plaintext.test.ts — needs a stored blob and a database",
    "custom-original": "never parsed, so the export route has no rebuild path to take",
  }
  const COVERED_HERE = ["usfm", "docx", "pptx"] as const

  it("leaves no byte-identical claim unproven", () => {
    const unproven = UNTOUCHED_EXPORT_FIDELITY
      .filter((e) => e.level === "byte-identical")
      .map((e) => e.format)
      .filter((f) => !COVERED_HERE.includes(f as never) && !(f in COVERED_ELSEWHERE))
    expect(unproven).toEqual([])
  })

  it("agrees with what this soak proved", () => {
    for (const format of COVERED_HERE) {
      expect(exportsUntouchedByteIdentical(format)).toBe(true)
    }
  })

  it("records each format once", () => {
    const formats = UNTOUCHED_EXPORT_FIDELITY.map((e) => e.format)
    expect(formats).toEqual([...new Set(formats)])
  })

  it("gives every entry a reason someone could read", () => {
    for (const entry of UNTOUCHED_EXPORT_FIDELITY) {
      expect(entry.note.trim().length).toBeGreaterThan(20)
    }
  })

  it("looks a format up, and says nothing about one it has not recorded", () => {
    expect(untouchedExportFidelity("usfm")?.level).toBe("byte-identical")
    expect(untouchedExportFidelity("idml")?.level).toBe("rebuilt")
    expect(untouchedExportFidelity("nonesuch")).toBeUndefined()
    expect(exportsUntouchedByteIdentical("nonesuch")).toBe(false)
  })

  it("still names the work that is left, and leaves generated reports out of it", () => {
    const remaining = formatsWithoutByteIdenticalExport().map((e) => e.format)
    // IDML is the open half of this rule: the engine returns the upload for an
    // empty translation list, but the NoBreak repair pass still rewrites a
    // member holding an over-long NoBreak run, translated or not, and no case
    // here proves the untouched export. If it ever drops off this list it is
    // because someone closed that gap, and this soak should have gained a case
    // for it.
    expect(remaining).toContain("idml")
    expect(remaining).not.toContain("xlsx")
    expect(remaining.every((f) => !exportsUntouchedByteIdentical(f))).toBe(true)
  })
})
