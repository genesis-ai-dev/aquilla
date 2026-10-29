// AQU-2260 (Sam, Oct 29): a grant that can't be revoked here says why on a
// click of its "via …" label, never on hover.
import { describe, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import { renderWithTooltips, expectClickNote } from "@/test-utils/tooltip"
import { ExternalCollaboratorsSection } from "./ExternalCollaboratorsSection"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "joel", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/members", () => ({
  fetchOrgMembersMatrix: vi.fn(async () => new Map()),
  removeProjectMember: vi.fn(async () => {}),
}))
vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjectsResult: vi.fn(async () => ({ ok: true, projects: [{ id: "p1", name: "Genesis" }] })),
  projectsResultError: vi.fn(() => new Error("x")),
}))
vi.mock("@/lib/frontier/external-collaborators", () => ({
  deriveExternalCollaborators: () => [{
    userId: 5,
    username: "guest",
    grants: [
      { projectId: "p1", projectName: "Genesis", roleName: "reviewer", source: "group" },
      { projectId: "p2", projectName: "Exodus", roleName: "owner", source: "creator" },
    ],
  }],
}))

describe("ExternalCollaboratorsSection", () => {
  it("says on click why a team grant can't be revoked here", async () => {
    renderWithTooltips(<ExternalCollaboratorsSection orgId={1} orgMemberIds={[1]} />)
    await expectClickNote(await screen.findByRole("button", { name: "via group" }), /Access via a team/)
  })

  it("says on click that a creator grant is the project creator's", async () => {
    renderWithTooltips(<ExternalCollaboratorsSection orgId={1} orgMemberIds={[1]} />)
    await expectClickNote(await screen.findByRole("button", { name: "via creator" }), "Project creator")
  })
})
