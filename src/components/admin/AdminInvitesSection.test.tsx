import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AdminInvitesSection } from "./AdminInvitesSection"
import type { AdminOrg, AdminProject, AdminUser } from "@/lib/frontier/admin"
import * as invitesModule from "@/lib/frontier/invites"
import * as toastModule from "@/components/ui/toast"
import userEvent from "@testing-library/user-event"
import { clearElevationRequired, isElevationRequired } from "@/lib/errors/elevation-required-signal"
import { throwIfElevationRequired } from "@/lib/frontier/elevation"

vi.mock("@/lib/frontier/invites")
vi.mock("@/components/ui/toast")

const mockOrgs: AdminOrg[] = [
  { id: 1, name: "Alpha", createdAt: "2026-01-01", ownerUsername: "al", memberCount: 3, projectCount: 2 },
  { id: 2, name: "Beta", createdAt: "2026-02-01", ownerUsername: "be", memberCount: 1, projectCount: 0 },
]

const mockProjects: AdminProject[] = [
  {
    id: "p1",
    name: "Project 1",
    orgId: 1,
    orgName: "Alpha",
    archived: false,
    createdAt: "2026-01-01",
    deadlineAt: null,
    creatorUsername: "user1",
    totalCells: 10,
    validatedCells: 5,
    wordCount: 100,
    lastEditAt: null,
    shared: false,
  },
]

const mockUsers: AdminUser[] = [
  { id: 1, username: "user1", email: "user1@example.com", displayName: "User One", createdAt: "2026-01-01", orgCount: 1, lastActiveAt: "2026-10-02T00:00:00Z" },
]

const twoProjects: AdminProject[] = [
  ...mockProjects,
  { ...mockProjects[0]!, id: "p2", name: "Project 2" },
]

const manyUsers: AdminUser[] = [
  ...mockUsers,
  { id: 7, username: "seven", email: "seven@example.com", displayName: "Seven", createdAt: "2026-01-01", orgCount: 1, lastActiveAt: "2026-10-02T00:00:00Z" },
]

const elevation403 = () =>
  new Response(JSON.stringify({ error: "elevation required to manage org membership with platform-admin access" }), { status: 403 })

describe("AdminInvitesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders three sections", async () => {
    vi.spyOn(invitesModule, "getOrgInvites").mockResolvedValue([])

    render(<AdminInvitesSection jwt="test-jwt" orgs={mockOrgs} projects={mockProjects} users={mockUsers} />)

    await waitFor(() => {
      expect(screen.getByText("Org invites")).toBeInTheDocument()
    })
    expect(screen.getByText("Access links")).toBeInTheDocument()
    expect(screen.getByText("Multi-project invite")).toBeInTheDocument()
  })

  it("loads org invites for the selected org", async () => {
    const invites = [
      {
        token: "tok1",
        role: { level: 400, name: "Maintainer" },
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-02-01T00:00:00Z",
        email: "user@example.com",
      },
    ]
    vi.spyOn(invitesModule, "getOrgInvites").mockResolvedValue(invites)

    render(<AdminInvitesSection jwt="test-jwt" orgs={mockOrgs} projects={mockProjects} users={mockUsers} />)

    await waitFor(() => {
      expect(screen.getByText("user@example.com")).toBeInTheDocument()
      expect(screen.getByText("Maintainer")).toBeInTheDocument()
    })
  })

  it("shows loading skeleton initially", () => {
    vi.spyOn(invitesModule, "getOrgInvites").mockImplementation(() => new Promise(() => {}))

    render(<AdminInvitesSection jwt="test-jwt" orgs={mockOrgs} projects={mockProjects} users={mockUsers} />)

    expect(screen.getByText(/Loading invites/i)).toBeInTheDocument()
  })

  it("shows error when loading fails", async () => {
    vi.spyOn(invitesModule, "getOrgInvites").mockRejectedValue(new Error("Network error"))

    render(<AdminInvitesSection jwt="test-jwt" orgs={mockOrgs} projects={mockProjects} users={mockUsers} />)

    await waitFor(() => {
      expect(screen.getByText(/Network error/i)).toBeInTheDocument()
    })
  })

  it("revokes an invite", async () => {
    const invites = [
      {
        token: "tok1",
        role: { level: 400, name: "Maintainer" },
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-02-01T00:00:00Z",
        email: "user@example.com",
      },
    ]
    vi.spyOn(invitesModule, "getOrgInvites").mockResolvedValue(invites)
    vi.spyOn(invitesModule, "revokeOrgInvite").mockResolvedValue(undefined)
    const toastSpy = vi.spyOn(toastModule.toast, "add")

    render(<AdminInvitesSection jwt="test-jwt" orgs={mockOrgs} projects={mockProjects} users={mockUsers} />)

    await waitFor(() => {
      expect(screen.getByText("Revoke")).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText("Revoke"))

    await waitFor(() => {
      expect(invitesModule.revokeOrgInvite).toHaveBeenCalledWith("test-jwt", 1, "tok1")
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }))
    })
  })

  it("shows empty state when no invites exist", async () => {
    vi.spyOn(invitesModule, "getOrgInvites").mockResolvedValue([])

    render(<AdminInvitesSection jwt="test-jwt" orgs={mockOrgs} projects={mockProjects} users={mockUsers} />)

    await waitFor(() => {
      expect(screen.getByText(/No pending invites/i)).toBeInTheDocument()
    })
  })

  describe("mint dialog", () => {
    async function openMintDialog() {
      vi.spyOn(invitesModule, "getOrgInvites").mockResolvedValue([])
      const user = userEvent.setup()
      render(<AdminInvitesSection jwt="test-jwt" orgs={mockOrgs} projects={twoProjects} users={manyUsers} />)
      await user.click(await screen.findByRole("button", { name: "Create access link" }))
      await screen.findByRole("dialog")
      return user
    }
    async function pickProject(user: ReturnType<typeof userEvent.setup>, name: string) {
      await user.click(screen.getByLabelText("Project"))
      await user.click(await screen.findByRole("option", { name }))
    }

    it("(a) mint: submit is enabled only with a project, a user and a 4-12 digit PIN", async () => {
      const user = await openMintDialog()
      const submit = screen.getByRole("button", { name: "Create link" })

      // user + short PIN, no project
      await user.click(screen.getByRole("button", { name: /Seven/ }))
      await user.type(screen.getByLabelText(/PIN/), "5678")
      expect(submit).toBeDisabled()

      await pickProject(user, "Project 2")
      expect(submit).toBeEnabled()

      await user.clear(screen.getByLabelText(/PIN/))
      await user.type(screen.getByLabelText(/PIN/), "123")
      expect(submit).toBeDisabled()
      expect(screen.getByText("PIN must be 4–12 digits")).toBeInTheDocument()

      await user.type(screen.getByLabelText(/PIN/), "4")
      expect(submit).toBeEnabled()
    })

    it("(b) mint: sends projectId, userId and pin, then shows token and PIN once", async () => {
      const create = vi
        .spyOn(invitesModule, "createAccessLink")
        .mockResolvedValue({ token: "minted-token-abc" } as Awaited<ReturnType<typeof invitesModule.createAccessLink>>)
      const user = await openMintDialog()

      await pickProject(user, "Project 2")
      await user.click(screen.getByRole("button", { name: /Seven/ }))
      await user.type(screen.getByLabelText(/PIN/), "5678")
      await user.click(screen.getByRole("button", { name: "Create link" }))

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      expect(create).toHaveBeenCalledWith("test-jwt", { projectId: "p2", userId: 7, pin: "5678" })
      expect(await screen.findByText("minted-token-abc")).toBeInTheDocument()
      expect(screen.getByText("5678")).toBeInTheDocument()
      expect(screen.getByText("This PIN is not shown again.")).toBeInTheDocument()
    })

    it("(d) elevation 403 on mint: raises the step-up signal", async () => {
      clearElevationRequired()
      vi.spyOn(invitesModule, "createAccessLink").mockImplementation(async () => {
        await throwIfElevationRequired(elevation403(), "create access link")
        throw new Error("unreachable")
      })
      const user = await openMintDialog()
      await pickProject(user, "Project 2")
      await user.click(screen.getByRole("button", { name: /Seven/ }))
      await user.type(screen.getByLabelText(/PIN/), "5678")
      expect(isElevationRequired()).toBe(false)

      const toastSpy = vi.spyOn(toastModule.toast, "add")
      await user.click(screen.getByRole("button", { name: "Create link" }))

      await waitFor(() => expect(isElevationRequired()).toBe(true))
      expect(invitesModule.createAccessLink).toHaveBeenCalledTimes(1)
      // form stays open and re-enabled for a retry after step-up
      await waitFor(() => expect(screen.getByRole("button", { name: "Create link" })).toBeEnabled())
      expect(toastSpy).toHaveBeenCalledTimes(0)
      clearElevationRequired()
    })
  })

  describe("multi-project dialog", () => {
    async function openInviteDialog() {
      vi.spyOn(invitesModule, "getOrgInvites").mockResolvedValue([])
      const user = userEvent.setup()
      render(<AdminInvitesSection jwt="test-jwt" orgs={mockOrgs} projects={twoProjects} users={manyUsers} />)
      await user.click(await screen.findByRole("button", { name: "Send invite" }))
      await screen.findByRole("dialog")
      return user
    }

    it("(c) multi-project: submit needs a ticked project and sends exactly the ticked ids", async () => {
      const create = vi
        .spyOn(invitesModule, "createMultiProjectInvite")
        .mockResolvedValue({ token: "multi-token" } as Awaited<ReturnType<typeof invitesModule.createMultiProjectInvite>>)
      const user = await openInviteDialog()
      const submit = screen.getByRole("button", { name: "Create invite" })
      expect(submit).toBeDisabled()

      await user.click(screen.getByRole("checkbox", { name: "Project 1" }))
      expect(submit).toBeDisabled()
      await user.click(screen.getByRole("checkbox", { name: "Project 2" }))
      await user.click(screen.getByRole("checkbox", { name: /every current target lane/i }))
      expect(submit).toBeEnabled()
      await user.click(submit)

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      expect(create).toHaveBeenCalledWith("test-jwt", {
        projectIds: ["p1", "p2"],
        allCurrentLanes: true,
      })
      expect(await screen.findByText("multi-token")).toBeInTheDocument()
    })

    it("(d) elevation 403 on multi-project invite: raises the step-up signal", async () => {
      clearElevationRequired()
      vi.spyOn(invitesModule, "createMultiProjectInvite").mockImplementation(async () => {
        await throwIfElevationRequired(elevation403(), "create multi-project invite")
        throw new Error("unreachable")
      })
      const user = await openInviteDialog()
      await user.click(screen.getByRole("checkbox", { name: "Project 1" }))
      await user.click(screen.getByRole("checkbox", { name: /every current target lane/i }))
      const toastSpy = vi.spyOn(toastModule.toast, "add")
      await user.click(screen.getByRole("button", { name: "Create invite" }))
      await waitFor(() => expect(isElevationRequired()).toBe(true))
      await waitFor(() => expect(screen.getByRole("button", { name: "Create invite" })).toBeEnabled())
      expect(toastSpy).toHaveBeenCalledTimes(0)
      clearElevationRequired()
    })
  })

  it("(d) elevation 403 on revoke: raises the step-up signal", async () => {
    clearElevationRequired()
    vi.spyOn(invitesModule, "getOrgInvites").mockResolvedValue([
      {
        token: "tok1",
        role: { level: 400, name: "Maintainer" },
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-02-01T00:00:00Z",
        email: "user@example.com",
      },
    ])
    const revoke = vi.spyOn(invitesModule, "revokeOrgInvite").mockImplementation(async () => {
      await throwIfElevationRequired(elevation403(), "revoke org invite")
    })
    const toastSpy = vi.spyOn(toastModule.toast, "add")
    const user = userEvent.setup()
    render(<AdminInvitesSection jwt="test-jwt" orgs={mockOrgs} projects={twoProjects} users={manyUsers} />)
    await user.click(await screen.findByRole("button", { name: "Revoke" }))

    await waitFor(() => expect(isElevationRequired()).toBe(true))
    expect(revoke).toHaveBeenCalledWith("test-jwt", 1, "tok1")
    await waitFor(() => expect(screen.getByRole("button", { name: "Revoke" })).toBeEnabled())
    expect(toastSpy).toHaveBeenCalledTimes(0)
    clearElevationRequired()
  })

  it("non-elevation failure on revoke still shows the generic error toast", async () => {
    clearElevationRequired()
    vi.spyOn(invitesModule, "getOrgInvites").mockResolvedValue([
      {
        token: "tok1",
        role: { level: 400, name: "Maintainer" },
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-02-01T00:00:00Z",
        email: "user@example.com",
      },
    ])
    vi.spyOn(invitesModule, "revokeOrgInvite").mockRejectedValue(new Error("boom"))
    const toastSpy = vi.spyOn(toastModule.toast, "add")
    const user = userEvent.setup()
    render(<AdminInvitesSection jwt="test-jwt" orgs={mockOrgs} projects={twoProjects} users={manyUsers} />)
    await user.click(await screen.findByRole("button", { name: "Revoke" }))

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "Failed to revoke invite", description: "boom" }),
      ),
    )
    expect(isElevationRequired()).toBe(false)
  })
})
