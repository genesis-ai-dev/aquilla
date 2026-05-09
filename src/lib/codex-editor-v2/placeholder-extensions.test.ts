/**
 * End-to-end round-trip through a real TipTap editor:
 *
 *   plain text + dict
 *     → parseTranslationText → ProseMirror JSON
 *     → editor.setContent
 *     → editor.getJSON
 *     → serializeProseMirrorDoc
 *     → plain text (must match original)
 *
 * This exercises the schema declared in placeholder-extensions, not just
 * the pure parser/serializer. If the editor's schema disagrees with our
 * JSON shape, the round-trip will mangle the doc and the test fails.
 */

import { describe, expect, test } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import {
  parseTranslationText,
  serializeProseMirrorDoc,
  type PMDoc,
  type TagDictionary,
} from "./placeholder-tokens"
import { placeholderExtensions } from "./placeholder-extensions"

const FULL_DICT: TagDictionary = {
  g1: { kind: "style", origin: { format: "usfm", marker: "\\add" } },
  nd1: { kind: "style", origin: { format: "usfm", marker: "\\nd" } },
  f1: { kind: "ph", ref: { cell_id: "demo:fn1" } },
}

function makeEditor(content: PMDoc): Editor {
  return new Editor({
    extensions: [StarterKit, ...placeholderExtensions],
    content,
  })
}

describe("placeholder extensions in a TipTap editor", () => {
  test.each([
    ["hello world", {}],
    ["{g1}hello{/g1}", FULL_DICT],
    ["{f1}", FULL_DICT],
    ["He said {g1}hello{/g1}{f1} to her.", FULL_DICT],
    ["the {nd1}LORD{/nd1}'s {g1}servant{/g1}", FULL_DICT],
    ["a \\{not a token\\} b", {}],
  ])(
    "round-trips %p through the live editor",
    (text: string, dict: TagDictionary) => {
      const json = parseTranslationText(text, dict)
      const editor = makeEditor(json)
      try {
        const out = editor.getJSON() as PMDoc
        expect(serializeProseMirrorDoc(out)).toBe(text)
      } finally {
        editor.destroy()
      }
    },
  )

  test("phRef nodes render contenteditable=false (the chip is atomic)", () => {
    const json = parseTranslationText("{f1}", FULL_DICT)
    const editor = makeEditor(json)
    try {
      const html = editor.getHTML()
      expect(html).toContain('contenteditable="false"')
      expect(html).toContain('data-ph-ref="f1"')
    } finally {
      editor.destroy()
    }
  })

  test("phStyle marks render with data-ph-style attribute", () => {
    const json = parseTranslationText("{g1}hola{/g1}", FULL_DICT)
    const editor = makeEditor(json)
    try {
      const html = editor.getHTML()
      expect(html).toContain('data-ph-style="g1"')
      expect(html).toContain("hola")
    } finally {
      editor.destroy()
    }
  })
})
