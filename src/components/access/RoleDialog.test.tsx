// AQU-2289: the one dialog behind every Change role and Add member.

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RoleDialog } from "./RoleDialog"
import { ROLE, roleDescription } from "@/lib/frontier/roles"

vi.mock("@/hooks/useUserSearch", () => ({
  useUserSearch: () => ({ query: "", results: [], isLoading: false, needsMorePrefix: true, lastFetchOk: true }),
}))

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Base UI Select: a click does not commit under happy-dom; highlight + Enter does. */
async function pickRole(level: number) {
  const option = await screen.findByRole("option", { name: new RegExp(escapeRegExp(roleDescription(level))) })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(option, { key: "Enter" })
}

async function offeredLevels(comboName: RegExp): Promise<number[]> {
  fireEvent.click(screen.getByRole("combobox", { name: comboName }))
  const listbox = await screen.findByRole("listbox")
  const offered: number[] = []
  for (const level of [ROLE.VIEWER, ROLE.COMMENTER, ROLE.REVIEWER, ROLE.CONTRIBUTOR, ROLE.PROJECT_LEAD, ROLE.MAINTAINER, ROLE.OWNER]) {
    if (within(listbox).queryByRole("option", { name: new RegExp(escapeRegExp(roleDescription(level))) })) {
      offered.push(level)
    }
  }
  return offered
}

describe("RoleDialog — Change role", () => {
  it("offers an organization role from the five, never the project-only Commenter or Reviewer", async () => {
    render(
      <RoleDialog
        open
        onOpenChange={() => {}}
        mode="change"
        level="org"
        callerLevel={ROLE.OWNER}
        name="bob"
        currentLevel={ROLE.CONTRIBUTOR}
        onSave={vi.fn()}
      />,
    )
    expect(screen.getByTestId("role-dialog")).toHaveAttribute("data-role-level", "org")
    expect(screen.getByRole("heading", { name: "Change role for bob" })).toBeInTheDocument()
    expect(await offeredLevels(/role for bob/i)).toEqual([
      ROLE.VIEWER, ROLE.CONTRIBUTOR, ROLE.PROJECT_LEAD, ROLE.MAINTAINER, ROLE.OWNER,
    ])
  })

  it("never offers a project role above the chooser's own", async () => {
    render(
      <RoleDialog
        open
        onOpenChange={() => {}}
        mode="change"
        level="project"
        callerLevel={ROLE.PROJECT_LEAD}
        name="bob"
        currentLevel={ROLE.CONTRIBUTOR}
        onSave={vi.fn()}
      />,
    )
    expect(await offeredLevels(/role for bob/i)).toEqual([
      ROLE.VIEWER, ROLE.COMMENTER, ROLE.REVIEWER, ROLE.CONTRIBUTOR, ROLE.PROJECT_LEAD,
    ])
  })

  it("saves the picked role and closes", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onOpenChange = vi.fn()
    render(
      <RoleDialog
        open
        onOpenChange={onOpenChange}
        mode="change"
        level="project"
        callerLevel={ROLE.MAINTAINER}
        name="bob"
        currentLevel={ROLE.CONTRIBUTOR}
        onSave={onSave}
      />,
    )
    // Save waits for a different role.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    fireEvent.click(screen.getByRole("combobox", { name: /role for bob/i }))
    await pickRole(ROLE.REVIEWER)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(ROLE.REVIEWER, undefined))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("says why saving failed and stays open", async () => {
    const onOpenChange = vi.fn()
    render(
      <RoleDialog
        open
        onOpenChange={onOpenChange}
        mode="change"
        level="org"
        callerLevel={ROLE.OWNER}
        name="bob"
        currentLevel={ROLE.CONTRIBUTOR}
        onSave={vi.fn().mockRejectedValue(new Error("nope"))}
        errorMessage={() => "Only organization owners can change member roles."}
      />,
    )
    fireEvent.click(screen.getByRole("combobox", { name: /role for bob/i }))
    await pickRole(ROLE.MAINTAINER)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Only organization owners can change member roles.")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("warns in one line before making someone an Owner, with the rest behind the (i)", async () => {
    render(
      <RoleDialog
        open
        onOpenChange={() => {}}
        mode="change"
        level="org"
        callerLevel={ROLE.OWNER}
        name="bob"
        currentLevel={ROLE.MAINTAINER}
        onSave={vi.fn()}
      />,
    )
    expect(screen.queryByTestId("role-dialog-owner-warning")).toBeNull()
    fireEvent.click(screen.getByRole("combobox", { name: /role for bob/i }))
    await pickRole(ROLE.OWNER)
    const warning = await screen.findByTestId("role-dialog-owner-warning")
    expect(warning).toHaveTextContent(/Owners get full control of this organization/)
    const info = within(warning).getByTestId("role-dialog-owner-info")
    expect(info).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(info)
    expect(info).toHaveAttribute("aria-expanded", "true")
    expect(warning).toHaveTextContent(/You keep your own ownership/)
  })

  it("shows a current role the list no longer offers, without offering it", async () => {
    render(
      <RoleDialog
        open
        onOpenChange={() => {}}
        mode="change"
        level="org"
        callerLevel={ROLE.OWNER}
        name="cora"
        currentLevel={ROLE.COMMENTER}
        onSave={vi.fn()}
      />,
    )
    expect(screen.getByRole("combobox", { name: /role for cora/i })).toHaveTextContent("Commenter")
    expect(await offeredLevels(/role for cora/i)).not.toContain(ROLE.COMMENTER)
  })

  it("adds one known person, asking for Language lanes when the role needs them", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <RoleDialog
        open
        onOpenChange={() => {}}
        mode="change"
        level="project"
        callerLevel={ROLE.OWNER}
        name="carol"
        currentLevel={null}
        where="Ruth"
        targetLanes={[{ id: "l1", label: "Hausa" }, { id: "l2", label: "Akan" }]}
        onSave={onSave}
      />,
    )
    expect(screen.getByRole("heading", { name: "Add carol to Ruth" })).toBeInTheDocument()
    const add = screen.getByRole("button", { name: "Add" })
    expect(add).toBeDisabled()
    fireEvent.click(screen.getByRole("radio", { name: /every current/i }))
    expect(add).toBeEnabled()
    fireEvent.click(add)
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(ROLE.CONTRIBUTOR, { allCurrentLanes: true }))
  })
})

describe("RoleDialog — Add member", () => {
  it("offers the organization's add list in the people row: no Owner, no Commenter or Reviewer", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
      <RoleDialog
        open
        onOpenChange={() => {}}
        mode="add"
        level="org"
        callerLevel={ROLE.OWNER}
        title="Add a member"
        people={{
          kind: "row",
          row: { defaultRole: ROLE.CONTRIBUTOR, grantScope: { kind: "organization" }, scopedUserSearch: false, onAdd: vi.fn() },
        }}
        otherTabs={[{ value: "invite", label: "Invite by email", content: <p>invite</p> }]}
      />
      </QueryClientProvider>,
    )
    expect(screen.getByTestId("role-dialog")).toHaveAttribute("data-role-dialog-mode", "add")
    expect(screen.getByRole("tab", { name: "Add members" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Invite by email" })).toBeInTheDocument()
    expect(await offeredLevels(/^role$/i)).toEqual([
      ROLE.VIEWER, ROLE.CONTRIBUTOR, ROLE.PROJECT_LEAD, ROLE.MAINTAINER,
    ])
  })

  it("keeps the long explanation behind a click (i)", () => {
    render(
      <RoleDialog
        open
        onOpenChange={() => {}}
        mode="add"
        level="org"
        callerLevel={ROLE.OWNER}
        title="Add a member"
        summary="Add people to this organization, or invite them by email."
        details="Maintainers and Owners see every project."
        people={{ kind: "custom", body: <p>people</p> }}
      />,
    )
    const info = screen.getByTestId("role-dialog-info")
    expect(screen.getByTestId("role-dialog-details")).toHaveAttribute("data-open", "false")
    fireEvent.click(info)
    expect(screen.getByTestId("role-dialog-details")).toHaveAttribute("data-open", "true")
  })
})
