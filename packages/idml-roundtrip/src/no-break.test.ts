import { describe, expect, it } from "vitest"
import { releaseOversizedNoBreak } from "./no-break.js"

const sentence =
  ". Davi era senhor e rei. Mas o senhor e rei aqui não era Davi. Nenhum rei de Israel serviu como sacerdote."

describe("releaseOversizedNoBreak", () => {
  it("releases a no-break run that grew into a sentence and keeps short locks", () => {
    const xml = [
      `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/k_xt" NoBreak="true"><Content>Melquisedeque</Content></CharacterStyleRange>`,
      `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]" HorizontalScale="90" NoBreak="true"><Content>${sentence}</Content></CharacterStyleRange>`,
      `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]" NoBreak="true"><Content>os d</Content></CharacterStyleRange>`,
    ].join("")

    const released = releaseOversizedNoBreak(xml)

    expect(released).toContain(
      `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/k_xt" NoBreak="true"><Content>Melquisedeque</Content></CharacterStyleRange>`,
    )
    expect(released).toContain(
      `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]" HorizontalScale="90"><Content>${sentence}</Content></CharacterStyleRange>`,
    )
    expect(released).toContain(`NoBreak="true"><Content>os d</Content>`)
    expect(released).not.toContain(`NoBreak="true"><Content>${sentence}</Content>`)
  })

  it("measures a nested range on its own", () => {
    const xml =
      `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/notes%3af_call" NoBreak="true">` +
      `<Content> </Content>` +
      `<Footnote><ParagraphStyleRange><CharacterStyleRange NoBreak="true">` +
      `<Content>${sentence}</Content>` +
      `</CharacterStyleRange></ParagraphStyleRange></Footnote>` +
      `</CharacterStyleRange>`

    const released = releaseOversizedNoBreak(xml)

    expect(released).toContain(
      `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/notes%3af_call" NoBreak="true">`,
    )
    expect(released).toContain(
      `<CharacterStyleRange><Content>${sentence}</Content></CharacterStyleRange>`,
    )
  })
})