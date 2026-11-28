/**
 * AQU-2321: the Remove dialog says, before anything is written, what the
 * person loses and what other grants keep — and removes exactly the grants it
 * was opened with plus any kept grant the viewer ticks, one checkbox per
 * grant. If it removed a kept grant nobody ticked, it would demote access the
 * dialog promised to keep; if it hid a kept grant, the viewer would believe
 * the person was gone when they were not.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { RemovalPreview } from "./edit-access-data"
import { RemoveAccessDialog } from "./RemoveAccessDialog"

const fetchRemovalPreview = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const removeGrants = vi.fn<(...args: unknown[]) => Promise<unknown>>()
vi.mock("./edit-access-data", async (orig) => ({
  ...(await orig<typeof import("./edit-access-data")>()),
  fetchRemovalPreview: (...a: unknown[]) => fetchRemovalPreview(...a),
  removeGrants: (...a: unknown[]) => removeGrants(...a),
}))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "owner" } }) }))
const toastAdd = vi.fn()
vi.mock("@/components/ui/toast", () => ({ toast: { add: (...a: unknown[]) => toastAdd(...a) } }))

const org = { type: "org" as const, id: "1", name: "Biblica" }
const team = { type: "team" as const, id: "3", name: "Reviewers" }
const book = (n: number) => ({ type: "project" as const, id: `q${n}`, name: `Book ${n}` })

/** AC1: Reviewer on a team with six projects plus a direct Reviewer on one of them. */
const teamRemoval: RemovalPreview = {
  person: { userId: "20", displayName: "Rhea" },
  invite: false,
  removes: [{ grant: { type: "team", id: "3" }, path: [org, team], roleLevel: null }],
  loses: [book(2), book(3), book(4), book(5), book(6)],
  keeps: [{
    project: book(1),
    roleBefore: 300,
    after: { roleLevel: 300, source: "direct", via: book(1) },
    grant: { type: "project", id: "q1" },
    grantedAt: "2026-03-04T12:00:00.000Z",
    removable: true,
  }],
  leavesTeams: [],
  guest: { before: true, after: true },
}

function open(props: Partial<Parameters<typeof RemoveAccessDialog>[0]> = {}) {
  const onRemoved = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <RemoveAccessDialog
      open
      onOpenChange={onOpenChange}
      orgId={1}
      person={{ userId: "20", displayName: "Rhea" }}
      grants={[{ type: "team", id: "3" }]}
      onRemoved={onRemoved}
      {...props}
    />,
  )
  return { onRemoved, onOpenChange }
}

beforeEach(() => {
  fetchRemovalPreview.mockReset()
  removeGrants.mockReset()
  toastAdd.mockReset()
})

describe("RemoveAccessDialog", () => {
  it("says what they lose (named, then 'and N more') and what they keep, with the keeping grant and its date (AC1)", async () => {
    fetchRemovalPreview.mockResolvedValue({ ok: true, preview: teamRemoval })
    open()
    expect(fetchRemovalPreview).toHaveBeenCalledWith("jwt", 1, { person: { userId: "20" }, grants: [{ type: "team", id: "3" }] })
    const loses = await screen.findByTestId("removal-loses")
    expect(loses).toHaveTextContent(/Can no longer open Book 2, Book 3,? and 3 more/)
    expect(screen.getByTestId("removal-kept")).toHaveTextContent("Reviewer on Book 1 through their direct grant there, given Mar 4, 2026")
    expect(screen.getByTestId("removal-removes")).toHaveTextContent("Removes them from the team Reviewers")
    // One checkbox per surviving grant, naming it.
    const also = screen.getAllByTestId("removal-also")
    expect(also).toHaveLength(1)
    expect(screen.getByRole("checkbox", { name: "Also remove their Reviewer grant on Book 1" })).toBe(also[0])
  })

  it("confirming without the checkbox removes only the grant it was opened with, then re-reads the lens (AC2)", async () => {
    fetchRemovalPreview.mockResolvedValue({ ok: true, preview: teamRemoval })
    removeGrants.mockResolvedValue({ done: 1, total: 1, error: null })
    const { onRemoved, onOpenChange } = open()
    fireEvent.click(await screen.findByTestId("remove-access-confirm"))
    await waitFor(() => expect(removeGrants).toHaveBeenCalledWith("jwt", 1, { userId: "20" }, [{ type: "team", id: "3" }]))
    await waitFor(() => expect(onRemoved).toHaveBeenCalled())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("confirming with the checkbox removes the kept grant too (AC2)", async () => {
    fetchRemovalPreview.mockResolvedValue({ ok: true, preview: teamRemoval })
    removeGrants.mockResolvedValue({ done: 2, total: 2, error: null })
    open()
    fireEvent.click(await screen.findByRole("checkbox", { name: "Also remove their Reviewer grant on Book 1" }))
    fireEvent.click(screen.getByTestId("remove-access-confirm"))
    await waitFor(() =>
      expect(removeGrants).toHaveBeenCalledWith("jwt", 1, { userId: "20" }, [{ type: "team", id: "3" }, { type: "project", id: "q1" }]),
    )
  })

  it("offers no checkbox for a kept grant the viewer may not remove, nor for one already being removed", async () => {
    fetchRemovalPreview.mockResolvedValue({
      ok: true,
      preview: {
        ...teamRemoval,
        keeps: [
          { ...teamRemoval.keeps[0], removable: false },
          { ...teamRemoval.keeps[0], project: book(7), grant: { type: "team", id: "3" } },
        ],
      },
    })
    open()
    await screen.findByTestId("removal-keeps")
    expect(screen.queryAllByTestId("removal-also")).toHaveLength(0)
  })

  it("an invite cancels with the same confirmation, without the keeps section", async () => {
    fetchRemovalPreview.mockResolvedValue({
      ok: true,
      preview: { person: { userId: "invite:project:q1:tok", displayName: "x@example.com" }, invite: true, removes: [{ grant: { type: "project", id: "q1" }, path: [org, book(1)], roleLevel: 300 }], loses: [book(1)], keeps: [], leavesTeams: [], guest: { before: false, after: false } },
    })
    removeGrants.mockResolvedValue({ done: 1, total: 1, error: null })
    const { onRemoved } = open({ person: { inviteId: "invite:project:q1:tok", email: "x@example.com" }, grants: [] })
    expect(await screen.findByRole("heading", { name: "Cancel the invitation to x@example.com" })).toBeTruthy()
    expect(await screen.findByTestId("removal-loses")).toHaveTextContent("The invitation to Book 1 stops working")
    expect(screen.queryByTestId("removal-keeps")).toBeNull()
    fireEvent.click(screen.getByTestId("remove-access-confirm"))
    await waitFor(() => expect(removeGrants).toHaveBeenCalledWith("jwt", 1, { inviteId: "invite:project:q1:tok" }, []))
    await waitFor(() => expect(onRemoved).toHaveBeenCalled())
  })

  it("shows the server's refusal and keeps the confirm shut", async () => {
    fetchRemovalPreview.mockResolvedValue({ ok: false, refused: { code: "maintainer_on_project", message: "cannot remove Rhea from project \"Book 1\": only a Maintainer" } })
    open()
    expect(await screen.findByTestId("removal-refused")).toHaveTextContent("only a Maintainer")
    expect(screen.getByTestId("remove-access-confirm")).toBeDisabled()
  })

  it("a removal that stops partway says how far it got, re-reads the lens, and stays open", async () => {
    fetchRemovalPreview.mockResolvedValue({ ok: true, preview: teamRemoval })
    removeGrants.mockResolvedValue({ done: 1, total: 2, error: new Error("boom") })
    const { onRemoved, onOpenChange } = open()
    fireEvent.click(await screen.findByRole("checkbox", { name: "Also remove their Reviewer grant on Book 1" }))
    fireEvent.click(screen.getByTestId("remove-access-confirm"))
    expect(await screen.findByTestId("removal-failure")).toHaveTextContent("Removed 1 of 2")
    expect(onRemoved).toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(within(screen.getByTestId("remove-access-dialog")).getByTestId("remove-access-confirm")).not.toBeDisabled()
  })
})
