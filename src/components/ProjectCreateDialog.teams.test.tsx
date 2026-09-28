// AQU-1352 P2 (spec §3.5, D4) — create into a team.
//
// Tim is an org Guest who leads the "Pattani Malay" team. The server accepts
// his create into the org only with a team he leads in teamIds, so the dialog
// must require a team for him and send the chosen ids; an org maintainer may
// create without one.

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

const TEAM = { teamId: 1, name: "Pattani Malay", role: 500 }
const TIM_ORG: CreateTarget = { kind: "org", orgId: 10, name: "Biblica ETT", path: ["Biblica ETT"], role: 100, teams: [TEAM] }
const MAINT_ORG: CreateTarget = { ...TIM_ORG, role: 600, teams: [TEAM, { teamId: 2, name: "Thai", role: null }] }

async function openAndFill() {
  render(<ProjectCreateDialog onCreated={vi.fn()} orgId={10} />)
  fireEvent.click(screen.getByRole("button", { name: "New Project" }))
  await screen.findByTestId("project-create-teams")
  fireEvent.change(screen.getByPlaceholderText("My Translation Project"), { target: { value: "Pattani" } })
  fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), { target: { value: "English" } })
  fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), { target: { value: "Malay" } })
}

describe("ProjectCreateDialog — teams multi-select (AQU-1352 P2)", () => {
  beforeEach(() => {
    mockCreate.mockClear()
    mockTargets.mockReset()
  })

  it("Tim must pick a team he leads; submitting without one does not POST", async () => {
    mockTargets.mockResolvedValue([TIM_ORG])
    await openAndFill()
    expect(screen.getByTestId("project-create-teams-hint")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))
    expect(await screen.findByText(/Choose at least one team/)).toBeTruthy()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("Tim's chosen team travels as teamIds", async () => {
    mockTargets.mockResolvedValue([TIM_ORG])
    await openAndFill()
    fireEvent.click(screen.getByTestId("project-create-teams"))
    fireEvent.click(await screen.findByRole("option", { name: "Pattani Malay" }))
    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ orgId: 10, teamIds: [1] })
  })

  it("an org maintainer may create without a team (no requirement hint)", async () => {
    mockTargets.mockResolvedValue([MAINT_ORG])
    await openAndFill()
    expect(screen.queryByTestId("project-create-teams-hint")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ orgId: 10, teamIds: [] })
  })
})
