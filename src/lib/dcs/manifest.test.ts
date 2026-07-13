import { describe, it, expect } from "vitest"
import { parseManifest } from "./manifest"

// A realistic Resource Container manifest.yaml, modelled on unfoldingWord's
// en_ult manifest (dublin_core + projects). Trimmed to the fields the router
// reads (spec §4).
const EN_ULT_MANIFEST = `dublin_core:
  conformsto: 'rc0.2'
  type: 'bundle'
  format: 'text/usfm'
  identifier: 'ult'
  subject: 'Aligned Bible'
  title: 'unfoldingWord Literal Text'
  language:
    identifier: 'en'
    title: 'English'
    direction: 'ltr'
  version: '89'
projects:
  - identifier: 'tit'
    title: 'Titus'
    path: './57-TIT.usfm'
    sort: 57
    categories: ['bible-nt']
  - identifier: 'phm'
    title: 'Philemon'
    path: './58-PHM.usfm'
    sort: 58
`

describe("parseManifest (RC manifest.yaml → DcsManifest)", () => {
  it("maps dublin_core fields to the routed shape", () => {
    const m = parseManifest(EN_ULT_MANIFEST)
    expect(m.rcType).toBe("bundle")
    expect(m.subject).toBe("Aligned Bible")
    expect(m.format).toBe("text/usfm")
    expect(m.identifier).toBe("ult")
    expect(m.language).toEqual({ identifier: "en", title: "English", direction: "ltr" })
  })

  it("maps projects[] preserving path/identifier/title/sort", () => {
    const m = parseManifest(EN_ULT_MANIFEST)
    expect(m.projects).toHaveLength(2)
    expect(m.projects[0]).toEqual({
      identifier: "tit",
      path: "./57-TIT.usfm",
      title: "Titus",
      sort: 57,
    })
    expect(m.projects[1].path).toBe("./58-PHM.usfm")
  })

  it("tolerates a manifest with no projects (defaults to [])", () => {
    const m = parseManifest(`dublin_core:
  type: 'help'
  format: 'text/tsv'
  identifier: 'tn'
  subject: 'TSV Translation Notes'
  language:
    identifier: 'en'
    title: 'English'
    direction: 'ltr'
`)
    expect(m.rcType).toBe("help")
    expect(m.projects).toEqual([])
  })

  it("throws on a manifest missing dublin_core", () => {
    expect(() => parseManifest("projects: []")).toThrow()
  })
})
