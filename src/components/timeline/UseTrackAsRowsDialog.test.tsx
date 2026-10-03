import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { UseTrackAsRowsDialog } from "./UseTrackAsRowsDialog"

// AQU-1566: the confirmation in front of "Use as this file's rows".
describe("UseTrackAsRowsDialog", () => {
  it("names the track, says what happens to it, and closes once the rows are in", async () => {
    const onConfirm = vi.fn(async () => {})
    const onCancel = vi.fn()
    render(<UseTrackAsRowsDialog trackName="Episode captions" onConfirm={onConfirm} onCancel={onCancel} />)
    expect(screen.getByText("Use Episode captions as this file's rows?")).toBeInTheDocument()
    expect(screen.getByText(/The track leaves the timeline and its captions show in the Source text row instead/))
      .toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Use as rows" }))
    expect(onConfirm).toHaveBeenCalledOnce()
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
  })

  it("writes nothing when cancelled", () => {
    const onConfirm = vi.fn(async () => {})
    const onCancel = vi.fn()
    render(<UseTrackAsRowsDialog trackName="Episode captions" onConfirm={onConfirm} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("stays open with the reason when it fails, and a second press tries again", async () => {
    const onConfirm = vi.fn()
      .mockRejectedValueOnce(new Error("Someone already added rows to this file. They're showing now."))
      .mockResolvedValueOnce(undefined)
    const onCancel = vi.fn()
    render(<UseTrackAsRowsDialog trackName="Episode captions" onConfirm={onConfirm} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole("button", { name: "Use as rows" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone already added rows to this file. They're showing now.")
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Use as rows" }))
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })

  it("ignores a second press while the first is still saving", async () => {
    let resolve!: () => void
    const onConfirm = vi.fn(() => new Promise<void>(r => { resolve = r }))
    const onCancel = vi.fn()
    render(<UseTrackAsRowsDialog trackName="Episode captions" onConfirm={onConfirm} onCancel={onCancel} />)
    const button = screen.getByRole("button", { name: "Use as rows" })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onConfirm).toHaveBeenCalledOnce()
    resolve()
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
  })
})
