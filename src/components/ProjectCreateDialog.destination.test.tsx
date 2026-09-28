// AQU-1352 P0 (spec 3.5 / 3.9 rule 5) — the create dialog's destination picker.
//
// Tim is org Guest + team Owner on "Biblica ETT". Before this, the dialog
// silently POSTed the page's orgId and the server 403'd (org role < maintainer),
// leaving him no way to create anything. The picker must: default to the page
// org only when the caller may create there, otherwise default to Personal and
// say why; and the submit must send the chosen destination.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ProjectCreateDialog } from "./ProjectCreateDialog"
import type { CreateTarget } from "@/lib/sync/create-targets"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tim" }, loading: false }),
}))
vi.mock("@/hooks/useAccessibleProjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAccessibleProjects")>()
  return {
    ...actual,
    useProjectsForNavigation: () => ({ projects: [], isLoading: false, refresh: vi.fn() }),
  }
})
vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cloud-projects")>()
  return { ...actual, createCloudProject: vi.fn().mockResolvedValue(undefined) }
})
vi.mock("@/lib/sync/project-settings", () => ({
  fetchProjectSettings: vi.fn().mockResolvedValue({ version: 0, settings: {} }),
  patchProjectSettings: vi.fn().mockResolvedValue({ kind: "ok" }),
  PROJECT_SETTINGS_VERSION_INITIAL: 0,
}))
vi.mock("@/lib/store/project-index", () => ({ createProject: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))
vi.mock("@/lib/sync/create-targets", () => ({ fetchCreateTargets: vi.fn() }))
vi.mock("@/context/OrgContext", () => ({
  useActiveOrgOptional: () => ({
    orgs: [{ id: 10, name: "Biblica ETT", role: { level: 400, name: "contributor" } }],
    guestOrgs: [],
  }),
}))

import { createCloudProject } from "@/lib/sync/cloud-projects"
import { fetchCreateTargets } from "@/lib/sync/create-targets"

const mockCreate = vi.mocked(createCloudProject)
const mockTargets = vi.mocked(fetchCreateTargets)

const PERSONAL: CreateTarget = { kind: "personal", orgId: null, name: "tim's workspace", path: ["tim's workspace"], role: 700 }
const BIBLICA: CreateTarget = { kind: "org", orgId: 10, name: "Biblica ETT", path: ["Biblica ETT"], role: 600 }

async function openAndFill(orgId?: number) {
  render(<ProjectCreateDialog onCreated={vi.fn()} orgId={orgId} />)
  fireEvent.click(screen.getByRole("button", { name: "New Project" }))
  await screen.findByTestId("project-create-destination")
  fireEvent.change(screen.getByPlaceholderText("My Translation Project"), { target: { value: "Pattani" } })
  fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), { target: { value: "English" } })
  fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), { target: { value: "Malay" } })
}

describe("ProjectCreateDialog — destination picker (AQU-1352)", () => {
  beforeEach(() => {
    mockCreate.mockClear()
    mockTargets.mockReset()
  })

  it("defaults to the page org when the caller may create there, and submits that orgId", async () => {
    mockTargets.mockResolvedValue([PERSONAL, BIBLICA])
    await openAndFill(10)
    expect(screen.getByTestId("project-create-destination")).toHaveTextContent("Biblica ETT")
    expect(screen.queryByTestId("project-create-destination-hint")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ orgId: 10 })
  })

  it("Tim's case: page org not a valid target → defaults to Personal, names his role, and omits orgId", async () => {
    mockTargets.mockResolvedValue([PERSONAL])
    await openAndFill(10)
    expect(screen.getByTestId("project-create-destination")).toHaveTextContent("Personal")
    const hint = screen.getByTestId("project-create-destination-hint")
    expect(hint).toHaveTextContent(/Contributor/)
    expect(hint).toHaveTextContent(/Biblica ETT/)
    expect(hint).toHaveTextContent(/Personal/)
    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    // Omitted orgId → server creates in (and lazily creates) the personal org
    // instead of 403ing on the org Tim can't create in.
    expect(mockCreate.mock.calls[0][1].orgId).toBeUndefined()
  })
})
