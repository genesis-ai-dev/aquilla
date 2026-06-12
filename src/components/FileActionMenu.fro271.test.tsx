/**
 * FRO-271 — FileActionMenu: delete affordance gating.
 *
 * When onDelete is undefined (caller is below project_lead), the Delete button
 * and its separator must not appear.  When onDelete is provided, they appear.
 */

import { render, screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import { FileActionMenu } from "./FileActionMenu"

// The menu is built on the shadcn DropdownMenu (Base UI), which portals to
// document.body — screen queries see it without any portal stubbing.

describe("FileActionMenu — delete affordance gating (FRO-271)", () => {
  const baseProps = {
    x: 0, y: 0,
    onClose: vi.fn(),
    onRename: vi.fn(),
    onMove: vi.fn(),
  }

  it("hides the Delete item when onDelete is undefined (below project_lead)", () => {
    render(<FileActionMenu {...baseProps} onDelete={undefined} />)
    expect(screen.queryByRole("menuitem", { name: /delete/i })).toBeNull()
  })

  it("shows the Delete item when onDelete is provided (project_lead+)", () => {
    render(<FileActionMenu {...baseProps} onDelete={vi.fn()} />)
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeTruthy()
  })
})
