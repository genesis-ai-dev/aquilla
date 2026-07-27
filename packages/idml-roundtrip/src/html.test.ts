import { describe, expect, it } from "vitest"

import {
  computeIdmlAnchorSequenceHash,
  renderIdmlUnitHtml,
  sha256Hex,
  validateIdmlTranslation,
} from "./html.js"
import type {
  IdmlFormatMetadataV2,
  IdmlProtectedToken,
  IdmlTextSlot,
  IdmlTranslationUnit,
} from "./types.js"

function makeUnit(
  slots: readonly IdmlTextSlot[],
  protectedTokens: readonly IdmlProtectedToken[] = [],
): IdmlTranslationUnit {
  const metadata: IdmlFormatMetadataV2 = {
    version: 2,
    slotCount: slots.length,
    editableSlotIndexes: slots.filter((slot) => slot.editable).map((slot) => slot.index),
    protectedTokenCount: protectedTokens.length,
    anchorSequenceHash: computeIdmlAnchorSequenceHash(slots, protectedTokens),
  }
  return {
    id: "unit-1",
    order: 0,
    sourceText: slots.map((slot) => slot.text).join(""),
    sourceHtml: "",
    locator: {
      kind: "idml",
      memberPath: "Stories/Story_u1.xml",
      storyId: "u1",
      elementPath: "/Story/ParagraphStyleRange[1]",
      elementId: "p1",
      scope: "story-paragraph",
      part: 0,
      slotIndexes: slots.map((slot) => slot.index),
      sourceBlockHash: "a".repeat(64),
    },
    metadata,
    slots,
    protectedTokens,
    diagnostics: [],
  }
}

const mixedSlots: readonly IdmlTextSlot[] = [
  {
    index: 0,
    text: "Bold & <β>",
    characterStyleId: "CharacterStyle/Bold\"<&",
    editable: true,
  },
  {
    index: 1,
    text: "",
    characterStyleId: "CharacterStyle/Plain",
    editable: true,
  },
]

const mixedTokens: readonly IdmlProtectedToken[] = [
  { index: 0, kind: "br", xmlName: "Br", position: 1 },
  { index: 1, kind: "variable", xmlName: "TextVariableInstance", position: 2 },
]

describe("renderIdmlUnitHtml", () => {
  it("renders deterministic protected slot and token anchors with escaped data", () => {
    const html = renderIdmlUnitHtml(makeUnit(mixedSlots, mixedTokens))

    expect(html).toBe(
      '<p data-idml-version="2">'
      + '<span data-idml-slot="0" data-idml-character-style="CharacterStyle/Bold&quot;&lt;&amp;" data-idml-protected="slot">Bold &amp; &lt;β&gt;</span>'
      + '<br data-idml-token="0" data-idml-token-kind="br" data-idml-protected="token" contenteditable="false">'
      + '<span data-idml-slot="1" data-idml-character-style="CharacterStyle/Plain" data-idml-protected="slot"></span>'
      + '<span data-idml-token="1" data-idml-token-kind="variable" data-idml-protected="token" contenteditable="false"></span>'
      + "</p>",
    )
  })

  it("renders user line breaks inside their original slot", () => {
    const unit = makeUnit([{
      index: 0,
      text: "one\n二\nतीन",
      characterStyleId: "CharacterStyle/Body",
      editable: true,
    }])

    expect(renderIdmlUnitHtml(unit)).toContain("one<br>二<br>तीन")
  })

  it("locks non-editable slots", () => {
    const unit = makeUnit([{
      index: 0,
      text: "computed",
      characterStyleId: "CharacterStyle/Variable",
      editable: false,
    }])

    expect(renderIdmlUnitHtml(unit)).toContain(
      'data-idml-protected="slot" contenteditable="false">computed</span>',
    )
  })

  it("rejects inconsistent unit indexes instead of emitting ambiguous anchors", () => {
    const unit = makeUnit([{
      index: 1,
      text: "wrong",
      characterStyleId: "CharacterStyle/Body",
      editable: true,
    }])

    expect(() => renderIdmlUnitHtml(unit)).toThrow("unique and contiguous")
  })

  it("rejects protected token indexes that do not follow document order", () => {
    const tokens: readonly IdmlProtectedToken[] = [
      { index: 0, kind: "variable", xmlName: "TextVariableInstance", position: 2 },
      { index: 1, kind: "br", xmlName: "Br", position: 1 },
    ]

    expect(() => renderIdmlUnitHtml(makeUnit(mixedSlots, tokens))).toThrow("document order")
  })
})

describe("validateIdmlTranslation", () => {
  it("returns decoded slot text and allows empty text, entities, and bare br variants", () => {
    const unit = makeUnit(mixedSlots, mixedTokens)
    const sourceHtml = renderIdmlUnitHtml(unit)
    const targetHtml = sourceHtml
      .replace("Bold &amp; &lt;β&gt;", "Fish &amp; Chips<br/>第二行<br />तीन")

    expect(validateIdmlTranslation(sourceHtml, targetHtml, unit.metadata)).toEqual({
      valid: true,
      diagnostics: [],
      slots: ["Fish & Chips\n第二行\nतीन", ""],
    })
  })

  it("allows an editable slot to become empty", () => {
    const unit = makeUnit(mixedSlots)
    const sourceHtml = renderIdmlUnitHtml(unit)
    const targetHtml = sourceHtml.replace("Bold &amp; &lt;β&gt;", "")

    expect(validateIdmlTranslation(sourceHtml, targetHtml, unit.metadata)).toMatchObject({
      valid: true,
      slots: ["", ""],
    })
  })

  it("accepts DOM-serialized non-breaking spaces without changing the text", () => {
    const unit = makeUnit([{
      index: 0,
      text: "A\u00a0B",
      characterStyleId: "CharacterStyle/Body",
      editable: true,
    }])
    const sourceHtml = renderIdmlUnitHtml(unit)
    const targetHtml = sourceHtml.replace("A\u00a0B", "A&nbsp;B")

    expect(validateIdmlTranslation(sourceHtml, targetHtml, unit.metadata)).toEqual({
      valid: true,
      diagnostics: [],
      slots: ["A\u00a0B"],
    })
  })

  it.each([
    ["spaced opening tag", (html: string) => html.replace("<span", "< span")],
    ["spaced closing tag", (html: string) => html.replace("</span>", "</ span>")],
    ["spaced line-break tag", (html: string) => html.replace("<br ", "< br ")],
  ])("rejects browser-invalid %s syntax", (_label, mutate) => {
    const unit = makeUnit(mixedSlots, mixedTokens)
    const sourceHtml = renderIdmlUnitHtml(unit)
    const result = validateIdmlTranslation(sourceHtml, mutate(sourceHtml), unit.metadata)

    expect(result.valid).toBe(false)
    expect(result.diagnostics[0]?.code).toBe("ANCHOR_INVALID")
  })

  it.each([
    ["literal C0 control", "\u0001"],
    ["numeric C0 entity", "&#1;"],
    ["noncharacter U+FFFE", "\ufffe"],
    ["noncharacter U+FFFF", "\uffff"],
  ])("rejects XML-forbidden slot text: %s", (_label, replacement) => {
    const unit = makeUnit(mixedSlots)
    const sourceHtml = renderIdmlUnitHtml(unit)
    const targetHtml = sourceHtml.replace("Bold &amp; &lt;β&gt;", replacement)
    const result = validateIdmlTranslation(sourceHtml, targetHtml, unit.metadata)

    expect(result.valid).toBe(false)
    expect(result.diagnostics[0]?.code).toBe("ANCHOR_INVALID")
  })

  it.each([
    null,
    { version: 2 },
    { version: 2, slotCount: 1, editableSlotIndexes: undefined, protectedTokenCount: 0, anchorSequenceHash: "a".repeat(64) },
    { version: 2, slotCount: 1, editableSlotIndexes: [], protectedTokenCount: 0, anchorSequenceHash: "not-a-hash" },
  ])("fails closed for malformed runtime metadata %#", (metadata) => {
    const unit = makeUnit(mixedSlots)
    const sourceHtml = renderIdmlUnitHtml(unit)

    expect(() => validateIdmlTranslation(
      sourceHtml,
      sourceHtml,
      metadata as unknown as IdmlFormatMetadataV2,
    )).not.toThrow()
    const result = validateIdmlTranslation(
      sourceHtml,
      sourceHtml,
      metadata as unknown as IdmlFormatMetadataV2,
    )
    expect(result.valid).toBe(false)
    expect(result.diagnostics[0]?.code).toBe("ANCHOR_INVALID")
  })

  it.each([
    ["missing", (html: string) => html.replace(/<span data-idml-slot="1"[\s\S]*?<\/span>/, ""), "ANCHOR_MISSING"],
    ["duplicated", (html: string) => html.replace("</p>", `${html.match(/<span data-idml-slot="1"[\s\S]*?<\/span>/)?.[0] ?? ""}</p>`), "ANCHOR_DUPLICATED"],
    ["renumbered", (html: string) => html.replace('data-idml-slot="1"', 'data-idml-slot="9"'), "ANCHOR_INVALID"],
    ["changed style", (html: string) => html.replace("CharacterStyle/Plain", "CharacterStyle/Other"), "ANCHOR_INVALID"],
    ["token kind tampering", (html: string) => html.replace('data-idml-token-kind="variable"', 'data-idml-token-kind="tab"'), "ANCHOR_INVALID"],
    ["token index tampering", (html: string) => html.replace('data-idml-token="1"', 'data-idml-token="7"'), "ANCHOR_INVALID"],
    ["unknown inner markup", (html: string) => html.replace("Bold &amp;", "<strong>Bold</strong> &amp;"), "ANCHOR_INVALID"],
    ["slot attribute tampering", (html: string) => html.replace('data-idml-protected="slot"', 'data-idml-protected="other"'), "ANCHOR_INVALID"],
  ])("rejects %s", (_label, mutate, expectedCode) => {
    const unit = makeUnit(mixedSlots, mixedTokens)
    const sourceHtml = renderIdmlUnitHtml(unit)
    const result = validateIdmlTranslation(sourceHtml, mutate(sourceHtml), unit.metadata)

    expect(result.valid).toBe(false)
    expect(result.slots).toEqual([])
    expect(result.diagnostics[0]?.code).toBe(expectedCode)
  })

  it("rejects reordered anchors even when their identities and counts are unchanged", () => {
    const unit = makeUnit(mixedSlots)
    const sourceHtml = renderIdmlUnitHtml(unit)
    const first = sourceHtml.match(/<span data-idml-slot="0"[\s\S]*?<\/span>/)?.[0] ?? ""
    const second = sourceHtml.match(/<span data-idml-slot="1"[\s\S]*?<\/span>/)?.[0] ?? ""
    const targetHtml = `<p data-idml-version="2">${second}${first}</p>`

    const result = validateIdmlTranslation(sourceHtml, targetHtml, unit.metadata)
    expect(result.valid).toBe(false)
    expect(result.diagnostics[0]?.code).toBe("ANCHOR_REORDERED")
  })

  it("rejects reordered protected tokens", () => {
    const unit = makeUnit(mixedSlots, mixedTokens)
    const sourceHtml = renderIdmlUnitHtml(unit)
    const lineBreakToken = sourceHtml.match(/<br data-idml-token="0"[^>]*>/)?.[0] ?? ""
    const variableToken = sourceHtml.match(/<span data-idml-token="1"[^>]*><\/span>/)?.[0] ?? ""
    const targetHtml = sourceHtml
      .replace(lineBreakToken, "__IDML_TOKEN__")
      .replace(variableToken, lineBreakToken)
      .replace("__IDML_TOKEN__", variableToken)

    const result = validateIdmlTranslation(sourceHtml, targetHtml, unit.metadata)
    expect(result.valid).toBe(false)
    expect(result.diagnostics[0]?.code).toBe("ANCHOR_REORDERED")
  })

  it("rejects duplicated protected tokens", () => {
    const unit = makeUnit(mixedSlots, mixedTokens)
    const sourceHtml = renderIdmlUnitHtml(unit)
    const token = sourceHtml.match(/<span data-idml-token="1"[^>]*><\/span>/)?.[0] ?? ""
    const targetHtml = sourceHtml.replace(token, `${token}${token}`)

    const result = validateIdmlTranslation(sourceHtml, targetHtml, unit.metadata)
    expect(result.valid).toBe(false)
    expect(result.diagnostics[0]?.code).toBe("ANCHOR_DUPLICATED")
  })

  it("rejects changes to locked slot text", () => {
    const unit = makeUnit([{
      index: 0,
      text: "automatic page number",
      characterStyleId: "CharacterStyle/Variable",
      editable: false,
    }])
    const sourceHtml = renderIdmlUnitHtml(unit)
    const targetHtml = sourceHtml.replace("automatic page number", "translated")

    const result = validateIdmlTranslation(sourceHtml, targetHtml, unit.metadata)
    expect(result.valid).toBe(false)
    expect(result.diagnostics[0]?.code).toBe("ANCHOR_INVALID")
  })

  it("rejects a metadata hash that does not describe the source anchor sequence", () => {
    const unit = makeUnit(mixedSlots)
    const sourceHtml = renderIdmlUnitHtml(unit)
    const metadata = { ...unit.metadata, anchorSequenceHash: "0".repeat(64) }

    const result = validateIdmlTranslation(sourceHtml, sourceHtml, metadata)
    expect(result.valid).toBe(false)
    expect(result.diagnostics[0]?.code).toBe("ANCHOR_INVALID")
  })

  it("rejects unsupported future metadata and HTML major versions", () => {
    const unit = makeUnit(mixedSlots)
    const sourceHtml = renderIdmlUnitHtml(unit)
    const futureMetadata = { ...unit.metadata, version: 3 } as unknown as IdmlFormatMetadataV2

    expect(validateIdmlTranslation(sourceHtml, sourceHtml, futureMetadata).diagnostics[0]?.code)
      .toBe("UNSUPPORTED_SCHEMA_VERSION")
    expect(
      validateIdmlTranslation(
        sourceHtml,
        sourceHtml.replace('data-idml-version="2"', 'data-idml-version="3"'),
        unit.metadata,
      ).diagnostics[0]?.code,
    ).toBe("UNSUPPORTED_SCHEMA_VERSION")
  })
})

describe("sha256Hex", () => {
  it("matches the standard SHA-256 test vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })

  it("matches the multi-block SHA-256 test vector", () => {
    expect(sha256Hex(
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    )).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
  })
})
