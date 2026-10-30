// AQU-2197: nobody is asked for a frame rate. A file whose times are frame
// numbers written as hundredths is fixed at the linked film's own rate when
// there is one (the frame numbers cannot tell 24 from 23.976), otherwise at
// the rate the frame numbers imply; the message says which, and "Use a
// different frame rate" is there for the person who knows better.

import { useEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { FramesAsHundredthsNotice, useFramesAsHundredths } from "./FramesAsHundredthsNotice"
import { filmFetch, framesAsHundredthsVtt, properlyTimedVtt, SAMPLE_CUE } from "@/lib/parsers/frame-timecode.fixtures"
import { parseTextFormat } from "@/lib/parsers/parse-text-formats"
import type { TranslatableString } from "@/lib/parsers/types"

const FLAGGED = parseTextFormat({ fileType: "vtt", text: framesAsHundredthsVtt(), name: "ep101.vtt" })[0]!.strings
const FINE = parseTextFormat({ fileType: "vtt", text: properlyTimedVtt(), name: "ok.vtt" })[0]!.strings

let written: readonly TranslatableString[] = []
const sampleStart = () => written.find((s) => s.original === SAMPLE_CUE.text)!.start!

function Harness({ cues, filmUrl }: { cues: readonly TranslatableString[]; filmUrl?: string }) {
  const frames = useFramesAsHundredths(cues, { filmUrl })
  // Written from an effect, not during render: a component that reassigns a
  // module variable is impure, and the react-hooks lint rejects it.
  useEffect(() => { written = frames.cues }, [frames.cues])
  return frames.state ? <FramesAsHundredthsNotice state={frames.state} onChange={frames.setPick} /> : null
}

// Each test links its own film: the reads are cached for the session.
let film = 0
const filmUrl = () => `https://cdn.example.test/videos/film-${++film}/master.m3u8`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the rate the fix converts at (AQU-2197)", () => {
  it("without a film: the rate the frame numbers imply, said so", () => {
    render(<Harness cues={FLAGGED} />)
    expect(screen.getByTestId("frames-as-hundredths-rate-source"))
      .toHaveTextContent("Converted at 24 frames a second, from the frame numbers.")
    expect(screen.getByTestId("frames-as-hundredths-fix")).toHaveAttribute("aria-checked", "true")
    expect(sampleStart()).toBeCloseTo(SAMPLE_CUE.startAt24, 6)
  })

  it("with a linked film: the film's own rate wins, said so", async () => {
    const fetch = vi.fn(filmFetch("23.976"))
    vi.stubGlobal("fetch", fetch)
    render(<Harness cues={FLAGGED} filmUrl={filmUrl()} />)
    expect(screen.getByTestId("frames-as-hundredths-rate-source")).toHaveTextContent("Checking the film's frame rate…")
    await waitFor(() => expect(screen.getByTestId("frames-as-hundredths-rate-source"))
      .toHaveTextContent("Converted at 23.976 frames a second, the film's rate."))
    expect(sampleStart()).toBeCloseTo(SAMPLE_CUE.startAt23976, 6)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("a film that cannot be read falls back to the frame numbers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    render(<Harness cues={FLAGGED} filmUrl={filmUrl()} />)
    await waitFor(() => expect(screen.getByTestId("frames-as-hundredths-rate-source"))
      .toHaveTextContent("Converted at 24 frames a second, from the frame numbers."))
    expect(sampleStart()).toBeCloseTo(SAMPLE_CUE.startAt24, 6)
  })

  it("a properly timed file never reads its film", () => {
    const fetch = vi.fn(filmFetch("25"))
    vi.stubGlobal("fetch", fetch)
    render(<Harness cues={FINE} filmUrl={filmUrl()} />)
    expect(screen.queryByTestId("frames-as-hundredths")).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("'Use a different frame rate' still lets the person override it", async () => {
    const user = userEvent.setup()
    vi.stubGlobal("fetch", vi.fn(filmFetch("23.976")))
    render(<Harness cues={FLAGGED} filmUrl={filmUrl()} />)
    await waitFor(() => expect(screen.getByTestId("frames-as-hundredths-rate-source")).toHaveAttribute("data-from", "film"))
    // The picker is out of the way until asked for.
    expect(screen.queryByTestId("frames-as-hundredths-rate")).toBeNull()
    await user.click(screen.getByTestId("frames-as-hundredths-other-rate"))
    await user.click(screen.getByTestId("frames-as-hundredths-rate"))
    await user.click(await screen.findByRole("option", { name: "25" }))
    expect(screen.getByTestId("frames-as-hundredths-rate-source"))
      .toHaveTextContent("Converted at 25 frames a second, the rate you picked.")
    expect(sampleStart()).toBeCloseTo(SAMPLE_CUE.startAt25, 6)

    // Keep as is, then fix again: the person's rate is still the one.
    await user.click(screen.getByTestId("frames-as-hundredths-keep"))
    expect(sampleStart()).toBeCloseTo(SAMPLE_CUE.start, 6)
    await act(async () => { await user.click(screen.getByTestId("frames-as-hundredths-fix")) })
    expect(sampleStart()).toBeCloseTo(SAMPLE_CUE.startAt25, 6)
  })
})

// AQU-2260 (Sam, Oct 29): nothing explains itself on hover. There is room in
// the notice, so why the times look wrong opens in place, under the warning,
// on a click of its (i), and shuts on a second one.
describe("why the times look wrong (AQU-2260)", () => {
  it("opens in place under the warning on a click, never on a hover", async () => {
    render(<Harness cues={FLAGGED} />)
    const info = screen.getByRole("button", { name: "Why these times look wrong" })
    await userEvent.setup().hover(info)
    expect(screen.queryByRole("tooltip")).toBeNull()
    const reveal = document.getElementById(info.getAttribute("aria-controls") ?? "")
    expect(reveal).not.toBeNull()
    expect(reveal).toHaveAttribute("data-open", "false")
    await userEvent.setup().click(info)
    expect(reveal).toHaveAttribute("data-open", "true")
    expect(reveal).toHaveTextContent("frame number")
    await userEvent.setup().click(info)
    expect(reveal).toHaveAttribute("data-open", "false")
  })
})
