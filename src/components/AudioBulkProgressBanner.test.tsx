import { describe, it, expect, vi } from "vitest"
import { act, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderWithTooltips } from "@/test-utils/tooltip"

vi.mock("@/lib/audio/change-voice-batch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audio/change-voice-batch")>()),
  cancelBatchChangeVoice: vi.fn(),
}))

import { runBatch } from "@/lib/audio/batch-audio"
import { cancelBatchChangeVoice } from "@/lib/audio/change-voice-batch"
import { AudioBulkProgressBanner } from "./AudioBulkProgressBanner"

describe("AudioBulkProgressBanner — Change voice (AQU-1109)", () => {
  it("labels a running Change voice batch and routes Cancel to it", async () => {
    const user = userEvent.setup()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    renderWithTooltips(<AudioBulkProgressBanner />)

    let run!: Promise<void>
    act(() => {
      run = runBatch([1, 2, 3, 4], () => gate, {
        kind: "changeVoice",
        isCancelled: () => false,
        onItemDone: () => {},
      })
    })
    expect(screen.getByText("Changing voices")).toBeTruthy()
    expect(screen.getByText("0/4")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Cancel batch" }))
    expect(cancelBatchChangeVoice).toHaveBeenCalledTimes(1)

    await act(async () => { release(); await run })
    expect(screen.queryByText("Changing voices")).toBeNull()
  })
})
