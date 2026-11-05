import { describe, expect, it } from "vitest"
import {
  classifyInlineTag,
  createTagMask,
  describeTagFailure,
  extractInlineTags,
  isTagsOnlyText,
  leakedSentinels,
  maskInlineTags,
  repairInlineTags,
  restoreInlineTags,
  sentinelFor,
  settleTagLadder,
  verifyInlineTags,
} from "./inline-tags"

const NONCE = "abc123"
const s = (i: number) => sentinelFor(NONCE, i)

describe("classifyInlineTag", () => {
  it("separates paired elements from point elements", () => {
    expect(classifyInlineTag("<b>").kind).toBe("paired-open")
    expect(classifyInlineTag("</b>").kind).toBe("paired-close")
    expect(classifyInlineTag("<br/>").kind).toBe("self-closing")
    expect(classifyInlineTag("<img src='a.png'>").kind).toBe("self-closing")
  })

  it("treats identified point tags as named placeholders (free order)", () => {
    expect(classifyInlineTag('<x id="1"/>').kind).toBe("named-placeholder")
    expect(classifyInlineTag('<ph id="7">').kind).toBe("named-placeholder")
  })

  it("names the placeholders AQU-2385 lists as free-order", () => {
    expect(classifyInlineTag("{name}").kind).toBe("named-placeholder")
    expect(classifyInlineTag("{{name}}").kind).toBe("named-placeholder")
    expect(classifyInlineTag("{0}").kind).toBe("named-placeholder")
    expect(classifyInlineTag("%1$s").kind).toBe("named-placeholder")
    expect(classifyInlineTag("%(name)s").kind).toBe("named-placeholder")
  })

  it("names the placeholders AQU-2385 lists as order-bearing", () => {
    expect(classifyInlineTag("%s").kind).toBe("ordered-placeholder")
    expect(classifyInlineTag("%@").kind).toBe("ordered-placeholder")
    expect(classifyInlineTag("{}").kind).toBe("ordered-placeholder")
  })
})

describe("extractInlineTags", () => {
  it("finds every form in document order", () => {
    const tags = extractInlineTags("<b>%s</b> {name} %(a)s {} <br/>")
    expect(tags.map((t) => t.raw)).toEqual(["<b>", "%s", "</b>", "{name}", "%(a)s", "{}", "<br/>"])
  })

  it("ignores prose that merely contains < or %", () => {
    expect(extractInlineTags("a < b and 50% done")).toEqual([])
  })
})

describe("isTagsOnlyText", () => {
  it("is true for markup with at most one placeholder", () => {
    expect(isTagsOnlyText("<b>%s</b>")).toBe(true)
    expect(isTagsOnlyText("{name}")).toBe(true)
    expect(isTagsOnlyText("<br/>")).toBe(true)
  })

  it("is false once there is translatable prose", () => {
    expect(isTagsOnlyText("<b>Hello %s</b>")).toBe(false)
  })

  it("is false with more than one placeholder — the order may need a model", () => {
    expect(isTagsOnlyText("%s %s")).toBe(false)
  })

  it("is false with no tags at all", () => {
    expect(isTagsOnlyText("plain text")).toBe(false)
    expect(isTagsOnlyText("   ")).toBe(false)
  })
})

describe("mask / restore", () => {
  it("replaces every tag with an opaque sentinel and puts them all back", () => {
    const mask = createTagMask(NONCE)
    const { masked } = maskInlineTags("<b>Hello %s</b>", mask)
    expect(masked).toBe(`${s(0)}Hello ${s(1)}${s(2)}`)
    expect(restoreInlineTags(masked, mask)).toBe("<b>Hello %s</b>")
  })

  it("mints no sentinel for text with no tags", () => {
    const mask = createTagMask(NONCE)
    const { masked } = maskInlineTags("In the beginning", mask)
    expect(masked).toBe("In the beginning")
    expect(mask.map.size).toBe(0)
  })

  it("keeps one ordinal sequence across a shared batch mask", () => {
    const mask = createTagMask(NONCE)
    const a = maskInlineTags("<b>one</b>", mask).masked
    const b = maskInlineTags("<i>two</i>", mask).masked
    expect(a).toBe(`${s(0)}one${s(1)}`)
    expect(b).toBe(`${s(2)}two${s(3)}`)
    expect(restoreInlineTags(`${a} ${b}`, mask)).toBe("<b>one</b> <i>two</i>")
  })

  it("restores a sentinel the model padded with spaces", () => {
    const mask = createTagMask(NONCE)
    maskInlineTags("<b>x</b>", mask)
    expect(restoreInlineTags(`[ # ${NONCE} 0 # ]texte[#${NONCE}1#]`, mask)).toBe("<b>texte</b>")
  })

  it("does not confuse sentinel 1 with sentinel 11", () => {
    const mask = createTagMask(NONCE)
    for (let i = 0; i < 12; i++) maskInlineTags("<b>x</b>", mask)
    expect(restoreInlineTags(s(11), mask)).toBe(mask.map.get(s(11)))
    expect(restoreInlineTags(s(1), mask)).toBe(mask.map.get(s(1)))
  })

  it("leaves an unknown ordinal in place so detection sees the leak", () => {
    const mask = createTagMask(NONCE)
    maskInlineTags("<b>x</b>", mask)
    const restored = restoreInlineTags(s(99), mask)
    expect(restored).toBe(s(99))
    expect(leakedSentinels(restored, mask).length).toBeGreaterThan(0)
  })

  it("spots a sentinel with an unknown nonce", () => {
    expect(leakedSentinels("texte [#ff00aa3#]")).toEqual(["[#ff00aa3#]"])
    expect(leakedSentinels("texte")).toEqual([])
  })
})

describe("verifyInlineTags", () => {
  it("accepts an identical tag set and order", () => {
    expect(verifyInlineTags("<b>a</b> %s", "<b>b</b> %s")).toEqual({ ok: true })
  })

  it("reports a missing tag", () => {
    const v = verifyInlineTags("<b>a</b>", "b</b>")
    expect(v).toMatchObject({ ok: false, reason: "tag-missing" })
  })

  it("reports an extra tag", () => {
    const v = verifyInlineTags("<b>a</b>", "<b>b</b><b>c</b>")
    expect(v).toMatchObject({ ok: false, reason: "tag-extra" })
  })

  it("reports unbalanced pairs before order", () => {
    const v = verifyInlineTags("<b>a</b><i>b</i>", "</b>a<b><i>b</i>")
    expect(v).toMatchObject({ ok: false, reason: "paired-unbalanced" })
  })

  it("reports a reorder of unnamed placeholders", () => {
    const v = verifyInlineTags("%s then %d", "%d then %s")
    expect(v).toMatchObject({ ok: false, reason: "order-changed" })
  })

  it("lets named placeholders move freely", () => {
    expect(verifyInlineTags("{a} then {b}", "{b} puis {a}")).toEqual({ ok: true })
    expect(verifyInlineTags("%1$s then %2$s", "%2$s puis %1$s")).toEqual({ ok: true })
    expect(verifyInlineTags('<x id="1"/> and <x id="2"/>', '<x id="2"/> et <x id="1"/>')).toEqual({ ok: true })
  })

  it("rejects a leaked sentinel ahead of everything else", () => {
    const mask = createTagMask(NONCE)
    maskInlineTags("<b>x</b>", mask)
    const v = verifyInlineTags("<b>x</b>", `${s(0)}texte</b>`, mask)
    expect(v).toMatchObject({ ok: false, reason: "sentinel-leaked" })
  })
})

describe("repairInlineTags", () => {
  it("drops a surplus duplicate placeholder, and the space it came with", () => {
    expect(repairInlineTags("hello %s", "bonjour %s %s")).toBe("bonjour %s")
    expect(repairInlineTags("hello %s", "%s %s bonjour")).toBe("%s bonjour")
    expect(repairInlineTags("hello %s", "bonjour %s au %s revoir")).toBe("bonjour %s au revoir")
  })

  it("absorbs no space in a script that does not space its words", () => {
    expect(repairInlineTags("hello %s", "%sこんにちは%s")).toBe("%sこんにちは")
  })

  it("drops a surplus duplicate point tag", () => {
    expect(repairInlineTags("a<br/>b", "a<br/>b<br/>")).toBe("a<br/>b")
  })

  it("restores the order of point tokens, keeping the model's positions", () => {
    expect(repairInlineTags("%s/%d", "%d/%s")).toBe("%s/%d")
  })

  it("refuses to reorder paired tags", () => {
    expect(repairInlineTags("<b>a</b><i>b</i>", "<i>b</i><b>a</b>")).toBeNull()
  })

  it("refuses paired-tag damage", () => {
    expect(repairInlineTags("<b>a</b>", "</b>a<b>")).toBeNull()
    expect(repairInlineTags("<b>a</b>", "<b>a<b>")).toBeNull()
  })

  it("refuses a surplus paired tag rather than guessing which half to cut", () => {
    expect(repairInlineTags("<b>a</b>", "<b>a</b><b>b</b></b>")).toBeNull()
  })

  it("refuses a missing tag — placement cannot be invented", () => {
    expect(repairInlineTags("<b>a</b>", "a</b>")).toBeNull()
  })

  it("refuses a sentinel leak", () => {
    const mask = createTagMask(NONCE)
    maskInlineTags("<b>x</b>", mask)
    expect(repairInlineTags("<b>x</b>", `${s(0)}texte${s(1)}`, mask)).toBeNull()
  })

  it("returns null when nothing is wrong", () => {
    expect(repairInlineTags("<b>a</b>", "<b>b</b>")).toBeNull()
  })

  it("only ever returns a candidate that re-verifies", () => {
    const source = "a %s b %d c"
    const candidate = repairInlineTags(source, "a %d b %s c %s")
    expect(candidate).not.toBeNull()
    expect(verifyInlineTags(source, candidate as string)).toEqual({ ok: true })
  })
})

describe("settleTagLadder", () => {
  it("restores and reports clean when the model behaved", () => {
    const mask = createTagMask(NONCE)
    const { masked } = maskInlineTags("<b>Hello</b> %s", mask)
    expect(masked).not.toContain("<b>")
    const reply = masked.replace("Hello", "Bonjour")
    expect(settleTagLadder("<b>Hello</b> %s", reply, mask)).toEqual({
      status: "clean",
      value: "<b>Bonjour</b> %s",
    })
  })

  it("reports a repair and carries the original reason", () => {
    const out = settleTagLadder("hello %s", "bonjour %s %s")
    expect(out.status).toBe("repaired")
    expect(out.reason).toBe("tag-extra")
    expect(verifyInlineTags("hello %s", out.value)).toEqual({ ok: true })
  })

  it("quarantines an unrepairable reply but still hands back the text", () => {
    const out = settleTagLadder("<b>hello</b>", "bonjour</b>")
    expect(out.status).toBe("unverified")
    expect(out.reason).toBe("tag-missing")
    expect(out.value).toBe("bonjour</b>")
  })

  it("quarantines a leaked sentinel", () => {
    const mask = createTagMask(NONCE)
    maskInlineTags("<b>hello</b>", mask)
    const out = settleTagLadder("<b>hello</b>", `[#${NONCE}0#]bonjour[#${NONCE}9#]`, mask)
    expect(out.status).toBe("unverified")
    expect(out.reason).toBe("sentinel-leaked")
  })

  it("still detects and repairs with masking switched off (no mask passed)", () => {
    const out = settleTagLadder("hello %s", "bonjour %s %s")
    expect(out.status).toBe("repaired")
  })
})

describe("describeTagFailure", () => {
  it("has an operator sentence for every reason", () => {
    for (const reason of ["sentinel-leaked", "tag-missing", "tag-extra", "paired-unbalanced", "order-changed"] as const) {
      expect(describeTagFailure(reason, "x")).toContain("(x)")
    }
  })
})
