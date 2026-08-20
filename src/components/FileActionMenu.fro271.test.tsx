/**
 * FileActionMenu — delete / export / assign-work affordance gating.
 *
 * When an optional callback is undefined, that item must not appear.
 * When it is provided, the item appears.
 */

import { render, screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { FileActionMenu } from "./FileActionMenu"

// The menu is built on the shadcn ContextMenu (Base UI), which portals to
// document.body when open — screen queries see it without any portal stubbing.

function renderMenu(overrides: Partial<Parameters<typeof FileActionMenu>[0]> = {}) {
  return render(
    <I18nProvider>
      <ContextMenu open>
        <ContextMenuTrigger>trigger</ContextMenuTrigger>
        <ContextMenuContent>
          <FileActionMenu
            onRename={vi.fn()}
            onMove={vi.fn()}
            {...overrides}
          />
        </ContextMenuContent>
      </ContextMenu>
    </I18nProvider>,
  )
}

describe("FileActionMenu — delete affordance gating (AQU-271)", () => {
  it("hides the Delete item when onDelete is undefined (below project_lead)", () => {
    renderMenu()
    expect(screen.queryByRole("menuitem", { name: /delete/i })).toBeNull()
  })

  it("shows the Delete item when onDelete is provided (project_lead+)", () => {
    renderMenu({ onDelete: vi.fn() })
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeTruthy()
  })
})

describe("FileActionMenu — export and assign work", () => {
  it("hides Export and Assign work when their callbacks are omitted", () => {
    renderMenu()
    expect(screen.queryByRole("menuitem", { name: /^Export$/ })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: /assign work/i })).toBeNull()
  })

  it("shows Assign work above Export when both callbacks are provided", () => {
    renderMenu({ onExport: vi.fn(), onAssignWork: vi.fn() })
    const assign = screen.getByRole("menuitem", { name: /assign work/i })
    const exportItem = screen.getByRole("menuitem", { name: /^Export$/ })
    expect(
      assign.compareDocumentPosition(exportItem) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})
