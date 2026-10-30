// Project settings → Members → "Revoke all access" (AQU-2259: moved out of the
// unrouted ProjectMembersPage with the dialog; these tests used to reach it
// through that page's member list, which only the dead Share dialog showed).
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { RevokeAllDialog } from "./RevokeAllDialog"
import type { ProjectMember } from "@/lib/frontier/members"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "carol" } }),
}))
vi.mock("@/lib/frontier/members", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/frontier/members")>()
  return {
    ...original,
    revokeAllProjectAccess: vi.fn().mockResolvedValue({
      removed: true,
      grantPaths: [{ source: "override", level: 600, name: "maintainer", removable: true }],
    }),
  }
})

const alice: ProjectMember = {
  userId: 1,
  username: "alice",
  role: { level: 600, name: "maintainer", source: "override" },
  secondarySources: [],
}

function renderDialog(onRevoked = vi.fn(), onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <RevokeAllDialog member={alice} projectId="proj-1" onClose={onClose} onRevoked={onRevoked} />
    </MemoryRouter>,
  )
  return { onRevoked, onClose }
}

describe("RevokeAllDialog", () => {
  it("disables the confirm button until the username is typed", () => {
    renderDialog()
    expect(screen.getByText("Revoke all access")).toBeInTheDocument()
    const confirmBtn = screen.getByRole("button", { name: "Revoke access" })
    expect(confirmBtn).toBeDisabled()
    const input = screen.getByPlaceholderText("alice")
    fireEvent.change(input, { target: { value: "wrong" } })
    expect(confirmBtn).toBeDisabled()
    fireEvent.change(input, { target: { value: "alice" } })
    expect(confirmBtn).not.toBeDisabled()
  })

  it("calls revokeAllProjectAccess and shows the result after confirm", async () => {
    const { revokeAllProjectAccess } = await import("@/lib/frontier/members")
    renderDialog()
    fireEvent.change(screen.getByPlaceholderText("alice"), { target: { value: "alice" } })
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }))
    await waitFor(() => expect(revokeAllProjectAccess).toHaveBeenCalledWith("test-jwt", "proj-1", 1))
    await waitFor(() => expect(screen.getByText("Access revoked")).toBeInTheDocument())
  })

  it("shows grant paths as role labels, not numeric levels (FRO-368)", async () => {
    renderDialog()
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Maintainer")).toBeInTheDocument()
    expect(within(dialog).queryByText(/\(level \d+\)/i)).not.toBeInTheDocument()
  })
})
