import { describe, expect, it } from "vitest"

import {
  isDescriptionTrack,
  pickAudioTrack,
  selectableAudioTracks,
  type FilmAudioTrack,
} from "./film-audio-tracks"

const t = (id: number, name: string, lang: string | null, over: Partial<FilmAudioTrack> = {}): FilmAudioTrack =>
  ({ id, name, lang, ...over })

/**
 * The shape of episode 101's real master, taken from
 * `https://cdn.thechosen.media/videos/cmkaom6vg0000bca7bhwyicjj/master.m3u8`
 * on 2026-08-18: 65 renditions, alphabetical by name, **Amharic first**, and
 * only English flagged — with AUTOSELECT, not DEFAULT. Trimmed to the entries
 * the rules actually turn on; the ordering and flags are verbatim.
 */
const EP_101 = [
  t(0, "Amharic", "am-ET"),
  t(1, "Arabic (Classical)", "ar"),
  t(2, "Arabic (Egypt)", "ar-EG"),
  t(3, "Arabic (Sudanese)", "apd"),
  t(16, "English", "en", { autoselect: true }),
  t(17, "English Audio Descriptions", "en_ad"),
  t(40, "Portuguese (Brazil)", "pt-BR"),
  t(50, "Spanish (Latin America)", "es-419"),
  t(64, "Vietnamese", "vi-VN"),
]

describe("the narration track for blind viewers is not a language", () => {
  it("recognises 101's, which is tagged only by its name and an _ad suffix", () => {
    expect(isDescriptionTrack(t(17, "English Audio Descriptions", "en_ad"))).toBe(true)
  })

  it("recognises the accessibility tag where a manifest sets one", () => {
    expect(
      isDescriptionTrack(
        t(9, "Commentary", "en", { characteristics: "public.accessibility.describes-video" }),
      ),
    ).toBe(true)
  })

  it("recognises a hyphenated suffix too", () => {
    expect(isDescriptionTrack(t(9, "Deutsch", "de-ad"))).toBe(true)
  })

  it("leaves ordinary languages alone", () => {
    expect(isDescriptionTrack(t(16, "English", "en"))).toBe(false)
    expect(isDescriptionTrack(t(3, "Arabic (Sudanese)", "apd"))).toBe(false)
  })

  it("is kept out of the list people choose from", () => {
    const names = selectableAudioTracks(EP_101).map((x) => x.name)
    expect(names).not.toContain("English Audio Descriptions")
    expect(names).toContain("English")
    expect(names).toHaveLength(EP_101.length - 1)
  })
})

describe("choosing what the film speaks", () => {
  it("plays English when nobody has asked for anything", () => {
    // The bug this exists for: with no preference and no DEFAULT in the
    // manifest, the player took the top of an alphabetical list — Amharic.
    expect(pickAudioTrack(EP_101, null)?.name).toBe("English")
  })

  it("plays what was asked for", () => {
    expect(pickAudioTrack(EP_101, "pt-BR")?.name).toBe("Portuguese (Brazil)")
  })

  it("matches a language across its regions", () => {
    // Asked for Spanish; the film only carries Latin American Spanish.
    expect(pickAudioTrack(EP_101, "es")?.name).toBe("Spanish (Latin America)")
    // …and the other way round.
    expect(pickAudioTrack(EP_101, "es-ES")?.name).toBe("Spanish (Latin America)")
  })

  it("prefers the exact region when the film has several", () => {
    const arabic = pickAudioTrack(EP_101, "ar-EG")
    expect(arabic?.name).toBe("Arabic (Egypt)")
  })

  it("NEVER answers a request for English with the descriptions track", () => {
    // "en_ad" would match "en" if the underscore were treated as a region.
    expect(pickAudioTrack(EP_101, "en")?.name).toBe("English")
    expect(pickAudioTrack([t(17, "English Audio Descriptions", "en_ad")], "en")).toBeNull()
  })

  it("falls back to English rather than nothing when the film lacks the language", () => {
    // A preference set on one episode must not break the next one.
    expect(pickAudioTrack(EP_101, "cy-GB")?.name).toBe("English")
  })

  it("takes the manifest's own opinion where there is no English at all", () => {
    const noEnglish = [t(0, "Amharic", "am-ET"), t(1, "Hindi", "hi-IN", { default: true })]
    expect(pickAudioTrack(noEnglish, "cy-GB")?.name).toBe("Hindi")
  })

  it("takes an autoselect hint before an arbitrary answer", () => {
    const noEnglish = [t(0, "Amharic", "am-ET"), t(1, "Hindi", "hi-IN", { autoselect: true })]
    expect(pickAudioTrack(noEnglish, null)?.name).toBe("Hindi")
  })

  it("takes the first rendition when the manifest says nothing at all", () => {
    const plain = [t(0, "Amharic", "am-ET"), t(1, "Hindi", "hi-IN")]
    expect(pickAudioTrack(plain, null)?.name).toBe("Amharic")
  })

  it("has no answer for a film with no usable renditions", () => {
    expect(pickAudioTrack([], "en")).toBeNull()
  })
})
