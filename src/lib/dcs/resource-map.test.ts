import { describe, it, expect } from "vitest"
import { ROUTES, routeFor, isSupportedCatalogEntry } from "./resource-map"
import { dcsCellId } from "./cell-id"
import { contentHash } from "./content-hash"
import type { DcsCatalogEntry, DcsManifest } from "./types"

const ULT_ENTRY: DcsCatalogEntry = {
  name: "en_ult",
  owner: "unfoldingWord",
  fullName: "unfoldingWord/en_ult",
  subject: "Aligned Bible",
  contentFormat: "usfm",
  ref: "v89",
  refType: "tag",
  commitSha: "84c73ba0",
  released: "2026-06-23T22:01:02Z",
  zipballUrl: "z",
  metadataUrl: "m",
  language: "en",
}

const ULT_MANIFEST: DcsManifest = {
  rcType: "bundle",
  subject: "Aligned Bible",
  format: "text/usfm",
  identifier: "ult",
  language: { identifier: "en", title: "English", direction: "ltr" },
  projects: [{ identifier: "tit", path: "./57-TIT.usfm" }],
}

const TIT_USFM = `\\id TIT
\\c 1
\\p
\\v 1 Paul, a servant of God.
\\v 2 In the hope of eternal life.`

describe("routeFor (spec §4 dispatch)", () => {
  it("selects the USFM route for a usfm content_format", () => {
    const route = routeFor(ULT_ENTRY, ULT_MANIFEST)
    expect(route?.id).toBe("usfm")
  })

  it("selects the USFM route for a book/bundle manifest with usfm format even if content_format is blank", () => {
    const entry = { ...ULT_ENTRY, contentFormat: "" }
    const route = routeFor(entry, ULT_MANIFEST)
    expect(route?.id).toBe("usfm")
  })

  it("routes TSV Translation Notes to the tsv-notes route (Slice E)", () => {
    const entry = { ...ULT_ENTRY, contentFormat: "tsv", subject: "TSV Translation Notes" }
    const manifest = { ...ULT_MANIFEST, rcType: "help", format: "text/tsv", identifier: "tn" }
    expect(routeFor(entry, manifest)?.id).toBe("tsv-notes")
  })

  it("routes Open Bible Stories to the obs route (Slice E)", () => {
    const entry = { ...ULT_ENTRY, contentFormat: "markdown", subject: "Open Bible Stories" }
    const manifest = { ...ULT_MANIFEST, rcType: "book", format: "text/markdown", identifier: "obs" }
    expect(routeFor(entry, manifest)?.id).toBe("obs")
  })

  it("returns null for a resource no route matches (e.g. Translation Words markdown — Slice E tail)", () => {
    const entry = { ...ULT_ENTRY, contentFormat: "markdown", subject: "Translation Words" }
    const manifest = { ...ULT_MANIFEST, rcType: "dict", format: "text/markdown", identifier: "tw" }
    expect(routeFor(entry, manifest)).toBeNull()
  })

  it("ROUTES is ordered — first match wins", () => {
    expect(ROUTES.length).toBeGreaterThan(0)
    expect(ROUTES[0].id).toBe("usfm")
  })
})

describe("isSupportedCatalogEntry (AQU-615 catalog pre-check)", () => {
  // WHY: the catalog browser greys out rows PRE-import using only the catalog
  // entry (no manifest exists yet). A false negative here hides an importable
  // resource; a false positive re-creates the "no route" throw dead-end AFTER
  // the user committed. Cases below are real Door43 catalog rows.
  const row = (name: string, subject: string, contentFormat: string): DcsCatalogEntry => ({
    ...ULT_ENTRY,
    name,
    fullName: `unfoldingWord/${name}`,
    subject,
    contentFormat,
  })

  it("accepts every resource type a route can import", () => {
    expect(isSupportedCatalogEntry(row("en_ult", "Aligned Bible", "usfm"))).toBe(true)
    expect(isSupportedCatalogEntry(row("en_obs", "Open Bible Stories", "markdown"))).toBe(true)
    expect(isSupportedCatalogEntry(row("en_tn", "TSV Translation Notes", "tsv7"))).toBe(true)
    expect(isSupportedCatalogEntry(row("en_obs-tq", "TSV OBS Translation Questions", "tsv9"))).toBe(true)
  })

  it("rejects the clearly-unrouted v1-tail resources (TW/TWL/TA/grammars)", () => {
    expect(isSupportedCatalogEntry(row("en_twl", "TSV Translation Words Links", "tsv7"))).toBe(false)
    expect(isSupportedCatalogEntry(row("en_tw", "Translation Words", "markdown"))).toBe(false)
    expect(isSupportedCatalogEntry(row("en_ta", "Translation Academy", "markdown"))).toBe(false)
    expect(isSupportedCatalogEntry(row("en_uhg", "Hebrew Grammar", "x-rst"))).toBe(false)
  })

  it("stays optimistic on unknown-but-maybe rows (usfm format, unrecognized subject)", () => {
    // A blank/odd subject must not block a usfm resource — routeFor()'s
    // manifest-aware dispatch is the authoritative gate at import time.
    expect(isSupportedCatalogEntry(row("hbo_uhb", "", "usfm"))).toBe(true)
    expect(isSupportedCatalogEntry(row("xx_odd", "Some Future Subject", ""))).toBe(true)
  })
})

describe("USFM route parse()", () => {
  const route = routeFor(ULT_ENTRY, ULT_MANIFEST)!

  it("maps each verse to a DcsCell with a deterministic id, canonicalRef, hash", () => {
    const files = route.parse({
      entry: ULT_ENTRY,
      manifest: ULT_MANIFEST,
      files: new Map([["57-TIT.usfm", TIT_USFM]]),
    })
    expect(files).toHaveLength(1)
    const cells = files[0].cells
    expect(cells).toHaveLength(2)

    // Deterministic id from `${repo}|BOOK C:V` — NOT the parser's fresh uuidv4.
    expect(cells[0].cellId).toBe(dcsCellId("unfoldingWord/en_ult|TIT 1:1"))
    expect(cells[1].cellId).toBe(dcsCellId("unfoldingWord/en_ult|TIT 1:2"))

    expect(cells[0].canonicalRef).toBe("TIT 1:1")
    expect(cells[0].type).toBe("verse")
    expect(cells[0].value).toContain("Paul, a servant of God")
    expect(cells[0].contentHash).toBe(contentHash(cells[0].value))

    // File id is deterministic on the repo-relative path.
    expect(files[0].bookCode).toBe("TIT")
  })

  it("produces STABLE ids across two independent parses (cross-import lineage)", () => {
    const parseOnce = () =>
      route.parse({
        entry: ULT_ENTRY,
        manifest: ULT_MANIFEST,
        files: new Map([["57-TIT.usfm", TIT_USFM]]),
      })
    const a = parseOnce()
    const b = parseOnce()
    expect(a[0].cells.map((c) => c.cellId)).toEqual(b[0].cells.map((c) => c.cellId))
    expect(a[0].fileId).toBe(b[0].fileId)
  })

  it("only parses .usfm files from the provided file map", () => {
    const files = route.parse({
      entry: ULT_ENTRY,
      manifest: ULT_MANIFEST,
      files: new Map([
        ["57-TIT.usfm", TIT_USFM],
        ["manifest.yaml", "dublin_core: {}"],
        ["LICENSE.md", "# License"],
      ]),
    })
    expect(files).toHaveLength(1)
    expect(files[0].name).toContain("TIT")
  })
})
