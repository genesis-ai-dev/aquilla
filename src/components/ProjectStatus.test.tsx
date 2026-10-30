// AQU-2260 (Sam, Oct 29): an Overdue or Due soon status gives its date on a
// click, never on hover — and that click stays on the status, so a table row
// it sits in does not open.
import { describe, expect, it, vi } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import { renderWithTooltips, expectClickNote } from "@/test-utils/tooltip"
import { ProjectStatus } from "./ProjectStatus"

describe("ProjectStatus deadline note", () => {
  it("gives an overdue project's due date on click", async () => {
    renderWithTooltips(
      <ProjectStatus archived={false} reasons={[{ kind: "overdue", label: "Overdue" }]} deadlineAt="2026-10-01T12:00:00Z" />,
    )
    await expectClickNote(screen.getByRole("button", { name: /Overdue/ }), /Due/)
  })

  it("keeps the click on the status inside a clickable row", () => {
    const onRow = vi.fn()
    renderWithTooltips(
      <div onClick={onRow}>
        <ProjectStatus archived={false} reasons={[{ kind: "soon", label: "Due soon" }]} deadlineAt="2026-11-01T12:00:00Z" />
      </div>,
    )
    fireEvent.click(screen.getByRole("button", { name: /Due soon/ }))
    expect(onRow).not.toHaveBeenCalled()
  })

  it("draws a plain status, no button, when there is no date to give", () => {
    renderWithTooltips(<ProjectStatus archived={false} reasons={[{ kind: "stalled", label: "Stalled" }]} />)
    expect(screen.queryByRole("button")).toBeNull()
  })
})
