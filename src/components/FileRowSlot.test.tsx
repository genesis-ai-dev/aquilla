// AQU-2654: a sidebar file row re-renders for what it shows, never for the
// callbacks its list rebuilds on every render — and still calls the latest one.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { FileReference } from "@/lib/parsers/types"
import type { FileRowProps } from "./FileRow"

const rowRendered = vi.hoisted(() => vi.fn())
vi.mock("./FileRow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./FileRow")>()
  const { createElement } = await import("react")
  return {
    ...actual,
    FileRow: (props: FileRowProps) => {
      rowRendered()
      return createElement(actual.FileRow, props)
    },
  }
})

import { FileRowSlot } from "./FileRowSlot"

const file = { id: "f1", name: "GEN.usfm", type: "usfm" } as FileReference

function props(overrides: Partial<FileRowProps> = {}): FileRowProps {
  return {
    file,
    active: false,
    expanded: false,
    editing: false,
    progress: { translated: 3, validated: 1, total: 10 },
    // Fresh closures every time, as the file list builds them.
    onEditCommit: () => {},
    onEditCancel: () => {},
    onToggleExpand: () => {},
    onSelect: () => {},
    onStartRename: () => {},
    onMove: () => {},
    ...overrides,
  }
}

describe("FileRowSlot", () => {
  beforeEach(() => {
    rowRendered.mockClear()
  })

  it("does not re-render the row when only its callbacks are rebuilt", () => {
    const view = render(<FileRowSlot {...props()} />)
    expect(rowRendered).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 5; i++) view.rerender(<FileRowSlot {...props()} />)
    expect(rowRendered).toHaveBeenCalledTimes(1)
  })

  it("calls the callback from the latest render, not the one the row was drawn with", () => {
    const first = vi.fn()
    const latest = vi.fn()
    const view = render(<FileRowSlot {...props({ onSelect: first })} />)
    view.rerender(<FileRowSlot {...props({ onSelect: latest })} />)
    expect(rowRendered).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "GEN.usfm" }))
    expect(latest).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it("re-renders when what the row shows changes", () => {
    const view = render(<FileRowSlot {...props()} />)
    view.rerender(<FileRowSlot {...props({ active: true })} />)
    expect(rowRendered).toHaveBeenCalledTimes(2)
    view.rerender(<FileRowSlot {...props({ active: true, progress: { translated: 4, validated: 1, total: 10 } })} />)
    expect(rowRendered).toHaveBeenCalledTimes(3)
  })

  it("treats a new progress object with the same figures as no change", () => {
    const view = render(<FileRowSlot {...props()} />)
    view.rerender(<FileRowSlot {...props({ progress: { translated: 3, validated: 1, total: 10 } })} />)
    expect(rowRendered).toHaveBeenCalledTimes(1)
  })

  it("re-renders when an action appears or goes away, and offers exactly the ones given", () => {
    const onDelete = vi.fn()
    const view = render(<FileRowSlot {...props()} />)
    view.rerender(<FileRowSlot {...props({ onDelete })} />)
    expect(rowRendered).toHaveBeenCalledTimes(2)
    view.rerender(<FileRowSlot {...props({ onDelete: () => {} })} />)
    expect(rowRendered).toHaveBeenCalledTimes(2)
    view.rerender(<FileRowSlot {...props()} />)
    expect(rowRendered).toHaveBeenCalledTimes(3)
  })
})
