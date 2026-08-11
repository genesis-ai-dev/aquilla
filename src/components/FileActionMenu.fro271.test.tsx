/**
 * AQU-271 — FileActionMenu: delete affordance gating.
 *
 * When onDelete is undefined (caller is below project_lead), the Delete button
 * and its separator must not appear.  When onDelete is provided, they appear.
 */

import { render, screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { FileActionMenu } from "./FileActionMenu"

// The menu is built on the shadcn ContextMenu (Base UI), which portals to
// document.body when open — screen queries see it without any portal stubbing.

function renderMenu(onDelete?: () => void) {
  return render(
    <I18nProvider>
      <ContextMenu open>
        <ContextMenuTrigger>trigger</ContextMenuTrigger>
        <FileActionMenu
          onRename={vi.fn()}
          onMove={vi.fn()}
          onDelete={onDelete}
        />
      </ContextMenu>
    </I18nProvider>,
  )
}

describe("FileActionMenu — delete affordance gating (AQU-271)", () => {
  it("hides the Delete item when onDelete is undefined (below project_lead)", () => {
    renderMenu(undefined)
    expect(screen.queryByRole("menuitem", { name: /delete/i })).toBeNull()
  })

  it("shows the Delete item when onDelete is provided (project_lead+)", () => {
    renderMenu(vi.fn())
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeTruthy()
  })
})
