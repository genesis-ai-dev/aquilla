import { describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { UsfmStyle } from "./usfm-style-mark"
import { UsfmFootnote } from "./footnote-node"
import { htmlSpanToUsfm } from "@/lib/parsers/usfm-html"

function makeEditor(content: string): Editor {
  return new Editor({ extensions: [StarterKit, UsfmStyle, UsfmFootnote], content })
}

describe("UsfmStyle mark — editor round-trip (the part pure-fn tests can't prove)", () => {
  it("preserves a restored <span data-usfm> through getHTML and reload", () => {
    const editor = makeEditor('<p>the <span data-usfm="nd">LORD</span> said</p>')
    const html = editor.getHTML()
    expect(html).toContain('data-usfm="nd"')
    // simulate a reload: feed the serialized HTML back into a fresh editor
    const reloaded = makeEditor(html)
    expect(reloaded.getHTML()).toContain('data-usfm="nd"')
    // and it still exports to USFM
    expect(htmlSpanToUsfm(reloaded.getHTML())).toContain("\\nd LORD\\nd*")
    editor.destroy(); reloaded.destroy()
  })

  it("is generic over marker names (wj, add, …) — no hard-coded set", () => {
    for (const m of ["wj", "add", "sc"]) {
      const editor = makeEditor(`<p><span data-usfm="${m}">x</span></p>`)
      expect(editor.getHTML()).toContain(`data-usfm="${m}"`)
      editor.destroy()
    }
  })

  it("does not swallow footnote spans (data-usfm-footnote stays the atom node)", () => {
    const editor = makeEditor('<p>x<span data-usfm-footnote="\\f + \\ft n\\f*">+</span></p>')
    expect(editor.getHTML()).toContain("data-usfm-footnote")
    editor.destroy()
  })
})
