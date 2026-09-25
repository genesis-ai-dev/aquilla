// AQU-341 regression guard: every row in the Files panel must share one
// truncation rule and a stable name-column width, so two files with the SAME
// name truncate to the SAME visible string regardless of which optional
// affordances (progress meter, etc.) that row happens to render.

import { describe, it, expect, vi } from "vitest"
import { render, within, fireEvent } from "@testing-library/react"
import { FileRow } from "./FileRow"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { FileReference } from "@/lib/parsers/types"

const LONG_NAME = "Berean Standard Bible (English) — very long corpus name that overflows"

function makeFile(overrides: Partial<FileReference> = {}): FileReference {
  return {
    id: "f1",
    name: LONG_NAME,
    type: "usfm",
    createdAt: "2026-01-01T00:00:00.000Z",
    cellCount: 0,
    ...overrides,
  }
}

const NOOP_PROPS = {
  active: false,
  expanded: false,
  editing: false,
  onEditCommit: vi.fn(),
  onEditCancel: vi.fn(),
  onToggleExpand: vi.fn(),
  onSelect: vi.fn(),
  onStartRename: vi.fn(),
  onMove: vi.fn(),
}

function renderRow(props: Partial<React.ComponentProps<typeof FileRow>> = {}) {
  return render(
    <I18nProvider>
      <FileRow file={makeFile()} {...NOOP_PROPS} {...props} />
    </I18nProvider>,
  )
}

function nameLabel(container: HTMLElement): HTMLElement {
  // The name button carries the whole (untruncated) name as its text/accessible
  // name; truncation is CSS-only, so the DOM always holds the full string.
  const btn = within(container).getByRole("button", { name: LONG_NAME })
  return btn
}

describe("FileRow — AQU-341 truncation consistency", () => {
  it("offers a focusable named file control and keyboard row activation", () => {
    const onSelect = vi.fn()
    const { container, getByRole } = renderRow({ onSelect })
    expect(getByRole("button", { name: LONG_NAME }).tabIndex).toBe(0)
    const row = container.querySelector('[data-showcase="sidebar.file"]')!
    fireEvent.keyDown(row, { key: "Enter" })
    fireEvent.keyDown(row, { key: " " })
    expect(onSelect).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(getByRole("button", { name: "File actions" }), { key: "Enter" })
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it("names the rename field after the file it edits", () => {
    const { getByRole } = renderRow({ editing: true })
    expect(getByRole("textbox", { name: LONG_NAME })).toHaveValue(LONG_NAME)
  })
  it("offers section expansion for Scripture-shaped non-USFM imports", () => {
    const { getByRole } = renderRow({ file: makeFile({ type: "csv", hasScriptureContent: true }) })
    expect(getByRole("button", { name: "Expand" })).toBeInTheDocument()
  })

  it("renders the file name with the shared `truncate` rule", () => {
    const { container } = renderRow()
    const label = nameLabel(container)
    expect(label.className).toContain("truncate")
    // Truncation must sit on the flex item inside a `min-w-0` column, not on a
    // width-of-content span, or the label width follows its siblings.
    expect(label.className).toContain("w-full")
    const column = label.closest("div")
    expect(column?.className).toContain("min-w-0")
    expect(column?.className).toContain("flex-1")
  })

  it("keeps the same truncation rule and a stable-width progress slot whether or not the file has progress", () => {
    // Row A: a fully-imported file (progress meter shown).
    const withProgress = renderRow({ progress: { translated: 10, validated: 5, total: 10 } })
    // Row B: same name, a partial/empty import residue (no meter).
    const withoutProgress = renderRow({ progress: { translated: 0, validated: 0, total: 0 } })

    const slotA = withProgress.container.querySelector('[data-testid="file-row-progress-slot"]')
    const slotB = withoutProgress.container.querySelector('[data-testid="file-row-progress-slot"]')

    // The slot is reserved in BOTH cases — this is what keeps the name column
    // the same width across rows so identical names truncate identically.
    expect(slotA).not.toBeNull()
    expect(slotB).not.toBeNull()
    expect(slotA!.className).toContain("w-[50px]")
    expect(slotB!.className).toContain("w-[50px]")

    // And both name labels share the exact same truncation classes.
    expect(nameLabel(withProgress.container).className).toBe(
      nameLabel(withoutProgress.container).className,
    )
  })

  it("exposes both translated and validated percents on the reserved progress slot", () => {
    const { container } = renderRow({ progress: { translated: 8, validated: 5, total: 10 } })
    const slot = container.querySelector('[data-testid="file-row-progress-slot"]')
    expect(slot).toHaveAttribute("aria-label", "80% translated, 50% validated")
  })

  it("exposes the full (untruncated) name so the user can recover it", () => {
    const { container } = renderRow()
    // The accessible name is the full string even though it renders truncated.
    expect(nameLabel(container).textContent).toBe(LONG_NAME)
  })
})

describe("FileRow — file actions menu", () => {
  it("opens the row's own menu from the ⋯ button, however it was activated", () => {
    const { getByRole } = renderRow({ onDelete: vi.fn() })
    const trigger = getByRole("button", { name: "File actions" })

    expect(trigger).toHaveAttribute("aria-haspopup", "menu")

    // A keyboard activation reports no pointer coordinates. The button used to
    // dispatch a synthetic `contextmenu` at those coordinates, which anchored the
    // menu to the top-left corner of the viewport; the popup is now the button's
    // own, so it anchors to the button either way.
    fireEvent.click(trigger, { detail: 0, clientX: 0, clientY: 0 })

    const popup = document.querySelector('[data-slot="dropdown-menu-content"]')
    expect(popup).not.toBeNull()
    expect(trigger.getAttribute("aria-controls")).toBe(popup!.id)
    expect(getByRole("menuitem", { name: /rename/i })).toBeInTheDocument()
  })

  it("keeps a menu press from also opening the file", () => {
    const onSelect = vi.fn()
    const onStartRename = vi.fn()
    const { getByRole } = renderRow({ onSelect, onStartRename })

    fireEvent.click(getByRole("button", { name: "File actions" }))
    fireEvent.click(getByRole("menuitem", { name: /rename/i }))

    expect(onStartRename).toHaveBeenCalledTimes(1)
    // Clicking the row opens the file, and React bubbles a portalled popup's
    // events along the React tree — so the popup lives outside the row.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("opens Export and Assign work from the ⋯ menu without opening the file", () => {
    const onSelect = vi.fn()
    const onExport = vi.fn()
    const onAssignWork = vi.fn()
    const { getByRole } = renderRow({ onSelect, onExport, onAssignWork })

    fireEvent.click(getByRole("button", { name: "File actions" }))
    fireEvent.click(getByRole("menuitem", { name: /^Export$/ }))
    expect(onExport).toHaveBeenCalledTimes(1)

    fireEvent.click(getByRole("button", { name: "File actions" }))
    fireEvent.click(getByRole("menuitem", { name: /assign work/i }))
    expect(onAssignWork).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })
})

// AQU-894 regression guard: a file the reader isn't assigned to recedes, but
// stays fully usable. The point of the ticket is "make mine obvious" — not to
// invent an access rule the server doesn't enforce.
describe("FileRow — AQU-894 unassigned de-emphasis", () => {
  function row(container: HTMLElement): HTMLElement {
    return container.querySelector('[data-showcase="sidebar.file"]') as HTMLElement
  }

  it("leaves the row untouched by default", () => {
    const { container } = renderRow()
    expect(row(container).dataset.unassigned).toBeUndefined()
    expect(row(container).className).not.toContain("opacity-55")
  })

  it("dims a row that is not the reader's", () => {
    const { container } = renderRow({ unassigned: true })
    expect(row(container).dataset.unassigned).toBe("true")
    expect(row(container).className).toContain("opacity-55")
    // Recovers on hover/focus, so a dimmed row never feels unreachable.
    expect(row(container).className).toContain("hover:opacity-100")
  })

  it("does not dim the row the reader is currently in", () => {
    const { container } = renderRow({ unassigned: true, active: true })
    expect(row(container).className).not.toContain("opacity-55")
  })

  it("keeps the dimmed row selectable, so the dimming is never a lock", () => {
    const onSelect = vi.fn()
    const { container, getByRole } = renderRow({ unassigned: true, onSelect })
    fireEvent.click(getByRole("button", { name: LONG_NAME }))
    fireEvent.keyDown(row(container), { key: "Enter" })
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it("says WHY the row is dim, and that it can still be opened", () => {
    // Dimming carries nothing to a screen reader, so the row states it in text
    // — and states the second half too, or it is heard as a locked file.
    const { container } = renderRow({ unassigned: true })
    const note = container.querySelector(".sr-only")
    expect(note?.textContent).toContain("Not assigned to you")
    expect(note?.textContent).toContain("still open it")
    expect(renderRow().container.querySelector(".sr-only")).toBeNull()
  })
})
