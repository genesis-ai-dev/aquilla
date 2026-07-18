import { describe, it, expect } from "vitest"
import { obsRoute } from "./obs"
import { dcsCellId, dcsFileId } from "../cell-id"
import { contentHash } from "../content-hash"
import type { DcsCatalogEntry, DcsManifest } from "../types"

const OBS_ENTRY: DcsCatalogEntry = {
  name: "en_obs",
  owner: "unfoldingWord",
  fullName: "unfoldingWord/en_obs",
  subject: "Open Bible Stories",
  contentFormat: "markdown",
  ref: "v9",
  refType: "tag",
  commitSha: "deadbeef",
  released: "2026-01-01T00:00:00Z",
  zipballUrl: "z",
  metadataUrl: "m",
  language: "en",
}

const OBS_MANIFEST: DcsManifest = {
  rcType: "book",
  subject: "Open Bible Stories",
  format: "text/markdown",
  identifier: "obs",
  language: { identifier: "en", title: "English", direction: "ltr" },
  projects: [{ identifier: "obs", path: "./content" }],
}

// A tiny 2-frame OBS story: title, two image+paragraph frames, trailing ref.
const STORY_01 = `# 1. The Creation

![OBS Image](https://cdn.door43.org/obs/jpg/01-01.jpg)

This is how the beginning of everything happened.

![OBS Image](https://cdn.door43.org/obs/jpg/01-02.jpg)

God made the light by speaking to the darkness.

_A Bible story from: Genesis 1-2_`

describe("obsRoute matches (spec §4)", () => {
  it("matches by subject 'Open Bible Stories'", () => {
    expect(obsRoute.matches(OBS_ENTRY, OBS_MANIFEST)).toBe(true)
  })

  it("matches by manifest (book + markdown + identifier obs) when subject is blank", () => {
    const entry = { ...OBS_ENTRY, subject: "" }
    expect(obsRoute.matches(entry, OBS_MANIFEST)).toBe(true)
  })

  it("does not match a USFM book", () => {
    const entry = { ...OBS_ENTRY, subject: "Aligned Bible", contentFormat: "usfm" }
    const manifest = { ...OBS_MANIFEST, format: "text/usfm", identifier: "ult" }
    expect(obsRoute.matches(entry, manifest)).toBe(false)
  })
})

describe("obsRoute parse()", () => {
  it("maps each frame to a cell seeded `repo|OBS story:frame`, carries the image attachment", () => {
    const out = obsRoute.parse({
      entry: OBS_ENTRY,
      manifest: OBS_MANIFEST,
      files: new Map([["content/01.md", STORY_01]]),
    })
    expect(out).toHaveLength(1)
    const file = out[0]
    expect(file.fileId).toBe(dcsFileId("unfoldingWord/en_obs", "content/01.md"))
    expect(file.name).toBe("1. The Creation")

    expect(file.cells).toHaveLength(2)
    const [f1, f2] = file.cells

    // Deterministic ids from the OBS ref — NOT the parser's fresh uuid.
    expect(f1.cellId).toBe(dcsCellId("unfoldingWord/en_obs|OBS 1:1"))
    expect(f2.cellId).toBe(dcsCellId("unfoldingWord/en_obs|OBS 1:2"))

    expect(f1.canonicalRef).toBe("OBS 1:1")
    expect(f1.type).toBe("text")
    expect(f1.value).toContain("beginning of everything")
    expect(f1.contentHash).toBe(contentHash(f1.value))

    // The frame's reference image rides through in metadata.attachments.
    const attachments = f1.metadata?.attachments as Array<{ type: string; url: string }>
    expect(attachments).toHaveLength(1)
    expect(attachments[0].type).toBe("image")
    expect(attachments[0].url).toContain("01-01.jpg")
  })

  it("produces STABLE ids across two independent parses (cross-import lineage)", () => {
    const run = () =>
      obsRoute.parse({
        entry: OBS_ENTRY,
        manifest: OBS_MANIFEST,
        files: new Map([["content/01.md", STORY_01]]),
      })
    const a = run()
    const b = run()
    expect(a[0].cells.map((c) => c.cellId)).toEqual(b[0].cells.map((c) => c.cellId))
    expect(a[0].fileId).toBe(b[0].fileId)
  })

  it("only parses NN.md story files, skipping front/back matter", () => {
    const out = obsRoute.parse({
      entry: OBS_ENTRY,
      manifest: OBS_MANIFEST,
      files: new Map([
        ["content/01.md", STORY_01],
        ["content/front/intro.md", "# Intro\n\nNot a story."],
        ["LICENSE.md", "# License"],
      ]),
    })
    expect(out).toHaveLength(1)
    expect(out[0].cells).toHaveLength(2)
  })
})
