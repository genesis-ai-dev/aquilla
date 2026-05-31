import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemberAccessRow } from "./MemberAccessPanel"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
const getMemberAccess = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({ getMemberAccess: (...a: unknown[]) => getMemberAccess(...a) }))
const removeProjectMember = vi.fn(async () => {})
vi.mock("@/lib/frontier/members", () => ({ removeProjectMember: (...a: unknown[]) => removeProjectMember(...a) }))

afterEach(() => vi.clearAllMocks())

const ACCESS = {
  orgRole: 100,
  projects: [
    { projectId: "pa", projectName: "John", direct: 300, groups: [{ groupId: 5, name: "Translators", roleLevel: 400 }], org: 100, creator: false, resolved: 400 },
    { projectId: "pb", projectName: "Mark", direct: null, groups: [{ groupId: 5, name: "Translators", roleLevel: 200 }], org: 100, creator: false, resolved: 200 },
  ],
}

function renderRow() {
  return render(
    <ul>
      <MemberAccessRow orgId={1} userId={2} username="anna" />
    </ul>,
  )
}

describe("MemberAccessRow", () => {
  it("expands to show per-project grant paths with resolved role", async () => {
    getMemberAccess.mockResolvedValue(ACCESS)
    renderRow()
    fireEvent.click(screen.getByRole("button", { name: /anna/ }))

    await waitFor(() => expect(getMemberAccess).toHaveBeenCalledWith("jwt", 1, 2))
    expect(await screen.findByText("John")).toBeInTheDocument()
    expect(screen.getByText("Mark")).toBeInTheDocument()
    expect(screen.getByText(/Org role:/)).toBeInTheDocument()
    // a team path chip renders for the project
    expect(screen.getAllByText(/Translators/).length).toBeGreaterThan(0)
  })

  it("revokes the direct grant via removeProjectMember, leaving inherited paths", async () => {
    getMemberAccess.mockResolvedValue(ACCESS)
    renderRow()
    fireEvent.click(screen.getByRole("button", { name: /anna/ }))
    await screen.findByText("John")

    // Only the direct-granted project (pa) exposes a revoke button.
    const revokeButtons = screen.getAllByRole("button", { name: /revoke direct grant/i })
    expect(revokeButtons).toHaveLength(1)
    fireEvent.click(revokeButtons[0])
    await waitFor(() => expect(removeProjectMember).toHaveBeenCalledWith("jwt", "pa", 2))
  })

  it("shows a blast-radius note for non-direct paths", async () => {
    getMemberAccess.mockResolvedValue(ACCESS)
    renderRow()
    fireEvent.click(screen.getByRole("button", { name: /anna/ }))
    await screen.findByText("Mark")
    // pb is group-only → note about residual access via the team
    expect(screen.getAllByText(/Also via team/).length).toBeGreaterThan(0)
  })
})
