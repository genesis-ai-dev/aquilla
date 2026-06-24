import { describe, it, expect } from "vitest"
import { parseObsStories } from "./obs"

describe("parseObsStories", () => {
  // A minimal 2-frame OBS story, shaped like unfoldingWord's en_obs `NN.md`:
  // a `# ` title, then per-frame (image line + paragraph), then a `_..._` ref.
  const md = [
    "# 1. The Creation",
    "",
    "![OBS Image](https://cdn.door43.org/obs/jpg/01-01.jpg)",
    "",
    "This is how the beginning of everything happened. God created the universe and everything in it in six days.",
    "",
    "![OBS Image](https://cdn.door43.org/obs/jpg/01-02.jpg)",
    "",
    "God made the dry land and the seas, and he filled them with plants and animals.",
    "",
    "_A Bible story from: Genesis 1-2_",
  ].join("\n")

  it("returns one TranslatableString per frame (2 frames → 2 strings, no image-only cells)", () => {
    const result = parseObsStories(md, "01.md")
    expect(result).toHaveLength(2)
  })

  it("each frame is a text cell with non-empty paragraph text", () => {
    const result = parseObsStories(md, "01.md")
    for (const frame of result) {
      expect(frame.type).toBe("text")
      expect(frame.original.trim().length).toBeGreaterThan(0)
    }
    expect(result[0].original).toContain("the beginning of everything")
    expect(result[1].original).toContain("dry land and the seas")
  })

  it("carries the frame image as the only attachment in metadata", () => {
    const result = parseObsStories(md, "01.md")
    const att0 = (result[0].metadata as { attachments?: Array<{ type: string; url: string }> })
      ?.attachments
    const att1 = (result[1].metadata as { attachments?: Array<{ type: string; url: string }> })
      ?.attachments
    expect(att0).toHaveLength(1)
    expect(att1).toHaveLength(1)
    expect(att0![0].type).toBe("image")
    expect(att0![0].url).toBe("https://cdn.door43.org/obs/jpg/01-01.jpg")
    expect(att1![0].url).toBe("https://cdn.door43.org/obs/jpg/01-02.jpg")
  })

  it("does NOT emit separate image-only strings (no empty-text cells)", () => {
    const result = parseObsStories(md, "01.md")
    const imageOnly = result.filter((f) => f.original.trim().length === 0)
    expect(imageOnly).toHaveLength(0)
  })

  it("threads a stable per-frame ref into group/canonicalRef (1-based)", () => {
    const result = parseObsStories(md, "01.md")
    expect(result[0].group).toBe("OBS 1:1")
    expect(result[1].group).toBe("OBS 1:2")
    expect(result[0].section).toBe("1. The Creation")
  })
})
