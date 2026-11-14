// Smart quotes are the default typing behaviour of the translation editor.
// What these tests hold:
//   - the opening/closing decision is the one a typist expects from Word, so
//     nobody has to fix a quote that curled the wrong way;
//   - the marks follow the project (its recorded quotation marks, else its
//     target language), so the editor types what the quotation checks expect
//     and a French project does not get English “ ”;
//   - apostrophes stay ’ in every language (a localized closing single quote
//     would corrupt "geht's");
//   - only typed characters change: stored and pasted text keeps its straight
//     quotes, so an untouched cell exports byte-identical;
//   - the straight quote is one Cmd/Ctrl+Z (or Backspace) away, the only way
//     to keep an inch mark while this is on.

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import {
  createSmartQuotesExtension,
  doubleQuoteMarks,
  smartQuoteFor,
  smartQuoteMarks,
  type SmartQuoteMarks,
} from "./smart-quotes"
import { UsfmFootnote } from "./footnote-node"

const ENGLISH = smartQuoteMarks("English")

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function mount(marks: SmartQuoteMarks | null, content = ""): Editor {
  editor = new Editor({
    extensions: [StarterKit, UsfmFootnote, createSmartQuotesExtension(() => marks)],
    content,
  })
  editor.commands.focus("end")
  return editor
}

/** Types `text` one character at a time through ProseMirror's text-input path, which is where the rule runs. */
function type(text: string): string {
  const view = editor!.view
  for (const ch of text) {
    const { from, to } = view.state.selection
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)))
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to))
  }
  return editor!.getText()
}

function typeInto(lang: string | undefined, text: string): string {
  mount(smartQuoteMarks(lang))
  return type(text)
}

/** Presses a key through the editor's keymaps. `mod` is Cmd on macOS and Ctrl elsewhere, as "Mod-" resolves. */
function press(key: string, mod = false): void {
  const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform)
  const event = new KeyboardEvent("keydown", { key, metaKey: mod && mac, ctrlKey: mod && !mac, bubbles: true, cancelable: true })
  editor!.view.someProp("handleKeyDown", (f) => f(editor!.view, event))
}

describe("smartQuoteFor", () => {
  const curl = (typed: string, before: string, marks = ENGLISH) => smartQuoteFor(typed, before, marks)

  it("opens at the start of the cell", () => {
    expect(curl('"', "")).toBe("“")
    expect(curl("'", "")).toBe("‘")
  })

  it("opens after a space or a line break", () => {
    expect(curl('"', "He said ")).toBe("“")
    expect(curl("'", "He said ")).toBe("‘")
    expect(curl('"', "first line\n")).toBe("“")
  })

  it("opens after an opening bracket", () => {
    for (const bracket of ["(", "[", "{"]) {
      expect(curl('"', `see ${bracket}`)).toBe("“")
      expect(curl("'", `see ${bracket}`)).toBe("‘")
    }
  })

  it("closes after a letter, a digit or closing punctuation", () => {
    expect(curl('"', "He said “yes")).toBe("”")
    expect(curl('"', "He said “yes.")).toBe("”")
    expect(curl("'", "the ‘word")).toBe("’")
    expect(curl('"', "5")).toBe("”")
  })

  it("makes an apostrophe inside or at the end of a word ’", () => {
    expect(curl("'", "don")).toBe("’")
    expect(curl("'", "the disciples")).toBe("’")
  })

  it("opens a single quote nested directly inside a double quote, and a double inside a single", () => {
    expect(curl("'", "He said “")).toBe("‘")
    expect(curl('"', "She wrote ‘")).toBe("“")
  })

  it("closes the outer quote directly after the inner one closes", () => {
    expect(curl('"', "“He said ‘go’")).toBe("”")
    expect(curl("'", "‘She said “go”")).toBe("’")
  })

  // The nested-quote rule must know every project's opening mark, not only
  // English “: «' used to give «’.
  it("nests inside the project's own opening mark", () => {
    expect(curl("'", "Il dit «", smartQuoteMarks("French"))).toBe("‘")
    expect(curl("'", "Er sagte „", smartQuoteMarks("German"))).toBe("‘")
  })

  // German closes with “, the mark English opens with.
  it("does not treat the project's closing mark as an opening one", () => {
    expect(curl("'", "Er sagte „ja“", smartQuoteMarks("German"))).toBe("’")
    expect(curl('"', "”hej", smartQuoteMarks("Swedish"))).toBe("”")
  })

  it("leaves quotes straight inside an unfinished inline tag", () => {
    expect(curl('"', "see <a href=")).toBeNull()
    expect(curl('"', 'see <a href="x')).toBeNull()
    expect(curl("'", "<span class=")).toBeNull()
  })

  // A tag is markup, not text: the quote is judged by the text around it.
  it("looks past a finished inline tag to the text before it", () => {
    expect(curl('"', 'see <a href="x">')).toBe("“")
    expect(curl('"', "<b>")).toBe("“")
    expect(curl('"', "“<b>word</b>")).toBe("”")
    expect(curl("'", "don<i></i>")).toBe("’")
  })

  it("does not mistake a bare < for a tag", () => {
    expect(curl('"', "a < b ")).toBe("“")
    expect(curl('"', "a <")).toBe("“")
  })

  it("leaves every other character alone", () => {
    expect(curl("a", "")).toBeNull()
    expect(curl("`", "")).toBeNull()
  })
})

describe("smartQuoteMarks", () => {
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

  // The quotation checks read this same slot, so typing must produce what
  // they expect even when the language's usual marks differ.
  it("prefers the project's recorded quotation marks over the language's", () => {
    const marks = smartQuoteMarks("English", {
      levels: [{ open: "«", close: "»" }, { open: "“", close: "”" }],
      continuation: "none",
    })
    expect(marks.double).toEqual({ open: "«", close: "»" })
  })

  // A British-style project quotes ‘ ’ first. The ' key already types those,
  // so the " key takes the next level instead of typing single quotes too.
  it("gives the \" key the first level that is not single quotes", () => {
    const marks = smartQuoteMarks("French", {
      levels: [{ open: "‘", close: "’" }, { open: "“", close: "”" }],
      continuation: "none",
    })
    expect(marks.double).toEqual({ open: "“", close: "”" })
  })

  it("keeps the ' key on ‘ ’ whatever the project records, so apostrophes stay ’", () => {
    const marks = smartQuoteMarks("German", {
      levels: [{ open: "„", close: "“" }, { open: "‚", close: "‘" }],
      continuation: "none",
    })
    expect(marks.single).toEqual({ open: "‘", close: "’" })
  })

  it("falls back to the language when the project recorded no levels", () => {
    expect(smartQuoteMarks("French", { levels: [], continuation: "none" }).double).toEqual({ open: "«", close: "»" })
    expect(smartQuoteMarks("French", null).double).toEqual({ open: "«", close: "»" })
  })
})

describe("typing in the editor", () => {
  it("curls double and single quotes and keeps apostrophes as ’", () => {
    expect(typeInto("English", `He said "it's 'fine'" today`)).toBe("He said “it’s ‘fine’” today")
  })

  it("nests a single quote typed straight after the opening double quote", () => {
    expect(typeInto("English", `"'Go,' he said."`)).toBe("“‘Go,’ he said.”")
  })

  it("uses the target language's double quotes", () => {
    expect(typeInto("French", `Il dit "oui"`)).toBe("Il dit «oui»")
    expect(typeInto("German", `Er sagte "ja"`)).toBe("Er sagte „ja“")
  })

  it("keeps the apostrophe as ’ where the language's secondary quotes differ", () => {
    expect(typeInto("German", "geht's")).toBe("geht’s")
    expect(typeInto("French", "c'est")).toBe("c’est")
  })

  it("types straight quotes when the project turned smart quotes off", () => {
    mount(null)
    expect(type(`He said "it's"`)).toBe(`He said "it's"`)
  })

  // Exports are byte-identical for untouched cells only if loading a cell
  // never rewrites it.
  it("does not rewrite quotes already in the cell", () => {
    mount(ENGLISH, `<p>He said "it's fine"</p>`)
    expect(editor!.getText()).toBe(`He said "it's fine"`)
    expect(type(" ok")).toBe(`He said "it's fine" ok`)
  })

  it("does not convert pasted or programmatically inserted text", () => {
    mount(ENGLISH)
    editor!.commands.insertContent(`"pasted" isn't typed`)
    expect(editor!.getText()).toBe(`"pasted" isn't typed`)
  })

  it("opens after a line break in the cell", () => {
    mount(ENGLISH)
    type("line one")
    editor!.commands.setHardBreak()
    type(`"two`)
    expect(editor!.state.doc.lastChild?.lastChild?.text).toBe("“two")
  })

  // A footnote is an atom after the word it annotates: the quote typed after
  // it closes that word's quotation instead of opening a new one.
  it("looks past a footnote to the word before it", () => {
    mount(ENGLISH)
    type(`"word`)
    editor!.commands.insertContent({ type: UsfmFootnote.name, attrs: { raw: "\\f + \\ft note\\f*" } })
    type(`"`)
    expect(editor!.state.doc.lastChild?.lastChild?.text).toBe("”")
  })

  it("leaves quotes straight in inline code", () => {
    mount(ENGLISH, "<p><code>x=</code></p>")
    expect(type(`"`)).toBe(`x="`)
  })

  it("leaves the attribute quotes of a typed inline tag straight", () => {
    mount(ENGLISH)
    expect(type(`<a href="x">"link"</a>`)).toBe(`<a href="x">“link”</a>`)
  })
})

describe("taking a conversion back", () => {
  it("restores the straight quote on Cmd/Ctrl+Z right after the conversion", () => {
    mount(ENGLISH)
    type(`5"`)
    expect(editor!.getText()).toBe("5”")
    press("z", true)
    expect(editor!.getText()).toBe(`5"`)
  })

  it("restores the straight quote on Backspace right after the conversion", () => {
    mount(ENGLISH)
    type(`5"`)
    press("Backspace")
    expect(editor!.getText()).toBe(`5"`)
  })

  // Word's second Ctrl+Z removes the quote. It must not bring the curly one
  // back, or the straight quote could never be kept across an undo.
  it("a second undo never brings the curly quote back", () => {
    mount(ENGLISH)
    type(`5"`)
    press("z", true)
    press("z", true)
    expect(editor!.getText()).not.toContain("”")
  })

  it("only the very next key can take it back: after more typing, undo is ordinary undo", () => {
    mount(ENGLISH)
    type(`"a`)
    press("z", true)
    expect(editor!.getText()).not.toContain('"')
  })

  it("keeps the straight quote straight while typing continues", () => {
    mount(ENGLISH)
    type(`5"`)
    press("z", true)
    expect(type(" tall")).toBe(`5" tall`)
  })
})
