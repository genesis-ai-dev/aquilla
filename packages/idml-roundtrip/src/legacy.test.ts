import { describe, expect, it } from "vitest"

import { sha256Hex, validateIdmlTranslation } from "./html.js"
import { upgradeLegacyIdmlMetadata } from "./legacy.js"

const sourceBlockXml = '<ParagraphStyleRange Self="p1"><Content>A &amp; Ω</Content><Br/><Content></Content></ParagraphStyleRange>'

const sourceHtml = [
  '<p class="indesign-paragraph" data-paragraph-style="ParagraphStyle/Body" data-story-id="u1" data-segment-count="2">',
  '<span class="idml-segment" data-segment-index="0" data-character-style="CharacterStyle/Bold">A &amp; Ω</span>',
  '<br class="idml-eoc" data-eoc="1" />',
  '<span class="idml-segment" data-segment-index="1" data-character-style="CharacterStyle/Plain"></span>',
  "</p>",
].join("")

function legacyInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    valueHtml: sourceHtml,
    metadata: {
      storyId: "u1",
      paragraphId: "p1",
      data: {
        idmlStructure: {
          storyId: "u1",
          paragraphId: "p1",
          contentSegments: ["A & Ω", ""],
          contentSegmentCount: 2,
          contentSegmentBreakBefore: [false, true],
          sourceBlockXml,
          paragraphStyleRange: {
            appliedParagraphStyle: "ParagraphStyle/Body",
          },
        },
        relationships: {
          parentStory: "u1",
          storyOrder: 0,
          paragraphOrder: 0,
        },
      },
    },
    ...overrides,
  }
}

describe("upgradeLegacyIdmlMetadata", () => {
  it("upgrades an unambiguous Codex idmlStructure and segment-index HTML", () => {
    const result = upgradeLegacyIdmlMetadata(legacyInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.locator).toEqual({
      kind: "idml",
      memberPath: "Stories/Story_u1.xml",
      storyId: "u1",
      elementPath: '/Story/ParagraphStyleRange[@Self="p1"]',
      elementId: "p1",
      scope: "story-paragraph",
      part: 0,
      slotIndexes: [0, 1],
      sourceBlockHash: sha256Hex(sourceBlockXml),
    })
    expect(result.metadata).toMatchObject({
      version: 2,
      slotCount: 2,
      editableSlotIndexes: [0, 1],
      protectedTokenCount: 1,
    })
    expect(result.sourceHtml).toBe(
      '<p data-idml-version="2">'
      + '<span data-idml-slot="0" data-idml-character-style="CharacterStyle/Bold" data-idml-protected="slot">A &amp; Ω</span>'
      + '<br data-idml-token="0" data-idml-token-kind="br" data-idml-protected="token" contenteditable="false">'
      + '<span data-idml-slot="1" data-idml-character-style="CharacterStyle/Plain" data-idml-protected="slot"></span>'
      + "</p>",
    )
    expect(
      validateIdmlTranslation(result.sourceHtml, result.sourceHtml, result.metadata),
    ).toMatchObject({ valid: true, slots: ["A & Ω", ""] })
  })

  it("upgrades target segment HTML without redistributing or trimming text", () => {
    const targetHtml = sourceHtml
      .replace("A &amp; Ω", "魚 &amp; चाय<br>line 2")
    const result = upgradeLegacyIdmlMetadata(legacyInput({ targetHtml }))

    expect(result.ok).toBe(true)
    if (!result.ok || !result.targetHtml) return
    expect(
      validateIdmlTranslation(result.sourceHtml, result.targetHtml, result.metadata),
    ).toMatchObject({
      valid: true,
      slots: ["魚 & चाय\nline 2", ""],
    })
  })

  it("accepts a supplied exact source-block hash instead of requiring XML in metadata", () => {
    const input = legacyInput()
    const metadata = input.metadata as {
      data: { idmlStructure: Record<string, unknown> }
    }
    delete metadata.data.idmlStructure.sourceBlockXml
    metadata.data.idmlStructure.sourceBlockHash = sha256Hex(sourceBlockXml)

    const result = upgradeLegacyIdmlMetadata(input)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.locator.sourceBlockHash).toBe(sha256Hex(sourceBlockXml))
  })

  it("supports an explicit member path plus stable paragraph order", () => {
    const input = legacyInput()
    const metadata = input.metadata as {
      storyId?: string
      paragraphId?: string
      data: {
        idmlStructure: Record<string, unknown>
        relationships: Record<string, unknown>
      }
    }
    delete metadata.storyId
    delete metadata.paragraphId
    delete metadata.data.idmlStructure.storyId
    delete metadata.data.idmlStructure.paragraphId
    delete metadata.data.relationships.parentStory
    input.valueHtml = sourceHtml.replace(' data-story-id="u1"', "")
    metadata.data.idmlStructure.memberPath = "Stories/Story_custom.xml"

    const result = upgradeLegacyIdmlMetadata(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.locator).toMatchObject({
      memberPath: "Stories/Story_custom.xml",
      elementPath: "/Story/ParagraphStyleRange[1]",
    })
    expect(result.locator.storyId).toBeUndefined()
  })

  it("passes through a valid v2 contract after validating it", () => {
    const upgraded = upgradeLegacyIdmlMetadata(legacyInput())
    expect(upgraded.ok).toBe(true)
    if (!upgraded.ok) return

    expect(upgradeLegacyIdmlMetadata(upgraded)).toEqual(upgraded)
  })

  it.each([
    [
      "missing exact source block evidence",
      () => {
        const input = legacyInput()
        const metadata = input.metadata as {
          data: { idmlStructure: Record<string, unknown> }
        }
        delete metadata.data.idmlStructure.sourceBlockXml
        return input
      },
      "SOURCE_HASH_MISMATCH",
    ],
    [
      "segment count mismatch",
      () => {
        const input = legacyInput()
        const metadata = input.metadata as {
          data: { idmlStructure: Record<string, unknown> }
        }
        metadata.data.idmlStructure.contentSegmentCount = 3
        return input
      },
      "ANCHOR_INVALID",
    ],
    [
      "missing line-break metadata",
      () => {
        const input = legacyInput()
        const metadata = input.metadata as {
          data: { idmlStructure: Record<string, unknown> }
        }
        delete metadata.data.idmlStructure.contentSegmentBreakBefore
        return input
      },
      "ANCHOR_INVALID",
    ],
    [
      "missing locator identity and order",
      () => {
        const input = legacyInput()
        const metadata = input.metadata as {
          storyId?: string
          paragraphId?: string
          data: {
            idmlStructure: Record<string, unknown>
            relationships: Record<string, unknown>
          }
        }
        delete metadata.storyId
        delete metadata.paragraphId
        delete metadata.data.idmlStructure.storyId
        delete metadata.data.idmlStructure.paragraphId
        delete metadata.data.relationships.parentStory
        delete metadata.data.relationships.paragraphOrder
        input.valueHtml = sourceHtml.replace(' data-story-id="u1"', "")
        return input
      },
      "LOCATOR_MISSING",
    ],
    [
      "omitted segment anchor",
      () => legacyInput({
        valueHtml: sourceHtml.replace(
          /<span class="idml-segment" data-segment-index="1"[\s\S]*?<\/span>/,
          "",
        ),
      }),
      "ANCHOR_INVALID",
    ],
    [
      "reordered segment anchors",
      () => {
        const first = sourceHtml.match(/<span class="idml-segment" data-segment-index="0"[\s\S]*?<\/span>/)?.[0] ?? ""
        const second = sourceHtml.match(/<span class="idml-segment" data-segment-index="1"[\s\S]*?<\/span>/)?.[0] ?? ""
        return legacyInput({
          valueHtml: `<p class="indesign-paragraph" data-story-id="u1" data-segment-count="2">${second}${first}</p>`,
        })
      },
      "ANCHOR_INVALID",
    ],
    [
      "target style tampering",
      () => legacyInput({
        targetHtml: sourceHtml.replace("CharacterStyle/Plain", "CharacterStyle/Other"),
      }),
      "ANCHOR_INVALID",
    ],
    [
      "target paragraph style tampering",
      () => legacyInput({
        targetHtml: sourceHtml.replace("ParagraphStyle/Body", "ParagraphStyle/Other"),
      }),
      "ANCHOR_INVALID",
    ],
    [
      "unknown legacy HTML markup",
      () => legacyInput({ valueHtml: sourceHtml.replace("A &amp; Ω", "<strong>A &amp; Ω</strong>") }),
      "ANCHOR_INVALID",
    ],
  ])("rejects ambiguous legacy data: %s", (_label, makeInput, expectedCode) => {
    const result = upgradeLegacyIdmlMetadata(makeInput())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe(expectedCode)
  })

  it("rejects future metadata majors instead of guessing", () => {
    const result = upgradeLegacyIdmlMetadata({
      locator: { kind: "idml" },
      metadata: {
        version: 3,
        slotCount: 1,
      },
      sourceHtml: '<p data-idml-version="3"></p>',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_SCHEMA_VERSION")
  })

  it("recognizes serialized future major versions", () => {
    const result = upgradeLegacyIdmlMetadata({
      locator: { kind: "idml" },
      metadata: {
        version: "3",
        slotCount: 1,
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_SCHEMA_VERSION")
  })

  it("rejects a hash that disagrees with provided exact XML", () => {
    const input = legacyInput()
    const metadata = input.metadata as {
      data: { idmlStructure: Record<string, unknown> }
    }
    metadata.data.idmlStructure.sourceBlockHash = "0".repeat(64)

    const result = upgradeLegacyIdmlMetadata(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("SOURCE_HASH_MISMATCH")
  })
})
