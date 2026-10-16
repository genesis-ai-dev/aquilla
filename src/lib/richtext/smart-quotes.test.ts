// Smart quotes are an opt-in typing aid for the translation editor. What these
// tests hold: the marks follow the target language (a French project must not
// get English “ ”), apostrophes stay ’ in every language (a localized closing
// single quote would corrupt "geht's"), and none of Typography's other
// replacements (-- → —, (c) → ©) ride along, because they would rewrite text
// the translator never asked to change.

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { createSmartQuotesExtension, doubleQuoteMarks } from "./smart-quotes"

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

/** Types `text` one character at a time through ProseMirror's text-input path, which is where input rules run. */
function typeInto(lang: string | undefined, text: string): string {
  editor = new Editor({ extensions: [StarterKit, createSmartQuotesExtension(lang)] })
  const view = editor.view
  for (const ch of text) {
    const { from, to } = view.state.selection
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)))
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to))
  }
  return editor.getText()
}

describe("doubleQuoteMarks", () => {
  it("falls back to English curly quotes for an unset or unknown language", () => {
    expect(doubleQuoteMarks(undefined)).toEqual({ open: "“", close: "”" })
    expect(doubleQuoteMarks("Tok Pisin")).toEqual({ open: "“", close: "”" })
  })

  it("resolves English names, 2-letter and 3-letter codes to the same marks", () => {
    for (const tag of ["French", "fr", "fra", "fr-CA"]) {
      expect(doubleQuoteMarks(tag)).toEqual({ open: "«", close: "»" })
    }
    expect(doubleQuoteMarks("German")).toEqual({ open: "„", close: "“" })
  })
})

describe("createSmartQuotesExtension", () => {
  it("curls double and single quotes and keeps apostrophes as ’", () => {
    expect(typeInto("English", `He said "it's 'fine'" today`)).toBe("He said “it’s ‘fine’” today")
  })

  it("uses the target language's double quotes", () => {
    expect(typeInto("French", `Il dit "oui"`)).toBe("Il dit «oui»")
    expect(typeInto("German", `Er sagte "ja"`)).toBe("Er sagte „ja“")
  })

  it("keeps the apostrophe as ’ where the language's secondary quotes differ", () => {
    expect(typeInto("German", "geht's")).toBe("geht’s")
    expect(typeInto("French", "c'est")).toBe("c’est")
  })

  // The settings description promises this, and it is the only way to keep a
  // straight quote (an inch mark, a code sample) once the setting is on.
  it("restores the straight quote when the conversion is undone (Backspace)", () => {
    typeInto("English", `5"`)
    editor!.commands.undoInputRule()
    expect(editor!.getText()).toBe(`5"`)
  })

  it("leaves Typography's other replacements off", () => {
    expect(typeInto("English", "a -- b... (c) 1/2 -> x")).toBe("a -- b... (c) 1/2 -> x")
  })
})
