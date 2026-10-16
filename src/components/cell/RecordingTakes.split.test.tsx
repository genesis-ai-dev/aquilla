// AQU-1767 (Sam, 2026-10-14): a split take in the Recording tab is ONE take
// with its pieces under it — never a piece on top and another as "1 other take".
import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "ready", error: null, isPlaying: false, currentTime: 0, duration: 4,
    peaks: null, peaksState: "idle",
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))
const drift = vi.hoisted(() => ({ map: new Map<string, unknown>() }))
vi.mock("@/hooks/useRecordingTextDrift", () => ({ useRecordingTextDrift: () => drift.map }))
vi.mock("@/lib/audio/peaks-loader", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio/peaks-loader")>()),
  loadPeaksFor: vi.fn(async () => null),
}))
const queued = vi.hoisted(() => ({ removes: [] as string[] }))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async () => "e"), emitCellAudioTrim: vi.fn(async () => "e"),
  emitCellAudioSelect: vi.fn(async () => "e"), emitCellAudioDeselect: vi.fn(async () => "e"),
  emitCellAudioRemove: vi.fn(async (i: { audioId: string }) => { queued.removes.push(i.audioId); return "e" }),
  emitCellAudioRename: vi.fn(async () => "e"), emitCellAudioPlace: vi.fn(async () => "e"),
  emitCellAudioValidate: vi.fn(async () => "e"), emitCellAudioUnvalidate: vi.fn(async () => "e"),
  enqueueEvents: vi.fn(async (inputs: Array<{ payload: { audioId: string } }>) => {
    queued.removes.push(...inputs.map((i) => i.payload.audioId))
    return inputs.map((_, i) => ({ event: {}, eventId: `ev-${i}` }))
  }),
}))
vi.mock("@/lib/history/history", () => ({ recordStep: vi.fn(), withGroup: async (_l: unknown, fn: () => Promise<unknown>) => fn() }))

import { RecordingTakes } from "./RecordingTakes"
import { getOptimisticShadows } from "@/lib/audio/audio-attachments-bus"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

const project = { id: "p1", sourceLanguage: "en", targetLanguage: "es", audioMediaStrategy: "manual", files: [{ id: "f1" }] } as unknown as ProjectRecord
const URL = "frontier-audio://audio-c1-1.webm"
const T1 = "audio-c1-1.webm", P2 = "audio-c1-2.webm", T2 = "audio-c1-3.webm", Q2 = "audio-c1-4.webm"
const audio = (over: Record<string, unknown>) => ({ type: "audio", url: URL, slot: "recording", durationMs: 4000, ...over })

function draw(attachments: Record<string, unknown>, selectedAudioId = T1, over: Record<string, unknown> = {}) {
  const c = { id: "c1", fileId: "f1", original: "", translated: "", selectedAudioId, attachments, ...over } as unknown as CellData
  render(
    <RecordingTakes
      project={project} cell={c} cellText="Hola mundo" editable username="dir"
      session={{ jwt: "j", username: "dir" } as never} onOpenRecording={vi.fn()} onUseAsCellText={vi.fn()}
    />,
  )
}

const splitTake = {
  [T1]: audio({ label: "Take 1 · 1", trimEndMs: 1500 }),
  [P2]: audio({ label: "Take 1 · 2", trimStartMs: 1500, pieceOf: T1 }),
}

describe("RecordingTakes — a split take (AQU-1767)", () => {
  it("shows the take once, with its whole length, and its pieces under it — not as another take", () => {
    draw(splitTake)
    expect(screen.getByTestId("cell-take-label")).toHaveTextContent(/^Take 1$/)
    expect(screen.getByTestId("cell-take-split")).toHaveTextContent("split in 2")
    expect(screen.getByTestId("cell-take-length")).toHaveTextContent("4.0s")
    expect(screen.queryByTestId("tab-other-takes")).toBeNull()
    const pieces = screen.getByTestId("tab-take-pieces")
    expect(within(pieces).getByText("2 pieces")).toBeInTheDocument()
    expect(within(pieces).getByTestId(`take-label-${T1}`)).toHaveTextContent("Take 1 · 1")
    expect(within(pieces).getByTestId(`take-label-${P2}`)).toHaveTextContent("Take 1 · 2")
    // Pieces play together: nothing on a piece's row chooses it on its own.
    expect(within(pieces).queryByRole("button", { name: "Use this take" })).toBeNull()
    // Sam, 2026-10-15: a piece is not edited on its own here, only deleted —
    // its approval shows but takes no vote, and it has no rename.
    const votes = within(pieces).getAllByTestId("audio-validation-button")
    expect(votes).toHaveLength(2)
    for (const v of votes) expect(v.hasAttribute("aria-pressed")).toBe(false)
    expect(within(pieces).queryByRole("button", { name: "Rename take" })).toBeNull()
    expect(within(pieces).getAllByRole("button", { name: "Delete take" })).toHaveLength(2)
  })

  // Sam, 2026-10-15: the take is renamed whole, and its pieces follow.
  it("renames the whole take from the top, its pieces numbered by where they sit", async () => {
    const { emitCellAudioRename } = await import("@/lib/sync/events-emit")
    vi.mocked(emitCellAudioRename).mockClear()
    draw(splitTake)
    fireEvent.click(screen.getByTestId("cell-take-rename-button"))
    const box = screen.getByTestId("cell-take-rename")
    expect(box).toHaveValue("Take 1")
    fireEvent.change(box, { target: { value: "Greeting" } })
    fireEvent.keyDown(box, { key: "Enter" })
    await vi.waitFor(() =>
      expect(vi.mocked(emitCellAudioRename).mock.calls.map(([i]) => [(i as { audioId: string }).audioId, (i as { label: string }).label]))
        .toEqual([[T1, "Greeting · 1"], [P2, "Greeting · 2"]]),
    )
  })

  it("numbers the pieces by where they sit in the recording, whatever number each has stored", () => {
    draw({
      [T1]: audio({ label: "Take 1 · 9", trimEndMs: 1500 }),
      [T2]: audio({ label: "Take 1 · 3", trimStartMs: 1500, trimEndMs: 2500, pieceOf: T1 }),
      [P2]: audio({ label: "Take 1 · 2", trimStartMs: 2500, pieceOf: T1 }),
    })
    const pieces = screen.getByTestId("tab-take-pieces")
    expect(within(pieces).getByTestId(`take-label-${T1}`)).toHaveTextContent("Take 1 · 1")
    expect(within(pieces).getByTestId(`take-label-${T2}`)).toHaveTextContent("Take 1 · 2")
    expect(within(pieces).getByTestId(`take-label-${P2}`)).toHaveTextContent("Take 1 · 3")
    expect(screen.getByTestId("cell-take-label")).toHaveTextContent(/^Take 1$/)
  })

  // Sam, 2026-10-15: "Text changed" agreed with itself nowhere — each piece
  // was dated by when it was CUT. The take is dated by its recording, and says
  // so once, on the take.
  describe("Text changed", () => {
    const recordedThen = { audioId: T1, recordedAt: 1_790_000_000_000, recordedBy: "dir", textAtRecording: "Hola", drifted: true }
    const cutLater = { audioId: P2, recordedAt: 1_792_000_000_000, recordedBy: "dir", textAtRecording: "Hola mundo", drifted: false }

    it("is said once, on the take, by the recording its words came from", () => {
      drift.map = new Map<string, unknown>([[T1, recordedThen], [P2, cutLater]])
      draw(splitTake, P2)
      expect(screen.getAllByText("Text changed")).toHaveLength(1)
      expect(within(screen.getByTestId("cell-take-head")).getByText("Text changed")).toBeInTheDocument()
      expect(within(screen.getByTestId("tab-take-pieces")).queryByTestId(`take-recorded-${P2}`)).toBeNull()
      drift.map = new Map()
    })

    it("is not said when the take's transcript matches the line as it reads now", () => {
      drift.map = new Map<string, unknown>([[T1, recordedThen]])
      draw(splitTake, T1, {
        audioTimings: { [T1]: [
          { word: "Hola", start: 0, end: 4, t0: 0, t1: 0.4 },
          { word: "mundo", start: 5, end: 10, t0: 0.4, t1: 0.9 },
        ] },
      })
      expect(screen.queryByText("Text changed")).toBeNull()
      drift.map = new Map()
    })
  })

  it("approves the whole take from the top, every piece", async () => {
    const { emitCellAudioValidate } = await import("@/lib/sync/events-emit")
    vi.mocked(emitCellAudioValidate).mockClear()
    draw(splitTake)
    const top = within(screen.getByTestId("cell-take-validation"))
    fireEvent.click(top.getByTestId("audio-validation-button"))
    await vi.waitFor(() =>
      expect(vi.mocked(emitCellAudioValidate).mock.calls.map(([i]) => (i as { audioId: string }).audioId).sort()).toEqual([T1, P2].sort()),
    )
  })

  it("deletes the whole take from the top, and one piece from its row", async () => {
    queued.removes = []
    draw(splitTake)
    fireEvent.click(screen.getByTestId("cell-take-delete"))
    await vi.waitFor(() => expect(queued.removes).toEqual([T1, P2]))

    queued.removes = []
    fireEvent.click(within(screen.getByTestId(`take-row-${P2}`)).getByRole("button", { name: /delete/i }))
    await vi.waitFor(() => expect(queued.removes).toEqual([P2]))
  })

  it("lists another split take as one row, chosen and deleted whole", async () => {
    queued.removes = []
    draw({
      ...splitTake,
      [T2]: audio({ url: "frontier-audio://audio-c1-3.webm", label: "Take 2 · 1", trimEndMs: 1000 }),
      [Q2]: audio({ url: "frontier-audio://audio-c1-3.webm", label: "Take 2 · 2", trimStartMs: 1000, trimEndMs: 3500, pieceOf: T2 }),
    })
    const others = screen.getByTestId("tab-other-takes")
    expect(within(others).getByText("1 other take")).toBeInTheDocument()
    const row = within(others).getByTestId(`take-row-${T2}`)
    expect(within(others).queryByTestId(`take-row-${Q2}`)).toBeNull()
    expect(within(row).getByTestId(`take-label-${T2}`)).toHaveTextContent(/^Take 2$/)
    expect(within(row).getByTestId(`take-split-${T2}`)).toHaveTextContent("split in 2")
    expect(within(row).getByTestId(`take-length-${T2}`)).toHaveTextContent("3.5s")
    fireEvent.click(within(row).getByRole("button", { name: /delete/i }))
    await vi.waitFor(() => expect(queued.removes).toEqual([T2, Q2]))
  })

  it("Revert on a cleaned split take paints the original take chosen at once, window and all", async () => {
    const DN = "dn-audio-c1-9.webm", DQ = "audio-c1-10.webm"
    draw({
      ...splitTake,
      [DN]: audio({ url: "frontier-audio://dn-audio-c1-9.webm", label: "Take 1 · 1", trimEndMs: 1500, referenceAudioId: T1 }),
      [DQ]: audio({ url: "frontier-audio://dn-audio-c1-9.webm", label: "Take 1 · 2", trimStartMs: 1500, pieceOf: DN, referenceAudioId: P2 }),
    }, DN)
    fireEvent.click(within(screen.getByTestId("cell-take-block")).getByRole("button", { name: /Revert/ }))
    await vi.waitFor(() => {
      const shadows = getOptimisticShadows("f1").get("c1") ?? []
      const painted = shadows.map((sh) => (sh as { att?: { audioId: string; trimEndMs: number | null } }).att).find((a) => a?.audioId === T1)
      expect(painted?.trimEndMs).toBe(1500)
    })
  })

  it("draws a take never split as before", () => {
    draw({ [T1]: audio({ label: "Take 1" }) })
    expect(screen.getByTestId("cell-take-label")).toHaveTextContent("Take 1")
    expect(screen.queryByTestId("cell-take-split")).toBeNull()
    expect(screen.queryByTestId("tab-take-pieces")).toBeNull()
  })
})
