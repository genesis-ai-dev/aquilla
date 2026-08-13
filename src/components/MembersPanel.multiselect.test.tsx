// AQU-734: multi-select add flow in the shared MembersPanel (used by the Share
// modal Members tab and the org roster at /members).
//
// Pins the corrected behavior: search results are checkboxes, checking people
// stages them as removable chips that survive a new search term, a single Add
// grants the whole batch in ONE onAdd call (no client-side fan-out), and a
// partial failure names only the person who failed while the successes drop.

import { describe, it, expect, vi } from "vitest"
import type { ReactElement } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MembersPanel, type MembersPanelMember } from "./MembersPanel"
import { UserError, toUserFacingError } from "@/lib/errors/user-error"

// Drive the typeahead deterministically: echo the query (so the component's
// searchMatchesInput gate passes) and return a canned roster filtered by an
// includes() prefix, mirroring the real server contract's shape.
vi.mock("@/hooks/useUserSearch", () => ({
  useUserSearch: (query: string) => {
    const all = [
      { id: 10, username: "alice" },
      { id: 11, username: "amir" },
      { id: 12, username: "bob" },
    ]
    const q = query.trim().toLowerCase()
    const results = q.length >= 2 ? all.filter((u) => u.username.toLowerCase().includes(q)) : []
    return { query, results, isLoading: false, lastFetchOk: true }
  },
}))

function renderPanel(ui: ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  )
}

const ROLE_OPTIONS = [
  { level: 300, name: "reviewer", description: "" },
  { level: 400, name: "contributor", description: "" },
  { level: 500, name: "project_lead", description: "" },
]

function existingMember(): MembersPanelMember {
  return {
    userId: 2,
    username: "carol",
    roleLevel: 400,
    roleName: "contributor",
    source: "override",
    isLocked: false,
  }
}

function baseProps(onAdd: (usernames: string[], role: number) => Promise<{ username: string; ok: boolean; error?: string }[]>) {
  return {
    members: [existingMember()],
    roleOptions: ROLE_OPTIONS,
    newMemberDefaultRole: 400,
    onAdd,
    onRemove: () => Promise.resolve(),
    callerUserId: 1,
    callerMaxRole: 500,
  }
}

function typeSearch(value: string) {
  const input = screen.getByPlaceholderText("Aquilla username")
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
}

describe("MembersPanel multi-select add (AQU-734)", () => {
  it("stages people checked across two different searches and adds them in one call", async () => {
    const onAdd = vi.fn(async () => [
      { username: "alice", ok: true },
      { username: "amir", ok: true },
    ])
    renderPanel(<MembersPanel {...baseProps(onAdd)} />)

    // First search: check alice.
    typeSearch("al")
    fireEvent.click(await screen.findByRole("checkbox", { name: "alice" }))
    // A removable chip appears for the staged person.
    expect(screen.getByRole("button", { name: "Remove alice" })).toBeInTheDocument()

    // Second search term returns a disjoint result — the alice chip must persist.
    typeSearch("am")
    expect(screen.getByRole("button", { name: "Remove alice" })).toBeInTheDocument()
    fireEvent.click(await screen.findByRole("checkbox", { name: "amir" }))

    fireEvent.click(screen.getByRole("button", { name: "Add" }))

    // ONE batch call carrying both people at the chosen role — no fan-out.
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1))
    expect(onAdd).toHaveBeenCalledWith(["alice", "amir"], 400)
  })

  it("reports a partial failure per person: the failure is named and kept staged, successes drop", async () => {
    const onAdd = vi.fn(async () => [
      { username: "alice", ok: true },
      { username: "amir", ok: false, error: "already a member" },
    ])
    renderPanel(<MembersPanel {...baseProps(onAdd)} />)

    typeSearch("al")
    fireEvent.click(await screen.findByRole("checkbox", { name: "alice" }))
    typeSearch("am")
    fireEvent.click(await screen.findByRole("checkbox", { name: "amir" }))
    fireEvent.click(screen.getByRole("button", { name: "Add" }))

    // The message names only the person who failed, with the reason.
    await waitFor(() =>
      expect(screen.getByText(/amir \(already a member\)/)).toBeInTheDocument(),
    )
    // amir stays staged for a retry; alice (succeeded) is gone.
    expect(screen.getByRole("button", { name: "Remove amir" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove alice" })).not.toBeInTheDocument()
  })

  // AQU-780: a whole-batch add throw (nothing landed — 403 owner-gate, 429,
  // 5xx) must surface the REAL cause via onAddBatchError, not a generic
  // "Could not add" and never a misleading "username may not exist." The org
  // roster maps forbidden → an owner-permission message; other classes → the
  // status-mapped message. A genuinely unknown username is a per-person
  // `user_not_found` RESULT (covered above), never a thrown batch error.
  const orgBatchError = (e: unknown) => {
    const uf = toUserFacingError(e, "org")
    return uf.category === "forbidden" ? "Only org owners can add members." : uf.message
  }

  async function stageAliceAndAdd(
    onAdd: (usernames: string[], role: number) => Promise<{ username: string; ok: boolean; error?: string }[]>,
  ) {
    renderPanel(
      <MembersPanel {...baseProps(onAdd)} onAddBatchError={orgBatchError} />,
    )
    typeSearch("al")
    fireEvent.click(await screen.findByRole("checkbox", { name: "alice" }))
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
  }

  it("surfaces a permission message (not 'may not exist') when a non-owner add is rejected with 403", async () => {
    const onAdd = vi.fn(async () => {
      throw new UserError(403, "only org owners can add members", "org")
    })
    await stageAliceAndAdd(onAdd)

    await waitFor(() =>
      expect(screen.getByText("Only org owners can add members.")).toBeInTheDocument(),
    )
    expect(screen.queryByText(/may not exist/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/could not add/i)).not.toBeInTheDocument()
    // The rejected person stays staged for a retry after the caller fixes perms.
    expect(screen.getByRole("button", { name: "Remove alice" })).toBeInTheDocument()
  })

  it("surfaces a distinct transient message (not 'may not exist') on a 5xx", async () => {
    const onAdd = vi.fn(async () => {
      throw new UserError(500, "boom", "org")
    })
    await stageAliceAndAdd(onAdd)

    await waitFor(() =>
      expect(screen.getByText(/something went wrong on the server/i)).toBeInTheDocument(),
    )
    expect(screen.queryByText(/may not exist/i)).not.toBeInTheDocument()
  })

  it("surfaces a distinct rate-limit message on a 429", async () => {
    const onAdd = vi.fn(async () => {
      throw new UserError(429, "slow down", "org")
    })
    await stageAliceAndAdd(onAdd)

    await waitFor(() =>
      expect(screen.getByText(/too many requests/i)).toBeInTheDocument(),
    )
    expect(screen.queryByText(/may not exist/i)).not.toBeInTheDocument()
  })

  it("disables Add when nothing is staged and re-disables after the last chip is removed", async () => {
    const onAdd = vi.fn(async () => [])
    renderPanel(<MembersPanel {...baseProps(onAdd)} />)

    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled()

    typeSearch("al")
    fireEvent.click(await screen.findByRole("checkbox", { name: "alice" }))
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: "Remove alice" }))
    // Clearing the input too so no leftover typed text keeps Add enabled.
    fireEvent.change(screen.getByPlaceholderText("Aquilla username"), { target: { value: "" } })
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled()
    expect(onAdd).not.toHaveBeenCalled()
  })
})
