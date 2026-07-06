// Acceptance tests for the XLIFF rows of PARITY_MATRIX.yaml.
// External validation (F4): exported documents are validated with xmllint
// against the official OASIS schemas via the frozen checks module.
import { describe, it, expect } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { TranslatableString } from "@/lib/parsers/types"
import { parseXliff, type XliffSegmentMeta } from "@/lib/parsers/xliff"
import {
  exportXliff12Structured,
  statusToXliffState,
} from "@/lib/export/exporters/xliff12-structured"
import { exportXliff20, statusToXliff20State } from "@/lib/export/exporters/xliff20"
import { validateXliff12, validateXliff20 } from "../roundtrip/checks"

const toCells = (
  strings: TranslatableString[],
  overrides?: (s: TranslatableString, i: number) => Partial<CellData>,
): CellData[] =>
  strings.map(
    (s, i) =>
      ({
        id: s.id,
        fileId: "f",
        original: s.original,
        translated: s.translated,
        group: s.group,
        context: s.context ?? "",
        type: s.type,
        status: "unvalidated",
        validationStatus: "unvalidated",
        activeValidators: [],
        validationHistory: [],
        history: [],
        threads: [],
        metadata: s.metadata,
        ...(overrides?.(s, i) ?? {}),
      }) as unknown as CellData,
  )

const bytes = async (b: Blob): Promise<Uint8Array> => new Uint8Array(await b.arrayBuffer())
const meta = (s: TranslatableString): XliffSegmentMeta =>
  (s.metadata as { xliff: XliffSegmentMeta }).xliff

const XLIFF12 = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en-US" target-language="fr-FR" datatype="plaintext" original="doc.txt">
    <body>
      <trans-unit id="intro 1">
        <source>Hello <g id="g1">bold <x id="x1"/> world</g> &amp; more.</source>
        <target state="translated">Bonjour <g id="g1">gras <x id="x1"/> monde</g> &amp; plus.</target>
        <note>greeting-context</note>
      </trans-unit>
      <trans-unit id="u2">
        <source>Second <bpt id="b1">&lt;b&gt;</bpt>tagged<ept id="b1">&lt;/b&gt;</ept> segment.</source>
        <target state="final">Deuxième segment.</target>
      </trans-unit>
      <trans-unit id="u3">
        <source>Untranslated segment.</source>
        <target state="new"></target>
      </trans-unit>
    </body>
  </file>
</xliff>`

const XLIFF20 = `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en-US" trgLang="de-DE">
  <file id="f1">
    <unit id="u1">
      <segment id="s1" state="translated">
        <source>First <pc id="pc1">tagged</pc> sentence.</source>
        <target>Erster <pc id="pc1">markierter</pc> Satz.</target>
      </segment>
      <ignorable><source> </source></ignorable>
      <segment id="s2" state="initial">
        <source>Second sentence with <ph id="ph1"/> placeholder.</source>
      </segment>
    </unit>
    <unit id="u2">
      <segment id="s1" state="final">
        <source>Standalone unit.</source>
        <target>Eigenständige Einheit.</target>
      </segment>
    </unit>
  </file>
</xliff>`

describe("XLIFF 1.2", () => {
  it("[fmt.xliff12.import] parses trans-units with states, notes and preserved inline-tag skeleton", () => {
    const strings = parseXliff(XLIFF12)
    expect(strings).toHaveLength(3)
    expect(strings[0].original).toBe("Hello bold  world & more.")
    expect(strings[0].translated).toBe("Bonjour gras  monde & plus.")
    expect(strings[0].context).toBe("greeting-context")
    const m0 = meta(strings[0])
    expect(m0.version).toBe("1.2")
    expect(m0.unitId).toBe("intro 1")
    expect(m0.state).toBe("translated")
    expect(m0.sourceXml).toContain('<g id="g1">')
    expect(m0.sourceXml).toContain('<x id="x1"/>')
    expect(m0.sourceXml).toContain("&amp; more.")
    const m1 = meta(strings[1])
    expect(m1.sourceXml).toContain('<bpt id="b1">&lt;b&gt;</bpt>')
    expect(m1.sourceXml).toContain('<ept id="b1">&lt;/b&gt;</ept>')
    expect(meta(strings[2]).state).toBe("new")
  })

  it("[fmt.xliff12.export] exported file validates against the official OASIS 1.2 schema", async () => {
    const strings = parseXliff(XLIFF12)
    const out = await bytes(exportXliff12Structured(toCells(strings), "en-US", "fr-FR"))
    expect(validateXliff12(out)).toBeNull()
    // cells with NO xliff metadata (e.g. imported from txt) must also validate
    const plain = toCells(strings, () => ({ metadata: undefined, group: "GEN 1:1" }))
    const out2 = await bytes(exportXliff12Structured(plain, "en", "fr"))
    expect(validateXliff20(out2)).not.toBeNull() // sanity: 1.2 doc is NOT valid 2.0
    expect(validateXliff12(out2)).toBeNull()
  })

  it("[fmt.xliff12.roundtrip] import→export→import preserves ids, order, source text and tag skeleton", async () => {
    const strings = parseXliff(XLIFF12)
    const out = await bytes(exportXliff12Structured(toCells(strings), "en-US", "fr-FR"))
    const text = new TextDecoder().decode(out)
    const reparsed = parseXliff(text)
    expect(reparsed.map((s) => meta(s).unitId)).toEqual(strings.map((s) => meta(s).unitId))
    expect(reparsed.map((s) => s.original)).toEqual(strings.map((s) => s.original))
    expect(reparsed.map((s) => meta(s).sourceXml)).toEqual(strings.map((s) => meta(s).sourceXml))
    // unedited targets keep their inline tags too
    expect(text).toContain('Bonjour <g id="g1">gras <x id="x1"/> monde</g>')
  })

  it("[fmt.xliff.states] segment status maps deterministically to target/@state in both dialects", () => {
    expect(statusToXliffState({ status: "empty", translated: "" })).toBe("new")
    expect(statusToXliffState({ status: "unvalidated", translated: "x" })).toBe("translated")
    expect(statusToXliffState({ status: "validated", translated: "x" })).toBe("final")
    expect(statusToXliff20State({ status: "empty", translated: "" })).toBe("initial")
    expect(statusToXliff20State({ status: "unvalidated", translated: "x" })).toBe("translated")
    expect(statusToXliff20State({ status: "validated", translated: "x" })).toBe("final")
  })

  it("[fmt.xliff.states] exported state attributes reflect cell statuses end-to-end", async () => {
    const strings = parseXliff(XLIFF12)
    const cells = toCells(strings, (_s, i) =>
      i === 0
        ? { status: "validated" }
        : i === 1
          ? { status: "unvalidated" }
          : { status: "empty", translated: "" },
    )
    const text12 = await exportXliff12Structured(cells, "en", "fr").text()
    expect(text12).toContain('state="final"')
    expect(text12).toContain('state="translated"')
    expect(text12).toContain('state="new"')
    const text20 = await exportXliff20(cells, "en", "fr").text()
    expect(text20).toContain('state="final"')
    expect(text20).toContain('state="translated"')
    expect(text20).toContain('state="initial"')
  })
})

describe("XLIFF 2.0", () => {
  it("[fmt.xliff20.import] parses per-segment with states, skips ignorables, preserves pc/ph skeleton", () => {
    const strings = parseXliff(XLIFF20)
    expect(strings).toHaveLength(3) // 2 segments in u1 + 1 in u2; ignorable skipped
    expect(strings[0].original).toBe("First tagged sentence.")
    expect(strings[0].translated).toBe("Erster markierter Satz.")
    const m0 = meta(strings[0])
    expect(m0.version).toBe("2.0")
    expect(m0.unitId).toBe("u1")
    expect(m0.segId).toBe("s1")
    expect(m0.state).toBe("translated")
    expect(m0.sourceXml).toContain('<pc id="pc1">tagged</pc>')
    expect(meta(strings[1]).sourceXml).toContain('<ph id="ph1"/>')
    expect(meta(strings[1]).state).toBe("initial")
  })

  it("[fmt.xliff20.export] exported file validates against the official OASIS 2.0 schema", async () => {
    const strings = parseXliff(XLIFF20)
    const out = await bytes(exportXliff20(toCells(strings), "en-US", "de-DE"))
    expect(validateXliff20(out)).toBeNull()
    // cells without metadata (ids with spaces → NMTOKEN sanitation) must validate too
    const plain = toCells(strings, () => ({ metadata: undefined, group: "GEN 1:1" }))
    expect(validateXliff20(await bytes(exportXliff20(plain, "en", "fr")))).toBeNull()
  })

  it("[fmt.xliff20.roundtrip] import→export→import preserves unit/segment granularity and tags", async () => {
    const strings = parseXliff(XLIFF20)
    const out = await exportXliff20(toCells(strings), "en-US", "de-DE").text()
    const reparsed = parseXliff(out)
    expect(reparsed).toHaveLength(strings.length)
    expect(reparsed.map((s) => meta(s).unitId)).toEqual(strings.map((s) => meta(s).unitId))
    expect(reparsed.map((s) => meta(s).segId)).toEqual(strings.map((s) => meta(s).segId))
    expect(reparsed.map((s) => s.original)).toEqual(strings.map((s) => s.original))
    expect(reparsed.map((s) => meta(s).sourceXml)).toEqual(strings.map((s) => meta(s).sourceXml))
    // multi-segment unit stays one unit with two segments
    expect((out.match(/<unit /g) ?? []).length).toBe(2)
    expect((out.match(/<segment /g) ?? []).length).toBe(3)
  })
})
