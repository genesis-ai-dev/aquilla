import { describe, expect, it } from "vitest"
import { codexFootnotesToUsfm } from "./codex-footnotes"

const YESU = "Yesu Anó Tuhe, Robbi Bapó Dio dale hubunge hó istimewo."
const LEGION = "Legion: Kato hó ning guno utú aska jumloh 3,000 henggo 6,000 dale sépuó."

describe("codexFootnotesToUsfm", () => {
  it("turns a Codex footnote marker into a USFM footnote", () => {
    const cases = [
      {
        name: "escaped note, class after the attribute",
        html: `<p>nené moye Dio.<sup data-footnote="&lt;p&gt;&lt;em&gt;${LEGION}&lt;/em&gt;&lt;/p&gt;" class="footnote-marker">1</sup></p>`,
      },
      {
        name: "unescaped note whose tags would split a naive strip",
        html: `<span>nené moye Dio.<sup data-footnote="<p> <span class=&quot;ql-cursor&quot;>\uFEFF</p>${YESU}</p><p><br></p>" class="footnote-marker">1</sup></span>`,
      },
      {
        name: "class before the attribute, single-quoted",
        html: `<sup class='footnote-marker' data-footnote='&lt;p&gt;${YESU}&lt;/p&gt;'>1</sup>`,
      },
    ]
    for (const sample of cases) {
      const out = codexFootnotesToUsfm(sample.html)
      expect(out, sample.name).toContain(`\\f + \\ft ${sample.name.startsWith("escaped") ? LEGION : YESU}\\f*`)
      expect(out, sample.name).not.toContain("data-footnote")
      expect(out, sample.name).not.toContain("footnote-marker")
      expect(out, sample.name).not.toContain(">1")
    }
  })

  it("keeps a marker whose note is empty", () => {
    const html = `<sup class="footnote-marker" data-footnote="">1</sup>`
    expect(codexFootnotesToUsfm(html)).toBe(html)
  })

  it("leaves ordinary HTML alone", () => {
    const html = `<p>Dio nó jadi oře mulio.</p>`
    expect(codexFootnotesToUsfm(html)).toBe(html)
  })
})
