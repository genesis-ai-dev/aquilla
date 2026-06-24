import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemberAccessRow } from "./MemberAccessPanel"
import { getMemberAccess } from "@/lib/frontier/orgs"
import { removeProjectMember } from "@/lib/frontier/members"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({ getMemberAccess: vi.fn() }))
vi.mock("@/lib/frontier/members", () => ({ removeProjectMember: vi.fn(async () => {}) }))

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
    vi.mocked(getMemberAccess).mockResolvedValue(ACCESS)
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
    vi.mocked(getMemberAccess).mockResolvedValue(ACCESS)
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
    vi.mocked(getMemberAccess).mockResolvedValue(ACCESS)
    renderRow()
    fireEvent.click(screen.getByRole("button", { name: /anna/ }))
    await screen.findByText("Mark")
    // pb is group-only → note about residual access via the team
    expect(screen.getAllByText(/Also via team/).length).toBeGreaterThan(0)
  })
})

describe("MemberAccessRow — FRO-427 permission denial on Revoke button", () => {
  function renderRowWithRole(callerOrgRoleLevel: number) {
    return render(
      <ul>
        <MemberAccessRow orgId={1} userId={2} username="anna" callerOrgRoleLevel={callerOrgRoleLevel} />
      </ul>,
    )
  }

  it("revoke button is enabled for PROJECT_LEAD (500)", async () => {
    vi.mocked(getMemberAccess).mockResolvedValue(ACCESS)
    renderRowWithRole(500)
    fireEvent.click(screen.getByRole("button", { name: /anna/ }))
    await screen.findByText("John")

    const revokeBtn = screen.getByTestId("revoke-direct-grant")
    expect(revokeBtn).not.toBeDisabled()
    expect(revokeBtn.getAttribute("title")).toBeNull()
  })

  it("revoke button is disabled with a denial tooltip for CONTRIBUTOR (400)", async () => {
    vi.mocked(getMemberAccess).mockResolvedValue(ACCESS)
    renderRowWithRole(400)
    fireEvent.click(screen.getByRole("button", { name: /anna/ }))
    await screen.findByText("John")

    const revokeBtn = screen.getByTestId("revoke-direct-grant")
    expect(revokeBtn).toBeDisabled()
    // Tooltip must mention the required role so the user understands why
    expect(revokeBtn.getAttribute("title")).toMatch(/project_lead/i)
  })

  it("revoke button is disabled with a denial tooltip for VIEWER (100)", async () => {
    vi.mocked(getMemberAccess).mockResolvedValue(ACCESS)
    renderRowWithRole(100)
    fireEvent.click(screen.getByRole("button", { name: /anna/ }))
    await screen.findByText("John")

    const revokeBtn = screen.getByTestId("revoke-direct-grant")
    expect(revokeBtn).toBeDisabled()
    expect(revokeBtn.getAttribute("title")).toMatch(/project_lead/i)
  })

  it("revoke button is enabled when callerOrgRoleLevel is not provided (fail-open)", async () => {
    vi.mocked(getMemberAccess).mockResolvedValue(ACCESS)
    render(
      <ul>
        <MemberAccessRow orgId={1} userId={2} username="anna" />
      </ul>,
    )
    fireEvent.click(screen.getByRole("button", { name: /anna/ }))
    await screen.findByText("John")

    const revokeBtn = screen.getByTestId("revoke-direct-grant")
    expect(revokeBtn).not.toBeDisabled()
  })
})
