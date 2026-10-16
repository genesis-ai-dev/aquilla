// AQU-733: multi-select add on the CANONICAL project surface.
//
// Project Overview's Members card and Project Settings → Team members both
// render MembersSection, whose "Add a member" dialog is the add affordance a
// real user reaches. AQU-734's multi-select behaviour was only pinned on
// MembersTab (ProjectMembersPage.test.tsx) — the building block kept for
// SharePanel, which the module header says is NOT the product surface. That
// gap is how the dialog's empty-state hint shipped as a raw English literal
// while its MembersTab twin was localized.
//
// Pins, at the canonical surface: eligible colleagues are checkbox rows,
// checking several stages removable chips, one Add sends ONE batch call, a
// partial failure names only the person who failed, and the all-added empty
// state comes from the message catalogue (never a hardcoded string).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { MembersSection } from "./MembersSection"
import { AddProjectMemberDialog } from "./AddProjectMemberDialog"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { LOCALE_STORAGE_KEY } from "@/lib/i18n/store"
import type { ProjectMember } from "@/lib/frontier/members"
import type { OrgMember } from "@/lib/frontier/orgs"

vi.mock("@/hooks/useCurrentTargetLanes", () => ({
  useCurrentTargetLanes: () => ({ lanes: [], ready: true }),
}))

// alice is the caller and the only direct grant, so she is never offered.
const MEMBERS: ProjectMember[] = [
  {
    userId: 1,
    username: "alice",
    email: "alice@example.com",
    role: { level: 600, name: "maintainer", source: "override" },
    secondarySources: [],
  },
]

const om = (userId: number, username: string): OrgMember =>
  ({ userId, username, role: { level: 400, name: "contributor" } }) as OrgMember

let orgRoster: OrgMember[] = []
const mockAddMany = vi.fn()

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project: { name: "Pattani Malay Bible" } }),
}))

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({
    members: MEMBERS,
    isLoading: false,
    error: null,
    rosterHidden: false,
    refresh: vi.fn(),
    add: vi.fn(),
    addMany: mockAddMany,
    remove: vi.fn(),
    changeRole: vi.fn(),
  }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "tok", username: "alice" },
    loading: false,
  }),
}))

vi.mock("@/hooks/useProjectOrgId", () => ({
  useProjectOrgId: () => ({ orgId: 1, isLoading: false, error: null }),
}))

vi.mock("@/context/OrgContext", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/context/OrgContext")>()
  return { ...original, useActiveOrgOptional: () => ({ activeOrgId: 1 }) }
})

vi.mock("@/lib/frontier/orgs", () => ({
  listOrgMembers: vi.fn(() => Promise.resolve(orgRoster)),
}))

vi.mock("@/hooks/useUserSearch", () => ({
  useUserSearch: () => ({
    query: "",
    results: [],
    isLoading: false,
    needsMorePrefix: true,
    lastFetchOk: true,
  }),
}))

vi.mock("@/lib/sync/invites", () => ({ createServerInvite: vi.fn() }))

async function openAddDialog() {
  render(
    <MemoryRouter>
      <MembersSection projectId="proj-1" />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole("button", { name: /add a member/i }))
  const input = await screen.findByPlaceholderText("Aquilla username")
  fireEvent.focus(input)
  return input
}

/** The dialog's batch-Add button — its label echoes the grant scope. */
const addButton = () =>
  screen.getByRole("button", { name: /^add\b/i, hidden: false })

describe("MembersSection add dialog — multi-select add (AQU-733)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    orgRoster = [om(1, "alice"), om(5, "dana"), om(6, "dave")]
    mockAddMany.mockResolvedValue([])
  })

  it("offers eligible org colleagues as checkbox rows, never an existing direct grant", async () => {
    await openAddDialog()

    expect(await screen.findByRole("checkbox", { name: "dana" })).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "dave" })).toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: "alice" })).not.toBeInTheDocument()
  })

  it("checking several people stages removable chips that survive a new search term", async () => {
    const input = await openAddDialog()

    fireEvent.click(await screen.findByRole("checkbox", { name: "dana" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "dave" }))

    const chips = screen.getByRole("list", { name: "People to add" })
    expect(within(chips).getByText("dana")).toBeInTheDocument()
    expect(within(chips).getByText("dave")).toBeInTheDocument()

    // A fresh query is a filter, not a reset — staged people stay staged.
    fireEvent.change(input, { target: { value: "zz" } })
    expect(within(chips).getByText("dana")).toBeInTheDocument()
    expect(within(chips).getByText("dave")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Remove dave" }))
    expect(within(chips).queryByText("dave")).not.toBeInTheDocument()
  })

  it("grants the whole batch in ONE call and names only the person who failed", async () => {
    mockAddMany.mockResolvedValueOnce([
      { username: "dana", ok: true },
      { username: "dave", ok: true },
      { username: "bogus", ok: false, error: { code: "not_found", message: "No user found" } },
    ])
    const input = await openAddDialog()

    fireEvent.click(await screen.findByRole("checkbox", { name: "dana" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "dave" }))
    // A free-typed username still rides along, staged with Enter.
    fireEvent.change(input, { target: { value: "bogus" } })
    fireEvent.keyDown(input, { key: "Enter" })

    fireEvent.click(addButton())

    await waitFor(() => {
      expect(mockAddMany).toHaveBeenCalledTimes(1)
      expect(mockAddMany).toHaveBeenCalledWith([
        { username: "dana", role: 400 },
        { username: "dave", role: 400 },
        { username: "bogus", role: 400 },
      ])
    })

    expect(
      await screen.findByText(/couldn't add 1 person: bogus \(No user found\)/i),
    ).toBeInTheDocument()
    const chips = screen.getByRole("list", { name: "People to add" })
    expect(within(chips).getByText("bogus")).toBeInTheDocument()
    expect(within(chips).queryByText("dana")).not.toBeInTheDocument()
  })

  it("keeps Add disabled until someone is staged, and again once the last chip goes", async () => {
    await openAddDialog()
    expect(addButton()).toBeDisabled()

    fireEvent.click(await screen.findByRole("checkbox", { name: "dana" }))
    expect(addButton()).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: "Remove dana" }))
    expect(addButton()).toBeDisabled()
  })

  it("shows an all-added empty state when every colleague already has a grant", async () => {
    orgRoster = [om(1, "alice")]
    await openAddDialog()

    expect(
      await screen.findByText(/all org members are already on this project/i),
    ).toBeInTheDocument()
  })

  // The hint used to be a raw English literal on this dialog (its MembersTab
  // twin already read the catalogue), so it stayed English for every non-English
  // reader. Asserting it under a non-default locale is what pins the fix —
  // against the literal, the English sentence renders here instead.
  it("resolves that empty state through the message catalogue, not a hardcoded string", async () => {
    orgRoster = [om(1, "alice")]
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "fr")

    render(
      <I18nProvider>
        <MemoryRouter>
          <AddProjectMemberDialog
            projectId="proj-1"
            open
            onOpenChange={() => {}}
            members={MEMBERS}
            addMany={mockAddMany}
            callerLevel={600}
          />
        </MemoryRouter>
      </I18nProvider>,
    )
    fireEvent.focus(await screen.findByPlaceholderText("Aquilla username"))

    expect(
      await screen.findByText(
        /Tous les membres de l\u2019organisation sont d\u00e9j\u00e0 sur ce projet\./,
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/all org members are already on this project/i),
    ).not.toBeInTheDocument()
  })
})
