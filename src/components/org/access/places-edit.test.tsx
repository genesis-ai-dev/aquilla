/**
 * AQU-2321: editing on the Places lens. Only a direct row is editable: its
 * pill is a dropdown capped at the viewer's own role there, and its × opens
 * the Remove dialog. An inherited row is never a dropdown; it names where the
 * grant is set and goes there. If any of that drifts, the lens offers a
 * change the server refuses, or lets a Project lead think they can raise
 * someone past themselves, or hides where an inherited role can be changed.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { PlaceGrantability } from "@/lib/access/grant-rules"

import type { AccessTreeNode, OrgAccessPerson } from "./org-access-data"
import { PlacesLens, type PlaceEditing } from "./PlacesLens"

const changeGrantRole = vi.fn<(...args: unknown[]) => Promise<void>>()
const fetchRemovalPreview = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const removeGrants = vi.fn<(...args: unknown[]) => Promise<unknown>>()
vi.mock("./edit-access-data", async (orig) => ({
  ...(await orig<typeof import("./edit-access-data")>()),
  changeGrantRole: (...a: unknown[]) => changeGrantRole(...a),
  fetchRemovalPreview: (...a: unknown[]) => fetchRemovalPreview(...a),
  removeGrants: (...a: unknown[]) => removeGrants(...a),
}))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "lead" } }) }))
const toastAdd = vi.fn()
vi.mock("@/components/ui/toast", () => ({ toast: { add: (...a: unknown[]) => toastAdd(...a) } }))

const org = { type: "org" as const, id: "1", name: "Biblica" }
const project = { type: "project" as const, id: "p1", name: "Pattani" }
const french = { type: "lane" as const, id: "fr", name: "French" }

const tree: AccessTreeNode[] = [{
  scope: org,
  directGrantees: [{ userId: "1", displayName: "Ruth", roleLevel: 700, source: "direct" }],
  inherited: [],
  children: [{
    scope: project,
    directGrantees: [
      { userId: "2", displayName: "Member", roleLevel: 400, source: "direct" },
      { userId: "3", displayName: "Peer", roleLevel: 500, source: "direct" },
      { userId: "5", displayName: "Lead", roleLevel: 500, source: "direct" },
    ],
    inherited: [{ kind: "person", userId: "1", displayName: "Ruth", roleLevel: 700, from: org }],
    children: [{
      scope: french,
      directGrantees: [{ userId: "6", displayName: "LaneOnly", roleLevel: 300, source: "direct" }],
      inherited: [{ kind: "person", userId: "2", displayName: "Member", roleLevel: 400, from: project }],
      children: [],
    }],
  }],
}]
const people: OrgAccessPerson[] = [
  { userId: "1", displayName: "Ruth", username: "ruth", isGuest: false, grants: [] },
  { userId: "2", displayName: "Member", username: "member-login", isGuest: false, grants: [] },
  { userId: "3", displayName: "Peer", username: "peer", isGuest: false, grants: [] },
  { userId: "5", displayName: "Lead", username: "lead", isGuest: false, grants: [] },
  { userId: "6", displayName: "LaneOnly", username: "laneonly", isGuest: false, grants: [] },
]

/** The viewer is a Project lead on p1 and holds nothing at the org. */
const LEAD: Record<string, PlaceGrantability> = {
  "org:1": { ok: false, denial: "owner_only" },
  "project:p1": { ok: true, cap: 500 },
  "lane:fr": { ok: true, cap: 500 },
}

function renderLens(grantable: Record<string, PlaceGrantability>, place = "project:p1") {
  const onChanged = vi.fn()
  const editing: PlaceEditing = { orgId: 1, grantable, people, viewerUsername: "lead", onChanged }
  const router = createMemoryRouter(
    [{ path: "/access", element: <TooltipProvider delay={0}><PlacesLens tree={tree} query="" editing={editing} /></TooltipProvider> }],
    { initialEntries: [`/access?place=${place}`] },
  )
  render(<RouterProvider router={router} />)
  return { router, onChanged }
}

const row = (name: string) => {
  // By the exact name: "Lead" must not match a "Project Lead" pill.
  const found = screen.getAllByTestId("granted-here-row").find((r) => within(r).queryByText(name, { exact: true }) != null)
  if (!found) throw new Error(`no granted row for ${name}`)
  return found
}
const offered = () => screen.getAllByRole("menuitemradio").map((item) => item.textContent)

beforeEach(() => {
  changeGrantRole.mockReset()
  fetchRemovalPreview.mockReset()
  removeGrants.mockReset()
  toastAdd.mockReset()
})

describe("the role dropdown on a direct row", () => {
  it("offers a Project lead the project's rungs up to Project lead and no higher, and only where they outrank the row (AC5)", async () => {
    renderLens(LEAD)
    await userEvent.click(within(row("Member")).getByTestId("role-dropdown"))
    expect(offered()).toEqual(["Project Lead", "Contributor", "Reviewer", "Commenter", "Viewer"])
    await userEvent.keyboard("{Escape}")

    // A peer Project lead, and the viewer's own row: a plain pill that says why.
    expect(within(row("Peer")).queryByTestId("role-dropdown")).toBeNull()
    expect(within(row("Peer")).getByTestId("role-static").getAttribute("data-reason")).toBe("target_outranks")
    expect(within(row("Lead")).getByTestId("role-static").getAttribute("data-reason")).toBe("self")
  })

  it("offers an Owner both org rungs", async () => {
    renderLens({ ...LEAD, "org:1": { ok: true, cap: 700 } }, "org:1")
    await userEvent.click(within(row("Ruth")).getByTestId("role-dropdown"))
    expect(offered()).toEqual(["Owner", "Maintainer"])
  })

  it("writes the change for the row's own person and place, and shows the new role in place before the lens re-reads (AC3)", async () => {
    let finish: () => void = () => {}
    changeGrantRole.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const { onChanged } = renderLens(LEAD)
    await userEvent.click(within(row("Member")).getByTestId("role-dropdown"))
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Reviewer" }))

    expect(changeGrantRole).toHaveBeenCalledWith("jwt", 1, { userId: "2", displayName: "Member", username: "member-login" }, { type: "project", id: "p1" }, 300)
    expect(within(row("Member")).getByTestId("role-badge")).toHaveTextContent("Reviewer")
    await act(async () => { finish() })
    expect(onChanged).toHaveBeenCalledWith(300)
  })

  it("puts the old role back when the write fails", async () => {
    changeGrantRole.mockRejectedValue(new Error("refused"))
    const { onChanged } = renderLens(LEAD)
    await userEvent.click(within(row("Member")).getByTestId("role-dropdown"))
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Reviewer" }))
    await waitFor(() => expect(within(row("Member")).getByTestId("role-badge")).toHaveTextContent("Contributor"))
    expect(onChanged).not.toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }))
  })

  it("leaves a language row to lane staffing: no dropdown, no ×", () => {
    renderLens(LEAD, "lane:fr")
    expect(within(row("LaneOnly")).getByTestId("role-static").getAttribute("data-reason")).toBe("lane_needs_staffing")
    expect(within(row("LaneOnly")).getByTestId("remove-grant")).toBeDisabled()
  })
})

describe("an inherited row", () => {
  it("is not a dropdown; it names where it is set and goes there (AC4)", async () => {
    const { router } = renderLens(LEAD, "lane:fr")
    const inherited = screen.getAllByTestId("reaches-here-row").find((r) => r.textContent?.includes("Member"))!
    expect(within(inherited).queryByTestId("role-dropdown")).toBeNull()
    expect(within(inherited).queryByRole("menuitemradio")).toBeNull()

    const source = within(inherited).getByTestId("inherited-source")
    fireEvent.pointerEnter(source, { pointerType: "mouse" })
    fireEvent.mouseEnter(source)
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Set at Pattani — change it there")

    fireEvent.click(source)
    expect(router.state.location.search).toContain("place=project%3Ap1")
  })
})

describe("the × on a direct row", () => {
  it("is shut to a Project lead (removing project members needs a Maintainer)", () => {
    renderLens(LEAD)
    expect(within(row("Member")).getByTestId("remove-grant")).toBeDisabled()
  })

  it("opens the Remove dialog for that row's grant, and re-reads the lens after it is removed", async () => {
    fetchRemovalPreview.mockResolvedValue({
      ok: true,
      preview: { person: { userId: "2", displayName: "Member" }, invite: false, removes: [{ grant: { type: "project", id: "p1" }, path: [org, project], roleLevel: 400 }], loses: [project], keeps: [], leavesTeams: [], guest: { before: false, after: false } },
    })
    removeGrants.mockResolvedValue({ done: 1, total: 1, error: null })
    const { onChanged } = renderLens({ ...LEAD, "project:p1": { ok: true, cap: 600 } })
    await userEvent.click(within(row("Member")).getByTestId("remove-grant"))
    expect(fetchRemovalPreview).toHaveBeenCalledWith("jwt", 1, { person: { userId: "2" }, grants: [{ type: "project", id: "p1" }] })
    await userEvent.click(await screen.findByTestId("remove-access-confirm"))
    expect(removeGrants).toHaveBeenCalledWith("jwt", 1, { userId: "2" }, [{ type: "project", id: "p1" }])
    expect(onChanged).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId("remove-access-dialog")).toBeNull())
  })
})
