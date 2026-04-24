import { describe, expect, it } from "vitest"
import { replaceInHtmlTextNodes, replacePlain } from "./replace-action"

describe("replacePlain", () => {
  it("literal match, case-insensitive by default", () => {
    const r = replacePlain("The Lord is my Shepherd.", "lord", "LORD", false)
    expect(r.text).toBe("The LORD is my Shepherd.")
    expect(r.count).toBe(1)
  })

  it("case-sensitive when requested", () => {
    const r = replacePlain("Jesus jesus JESUS", "jesus", "X", true)
    expect(r.text).toBe("Jesus X JESUS")
    expect(r.count).toBe(1)
  })

  it("returns zero count when no match", () => {
    const r = replacePlain("nothing here", "zebra", "X", false)
    expect(r.count).toBe(0)
    expect(r.text).toBe("nothing here")
  })

  it("escapes regex metacharacters in find string", () => {
    const r = replacePlain("price: $10.00 (incl. tax)", "$10.00", "$12.00", false)
    expect(r.text).toBe("price: $12.00 (incl. tax)")
    expect(r.count).toBe(1)
  })

  it("replaces every occurrence", () => {
    const r = replacePlain("aaa aaa aaa", "aaa", "b", false)
    expect(r.text).toBe("b b b")
    expect(r.count).toBe(3)
  })

  it("empty find returns input unchanged", () => {
    const r = replacePlain("hello", "", "X", false)
    expect(r.text).toBe("hello")
    expect(r.count).toBe(0)
  })
})

describe("replaceInHtmlTextNodes", () => {
  it("replaces inside text nodes without disturbing tags", () => {
    const input = "<p>Blessed are the <b>peacemakers</b>.</p>"
    const r = replaceInHtmlTextNodes(input, "peacemakers", "merciful", false)
    expect(r.html).toBe("<p>Blessed are the <b>merciful</b>.</p>")
    expect(r.count).toBe(1)
  })

  it("does not match inside tag attributes", () => {
    // Even if <p class="peacemakers"> contains the token, only visible text is replaced.
    const input = '<p class="peacemakers">see above</p>'
    const r = replaceInHtmlTextNodes(input, "peacemakers", "merciful", false)
    expect(r.html).toContain('class="peacemakers"')
    expect(r.count).toBe(0)
  })

  it("respects case-insensitive matching across text nodes", () => {
    const input = "<p>Lord <i>lord</i> LORD</p>"
    const r = replaceInHtmlTextNodes(input, "lord", "Yahweh", false)
    expect(r.count).toBe(3)
    expect(r.html).toBe("<p>Yahweh <i>Yahweh</i> Yahweh</p>")
  })

  it("returns unchanged html when no match", () => {
    const input = "<p>hello world</p>"
    const r = replaceInHtmlTextNodes(input, "zzz", "Y", false)
    expect(r.html).toBe("<p>hello world</p>")
    expect(r.count).toBe(0)
  })
})
