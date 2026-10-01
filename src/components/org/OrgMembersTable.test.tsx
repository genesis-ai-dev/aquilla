import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { OrgMembersTable } from "./OrgMembersTable"
import { ROLE, roleDescription } from "@/lib/frontier/roles"
import type { OrgMember } from "@/lib/frontier/orgs"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "joel", createdAt: "x" }, loading: false }),
}))

afterEach(() => vi.clearAllMocks())

const MEMBERS: OrgMember[] = [
  { userId: 1, username: "joel", email: "joel@frontier.test", role: { level: ROLE.OWNER, name: "owner" } },
  { userId: 2, username: "esther", email: "esther@odb.test", role: { level: ROLE.CONTRIBUTOR, name: "contributor" } },
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Base UI Select: click does not commit under happy-dom — highlight + Enter. */
async function pickRoleOption(level: number) {
  const option = await screen.findByRole("option", {
    name: new RegExp(escapeRegExp(roleDescription(level))),
  })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(option, { key: "Enter" })
}

function renderTable(overrides: Partial<Parameters<typeof OrgMembersTable>[0]> = {}) {
  const add = vi.fn(async () => ({}))
  render(
    <OrgMembersTable
      orgId={7}
      members={MEMBERS}
      callerOrgRoleLevel={ROLE.OWNER}
      canAddToProjects={false}
      onAddToProjects={() => {}}
      add={add}
      addMany={vi.fn(async () => [])}
      onRequestRemove={() => {}}
      {...overrides}
    />,
  )
  return { add }
}

async function openChangeRole(username: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${username}` }))
  fireEvent.click(await screen.findByRole("menuitem", { name: /change role/i }))
}

describe("OrgMembersTable — org role change (AQU-952)", () => {
  it("lets an owner promote a member to Owner, handing the workspace over", async () => {
    const { add } = renderTable()
    await openChangeRole("esther")

    fireEvent.click(await screen.findByRole("combobox", { name: /role for esther/i }))
    const listbox = await screen.findByRole("listbox")
    expect(
      within(listbox).getByRole("option", { name: new RegExp(escapeRegExp(roleDescription(ROLE.OWNER))) }),
    ).toBeInTheDocument()

    await pickRoleOption(ROLE.OWNER)

    // Owner is a governance escalation — the dialog says so before saving.
    expect(await screen.findByText(/Owners get full control of this workspace/i)).toBeInTheDocument()
    expect(screen.getByText(/You keep your own ownership/i)).toBeInTheDocument()
    expect(screen.getByText(/cannot be undone here/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(add).toHaveBeenCalledWith("esther", ROLE.OWNER))
  })

  it("keeps the lower rungs available so a promotion is not forced", async () => {
    const { add } = renderTable()
    await openChangeRole("esther")

    fireEvent.click(await screen.findByRole("combobox", { name: /role for esther/i }))
    await pickRoleOption(ROLE.MAINTAINER)

    expect(screen.queryByText(/Owners get full control of this workspace/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(add).toHaveBeenCalledWith("esther", ROLE.MAINTAINER))
  })

  it("does not offer Change role to a non-owner caller", async () => {
    renderTable({ callerOrgRoleLevel: ROLE.MAINTAINER })
    fireEvent.click(await screen.findByRole("button", { name: "Actions for esther" }))
    expect(screen.queryByRole("menuitem", { name: /change role/i })).not.toBeInTheDocument()
  })
})
