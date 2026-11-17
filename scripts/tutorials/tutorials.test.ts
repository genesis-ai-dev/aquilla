import { describe, expect, it } from "vitest"
import { TUTORIALS } from "../../e2e/recordings/tutorials/catalog"
import { lookOf, steadyScreen } from "../../e2e/recordings/tutorials/look"
import { INTRO_MS, OUTRO_MS } from "./brand"
import { buildVtt, composeArgs, totalMs, type Take } from "./compose"
import { plan, whyPublish, type Filmed, type VideoEntry } from "./manifest"
import { pcmToWav, unsaidLines } from "./voice"

const take: Take = {
  id: "translate-a-verse",
  video: "take.webm",
  preludeMs: 6000,
  durationMs: 20_000,
  lines: [
    { key: "intro", text: "Here's how to translate a verse.", t: 500, ms: 2400, voiced: true },
    { key: "type", text: "Type your translation.", t: 9000, ms: 30_000, voiced: false },
  ],
}
const cards = { frame: "frame.png", intro: "intro.png", outro: "outro.png" }

const film: Filmed = {
  id: "translate-a-verse",
  title: "Translate a verse",
  description: "Here's how to translate a verse.",
  audience: "translators",
  language: "en",
  durationSeconds: 25,
  voiced: true,
  look: "aaaa",
  script: "bbbb",
  frame: 1,
}
const now = { at: "2026-11-17T20:00:00.000Z", commit: "abc1234", base: "https://docs.aquilla.app/media/tutorials/" }

describe("tutorial videos", () => {
  it("every video opens by saying what it shows, and no two share an id", () => {
    expect(new Set(TUTORIALS.map((tutorial) => tutorial.id)).size).toBe(TUTORIALS.length)
    for (const tutorial of TUTORIALS) {
      expect(Object.values(tutorial.lines)[0], tutorial.id).toMatch(/^Here's how to .+\.$/)
    }
  })

  it("a screen's look ignores what differs between two runs, and nothing else", () => {
    const first = '- button "Copy build info": v0.2.4 · 22143b8 · 2026-11-17\n- text: demo just now\n- button "Automatic health awaiting evidence"\n- button "Save"'
    const second = '- button "Copy build info": v0.2.5 · 9fe01ab · 2026-11-18\n- text: demo 2 minutes ago\n- button "Automatic health 100%"\n- button "Save"'
    expect(steadyScreen(first)).toBe(steadyScreen(second))
    expect(lookOf([first])).toBe(lookOf([second]))
    expect(lookOf([first])).not.toBe(lookOf([first.replace("Save", "Keep")]))
  })

  it("captions follow the lines, moved past the opening card and cut at the take's end", () => {
    expect(buildVtt(take)).toBe(
      "WEBVTT\n\n" +
        "1\n00:00:02.500 --> 00:00:04.900\nHere's how to translate a verse.\n\n" +
        "2\n00:00:11.000 --> 00:00:22.000\nType your translation.\n",
    )
  })

  it("the video cuts the sign-in off the take and lays each voiced line where it was said", () => {
    const args = composeArgs(take, cards, { intro: "intro.mp3" }, "out.mp4")
    const graph = args[args.indexOf("-filter_complex") + 1]
    expect(graph).toContain("[0:v]trim=start=6.000:duration=20.000")
    // One voiced line, said 500 ms into the take: after the 2 s opening card.
    expect(graph).toContain(`[6:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${INTRO_MS + 500}|${INTRO_MS + 500}[say0]`)
    expect(graph).toContain("amix=inputs=2")
    expect(graph).toContain("loudnorm=I=-16")
    expect(args[args.indexOf("-t") + 1]).toBe(((INTRO_MS + 20_000 + OUTRO_MS) / 1000).toFixed(3))
    expect(totalMs(take)).toBe(INTRO_MS + 20_000 + OUTRO_MS)

    // No voice at all: a silent track, so every player still shows a timeline.
    const silent = composeArgs(take, cards, {}, "out.mp4")
    expect(silent[silent.indexOf("-filter_complex") + 1]).not.toContain("amix")
    expect(silent).toContain("[a]")
  })

  it.each<[string, Partial<Filmed>, string | null]>([
    ["nothing changed", {}, null],
    ["a screen changed", { look: "cccc" }, "its screens changed"],
    ["the script changed", { script: "dddd" }, "its script changed"],
    ["the frame changed", { frame: 2 }, "the frame changed"],
    ["the voice went", { voiced: false }, "its voice is gone"],
  ])("publishes again only when %s calls for it", (_name, change, why) => {
    const up: VideoEntry = { ...film, src: "s", poster: "p", captions: "c", filmedAt: "then", commit: "old" }
    expect(whyPublish(up, { ...film, ...change })).toBe(why)
  })

  it("the manifest keeps an unchanged film's entry and one this run did not film", () => {
    const first = plan(null, [film, { ...film, id: "validate-a-verse" }], now)
    expect(first.publish.map((entry) => entry.id)).toEqual(["translate-a-verse", "validate-a-verse"])
    expect(first.manifest.videos[0].src).toBe("https://docs.aquilla.app/media/tutorials/translate-a-verse/translate-a-verse.mp4")
    expect(first.manifest.videos[0].captions).toMatch(/translate-a-verse\.en\.vtt$/)

    // Next night: one video's screens changed; the other was not filmed at all.
    const later = { ...now, at: "2026-11-18T20:00:00.000Z", commit: "def5678" }
    const second = plan(first.manifest, [{ ...film, look: "cccc" }], later)
    expect(second.publish).toEqual([{ id: "translate-a-verse", why: "its screens changed" }])
    const [translate, validate] = second.manifest.videos
    expect(translate).toMatchObject({ look: "cccc", commit: "def5678", filmedAt: later.at })
    expect(validate).toEqual(first.manifest.videos[1])
  })

  it("only lines without a recording are said", () => {
    const [tutorial] = TUTORIALS
    const all = unsaidLines([tutorial], null)
    expect(all).toHaveLength(Object.keys(tutorial.lines).length)
    expect(unsaidLines([tutorial], { voice: "v", model: "m", lines: {} })).toEqual(all)
  })

  it("Gemini's raw speech becomes a WAV a player can read", () => {
    const wav = pcmToWav(Buffer.alloc(48_000), 24_000) // one second, 16-bit mono
    expect(wav.subarray(0, 4).toString()).toBe("RIFF")
    expect(wav.readUInt32LE(24)).toBe(24_000)
    expect(wav.readUInt32LE(28)).toBe(48_000) // bytes a second
    expect(wav.readUInt32LE(40)).toBe(48_000)
    expect(wav.length).toBe(44 + 48_000)
  })
})
