import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { PrivilegedMembersDialog } from "./PrivilegedMembersDialog"
import { renderWithTooltips } from "@/test-utils/tooltip"
import type { ProjectMember, ProjectRosterResult } from "@/lib/frontier/members"

const { fetchPrivilegedProjectMembers } = vi.hoisted(() => ({
  fetchPrivilegedProjectMembers: vi.fn(),
}))

vi.mock("@/lib/frontier/members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontier/members")>()
  return {
    ...actual,
    fetchPrivilegedProjectMembers: (...args: unknown[]) => fetchPrivilegedProjectMembers(...args),
  }
})

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "tok", username: "carol", email: "carol@local.test" },
    loading: false,
  }),
}))

function member(overrides: Partial<ProjectMember> = {}): ProjectMember {
  return {
    userId: 1,
    username: "dev",
    email: "dev@local.test",
    role: { level: 700, name: "owner", source: "creator" },
    secondarySources: [],
    ...overrides,
  }
}

function renderDialog(open = true) {
  return renderWithTooltips(
    <I18nProvider>
      <PrivilegedMembersDialog
        open={open}
        onOpenChange={vi.fn()}
        projectId="dev-project"
        roleLabel="Maintainers"
      />
    </I18nProvider>,
  )
}

beforeEach(() => {
  fetchPrivilegedProjectMembers.mockReset()
})

describe("PrivilegedMembersDialog", () => {
  it("lists only the people returned by the privileged members fetch", async () => {
    const result: ProjectRosterResult = {
      kind: "ok",
      members: [
        member({ userId: 2, username: "alice", email: "alice@local.test", role: { level: 600, name: "maintainer", source: "org" } }),
        member(),
      ],
    }
    fetchPrivilegedProjectMembers.mockResolvedValueOnce(result)
    renderDialog()
    expect(await screen.findByRole("dialog")).toBeTruthy()
    expect(screen.getByRole("heading", { name: /project maintainers/i })).toBeTruthy()
    expect(screen.getByText(/can change shared settings/i)).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByText("dev")).toBeTruthy()
      expect(screen.getByText("alice")).toBeTruthy()
    })
    expect(screen.queryByText("carol")).toBeNull()
    expect(fetchPrivilegedProjectMembers).toHaveBeenCalledWith("tok", "dev-project")
  })

  it("does not treat a contributor-only roster as people who can modify", async () => {
    fetchPrivilegedProjectMembers.mockResolvedValueOnce({ kind: "ok", members: [] })
    renderDialog()
    expect(await screen.findByText(/no maintainers on this project/i)).toBeTruthy()
  })

  it("shows an error with a docs link when the privileged list cannot load", async () => {
    fetchPrivilegedProjectMembers.mockResolvedValueOnce({ kind: "roster-hidden" })
    renderDialog()
    expect(await screen.findByText(/couldn't load maintainers/i)).toBeTruthy()
    expect(screen.getByRole("link", { name: /learn about permission levels/i })).toHaveAttribute(
      "target",
      "_blank",
    )
  })
})
