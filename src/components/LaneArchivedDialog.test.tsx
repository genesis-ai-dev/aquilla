import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { LaneArchivedDialog } from "./LaneArchivedDialog"

/**
 * AQU-1463: the modal's whole job is to be unmissable, so the tests are about
 * the ways a member could otherwise dismiss it without reading it.
 */
describe("LaneArchivedDialog", () => {
  it("names the archived lane in the title and the body", () => {
    render(<LaneArchivedDialog laneLabel="Spanish" open onAcknowledge={() => {}} />)
    const dialog = screen.getByRole("dialog")
    expect(dialog).toHaveTextContent("Spanish has been archived")
    expect(dialog).toHaveTextContent(/read-only/i)
  })

  it("says the member keeps reading, searching, exporting and commenting", () => {
    // Without this the member's first assumption is that the work is gone.
    render(<LaneArchivedDialog laneLabel="Spanish" open onAcknowledge={() => {}} />)
    const dialog = screen.getByRole("dialog")
    for (const promise of [/read/i, /search/i, /export/i, /comment/i]) {
      expect(dialog).toHaveTextContent(promise)
    }
  })

  it("says the member's other languages are unaffected", () => {
    render(<LaneArchivedDialog laneLabel="Spanish" open onAcknowledge={() => {}} />)
    expect(screen.getByRole("dialog")).toHaveTextContent(/other languages are unaffected/i)
  })

  it("offers no close button — the acknowledge button is the only exit", () => {
    render(<LaneArchivedDialog laneLabel="Spanish" open onAcknowledge={() => {}} />)
    const buttons = screen.getAllByRole("button")
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAttribute("data-testid", "lane-archived-acknowledge")
  })

  it("stays open on Escape", async () => {
    const onAcknowledge = vi.fn()
    render(<LaneArchivedDialog laneLabel="Spanish" open onAcknowledge={onAcknowledge} />)
    await userEvent.keyboard("{Escape}")
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(onAcknowledge).not.toHaveBeenCalled()
  })

  it("stays open on a click outside", async () => {
    const onAcknowledge = vi.fn()
    render(<LaneArchivedDialog laneLabel="Spanish" open onAcknowledge={onAcknowledge} />)
    const backdrop = document.querySelector('[data-slot="dialog-overlay"]')
    expect(backdrop).not.toBeNull()
    await userEvent.click(backdrop as Element)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(onAcknowledge).not.toHaveBeenCalled()
  })

  it("acknowledges on its own button", async () => {
    const onAcknowledge = vi.fn()
    render(<LaneArchivedDialog laneLabel="Spanish" open onAcknowledge={onAcknowledge} />)
    await userEvent.click(screen.getByTestId("lane-archived-acknowledge"))
    expect(onAcknowledge).toHaveBeenCalledTimes(1)
  })

  it("renders nothing while closed", () => {
    render(<LaneArchivedDialog laneLabel="Spanish" open={false} onAcknowledge={() => {}} />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})
