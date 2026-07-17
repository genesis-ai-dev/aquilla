// Tests for ApiTokensSection (AQU-533 §1 "Token UI").
//
// WHY these tests matter: this is the only UI surface for minting/revoking
// external Agent API credentials. If list rendering, the show-once token
// display, or the client-side role filtering on mint (act mode requires a
// maintainer-level project scope) regresses, users either can't find their
// tokens, lose a token they'll never see again, or mint an 'act' credential
// the server will just 403 on anyway with no warning up front.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ApiTokensSection } from "./ApiTokensSection"
import type { ApiCredential, MintCredentialResult } from "@/lib/sync/credentials"
import type { OrgSummary } from "@/lib/frontier/orgs"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: vi.fn(() => ({ session: { jwt: "test-jwt" }, loading: false })),
}))
vi.mock("@/lib/sync/credentials", () => ({
  listCredentials: vi.fn(),
  mintCredential: vi.fn(),
  revokeCredential: vi.fn(),
}))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: vi.fn() }))
vi.mock("@/lib/sync/cloud-projects", () => ({ fetchAccessibleProjects: vi.fn() }))

import { useFrontierSession } from "@/hooks/useFrontierSession"
import { listCredentials, mintCredential, revokeCredential } from "@/lib/sync/credentials"
import { listMyOrgs } from "@/lib/frontier/orgs"
import { fetchAccessibleProjects } from "@/lib/sync/cloud-projects"

const mockUseFrontierSession = vi.mocked(useFrontierSession)
const mockListCredentials = vi.mocked(listCredentials)
const mockMintCredential = vi.mocked(mintCredential)
const mockRevokeCredential = vi.mocked(revokeCredential)
const mockListMyOrgs = vi.mocked(listMyOrgs)
const mockFetchAccessibleProjects = vi.mocked(fetchAccessibleProjects)

const ORG: OrgSummary = { id: 1, name: "Acme Org", role: { level: 600, name: "maintainer" } }

const PROJECT_CONTRIBUTOR: CloudProjectSummary = {
  id: "proj-contrib",
  name: "Contributor Project",
  gitlabProjectId: null,
  orgId: 1,
  role: { level: 400, name: "contributor", source: "invite" },
}
const PROJECT_MAINTAINER: CloudProjectSummary = {
  id: "proj-maint",
  name: "Maintainer Project",
  gitlabProjectId: null,
  orgId: 1,
  role: { level: 600, name: "maintainer", source: "invite" },
}

const ASK_CREDENTIAL: ApiCredential = {
  id: "cred-1",
  name: "Import agent",
  mode: "ask",
  orgId: null,
  projectId: null,
  tokenPrefix: "aqk_abc123",
  createdAt: "2026-06-01T00:00:00.000Z",
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
}

const REVOKED_CREDENTIAL: ApiCredential = {
  id: "cred-2",
  name: "Old bot",
  mode: "act",
  orgId: null,
  projectId: "proj-maint",
  tokenPrefix: "aqk_def456",
  createdAt: "2026-05-01T00:00:00.000Z",
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: "2026-06-15T00:00:00.000Z",
}

// Base UI Select renders a combobox trigger; options live in a portaled
// popup. Clicks on options don't reliably commit a selection under
// happy-dom, but hover-highlighting + Enter does (see
// ProjectCreateDialog.addAsLane.test.tsx for the original of this helper).
async function pickSelectOption(triggerName: RegExp, optionName: RegExp) {
  const trigger = screen.getByRole("combobox", { name: triggerName })
  fireEvent.click(trigger)
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(document.activeElement ?? option, { key: "Enter" })
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseFrontierSession.mockReturnValue({
    session: { jwt: "test-jwt" } as ReturnType<typeof useFrontierSession>["session"],
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  })
  mockListMyOrgs.mockResolvedValue([ORG])
  mockFetchAccessibleProjects.mockResolvedValue([PROJECT_CONTRIBUTOR, PROJECT_MAINTAINER])
  mockListCredentials.mockResolvedValue([ASK_CREDENTIAL, REVOKED_CREDENTIAL])
})
afterEach(() => vi.restoreAllMocks())

describe("ApiTokensSection", () => {
  it("renders the credential list from the mocked client (prefix, mode, resolved scope, revoked state)", async () => {
    render(<ApiTokensSection />)

    await waitFor(() => expect(mockListCredentials).toHaveBeenCalledWith("test-jwt"))

    expect(await screen.findByText(/aqk_abc123/)).toBeInTheDocument()
    expect(screen.getByText("ask")).toBeInTheDocument()
    expect(screen.getByText(/Unscoped \(personal\)/)).toBeInTheDocument()

    // The revoked credential's project scope resolves to its display name via
    // the fetched project list, and shows a Revoked badge instead of a button.
    await waitFor(() => expect(screen.getByText(/Maintainer Project/)).toBeInTheDocument())
    expect(screen.getByText("Revoked")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1)
  })

  it("renders an empty state when the caller has no tokens", async () => {
    mockListCredentials.mockResolvedValue([])
    render(<ApiTokensSection />)
    await waitFor(() => expect(screen.getByText(/No tokens yet/)).toBeInTheDocument())
  })

  it("mint flow: act mode stays disabled until a maintainer-level project is picked, then mints and shows the token exactly once", async () => {
    const mintResult: MintCredentialResult = {
      token: "aqk_freshplaintext",
      credential: {
        id: "cred-3",
        name: "Deploy bot",
        mode: "act",
        orgId: null,
        projectId: "proj-maint",
        tokenPrefix: "aqk_fresh",
        createdAt: "2026-07-17T00:00:00.000Z",
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      },
    }
    mockMintCredential.mockResolvedValue(mintResult)

    render(<ApiTokensSection />)
    await waitFor(() => expect(mockListCredentials).toHaveBeenCalled())

    fireEvent.click(screen.getByRole("button", { name: "New token" }))
    await screen.findByText("New API token")

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Deploy bot" } })

    await pickSelectOption(/Organization/i, /Acme Org/i)
    await pickSelectOption(/^Project$/i, /Contributor Project/i)

    // The contributor-level project isn't a maintainer scope — act stays disabled.
    expect(screen.getByRole("radio", { name: /Act/i })).toHaveAttribute("aria-disabled", "true")

    await pickSelectOption(/^Project$/i, /Maintainer Project/i)

    const actRadio = screen.getByRole("radio", { name: /Act/i })
    expect(actRadio).not.toHaveAttribute("aria-disabled", "true")
    fireEvent.click(actRadio)

    fireEvent.click(screen.getByRole("button", { name: "Mint token" }))

    await waitFor(() => expect(mockMintCredential).toHaveBeenCalledTimes(1))
    expect(mockMintCredential).toHaveBeenCalledWith(
      "test-jwt",
      expect.objectContaining({ name: "Deploy bot", mode: "act", projectId: "proj-maint" }),
    )

    // Show-once dialog: the plaintext token renders, with the "never again" notice.
    expect(await screen.findByText("aqk_freshplaintext")).toBeInTheDocument()
    expect(screen.getByText(/you will not see it again/i)).toBeInTheDocument()

    // Closing it makes it disappear for good — it isn't reachable again without
    // a fresh mint (the client never stores the plaintext).
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    await waitFor(() => expect(screen.queryByText("aqk_freshplaintext")).not.toBeInTheDocument())
  })

  it("revoke: opens a confirm dialog and only calls revokeCredential after confirming", async () => {
    mockRevokeCredential.mockResolvedValue(undefined)
    render(<ApiTokensSection />)
    await waitFor(() => expect(mockListCredentials).toHaveBeenCalled())
    await screen.findByText(/aqk_abc123/)

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }))
    await screen.findByText("Revoke token?")

    expect(mockRevokeCredential).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Revoke token" }))

    await waitFor(() => expect(mockRevokeCredential).toHaveBeenCalledWith("test-jwt", "cred-1"))
    await waitFor(() => expect(screen.queryByText("Revoke token?")).not.toBeInTheDocument())
  })
})
