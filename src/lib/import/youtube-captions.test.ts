import { afterEach, describe, expect, it, vi } from "vitest"
import { prepareYouTubeCaptionImport } from "./youtube-captions"
import { normalizeTranslatableStrings } from "./normalized-manifest"
import { buildBulkCellsWithSpeakers } from "../import"

const srt = "2\n00:00:03,000 --> 00:00:04,500\nSecond phrase\n\n1\n00:00:01,250 --> 00:00:02,000\nFirst phrase\n"
const vtt = "WEBVTT\n\n00:03.000 --> 00:04.500\nSecond phrase\n\n00:01.250 --> 00:02.000\nFirst phrase\n"
const sbv = "0:00:03.000,0:00:04.500\nSecond phrase\n\n0:00:01.250,0:00:02.000\nFirst phrase\n"

afterEach(() => vi.unstubAllGlobals())

describe("YouTube captions import preparation", () => {
  it.each([["srt", srt], ["vtt", vtt], ["sbv", sbv]])(
    "passes original %s captions through real normalization and cell creation",
    (format, captionText) => {
      const network = vi.fn()
      vi.stubGlobal("fetch", network)
      const result = prepareYouTubeCaptionImport({
        url: "https://youtu.be/dQw4w9WgXcQ?t=12",
        captionName: `My captions.${format}`, captionText,
      })
      expect(result.name).toBe("My captions")
      expect(result.videoUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
      expect(result.rawSource).toBe(captionText)
      expect(result.rawSourceFormat).toBe(format)
      expect(result.strings.map(cue => [cue.original, cue.start, cue.end])).toEqual([
        ["First phrase", 1.25, 2], ["Second phrase", 3, 4.5],
      ])
      const normalizedFile = normalizeTranslatableStrings(result.strings, {
        fileName: result.name, fileType: result.rawSourceFormat,
        profileId: `builtin:${format}`, profileVersion: "1",
      })
      const { cells } = buildBulkCellsWithSpeakers(result.strings, { normalizedFile })
      expect(cells.map(cell => [cell.value, cell.startMs, cell.endMs])).toEqual([
        ["First phrase", 1250, 2000], ["Second phrase", 3000, 4500],
      ])
      expect(cells[1].anchorCellId).toBe(cells[0].cellId)
      expect(network).not.toHaveBeenCalled()
    },
  )

  it("keeps WebVTT notes as source metadata rather than extra spoken captions", () => {
    const captionText = vtt.replace("WEBVTT\n\n", "WEBVTT\n\nNOTE review marker\n00:05.000 --> 00:06.000\nEditor note\n\n")
    const result = prepareYouTubeCaptionImport({
      url: "https://youtu.be/dQw4w9WgXcQ", captionName: "Captions.vtt", captionText,
    })
    expect(result.strings.map(cue => cue.original)).toEqual(["First phrase", "Second phrase"])
    expect(result.rawSource).toBe(captionText)
  })

  it("keeps uploaded source bytes unchanged", () => {
    const rawBytes = new TextEncoder().encode("\uFEFF" + srt).buffer
    const result = prepareYouTubeCaptionImport({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      captionName: "Captions.SRT", captionText: srt, rawBytes,
    })
    expect(result.rawBytes).toBe(rawBytes)
    expect(result.rawSource).toBeUndefined()
    expect(result.rawSourceFormat).toBe("srt")
  })

  // Import map X-D-silent-cue-drop / M-caption-rules: a cue whose time can't
  // be read is left out and counted, as Upload files does with the same file.
  it.each([["srt", srt], ["vtt", vtt], ["sbv", sbv]])(
    "does not silently discard a malformed cue from %s: it counts it", (format, valid) => {
      const broken = format === "sbv"
        ? "0:00:05,0:00:06\nMissing fractions\n"
        : "00:00:05 --> 00:00:06\nMissing fractions\n"
      const result = prepareYouTubeCaptionImport({
        url: "https://youtu.be/dQw4w9WgXcQ", captionName: `Captions.${format}`,
        captionText: valid + "\n" + broken,
      })
      expect(result.droppedCues).toBe(1)
      expect(result.strings.map(cue => cue.original)).not.toContain("Missing fractions")
    },
  )

  it("counts a cue whose time has a typo in it, which used to vanish without a word", () => {
    const captionText = vtt + "\n00:00:xx.000 --> 00:00:12.000\nThe typo cue\n"
    const result = prepareYouTubeCaptionImport({
      url: "https://youtu.be/dQw4w9WgXcQ", captionName: "Captions.vtt", captionText,
    })
    expect(result.droppedCues).toBe(1)
  })

  it("counts nothing when every cue is read", () => {
    expect(prepareYouTubeCaptionImport({
      url: "https://youtu.be/dQw4w9WgXcQ", captionName: "Captions.vtt", captionText: vtt,
    }).droppedCues).toBe(0)
  })

  it.each([
    { url: "https://example.com/video", captionName: "captions.srt", captionText: srt },
    { url: "https://youtu.be/dQw4w9WgXcQ", captionName: "script.txt", captionText: srt },
    { url: "https://youtu.be/dQw4w9WgXcQ", captionName: "captions.srt", captionText: "No timed captions" },
    { url: "https://youtu.be/dQw4w9WgXcQ", captionName: "captions.srt", captionText: "1\n00:00:02,000 --> 00:00:01,000\nBackwards\n" },
  ])("rejects incomplete or invalid source input %j", input => {
    expect(() => prepareYouTubeCaptionImport(input)).toThrow()
  })
})
