import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { matchCase, selectedSingleWord } from "./words-that-fit"

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

describe("words-that-fit selection helpers", () => {
  it("accepts exactly one whole word, in any script", () => {
    editor = new Editor({ extensions: [StarterKit], content: "<p>The king, परमप्रभुको spoke</p>" })
    editor.commands.setTextSelection({ from: 5, to: 9 })
    expect(selectedSingleWord(editor)).toEqual({ word: "king", from: 5, to: 9 })
    editor.commands.setTextSelection({ from: 5, to: 10 })
    expect(selectedSingleWord(editor)).toBeNull()
    editor.commands.setTextSelection({ from: 1, to: 9 })
    expect(selectedSingleWord(editor)).toBeNull()
    editor.commands.setTextSelection({ from: 11, to: 21 })
    expect(selectedSingleWord(editor)?.word).toBe("परमप्रभुको")
  })

  it("matches a leading capital", () => {
    expect(matchCase("King", "queen")).toBe("Queen")
    expect(matchCase("king", "queen")).toBe("queen")
    expect(matchCase("राजा", "छोरा")).toBe("छोरा")
  })
})
