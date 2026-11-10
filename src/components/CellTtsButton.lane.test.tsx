// AQU-1978: the row's voice button saves its voice IN THE OPEN LANE.
//
// It used to generate with no lane at all. The server reads a missing tag as
// the `''` lane, which a project made since AQU-1594 does not have, so the take
// was stored with no lane, showed in none — and because the button found no
// clip to replay, every press paid for another one.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "sam" }, loading: false }),
}))

vi.mock("@/lib/audio/prefetch", () => ({
  useModelStatus: () => ({ kind: "idle" }),
}))

const generated = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock("@/lib/audio/generate-voice", () => ({
  generateAndAttachCellVoice: vi.fn(async (args: Record<string, unknown>) => {
    generated.push(args)
    return { audioId: "a.webm", url: "frontier-audio://a.webm", blob: new Blob(["x"]) }
  }),
}))

import { CellTtsButton } from "./CellTtsButton"
import { setTtsStatus, ttsStatusKey } from "@/lib/audio/tts"

beforeEach(() => {
  generated.length = 0
  URL.createObjectURL = vi.fn(() => "blob:voice")
  URL.revokeObjectURL = vi.fn()
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined)
  HTMLMediaElement.prototype.pause = vi.fn()
})

function press(props: Partial<React.ComponentProps<typeof CellTtsButton>> = {}) {
  const view = render(
    <CellTtsButton
      cellId="c1"
      text="Hola, mundo"
      projectTtsSettings={{}}
      projectId="p1"
      fileId="f1"
      {...props}
    />,
  )
  fireEvent.click(screen.getByRole("button"))
  return view
}

describe("CellTtsButton generates into the open lane (AQU-1978)", () => {
  it("stamps the lane on the voice it attaches", async () => {
    press({ cellId: "c-lane", targetLang: "Spanish" })
    await waitFor(() => expect(generated).toHaveLength(1))
    expect(generated[0]).toMatchObject({ cellId: "c-lane", targetLang: "Spanish" })
  })

  it("stamps it on every heard line the subtitle is voiced onto, too", async () => {
    press({
      cellId: "cue-1",
      targetLang: "Spanish",
      alsoAttachTo: [{ cellId: "cue-2", fileId: "cues" }],
    })
    await waitFor(() => expect(generated).toHaveLength(2))
    expect(generated.map((g) => [g.cellId, g.targetLang])).toEqual([
      ["cue-1", "Spanish"],
      ["cue-2", "Spanish"],
    ])
  })

  it("sends no lane on the default lane, exactly as before", async () => {
    // An old project's `''` lane is spelled by omission on every audio event.
    press({ cellId: "c-default" })
    await waitFor(() => expect(generated).toHaveLength(1))
    expect(generated[0]).not.toHaveProperty("targetLang")
  })

  it("does not replay one lane's clip in another lane with the same words", async () => {
    const first = press({ cellId: "c-twin", targetLang: "Spanish" })
    await waitFor(() => expect(generated).toHaveLength(1))
    first.unmount()
    // The stubbed player never reports `play`, so the first press is left
    // "loading" and would hold the button disabled.
    setTtsStatus(ttsStatusKey("c-twin"), { kind: "idle" })
    press({ cellId: "c-twin", targetLang: "a3f09c1e" })
    await waitFor(() => expect(generated).toHaveLength(2))
    expect(generated[1]).toMatchObject({ cellId: "c-twin", targetLang: "a3f09c1e" })
  })
})

// AQU-2491 (review, Nov 9): a line recorded before AQU-2491 holds the
// recorder's pre-roll as its place. The voice this button makes is given its
// own place, the line's start, on the line it lands on and on every heard line
// it is voiced onto too, so none of them reads that old place and starts early.
describe("CellTtsButton places each new voice on its own line's start (AQU-2491)", () => {
  it("each line it voices gets its own place on a line with times, and none on a line with no times", async () => {
    press({
      cellId: "cue-p1",
      lineStartTime: 12,
      alsoAttachTo: [{ cellId: "cue-p2", fileId: "cues", startTime: 15 }, { cellId: "cue-p3", fileId: "cues", startTime: null }],
    })
    await waitFor(() => expect(generated).toHaveLength(3))
    expect(generated.map((g) => [g.cellId, g.place ?? null])).toEqual([
      ["cue-p1", { targetOffsetMs: 0, recordingsOffsetMs: null }],
      ["cue-p2", { targetOffsetMs: 0, recordingsOffsetMs: null }],
      ["cue-p3", null],
    ])
  })
})
