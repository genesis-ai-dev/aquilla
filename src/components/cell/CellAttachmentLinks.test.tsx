/**
 * AQU-777 — the attachment links under a cell.
 *
 * Small surface, but two behaviours are load-bearing enough to pin: the click
 * must NOT bubble (the row's own handler starts a target edit, so a click on a
 * link would otherwise also put the caret in the editor), and a cell with no
 * attachments must render nothing at all rather than an empty container that
 * adds height to every row in the table.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CellAttachmentLinks } from "./CellAttachmentLinks"
import type { CellAttachmentRecord } from "@/lib/sync/cell-attachments-read-types"

function makeRecord(overrides: Partial<CellAttachmentRecord> = {}): CellAttachmentRecord {
  return {
    attachmentId: "att-1",
    projectId: "proj-1",
    fileId: "file-1",
    cellId: "GEN 1:1",
    objectName: "att-1.png",
    name: "layout.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    authorId: "ana",
    authorLabel: "ana",
    createdAt: 1000,
    cellRef: "GEN 1:1",
    ...overrides,
  }
}

describe("CellAttachmentLinks", () => {
  it("renders nothing when the cell has no attachments", () => {
    const { container } = render(
      <CellAttachmentLinks attachments={[]} onOpen={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("lists every attachment by its own file name", () => {
    render(
      <CellAttachmentLinks
        attachments={[
          makeRecord({ attachmentId: "a1", name: "one.png" }),
          makeRecord({ attachmentId: "a2", name: "two.png" }),
        ]}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByText("one.png")).toBeInTheDocument()
    expect(screen.getByText("two.png")).toBeInTheDocument()
  })

  it("opens the clicked attachment by id", async () => {
    const onOpen = vi.fn()
    render(<CellAttachmentLinks attachments={[makeRecord({ attachmentId: "a7" })]} onOpen={onOpen} />)
    await userEvent.click(screen.getByRole("button", { name: /layout\.png/ }))
    expect(onOpen).toHaveBeenCalledWith("a7")
  })

  it("does not let the click reach the row underneath", async () => {
    // The row's click handler starts a target edit. Without stopPropagation,
    // opening an attachment would also drop the caret into the editor.
    const rowClick = vi.fn()
    render(
      <div onClick={rowClick}>
        <CellAttachmentLinks attachments={[makeRecord()]} onOpen={() => {}} />
      </div>,
    )
    await userEvent.click(screen.getByRole("button", { name: /layout\.png/ }))
    expect(rowClick).not.toHaveBeenCalled()
  })

  it("gives each link an accessible name that says what clicking does", () => {
    render(<CellAttachmentLinks attachments={[makeRecord()]} onOpen={() => {}} />)
    expect(
      screen.getByRole("button", { name: /layout\.png — Show in the attachments panel/i }),
    ).toBeInTheDocument()
  })
})
