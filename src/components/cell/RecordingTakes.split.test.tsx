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
vi.mock("@/hooks/useRecordingTextDrift", () => ({ useRecordingTextDrift: () => new Map() }))
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
vi.mock("@/lib/history/history", () => ({ recordStep: vi.fn() }))

import { RecordingTakes } from "./RecordingTakes"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

const project = { id: "p1", sourceLanguage: "en", targetLanguage: "es", audioMediaStrategy: "manual", files: [{ id: "f1" }] } as unknown as ProjectRecord
const URL = "frontier-audio://audio-c1-1.webm"
const T1 = "audio-c1-1.webm", P2 = "audio-c1-2.webm", T2 = "audio-c1-3.webm", Q2 = "audio-c1-4.webm"
const audio = (over: Record<string, unknown>) => ({ type: "audio", url: URL, slot: "recording", durationMs: 4000, ...over })

function draw(attachments: Record<string, unknown>, selectedAudioId = T1) {
  const c = { id: "c1", fileId: "f1", original: "", translated: "", selectedAudioId, attachments } as unknown as CellData
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
    // Each piece is approved on its own row; the take's name is its pieces'.
    expect(within(pieces).getAllByTestId("audio-validation-button")).toHaveLength(2)
    expect(screen.queryByTestId("cell-take-rename-button")).toBeNull()
  })

  it("approves the whole take from the top, every piece", () => {
    draw(splitTake)
    const top = within(screen.getByTestId("cell-take-validation"))
    expect(top.getByTestId("audio-validation-button").getAttribute("aria-label")).toMatch(/click to validate/i)
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

  it("draws a take never split as before", () => {
    draw({ [T1]: audio({ label: "Take 1" }) })
    expect(screen.getByTestId("cell-take-label")).toHaveTextContent("Take 1")
    expect(screen.queryByTestId("cell-take-split")).toBeNull()
    expect(screen.queryByTestId("tab-take-pieces")).toBeNull()
  })
})
