import { beforeEach, describe, expect, it } from "vitest"
import {
  createTagMask,
  INLINE_TAG_MASKING_STORAGE_KEY,
  isInlineTagMaskingEnabled,
  protectPromptSource,
  restoreProtectedPreview,
  setInlineTagMaskingEnabled,
  settleProtectedReply,
  __resetInlineTagMaskingForTests,
} from "./tag-protection"
import { sentinelFor } from "../../../db/shared/inline-tags"
import { collectInlineStyleWarnings } from "@/lib/export/fidelity"
import type { CellData } from "@/hooks/useCells"

beforeEach(() => {
  localStorage.removeItem(INLINE_TAG_MASKING_STORAGE_KEY)
  __resetInlineTagMaskingForTests()
})

describe("the masking switch", () => {
  it("is on until somebody turns it off", () => {
    expect(isInlineTagMaskingEnabled()).toBe(true)
    setInlineTagMaskingEnabled(false)
    expect(isInlineTagMaskingEnabled()).toBe(false)
    expect(localStorage.getItem(INLINE_TAG_MASKING_STORAGE_KEY)).toBe("0")
    setInlineTagMaskingEnabled(true)
    expect(isInlineTagMaskingEnabled()).toBe(true)
  })
})

describe("protectPromptSource", () => {
  it("keeps the real tags out of the prompt", () => {
    const p = protectPromptSource("<b>Hello</b> %s")
    expect(p.active).toBe(true)
    expect(p.promptSource).not.toContain("<b>")
    expect(p.promptSource).not.toContain("%s")
    expect(p.promptSource).toContain("Hello")
  })

  it("is inert for prose with no inline tags, so a plain draft is never judged on markup", () => {
    const p = protectPromptSource("In the beginning")
    expect(p).toEqual({ source: "In the beginning", promptSource: "In the beginning", active: false })
    expect(settleProtectedReply(p, "Au commencement <b>")).toEqual({
      status: "clean",
      value: "Au commencement <b>",
    })
  })

  it("leaves a protected-markup (IDML) cell to its own anchor contract", () => {
    const p = protectPromptSource('<span class="x">Hello</span>', { protectedMarkup: true })
    expect(p.active).toBe(false)
    expect(p.promptSource).toBe('<span class="x">Hello</span>')
    expect(p.mask).toBeUndefined()
  })

  it("shares one nonce and ordinal sequence across a batch", () => {
    const mask = createTagMask()
    const a = protectPromptSource("<b>one</b>", { mask })
    const b = protectPromptSource("<i>two</i>", { mask })
    expect(a.promptSource).not.toBe(b.promptSource)
    expect(new Set([...mask.map.keys()]).size).toBe(4)
  })

  it("sends the real tags when masking is switched off, but still judges the reply", () => {
    setInlineTagMaskingEnabled(false)
    const p = protectPromptSource("hello %s")
    expect(p.promptSource).toBe("hello %s")
    expect(p.mask).toBeUndefined()
    expect(p.active).toBe(true)
    // Detection and repair do not switch off with masking.
    expect(settleProtectedReply(p, "bonjour %s %s")).toMatchObject({
      status: "repaired",
      value: "bonjour %s",
    })
  })
})

describe("settleProtectedReply", () => {
  it("restores the tags of a well-behaved reply", () => {
    const p = protectPromptSource("<b>Hello</b>")
    const reply = p.promptSource.replace("Hello", "Bonjour")
    expect(settleProtectedReply(p, reply)).toEqual({ status: "clean", value: "<b>Bonjour</b>" })
  })

  it("quarantines a reply carrying a sentinel it cannot put back", () => {
    const p = protectPromptSource("<b>Hello</b> %s")
    // A sentinel the model invented (or mangled beyond the ordinal it was
    // given) has no tag behind it, so restore leaves it in the text.
    const stray = sentinelFor(p.mask?.nonce ?? "", 99)
    const out = settleProtectedReply(p, `Bonjour ${stray}`)
    expect(out.status).toBe("unverified")
    expect(out.reason).toBe("sentinel-leaked")
    expect(out.value).toContain(stray)
  })
})

describe("restoreProtectedPreview", () => {
  it("never shows a translator a sentinel, not even mid-stream", () => {
    const p = protectPromptSource("<b>Hello</b>")
    const half = p.promptSource.replace("Hello", "Bonj")
    expect(restoreProtectedPreview(p, half)).toBe("<b>Bonj</b>")
  })

  it("passes text through untouched when nothing was masked", () => {
    const p = protectPromptSource("In the beginning")
    expect(restoreProtectedPreview(p, "Au comm")).toBe("Au comm")
  })
})

describe("export fidelity surfaces a leaked sentinel", () => {
  const cell = (original: string, translated: string): CellData =>
    ({ id: "c1", fileId: "f1", original, translated, context: "seg" } as unknown as CellData)

  it("warns when a drafting placeholder survived into the translation", () => {
    const p = protectPromptSource("<b>Hello</b>")
    const sentinel = [...(p.mask?.map.keys() ?? [])][0]
    const warnings = collectInlineStyleWarnings([cell("<b>Hello</b>", `${sentinel} Bonjour`)])
    expect(warnings.some((w) => w.kind === "inline-tag-placeholder-leaked")).toBe(true)
  })

  it("stays quiet for a clean translation", () => {
    const warnings = collectInlineStyleWarnings([cell("<b>Hello</b>", "<b>Bonjour</b>")])
    expect(warnings.filter((w) => w.kind === "inline-tag-placeholder-leaked")).toEqual([])
  })
})
