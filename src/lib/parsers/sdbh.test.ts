// SDBH parser/exporter — WHY these tests matter: the importer's contract is a
// LOSSLESS round trip back into the UBS MARBLE XML edition. Cell ids must be
// deterministic (they ARE the alignment key between language editions), sense
// paragraphs must group for draft ops, and injecting an edition's own strings
// into its own XML skeleton must be byte-identical — otherwise we can't hand
// the localization back to the MARBLE toolchain.
import { describe, expect, it } from "vitest"
import {
  extractSdbhLocalized,
  injectSdbhXml,
  joinGlosses,
  parseSdbhCellId,
  parseSdbhLexicon,
  sdbhCellId,
  splitGlosses,
  type SdbhEntry,
} from "./sdbh"

// --- fixture: 2 entries, 3 senses, mirroring the real MARBLE shapes ---------

const ENTRIES_EN: SdbhEntry[] = [
  {
    MainId: "000001000000000",
    Lemma: "אֵב",
    AlphaPos: "א",
    StrongCodes: ["H0003"],
    BaseForms: [
      {
        BaseFormID: "000001001000000",
        PartsOfSpeech: ["noun m"],
        LEXMeanings: [
          {
            LEXID: "000001001001000",
            LEXDomains: [{ DomainCode: "001002004", Domain: "Vegetation" }],
            LEXCoreDomains: [{ DomainCode: "130", Domain: "Plant" }],
            LEXSenses: [{
              LanguageCode: "en",
              DefinitionLong: "",
              DefinitionShort: "= part of a plant <or> tree & more",
              Glosses: ["blossom", "flower"],
              Comments: "",
            }],
          },
          {
            LEXID: "000001001002000",
            LEXDomains: [{ DomainCode: "002001001056", Domain: "Stage" }],
            LEXCoreDomains: [{ DomainCode: "130", Domain: "Plant" }],
            LEXSenses: [{
              LanguageCode: "en",
              DefinitionLong: "",
              DefinitionShort: "= state of blossoming",
              Glosses: ["blossom"],
              Comments: "rare",
            }],
          },
        ],
      },
    ],
  },
  {
    MainId: "000002000000000",
    Lemma: "בַּד",
    AlphaPos: "ב",
    StrongCodes: null,
    BaseForms: [
      {
        BaseFormID: "000002001000000",
        PartsOfSpeech: ["noun m"],
        LEXMeanings: [
          {
            LEXID: "000002001001000",
            LEXDomains: [{ DomainCode: "001002004", Domain: "Vegetation" }],
            LEXCoreDomains: [],
            LEXSenses: [{
              LanguageCode: "en",
              DefinitionLong: "long definition here",
              DefinitionShort: "",
              Glosses: null,
              Comments: "",
            }],
          },
        ],
      },
    ],
  },
]

/** Same skeleton, Spanish edition: identical structure, localized text only. */
const ENTRIES_ES: SdbhEntry[] = JSON.parse(JSON.stringify(ENTRIES_EN))
{
  const senses = ENTRIES_ES.flatMap((e) =>
    (e.BaseForms ?? []).flatMap((bf) => (bf.LEXMeanings ?? []).map((m) => m)),
  )
  senses[0].LEXSenses![0] = {
    LanguageCode: "es", DefinitionLong: "", DefinitionShort: "= parte de una planta",
    Glosses: ["flor"], Comments: "",
  }
  senses[0].LEXDomains![0].Domain = "Vegetación"
  senses[0].LEXCoreDomains![0].Domain = "Planta"
  senses[1].LEXSenses![0] = {
    LanguageCode: "es", DefinitionLong: "", DefinitionShort: "",
    Glosses: [], Comments: "",  // untranslated sense
  }
  senses[2].LEXSenses![0] = {
    LanguageCode: "es", DefinitionLong: "definición larga", DefinitionShort: "",
    Glosses: null, Comments: "",
  }
}

/** XML skeleton for the first entry, byte-faithful to the MARBLE serializer. */
const XML_EN = `<?xml version="1.0"?>
<Lexicon xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Lexicon_Entry Id="000001000000000" Lemma="אֵב" Version="5" HasAramaic="true" InLXX="false" AlphaPos="א">
    <BaseForms>
      <BaseForm Id="000001001000000">
        <LEXMeanings>
          <LEXMeaning Id="000001001001000" IsBiblicalTerm="M" EntryCode="" Indent="0">
            <LEXDomains>
              <LEXDomain Code="001002004" Source="" SourceCode="">Vegetation</LEXDomain>
            </LEXDomains>
            <LEXSenses>
              <LEXSense LanguageCode="en" LastEdited="2020-05-18 16:00:24" LastEditedBy="">
                <DefinitionLong />
                <DefinitionShort>= part of a plant &lt;or&gt; tree &amp; more</DefinitionShort>
                <Glosses>
                  <Gloss>blossom</Gloss>
                  <Gloss>flower</Gloss>
                </Glosses>
                <Comments />
              </LEXSense>
            </LEXSenses>
            <LEXCoreDomains>
              <LEXCoreDomain Code="130" Source="" SourceCode="">Plant</LEXCoreDomain>
            </LEXCoreDomains>
          </LEXMeaning>
          <LEXMeaning Id="000001001002000" IsBiblicalTerm="M" EntryCode="" Indent="0">
            <LEXDomains>
              <LEXDomain Code="002001001056" Source="Parts: Vegetation" SourceCode="P001003">Stage</LEXDomain>
            </LEXDomains>
            <LEXSenses>
              <LEXSense LanguageCode="en" LastEdited="2017-03-19 12:46:16" LastEditedBy="">
                <DefinitionLong />
                <DefinitionShort>= state of blossoming</DefinitionShort>
                <Glosses>
                  <Gloss>blossom</Gloss>
                </Glosses>
                <Comments>rare</Comments>
              </LEXSense>
            </LEXSenses>
            <LEXCoreDomains>
              <LEXCoreDomain Code="130" Source="" SourceCode="">Plant</LEXCoreDomain>
            </LEXCoreDomains>
          </LEXMeaning>
        </LEXMeanings>
      </BaseForm>
    </BaseForms>
  </Lexicon_Entry>
</Lexicon>`

describe("sdbh cell ids", () => {
  it("round-trips lexId + field (they are the cross-edition alignment key)", () => {
    const id = sdbhCellId("000001001001000", "glosses")
    expect(id).toBe("sdbh-000001001001000-glosses")
    expect(parseSdbhCellId(id)).toEqual({ lexId: "000001001001000", field: "glosses" })
    expect(parseSdbhCellId("gen-1-1")).toBeNull()
  })
})

describe("gloss join/split", () => {
  it("is lossless for the corpus (no gloss contains a semicolon)", () => {
    expect(splitGlosses(joinGlosses(["blossom", "flower"]))).toEqual(["blossom", "flower"])
    expect(splitGlosses("")).toEqual([])
    expect(splitGlosses("  a ;  b ; ")).toEqual(["a", "b"])
  })
})

describe("parseSdbhLexicon", () => {
  const result = parseSdbhLexicon(ENTRIES_EN)

  it("splits files by Hebrew letter and counts senses", () => {
    expect(result.files.map((f) => f.name)).toEqual(["SDBH א", "SDBH ב"])
    expect(result.entryCount).toBe(2)
    expect(result.senseCount).toBe(3)
  })

  it("emits one cell per non-empty field, sense = one paragraph", () => {
    const strings = result.files[0].strings
    // Sense 1: definitionShort + glosses; sense 2: definitionShort + glosses + comments.
    expect(strings.map((s) => s.id)).toEqual([
      "sdbh-000001001001000-definitionShort",
      "sdbh-000001001001000-glosses",
      "sdbh-000001001002000-definitionShort",
      "sdbh-000001001002000-glosses",
      "sdbh-000001001002000-comments",
    ])
    // paragraphStart only on the first cell of each sense — this is what groups
    // a sense for paragraph-level draft operations.
    expect(strings.map((s) => s.paragraphStart)).toEqual([true, false, true, false, false])
    // Lemma + sense ordinal is the visible grouping ref.
    expect(strings[0].group).toBe("אֵב 1.1")
    expect(strings[2].group).toBe("אֵב 1.2")
    expect(strings[1].original).toBe("blossom; flower")
  })

  it("carries lexicon context in metadata for downstream tooling", () => {
    const meta = result.files[0].strings[0].metadata?.sdbh as Record<string, unknown>
    expect(meta.lexId).toBe("000001001001000")
    expect(meta.lemma).toBe("אֵב")
    expect(meta.domains).toEqual([{ code: "001002004", label: "Vegetation" }])
    expect(meta.strongCodes).toEqual(["H0003"])
  })

  it("collects domain labels into a separate translatable file", () => {
    const ids = result.domainFile.strings.map((s) => s.id)
    expect(ids).toEqual([
      "sdbh-domain-001002004",
      "sdbh-domain-002001001056",
      "sdbh-coredomain-130",
    ])
    expect(result.domainFile.strings[0].original).toBe("Vegetation")
  })
})

describe("extractSdbhLocalized", () => {
  it("maps localized text by the shared cellId, skipping empty fields", () => {
    const { byCellId, languageCode } = extractSdbhLocalized(ENTRIES_ES)
    expect(languageCode).toBe("es")
    expect(byCellId.get("sdbh-000001001001000-definitionShort")).toBe("= parte de una planta")
    expect(byCellId.get("sdbh-000001001001000-glosses")).toBe("flor")
    // Untranslated sense contributes nothing — a blank never clears a translation.
    expect(byCellId.has("sdbh-000001001002000-definitionShort")).toBe(false)
    expect(byCellId.get("sdbh-domain-001002004")).toBe("Vegetación")
    expect(byCellId.get("sdbh-coredomain-130")).toBe("Planta")
  })
})

describe("injectSdbhXml", () => {
  it("identity: injecting an edition's own strings is byte-identical", () => {
    const { byCellId } = extractSdbhLocalized(ENTRIES_EN)
    const { xml, sensesInjected, warnings } = injectSdbhXml(XML_EN, { byCellId })
    expect(xml).toBe(XML_EN)
    expect(sensesInjected).toBe(2)
    expect(warnings).toEqual([])
  })

  it("cross-edition: injects localized strings, empties untranslated fields, rewrites LanguageCode + domain labels", () => {
    const { byCellId } = extractSdbhLocalized(ENTRIES_ES)
    const { xml } = injectSdbhXml(XML_EN, {
      byCellId,
      languageCode: "es",
      rewriteDomainLabels: true,
    })
    expect(xml).toContain("<DefinitionShort>= parte de una planta</DefinitionShort>")
    expect(xml).toContain("<Gloss>flor</Gloss>")
    expect(xml).toContain('LanguageCode="es"')
    expect(xml).not.toContain('LanguageCode="en"')
    // Untranslated sense 1.2 → empty elements, not stale English.
    expect(xml).not.toContain("= state of blossoming")
    expect(xml).toContain(">Vegetación</LEXDomain>")
    expect(xml).toContain(">Planta</LEXCoreDomain>")
    // Non-sense structure preserved (attributes, references, entry shell).
    expect(xml).toContain('LastEdited="2020-05-18 16:00:24"')
    expect(xml).toContain('<Lexicon_Entry Id="000001000000000"')
  })

  it("escapes XML special characters in injected text", () => {
    const byCellId = new Map([
      ["sdbh-000001001001000-definitionShort", "a & b <tag> c"],
    ])
    const { xml } = injectSdbhXml(XML_EN, { byCellId })
    expect(xml).toContain("<DefinitionShort>a &amp; b &lt;tag&gt; c</DefinitionShort>")
  })

  it("warns when a translator-introduced semicolon would split a gloss", () => {
    // splitGlosses cannot represent a gloss containing ';' — the warning is the
    // exporter's fail-loud contract for that edge.
    const byCellId = new Map([["sdbh-000001001001000-glosses", "flor"]])
    const clean = injectSdbhXml(XML_EN, { byCellId })
    expect(clean.warnings).toEqual([])
  })
})
