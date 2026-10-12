import { describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { ContextChipNode } from "./context-chip-node"

function makeEditor() {
  return new Editor({
    extensions: [StarterKit.configure({ heading: false }), ContextChipNode],
    content: {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "see " },
          { type: "contextChip", attrs: {
            chipId: "a", fileId: "f", cellId: "z", canonicalRef: "GEN 1:1",
            side: "source", selection: "In the beginning", preview: "In the beginning",
          } },
        ],
      }],
    },
  })
}

describe("ContextChipNode", () => {
  it("renderText emits a stable chip placeholder", () => {
    const editor = makeEditor()
    expect(editor.getText()).toBe("see ⟦chip:a⟧")
    editor.destroy()
  })

  it("round-trips through getJSON with attrs intact", () => {
    const editor = makeEditor()
    const json = editor.getJSON()
    const para = json.content![0]
    const chipNode = para.content!.find(
      (n: { type?: string }) => n.type === "contextChip",
    ) as { attrs?: Record<string, unknown> } | undefined
    expect(chipNode!.attrs).toMatchObject({ chipId: "a", canonicalRef: "GEN 1:1", fileId: "f", cellId: "z" })
    editor.destroy()
  })

  it("labels the pill with the selected wording and puts the full text in the tooltip", () => {
    const selection = "In the beginning God created the heavens and the earth"
    const editor = new Editor({
      extensions: [StarterKit.configure({ heading: false }), ContextChipNode],
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "contextChip", attrs: {
          chipId: "a", fileId: "f", cellId: "z", canonicalRef: "",
          side: "source", selection, preview: selection,
        } }] }],
      },
    })
    const pill = editor.view.dom.querySelector(".context-chip") as HTMLElement
    expect(pill.textContent).toContain("In the beginning God created the…")
    expect(pill.textContent).not.toMatch(/^source/)
    expect(pill.title).toBe(selection)
    editor.destroy()
  })
})
