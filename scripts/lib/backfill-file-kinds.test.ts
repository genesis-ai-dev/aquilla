// @vitest-environment node
import { describe, it, expect } from "vitest"
import type { CodexNotebookFile } from "../../src/lib/codex-editor/types"
import { decideFileKind, metaWithLegacyCodex, tallyDecisions, type CodexFileRow } from "./backfill-file-kinds"

const row = (meta: string | null = null): CodexFileRow => ({ id: "f1", project_id: "p1", name: "1CH", meta })
const notebook = (metadata: Partial<CodexNotebookFile["metadata"]>): CodexNotebookFile => ({
  metadata: { id: "n", originalName: "1CH", ...metadata },
  cells: [{ kind: 2, languageId: "html", value: "<p>x</p>", metadata: { id: "c1", type: "text" } }],
})

describe("decideFileKind (AQU-2211)", () => {
  it("retypes a row whose notebook names a mapped importer, recording the facts in meta", () => {
    const d = decideFileKind(row('{"sourceLanguage":"eng"}'), { target: notebook({ importerType: "usfm" }) })
    expect(d).toMatchObject({ action: "retype", kind: "usfm" })
    expect(JSON.parse((d as { meta: string }).meta)).toEqual({
      sourceLanguage: "eng",
      legacyCodex: { importerType: "usfm", originalName: "1CH" },
    })
  })

  it("reads the .source notebook for what the .codex does not say", () => {
    const d = decideFileKind(row(), {
      source: notebook({ importerType: "subtitles", originalName: "ep.srt" }),
      target: notebook({ originalName: "ep" }),
    })
    expect(d).toMatchObject({ action: "retype", kind: "srt" })
  })

  it("annotates but never retypes an importer Aquilla has no type for", () => {
    const d = decideFileKind(row(), { target: notebook({ importerType: "macula", originalName: "1CH.macula" }) })
    expect(d).toMatchObject({ action: "annotate", reason: 'importer "macula" has no Aquilla type' })
    expect(JSON.parse((d as { meta: string }).meta)).toEqual({
      legacyCodex: { importerType: "macula", originalName: "1CH.macula" },
    })
  })

  it("annotates a notebook with no importer and a bare name, once", () => {
    const first = decideFileKind(row(), { target: notebook({}) })
    expect(first).toMatchObject({ action: "annotate", reason: "no importer and no usable file name" })
    const again = decideFileKind(row((first as { meta: string }).meta), { target: notebook({}) })
    expect(again).toEqual({ action: "skip", reason: "stays codex, already recorded" })
  })

  it("never retypes an IDML notebook — that is a re-migration", () => {
    const d = decideFileKind(row(), { target: notebook({ importerType: "biblica", originalName: "JOS-EST.idml" }) })
    expect(d).toEqual({ action: "skip", reason: "IDML notebook — re-migrate instead" })
  })

  it("skips a row with no notebook behind it", () => {
    expect(decideFileKind(row(), {})).toEqual({ action: "skip", reason: "no notebook on GitLab" })
  })

  it("metaWithLegacyCodex keeps every other key and survives bad JSON", () => {
    expect(JSON.parse(metaWithLegacyCodex('{"a":1}', { importerType: "docx" }))).toEqual({ a: 1, legacyCodex: { importerType: "docx" } })
    expect(JSON.parse(metaWithLegacyCodex("not json", { importerType: "docx" }))).toEqual({ legacyCodex: { importerType: "docx" } })
    expect(JSON.parse(metaWithLegacyCodex(null, { importerType: "docx" }))).toEqual({ legacyCodex: { importerType: "docx" } })
  })

  it("tallies outcomes per kind and reason", () => {
    const tally = tallyDecisions([
      decideFileKind(row(), { target: notebook({ importerType: "usfm" }) }),
      decideFileKind(row(), { target: notebook({ importerType: "ebibleCorpus" }) }),
      decideFileKind(row(), { target: notebook({ importerType: "usfm" }) }),
      decideFileKind(row(), { target: notebook({ importerType: "pdf" }) }),
      decideFileKind(row(), {}),
    ])
    expect([...tally]).toEqual([
      ["codex -> ebible", 1],
      ["codex -> usfm", 2],
      ['stays codex (importer "pdf" has no Aquilla type)', 1],
      ["untouched (no notebook on GitLab)", 1],
    ])
  })
})
