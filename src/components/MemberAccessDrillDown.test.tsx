// AQU-2260 (Sam, Oct 29): each grant path under a project says what it means
// on a click, never on hover. The project's own name may still show in full on
// hover (it is the name, truncated).
import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import { renderWithTooltips, expectClickNote } from "@/test-utils/tooltip"
import { MemberAccessDrillDown } from "./MemberAccessDrillDown"

vi.mock("@/hooks/useMemberAccess", () => ({
  useMemberAccess: () => ({
    kind: "success",
    data: {
      orgRole: null,
      projects: [{
        projectId: "p1",
        projectName: "Genesis",
        direct: 400,
        groups: [{ groupId: 9, name: "Reviewers", roleLevel: 300 }],
        org: null,
        creator: false,
        resolved: 400,
      }],
    },
  }),
}))

describe("MemberAccessDrillDown", () => {
  it("opens what each grant path means on click", async () => {
    renderWithTooltips(<MemberAccessDrillDown orgId={1} userId={2} username="anna" onClose={() => {}} />)
    const paths = screen.getAllByRole("button").filter((b) => b.dataset.slot === "note-on-click")
    expect(paths).toHaveLength(2)
    await expectClickNote(paths[0], "Explicitly added to this project (direct grant / override)")
    await expectClickNote(paths[1], 'Member of group "Reviewers" which has a project grant')
  })
})
