// AQU-804: Org settings → Airtable. Connecting is pasting a personal access
// token (the server checks and encrypts it); the token is never shown again,
// and Monday's "link your projects" list follows once connected.

import { beforeEach, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgSettingsAirtable } from "./OrgSettingsAirtable"
import {
  AirtableApiError,
  connectAirtable,
  fetchAirtableConnection,
  fetchAirtableOrgLinks,
} from "@/lib/airtable/api"

let orgRole = 700

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok" } }),
}))
vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => ({
    activeOrgId: 7,
    activeOrg: { role: { level: orgRole } },
    accessibleProjectsLoading: false,
    accessibleProjects: [{ id: "chosen", name: "The Chosen Burmese", orgId: 7, role: { level: 600 } }],
  }),
}))
vi.mock("./OrgSettingsDetailPage", () => ({
  OrgSettingsDetailPage: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/lib/airtable/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/airtable/api")>()),
  fetchAirtableConnection: vi.fn(),
  connectAirtable: vi.fn(),
  deleteAirtableConnection: vi.fn(),
  fetchAirtableOrgLinks: vi.fn(),
}))
vi.mock("@/components/ProjectSettings/AirtableSetupWizard", () => ({
  AirtableSetupWizard: ({ projectId }: { projectId: string }) => <div data-testid="setup-wizard">{projectId}</div>,
}))

beforeEach(() => {
  vi.clearAllMocks()
  orgRole = 700
  vi.mocked(fetchAirtableOrgLinks).mockResolvedValue([])
})

const pasteToken = (value: string) =>
  fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value } })

it("a maintainer pastes a token; once Airtable accepts it the projects can be linked", async () => {
  vi.mocked(fetchAirtableConnection).mockResolvedValue({ connected: false })
  vi.mocked(connectAirtable).mockResolvedValue({
    connected: true,
    account: { userId: "usr1", email: "anna@comeandsee.example" },
    createdAt: "2026-10-15T10:00:00Z",
    baseCount: 2,
    usable: true,
  })
  render(<MemoryRouter><OrgSettingsAirtable /></MemoryRouter>)

  await screen.findByLabelText("Personal access token")
  expect(screen.getByText(/data\.records:read, data\.records:write, schema\.bases:read, schema\.bases:write/)).toBeTruthy()
  pasteToken("  patABC.123secret  ")
  fireEvent.click(screen.getByRole("button", { name: "Connect Airtable" }))

  await waitFor(() => expect(connectAirtable).toHaveBeenCalledWith("tok", 7, "patABC.123secret"))
  expect(await screen.findByText("Airtable connected. The token can see 2 bases.")).toBeTruthy()
  expect(screen.getByText(/anna@comeandsee\.example/)).toBeTruthy()
  // The token field is gone and the token appears nowhere on the page.
  expect(screen.queryByLabelText("Personal access token")).toBeNull()
  expect(document.body.textContent).not.toContain("patABC")
  expect(await screen.findByText("Not linked yet")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Set up" }))
  expect(screen.getByTestId("setup-wizard").textContent).toBe("chosen")
})

it("a token Airtable refuses says so next to the field", async () => {
  vi.mocked(fetchAirtableConnection).mockResolvedValue({ connected: false })
  vi.mocked(connectAirtable).mockRejectedValue(
    new AirtableApiError("Airtable didn't accept this token. Check that you copied all of it and that it hasn't been deleted.", 400),
  )
  render(<MemoryRouter><OrgSettingsAirtable /></MemoryRouter>)
  await screen.findByLabelText("Personal access token")
  pasteToken("patWRONG")
  fireEvent.click(screen.getByRole("button", { name: "Connect Airtable" }))
  expect((await screen.findByRole("alert")).textContent).toMatch(/didn't accept this token/)
})

it("a rejected token asks for a new one, with the field to paste it", async () => {
  vi.mocked(fetchAirtableConnection).mockResolvedValue({
    connected: true,
    account: { userId: "usr1", email: null },
    needsReauth: true,
    usable: true,
  })
  render(<MemoryRouter><OrgSettingsAirtable /></MemoryRouter>)
  expect(await screen.findByText(/no longer accepts the saved token/)).toBeTruthy()
  expect(screen.getByRole("button", { name: "Save new token" })).toBeTruthy()
})

it("a member who can't manage the connection is told who can", async () => {
  orgRole = 400
  vi.mocked(fetchAirtableConnection).mockResolvedValue({ connected: false })
  render(<MemoryRouter><OrgSettingsAirtable /></MemoryRouter>)
  expect(await screen.findByText("Ask an org maintainer or owner to connect Airtable.")).toBeTruthy()
  expect(screen.queryByLabelText("Personal access token")).toBeNull()
})
