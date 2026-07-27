import { describe, it, expect } from "vitest"
import { deriveLanes, subtitleMirrorText } from "./lanes"

const seg = (o: Partial<{ id: string; startTime: number; endTime: number; medium: "text" | "media"; sequenceIndex: number }>) =>
  ({ medium: "text", ...o }) as any

describe("deriveLanes", () => {
  it("splits timed media into dialogue, timed text into subtitle, untimed into untimed", () => {
    const cells = [
      seg({ id: "a", startTime: 0, endTime: 3, medium: "text" }),
      seg({ id: "b", startTime: 0.4, endTime: 6, medium: "media" }),
      seg({ id: "c", medium: "text", sequenceIndex: 9 }), // untimed
      seg({ id: "d", startTime: 8, endTime: 12, medium: "text" }),
    ]
    const { subtitle, dialogue, untimed } = deriveLanes(cells)
    expect(subtitle.map((s) => s.id)).toEqual(["a", "d"])
    expect(dialogue.map((s) => s.id)).toEqual(["b"])
    expect(untimed.map((s) => s.id)).toEqual(["c"])
  })

  it("sorts each timed lane by startTime", () => {
    const cells = [
      seg({ id: "late", startTime: 10, endTime: 11, medium: "media" }),
      seg({ id: "early", startTime: 1, endTime: 2, medium: "media" }),
    ]
    expect(deriveLanes(cells).dialogue.map((s) => s.id)).toEqual(["early", "late"])
  })

  it("treats missing medium as text (subtitle lane)", () => {
    const cells = [seg({ id: "x", startTime: 0, endTime: 1, medium: undefined })]
    expect(deriveLanes(cells).subtitle.map((s) => s.id)).toEqual(["x"])
  })

  // ── AQU-646: subtitle-lane mirror for pure-audio files ──

  it("pure-audio file: media cells with text mirror into the subtitle lane (same refs)", () => {
    const withText = { ...seg({ id: "m1", startTime: 0, endTime: 5, medium: "media" }), transcription: "hello" }
    const translated = { ...seg({ id: "m2", startTime: 5, endTime: 9, medium: "media" }), translated: "hola" }
    const bare = seg({ id: "m3", startTime: 9, endTime: 12, medium: "media" }) // untranscribed
    const { subtitle, dialogue } = deriveLanes([withText, translated, bare])
    expect(dialogue.map((s) => s.id)).toEqual(["m1", "m2", "m3"])
    expect(subtitle.map((s) => s.id)).toEqual(["m1", "m2"]) // bare cell has nothing to show yet
    expect(subtitle[0]).toBe(withText) // same object, not a clone — selection stays one cell
  })

  it("mixed file (real subtitle cells present): no mirroring", () => {
    const sub = seg({ id: "s1", startTime: 0, endTime: 2, medium: "text" })
    const media = { ...seg({ id: "m1", startTime: 0, endTime: 5, medium: "media" }), transcription: "hello" }
    const { subtitle } = deriveLanes([sub, media])
    expect(subtitle.map((s) => s.id)).toEqual(["s1"])
  })

  it("subtitleMirrorText prefers the translation, falls back to the transcript", () => {
    expect(subtitleMirrorText({ transcription: "src", translated: "tgt" })).toBe("tgt")
    expect(subtitleMirrorText({ transcription: "src", translated: "  " })).toBe("src")
    expect(subtitleMirrorText({})).toBe("")
  })
})
