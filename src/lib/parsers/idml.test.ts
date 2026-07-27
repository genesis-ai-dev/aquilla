import { describe, expect, it, vi } from "vitest"
import JSZip from "jszip"
import {
  parseIdml,
  validateIdmlTranslation,
  type IdmlFormatMetadataV2,
} from "@aquilla/idml-roundtrip"
import { extractIdmlStrings } from "./idml"

const MIME = "application/vnd.adobe.indesign-idml-package"
const STORY = "Stories/Story_u1.xml"
const IDPKG = "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"

async function makeIdmlParagraph(paragraphInner: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", MIME, { compression: "STORE" })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>`
      + `<Document xmlns:idPkg="${IDPKG}"><idPkg:Story src="${STORY}"/></Document>`,
  )
  zip.file(
    STORY,
    `<?xml version="1.0" encoding="UTF-8"?>`
      + `<idPkg:Story xmlns:idPkg="${IDPKG}"><Story Self="u1">`
      + `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body">`
      + paragraphInner
      + `</ParagraphStyleRange>`
      + `</Story></idPkg:Story>`,
  )
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })
}

function makeIdml(content: string): Promise<ArrayBuffer> {
  return makeIdmlParagraph(
    `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain">`
      + `<Content>${content}</Content>`
      + `</CharacterStyleRange>`,
  )
}

describe("IDML v2 parser adapter", () => {
  it("maps a real shared-engine unit to one protected Aquilla cell", async () => {
    const source = `${"Long source paragraph. ".repeat(30)}&amp; final`
    const buffer = await makeIdml(source)
    const parsed = await parseIdml(buffer)
    const strings = await extractIdmlStrings(
      buffer,
      async () => parsed,
    )

    expect(strings).toHaveLength(1)
    const [cell] = strings
    expect(cell.id).toBe(parsed.units[0].id)
    expect(cell.original.length).toBeGreaterThan(200)
    expect(cell.original).toContain("& final")
    expect(cell.paragraphStart).toBeUndefined()
    expect(cell.sourceLocator).toMatchObject({
      kind: "idml",
      memberPath: STORY,
      scope: "story-paragraph",
      part: 0,
      slotIndexes: [0],
    })
    expect(cell.metadata?.idml).toMatchObject({
      version: 2,
      slotCount: 1,
      editableSlotIndexes: [0],
    })
    expect(cell.originalHtml).toContain('data-idml-slot="0"')
    expect(cell.originalHtml).toContain("Long source paragraph")
    expect(cell.translatedHtml).toContain('data-idml-slot="0"')
    expect(cell.translatedHtml).not.toContain("Long source paragraph")
    expect(validateIdmlTranslation(
      cell.originalHtml!,
      cell.translatedHtml!,
      cell.metadata!.idml as IdmlFormatMetadataV2,
    ).valid).toBe(true)
  })

  it("initializes every mixed-style target slot empty with style identity intact", async () => {
    const buffer = await makeIdmlParagraph(
      `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain">`
        + `<Content>Regular </Content></CharacterStyleRange>`
        + `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Bold">`
        + `<Content>bold</Content></CharacterStyleRange>`,
    )
    const strings = await extractIdmlStrings(
      buffer,
      (bytes, profile) => parseIdml(bytes, profile),
    )
    const [cell] = strings

    expect(cell.metadata?.idml).toMatchObject({ slotCount: 2, editableSlotIndexes: [0, 1] })
    expect(cell.translated).toBe("")
    expect(cell.translatedHtml).toContain('data-idml-character-style="CharacterStyle/Plain"')
    expect(cell.translatedHtml).toContain('data-idml-character-style="CharacterStyle/Bold"')
    expect(cell.translatedHtml).not.toContain("Regular")
    expect(cell.translatedHtml).not.toContain("bold")
    expect(validateIdmlTranslation(
      cell.originalHtml!,
      cell.translatedHtml!,
      cell.metadata!.idml as IdmlFormatMetadataV2,
    ).valid).toBe(true)
  })

  it("forwards the selected semantic profile to the injectable executor", async () => {
    let receivedProfile: string | undefined
    const result = await extractIdmlStrings(
      new Uint8Array([1]).buffer,
      async (_bytes, profile) => {
        receivedProfile = profile
        return { units: [], manifest: {
          version: 2,
          sourceSha256: "a".repeat(64),
          profile,
          members: [],
          unitLocators: [],
          diagnostics: [],
        }, diagnostics: [] }
      },
      "biblica",
    )

    expect(result).toEqual([])
    expect(receivedProfile).toBe("biblica")
  })

  it("forwards cancellation and progress to the worker executor", async () => {
    const controller = new AbortController()
    const onProgress = vi.fn()
    let receivedOptions: Parameters<
      NonNullable<Parameters<typeof extractIdmlStrings>[1]>
    >[2]

    await extractIdmlStrings(
      new Uint8Array([1]).buffer,
      async (_bytes, profile, options) => {
        receivedOptions = options
        options?.onProgress?.({ phase: "parse", completed: 1, total: 1 })
        return {
          units: [],
          manifest: {
            version: 2,
            sourceSha256: "a".repeat(64),
            profile,
            members: [],
            unitLocators: [],
            diagnostics: [],
          },
          diagnostics: [],
        }
      },
      "generic",
      { signal: controller.signal, onProgress },
    )

    expect(receivedOptions?.signal).toBe(controller.signal)
    expect(onProgress).toHaveBeenCalledWith({ phase: "parse", completed: 1, total: 1 })
  })
})
