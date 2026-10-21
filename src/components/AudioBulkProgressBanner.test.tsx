import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderWithTooltips } from "@/test-utils/tooltip"

vi.mock("@/lib/audio/change-voice-batch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audio/change-voice-batch")>()),
  cancelBatchChangeVoice: vi.fn(),
}))
vi.mock("@/lib/audio/transcribe", () => ({ transcribeCell: vi.fn(async () => 0) }))

import { cancelBatchTranscribe, runBatchJobs, runTranscribeAll } from "@/lib/audio/batch-audio"
import { cancelBatchChangeVoice } from "@/lib/audio/change-voice-batch"
import { AudioBulkProgressBanner } from "./AudioBulkProgressBanner"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

afterEach(() => {
  cancelBatchTranscribe()
  vi.useRealTimers()
})

describe("AudioBulkProgressBanner — Change voice (AQU-1109)", () => {
  it("labels a running Change voice batch and routes Cancel to it", async () => {
    const user = userEvent.setup()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    renderWithTooltips(<AudioBulkProgressBanner />)

    let run!: Promise<void>
    act(() => {
      run = runBatchJobs([1, 2, 3, 4], () => gate, {
        kind: "changeVoice",
        isCancelled: () => false,
        onItemDone: () => {},
      })
    })
    expect(screen.getByText("Changing voices")).toBeTruthy()
    expect(screen.getByText("0/4")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Cancel batch" }))
    await vi.waitFor(() => expect(cancelBatchChangeVoice).toHaveBeenCalledTimes(1))

    await act(async () => { release(); await run })
    expect(screen.queryByText("Changing voices")).toBeNull()
  })
})

// AQU-1681. WHY: a long transcription that reaches the hosted limit (60
// requests per 15 minutes per person) pauses for up to a quarter of an hour.
// Without a word on the banner that looks like a hang; it must say that the
// batch carries on by itself, and when.
describe("AudioBulkProgressBanner — transcription limit (AQU-1681)", () => {
  it("says when a batch paused by the transcription limit carries on", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-15T19:30:00") })
    const { transcribeCell } = await import("@/lib/audio/transcribe")
    vi.mocked(transcribeCell).mockImplementation(async (args) => {
      await args.onRateLimited?.(899).catch(() => {})
      return 0
    })
    const cell = { id: "c1", selectedAudioId: "a1", attachments: { a1: { url: "frontier-audio://a1.wav" } } } as unknown as CellData
    const run = runTranscribeAll({ cells: [cell], projectId: "p1", session: { jwt: "j", username: "u" } as FrontierSession })
    render(<AudioBulkProgressBanner />)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    // 899 s, plus the second the batch adds, from 19:30:00 is 19:45:00.
    expect(screen.getByTestId("bulk-progress-waiting").textContent).toMatch(/^Transcription limit reached, continuing at 7:45/)
    cancelBatchTranscribe()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
    await run
  })
})
