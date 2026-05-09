/**
 * Round-trip tests for the plain-text ↔ ProseMirror JSON conversion that
 * the new cell editor uses. The persistence shape is plain text with
 * placeholder tokens (`{g1}…{/g1}`, `{f1}`); the editor's working shape
 * is ProseMirror JSON with `phStyle` marks and `phRef` atomic nodes.
 *
 * See DATA_PERSISTENCE_PLAN.md §6.
 */

import { describe, expect, test } from "vitest"
import {
  parseTranslationText,
  serializeProseMirrorDoc,
  type TagDictionary,
} from "./placeholder-tokens"

const STYLE_DICT: TagDictionary = {
  g1: { kind: "style", origin: { format: "usfm", marker: "\\add" } },
  nd1: { kind: "style", origin: { format: "usfm", marker: "\\nd" } },
}
const REF_DICT: TagDictionary = {
  f1: { kind: "ph", ref: { cell_id: "demo:fn1" } },
}
const FULL_DICT: TagDictionary = { ...STYLE_DICT, ...REF_DICT }

describe("parseTranslationText", () => {
  test("plain text with no tokens becomes a single text node", () => {
    const doc = parseTranslationText("hello world", {})
    expect(doc).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "hello world" }],
        },
      ],
    })
  })

  test("empty string yields an empty paragraph", () => {
    const doc = parseTranslationText("", {})
    expect(doc).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [] }],
    })
  })

  test("paired token wraps text in a phStyle mark", () => {
    const doc = parseTranslationText("{g1}hello{/g1}", STYLE_DICT)
    expect(doc.content[0].content).toEqual([
      {
        type: "text",
        text: "hello",
        marks: [{ type: "phStyle", attrs: { tagId: "g1" } }],
      },
    ])
  })

  test("atomic token becomes a phRef node", () => {
    const doc = parseTranslationText("{f1}", REF_DICT)
    expect(doc.content[0].content).toEqual([
      { type: "phRef", attrs: { tagId: "f1" } },
    ])
  })

  test("mixed: leading text, paired, atomic, trailing text", () => {
    const doc = parseTranslationText(
      "He said {g1}hello{/g1}{f1} to her.",
      FULL_DICT,
    )
    expect(doc.content[0].content).toEqual([
      { type: "text", text: "He said " },
      {
        type: "text",
        text: "hello",
        marks: [{ type: "phStyle", attrs: { tagId: "g1" } }],
      },
      { type: "phRef", attrs: { tagId: "f1" } },
      { type: "text", text: " to her." },
    ])
  })

  test("two paired tokens with text between", () => {
    const doc = parseTranslationText(
      "the {nd1}LORD{/nd1}'s {g1}servant{/g1}",
      FULL_DICT,
    )
    expect(doc.content[0].content).toEqual([
      { type: "text", text: "the " },
      {
        type: "text",
        text: "LORD",
        marks: [{ type: "phStyle", attrs: { tagId: "nd1" } }],
      },
      { type: "text", text: "'s " },
      {
        type: "text",
        text: "servant",
        marks: [{ type: "phStyle", attrs: { tagId: "g1" } }],
      },
    ])
  })

  test("unmatched opening token without dictionary entry stays as text", () => {
    const doc = parseTranslationText("hello {z9} world", {})
    expect(doc.content[0].content).toEqual([
      { type: "text", text: "hello {z9} world" },
    ])
  })

  test("dictionary says ph but no closing tag is fine — atomic", () => {
    const doc = parseTranslationText("a {f1} b", REF_DICT)
    expect(doc.content[0].content).toEqual([
      { type: "text", text: "a " },
      { type: "phRef", attrs: { tagId: "f1" } },
      { type: "text", text: " b" },
    ])
  })

  test("dictionary says style but closing token is missing — falls back to literal text", () => {
    const doc = parseTranslationText("a {g1}stranded text", STYLE_DICT)
    // Without a closing tag, the parser leaves the bytes intact rather than
    // silently swallowing user content.
    expect(doc.content[0].content).toEqual([
      { type: "text", text: "a {g1}stranded text" },
    ])
  })

  test("escaped braces (`\\{`, `\\}`) survive as literal characters", () => {
    const doc = parseTranslationText("a \\{not a token\\} b", {})
    expect(doc.content[0].content).toEqual([
      { type: "text", text: "a {not a token} b" },
    ])
  })
})

describe("serializeProseMirrorDoc", () => {
  test("plain text", () => {
    const out = serializeProseMirrorDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    })
    expect(out).toBe("hello")
  })

  test("phRef node serializes as `{tagId}`", () => {
    const out = serializeProseMirrorDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "phRef", attrs: { tagId: "f1" } }],
        },
      ],
    })
    expect(out).toBe("{f1}")
  })

  test("text with phStyle mark serializes as `{tagId}…{/tagId}`", () => {
    const out = serializeProseMirrorDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "hello",
              marks: [{ type: "phStyle", attrs: { tagId: "g1" } }],
            },
          ],
        },
      ],
    })
    expect(out).toBe("{g1}hello{/g1}")
  })

  test("escapes literal braces in plain text so they don't reparse as tokens", () => {
    const out = serializeProseMirrorDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "a {not a token} b" }],
        },
      ],
    })
    expect(out).toBe("a \\{not a token\\} b")
  })

  test("empty paragraph serializes as empty string", () => {
    const out = serializeProseMirrorDoc({
      type: "doc",
      content: [{ type: "paragraph", content: [] }],
    })
    expect(out).toBe("")
  })
})

describe("round-trip parse → serialize", () => {
  const cases: ReadonlyArray<{ text: string; dict: TagDictionary }> = [
    { text: "hello world", dict: {} },
    { text: "{g1}hello{/g1}", dict: STYLE_DICT },
    { text: "{f1}", dict: REF_DICT },
    {
      text: "He said {g1}hello{/g1}{f1} to her.",
      dict: FULL_DICT,
    },
    {
      text: "the {nd1}LORD{/nd1}'s {g1}servant{/g1}",
      dict: FULL_DICT,
    },
    { text: "", dict: {} },
    { text: "a \\{not a token\\} b", dict: {} },
  ]

  for (const { text, dict } of cases) {
    test(`"${text}"`, () => {
      const parsed = parseTranslationText(text, dict)
      const serialized = serializeProseMirrorDoc(parsed)
      expect(serialized).toBe(text)
    })
  }
})
