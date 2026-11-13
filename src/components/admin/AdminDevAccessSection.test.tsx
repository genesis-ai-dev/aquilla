/**
 * AdminDevAccessSection (AQU-2469): lists who may use dev, adds a normalised
 * email, removes one, and says plainly when the list does nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { AdminDevAccessSection } from "./AdminDevAccessSection"

vi.mock("@/lib/frontier/admin", () => ({
  getAdminDevAccess: vi.fn(),
  addAdminDevAccess: vi.fn(),
  removeAdminDevAccess: vi.fn(),
}))
import * as api from "@/lib/frontier/admin"

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getAdminDevAccess).mockResolvedValue({
    enabled: true,
    entries: [{ email: "qa-bot@example.com", addedBy: "root@example.com", addedAt: "2026-11-09T00:00:00Z" }],
  })
  vi.mocked(api.addAdminDevAccess).mockResolvedValue({} as never)
  vi.mocked(api.removeAdminDevAccess).mockResolvedValue()
})

describe("AdminDevAccessSection", () => {
  it("adds a trimmed, lower-cased email", async () => {
    render(<AdminDevAccessSection jwt="t" />)
    expect(await screen.findByText("qa-bot@example.com")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Add someone"), { target: { value: "  New@Example.com " } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(api.addAdminDevAccess).toHaveBeenCalledWith("t", "new@example.com"))
  })

  it("will not submit a malformed email", async () => {
    render(<AdminDevAccessSection jwt="t" />)
    await screen.findByText("qa-bot@example.com")
    fireEvent.change(screen.getByLabelText("Add someone"), { target: { value: "not-an-email" } })
    expect(screen.getByText("Enter a valid email address.")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("removes an entry after confirming", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true))
    render(<AdminDevAccessSection jwt="t" />)
    fireEvent.click(await screen.findByRole("button", { name: "Remove qa-bot@example.com" }))
    await waitFor(() => expect(api.removeAdminDevAccess).toHaveBeenCalledWith("t", "qa-bot@example.com"))
    vi.unstubAllGlobals()
  })

  it("directs list management to dev when it is off", async () => {
    vi.mocked(api.getAdminDevAccess).mockResolvedValue({ enabled: false, entries: [] })
    render(<AdminDevAccessSection jwt="t" />)
    expect(await screen.findByText(/Manage access.*dev\.aquilla\.app/)).toBeTruthy()
    expect(screen.queryByLabelText("Add someone")).toBeNull()
  })
})
