import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { OrgMembersTable } from "./OrgMembersTable"
import { ROLE, roleDescription } from "@/lib/frontier/roles"
import type { OrgMember } from "@/lib/frontier/orgs"
import { expectClickNote } from "@/test-utils/tooltip"

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

    // Owner is a governance escalation — the dialog says so before saving,
    // in one line, with the rest behind its (i) (AQU-2289).
    const warning = await screen.findByTestId("role-dialog-owner-warning")
    expect(warning).toHaveTextContent(/Owners get full control of this organization/i)
    expect(warning).toHaveTextContent(/can't be undone here/i)
    expect(warning).toHaveTextContent(/You keep your own ownership/i)

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(add).toHaveBeenCalledWith("esther", ROLE.OWNER))
  })

  it("keeps the lower rungs available so a promotion is not forced", async () => {
    const { add } = renderTable()
    await openChangeRole("esther")

    fireEvent.click(await screen.findByRole("combobox", { name: /role for esther/i }))
    await pickRoleOption(ROLE.MAINTAINER)

    expect(screen.queryByTestId("role-dialog-owner-warning")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(add).toHaveBeenCalledWith("esther", ROLE.MAINTAINER))
  })

  // AQU-2260 (Sam, Oct 29): why a member's org role is read-only here is a
  // status note on the role itself, opened by a click, never a hover.
  it("says on click why a non-owner cannot change an org role", async () => {
    renderTable({ callerOrgRoleLevel: ROLE.MAINTAINER })
    await expectClickNote(
      await screen.findByRole("button", { name: /org-level role: contributor/i }),
      /can only be changed by an org owner/,
    )
  })

  it("does not offer Change role to a non-owner caller", async () => {
    renderTable({ callerOrgRoleLevel: ROLE.MAINTAINER })
    fireEvent.click(await screen.findByRole("button", { name: "Actions for esther" }))
    expect(screen.queryByRole("menuitem", { name: /change role/i })).not.toBeInTheDocument()
  })
})

// AQU-2289: the member list's Change role and Add a member open the one role
// dialog, with the organization's list.
describe("OrgMembersTable — the one role dialog (AQU-2289)", () => {
  it("Change role opens the one role dialog at the organization level", async () => {
    renderTable()
    await openChangeRole("esther")
    const dialog = await screen.findByTestId("role-dialog")
    expect(dialog).toHaveAttribute("data-role-dialog-mode", "change")
    expect(dialog).toHaveAttribute("data-role-level", "org")
    expect(within(dialog).getByRole("heading", { name: "Change role for esther" })).toBeInTheDocument()
  })

  it("Add a member opens the same dialog, with Invite by email beside it", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <OrgMembersTable
            orgId={7}
            members={MEMBERS}
            callerOrgRoleLevel={ROLE.OWNER}
            canAddToProjects={false}
            onAddToProjects={() => {}}
            add={vi.fn()}
            addMany={vi.fn(async () => [])}
            onRequestRemove={() => {}}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Add a member" }))
    const dialog = await screen.findByTestId("role-dialog")
    expect(dialog).toHaveAttribute("data-role-dialog-mode", "add")
    expect(dialog).toHaveAttribute("data-role-level", "org")
    expect(within(dialog).getByRole("tab", { name: "Invite by email" })).toBeInTheDocument()
  })

  it("says why a save was refused in plain words", async () => {
    const add = vi.fn(async () => { throw Object.assign(new Error("forbidden"), { status: 403 }) })
    renderTable({ add })
    await openChangeRole("esther")
    fireEvent.click(await screen.findByRole("combobox", { name: /role for esther/i }))
    await pickRoleOption(ROLE.MAINTAINER)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByRole("alert")).toBeInTheDocument()
  })
})

// AQU-1352 §3.7 rule 1: every roster row carries its origin. The org is the
// top scope, so an org row's role is always a direct grant there — the badge
// keeps org, team and project rosters speaking the same vocabulary.
describe("OrgMembersTable origin badge (AQU-1352)", () => {
  it("badges every org member row as direct", async () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <OrgMembersTable
          orgId={1}
          orgName="CAS"
          members={[
            { userId: 2, username: "anna", role: { level: 100, name: "viewer" } },
            { userId: 3, username: "ben", role: { level: 600, name: "maintainer" } },
          ]}
          callerOrgRoleLevel={100}
          canAddToProjects={false}
          onAddToProjects={vi.fn()}
          add={vi.fn()}
          addMany={vi.fn()}
          onRequestRemove={vi.fn()}
        />
      </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText("ben")).toBeInTheDocument()
    const origins = Array.from(container.querySelectorAll("[data-origin]")).map((el) => el.getAttribute("data-origin"))
    expect(origins).toEqual(["direct", "direct"])
  })
})
