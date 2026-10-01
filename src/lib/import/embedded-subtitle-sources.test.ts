import { describe, expect, it } from "vitest"
import { prepareEmbeddedSubtitleSources } from "./embedded-subtitle-sources"
import { embeddedSubtitleFixture } from "../parsers/__fixtures__/embedded-subtitles"

describe("prepareEmbeddedSubtitleSources", () => {
  it("converts ISO BMFF embedded subtitles to editable media-source representation", () => {
    const buffer = embeddedSubtitleFixture()
    const options = prepareEmbeddedSubtitleSources(buffer)

    expect(options).toHaveLength(1)
    expect(options[0]).toEqual(
      expect.objectContaining({
        id: "embedded-track-1",
        source: expect.objectContaining({
          cues: [
            expect.objectContaining({
              type: "cue",
              original: "First phrase",
              start: 0,
              end: 1,
              translated: "",
            }),
            expect.objectContaining({
              type: "cue",
              original: "Second phrase",
              start: 1,
              end: 3,
              translated: "",
            }),
          ],
        }),
      }),
    )
  })

  it("retains one-microsecond headings for explicit timing correction", () => {
    const buffer = embeddedSubtitleFixture(["Heading", "Speech"], {
      timescale: 1_000_000,
      durations: [1, 2_000_000],
    })
    const cues = prepareEmbeddedSubtitleSources(buffer)[0].source.cues
    expect(cues).toHaveLength(2)
    expect(cues[0]).toMatchObject({ original: "Heading", start: 0, end: 0.000001 })
    expect(cues[1]).toMatchObject({ original: "Speech", start: 0.000001, end: 2.000001 })
    expect(Math.round(cues[0].end! * 1000)).toBe(Math.round(cues[0].start! * 1000))
  })

  it("keeps the edited movie timeline when preparing caption sources", () => {
    const sources = prepareEmbeddedSubtitleSources(
      embeddedSubtitleFixture(undefined, { edit: true }),
    )
    expect(sources[0].source.cues.map(cue => [cue.start, cue.end]))
      .toEqual([[0.5, 1.5], [1.5, 3.5]])
  })

  it("offers no text source when the media has no readable subtitle track", () => {
    expect(prepareEmbeddedSubtitleSources(new ArrayBuffer(0))).toEqual([])
  })
})
