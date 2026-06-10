/**
 * FRO-271 — FileActionMenu: delete affordance gating.
 *
 * When onDelete is undefined (caller is below project_lead), the Delete button
 * and its separator must not appear.  When onDelete is provided, they appear.
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import { FileActionMenu } from "./FileActionMenu"

// Stub createPortal so renders land in the test DOM without document.body tricks.
vi.mock("react-dom", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react-dom")>()
  return {
    ...mod,
    createPortal: (children: React.ReactNode) => children,
  }
})

describe("FileActionMenu — delete affordance gating (FRO-271)", () => {
  const baseProps = {
    x: 0, y: 0,
    onClose: vi.fn(),
    onRename: vi.fn(),
    onMove: vi.fn(),
  }

  it("hides the Delete button when onDelete is undefined (below project_lead)", () => {
    render(<FileActionMenu {...baseProps} onDelete={undefined} />)
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull()
  })

  it("shows the Delete button when onDelete is provided (project_lead+)", () => {
    render(<FileActionMenu {...baseProps} onDelete={vi.fn()} />)
    expect(screen.getByRole("button", { name: /delete/i })).toBeTruthy()
  })
})
