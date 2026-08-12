// The remote timing-mode heads-up dialog (2026-08-06).
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TimingModeChangedDialog } from "./TimingModeChangedDialog"

describe("TimingModeChangedDialog", () => {
  it("renders nothing without a pending ack", () => {
    render(<TimingModeChangedDialog ack={null} onAcknowledge={() => {}} />)
    expect(screen.queryByTestId("timing-mode-changed-ack")).toBeNull()
  })

  it("names both modes and OK acknowledges", () => {
    const onAcknowledge = vi.fn()
    render(
      <TimingModeChangedDialog ack={{ from: "dubbing", to: "audioFirst" }} onAcknowledge={onAcknowledge} />,
    )
    const dialog = screen.getByTestId("timing-mode-changed-ack")
    expect(dialog).toHaveTextContent("Original's timing")
    expect(dialog).toHaveTextContent("Free timing")
    fireEvent.click(screen.getByTestId("timing-ack-ok"))
    expect(onAcknowledge).toHaveBeenCalledTimes(1)
  })
})
