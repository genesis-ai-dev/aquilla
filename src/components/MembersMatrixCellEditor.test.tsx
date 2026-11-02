// AQU-2289: a members-matrix cell's Change role and add open the one role
// dialog, with the project list capped at the caller's own role.

import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MembersMatrixCellEditor } from "./MembersMatrixCellEditor"
import { ROLE, roleDescription } from "@/lib/frontier/roles"
import type { MatrixCell } from "@/hooks/useProjectsMembersMatrix"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt-pm", username: "pm", createdAt: "x" }, loading: false }),
}))
vi.mock("@/hooks/useCurrentTargetLanes", () => ({
  useCurrentTargetLanes: () => ({ lanes: [], ready: true }),
}))
const { addProjectMember, removeProjectMember } = vi.hoisted(() => ({
  addProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
}))
vi.mock("@/lib/frontier/members", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontier/members")>()),
  addProjectMember,
  removeProjectMember,
}))

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function renderCell(cell: MatrixCell | undefined, callerLevel: number | null, username = "carol") {
  const onMutated = vi.fn()
  render(
    <table>
      <tbody>
        <tr>
          <MembersMatrixCellEditor
            cell={cell}
            userId={4}
            username={username}
            projectId="gen"
            projectName="Genesis"
            callerLevel={callerLevel}
            grantLanes="all"
            onMutated={onMutated}
            cellClassName=""
            sourceBadge={cell ? "D" : ""}
          />
        </tr>
      </tbody>
    </table>,
  )
  return { onMutated }
}

function offered(): number[] {
  fireEvent.click(within(screen.getByTestId("role-dialog")).getByRole("combobox"))
  const listbox = screen.getByRole("listbox")
  return [ROLE.VIEWER, ROLE.COMMENTER, ROLE.REVIEWER, ROLE.CONTRIBUTOR, ROLE.PROJECT_LEAD, ROLE.MAINTAINER, ROLE.OWNER]
    .filter((level) => within(listbox).queryByRole("option", { name: new RegExp(escapeRegExp(roleDescription(level))) }))
}

const direct = (level: number): MatrixCell => ({
  role: { level, name: "x", source: "override" },
  secondarySources: [],
})

beforeEach(() => {
  addProjectMember.mockReset()
  addProjectMember.mockResolvedValue({})
  removeProjectMember.mockReset()
})

describe("MembersMatrixCellEditor — the one role dialog (AQU-2289)", () => {
  it("an editable cell's Change role opens the dialog with the project list, capped at the caller's role", async () => {
    renderCell(direct(ROLE.CONTRIBUTOR), ROLE.PROJECT_LEAD)
    fireEvent.click(screen.getByRole("button", { name: "Edit carol's role on this project" }))
    fireEvent.click(await screen.findByRole("button", { name: "Change role" }))
    const dialog = await screen.findByTestId("role-dialog")
    expect(dialog).toHaveAttribute("data-role-level", "project")
    expect(within(dialog).getByRole("heading", { name: "Change role for carol" })).toBeInTheDocument()
    expect(offered()).toEqual([ROLE.VIEWER, ROLE.COMMENTER, ROLE.REVIEWER, ROLE.CONTRIBUTOR, ROLE.PROJECT_LEAD])
  })

  it("an empty cell opens the dialog to add that one person", async () => {
    const { onMutated } = renderCell(undefined, ROLE.OWNER)
    fireEvent.click(screen.getByRole("button", { name: "Add carol to project" }))
    const dialog = await screen.findByTestId("role-dialog")
    expect(within(dialog).getByRole("heading", { name: "Add carol to Genesis" })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }))
    await waitFor(() => expect(addProjectMember).toHaveBeenCalledWith("jwt-pm", "gen", "carol", ROLE.CONTRIBUTOR))
    await waitFor(() => expect(onMutated).toHaveBeenCalled())
  })

  it("an org-wide cell sets a role for this project through the same dialog", async () => {
    renderCell({ role: { level: ROLE.MAINTAINER, name: "maintainer", source: "org" }, secondarySources: [] }, ROLE.OWNER)
    fireEvent.click(screen.getByRole("button", { name: "Edit carol's role on this project" }))
    fireEvent.click(await screen.findByRole("button", { name: "Set a role for this project…" }))
    expect(await screen.findByTestId("role-dialog")).toHaveAttribute("data-role-level", "project")
  })

  it("says why a member at or above the caller's own role can't be changed, instead of offering it", async () => {
    renderCell(direct(ROLE.MAINTAINER), ROLE.MAINTAINER)
    fireEvent.click(screen.getByRole("button", { name: "Edit carol's role on this project" }))
    expect(await screen.findByText(/can't change a member whose role is at or above your own/i)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Change role" })).toBeNull()
  })

  it("keeps Remove from project beside Change role", async () => {
    const { onMutated } = renderCell(direct(ROLE.CONTRIBUTOR), ROLE.OWNER)
    fireEvent.click(screen.getByRole("button", { name: "Edit carol's role on this project" }))
    fireEvent.click(await screen.findByRole("button", { name: /remove from project/i }))
    await waitFor(() => expect(removeProjectMember).toHaveBeenCalledWith("jwt-pm", "gen", 4))
    await waitFor(() => expect(onMutated).toHaveBeenCalled())
  })
})
