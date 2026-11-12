import { describe, expect, it, vi } from "vitest"
import { reviewMediaCompanions } from "./media-companion-batch"
import { extractSrtStrings } from "../parsers/subtitle"

describe("media companion review", () => {
  const captionText = "1\n00:00:00,500 --> 00:00:01,500\nCaption wording"
  const prepareCaptions = async (file: File) => ({
    cues: extractSrtStrings(await file.text()),
    artifact: { name: file.name, format: "srt" as const, bytes: await file.arrayBuffer() },
  })

  it("keeps captions standalone when no media is selected", async () => {
    const captions = new File([captionText], "clip.srt")
    const prepare = vi.fn(prepareCaptions)
    const review = vi.fn()
    expect(await reviewMediaCompanions([captions], prepare, review))
      .toEqual({ files: [captions], sources: new Map() })
    expect(prepare).not.toHaveBeenCalled()
    expect(review).not.toHaveBeenCalled()
  })

  it("retains unselected captions when the user chooses transcription", async () => {
    const files = [new File(["audio"], "clip.mp3"), new File([captionText], "clip.srt")]
    expect(await reviewMediaCompanions(files, prepareCaptions, async () => undefined))
      .toEqual({ files, sources: new Map() })
  })

  it("cancels the entire batch before publication when a later review is cancelled", async () => {
    const files = [new File(["audio"], "one.mp3"), new File(["audio"], "two.mp3"),
      new File([captionText], "one.srt")]
    const review = vi.fn(async (media, options) => media.name === "two.mp3" ? null : options[0].source)
    expect(await reviewMediaCompanions(files, prepareCaptions, review)).toBeNull()
    expect(review).toHaveBeenCalledTimes(2)
  })

  it("offers matching companion names first regardless of selection order", async () => {
    const one = new File(["audio"], "one.mp3")
    const two = new File(["audio"], "two.mp3")
    const files = [two, new File([captionText], "one.srt"), one,
      new File([captionText], "two.srt")]
    const result = await reviewMediaCompanions(files, prepareCaptions, async (_, options) => options[0].source)
    expect(result?.files).toEqual([two, one])
    expect(result?.sources.get(one)?.artifact?.name).toBe("one.srt")
    expect(result?.sources.get(two)?.artifact?.name).toBe("two.srt")
  })

  it("pairs captions with media after review and retains the caption original", async () => {
    const media = new File(["audio"], "clip.mp3")
    const text = "1\n00:00:00,500 --> 00:00:01,500\nCaption wording"
    const captions = new File([text], "clip.srt")
    const prepare = vi.fn(async () => ({
      cues: extractSrtStrings(text),
      artifact: { name: captions.name, format: "srt" as const, bytes: await captions.arrayBuffer() },
    }))
    const review = vi.fn(async (_file, options) => options[0].source)
    const result = await reviewMediaCompanions([media, captions], prepare, review)
    expect(review).toHaveBeenCalledWith(media, [expect.objectContaining({ label: "clip.srt" })])
    expect(result?.files).toEqual([media])
    expect(result?.sources.get(media)).toMatchObject({
      cues: [expect.objectContaining({ original: "Caption wording", start: 0.5, end: 1.5 })],
      artifact: { name: "clip.srt", bytes: await captions.arrayBuffer() },
    })
    expect(prepare).toHaveBeenCalledTimes(1)
  })
})
