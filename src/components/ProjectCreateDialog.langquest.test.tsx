// AQU-2105: the "Import from LangQuest" path of the New project dialog.
//
// The contract: a pasted token is checked with LangQuest before anything is
// created; the dialog says what that token lets Aquilla do (and which scope a
// missing capability needs); Create makes the project, puts the recordings'
// language on a target lane, and links the project with the token — which is
// sent to the server once and never kept in the browser.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ProjectCreateDialog } from "./ProjectCreateDialog"
import type { CreateTarget } from "@/lib/sync/create-targets"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "anna" }, loading: false }),
}))
vi.mock("@/hooks/useAccessibleProjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAccessibleProjects")>()
  return { ...actual, useProjectsForNavigation: () => ({ projects: [], error: null }) }
})
vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cloud-projects")>()
  return { ...actual, createCloudProject: vi.fn().mockResolvedValue(undefined) }
})
vi.mock("@/lib/sync/project-settings", () => ({
  createProjectLane: vi.fn().mockResolvedValue({ kind: "ok", lane: { id: "lane" } }),
  renameProjectLane: vi.fn().mockResolvedValue({ kind: "ok", lane: { id: "source-lane" } }),
  fetchProjectSettings: vi.fn().mockResolvedValue({ version: 0, settings: {}, lanes: [{ id: "src", role: "source" }] }),
  patchProjectSettings: vi.fn().mockResolvedValue({ kind: "ok" }),
}))
vi.mock("@/lib/store/project-index", () => ({ createProject: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@/lib/posthog", () => ({ default: { scope() { return { ...this, enabled: () => true } }, capture: vi.fn() } }))
vi.mock("@/lib/sync/create-targets", () => ({ fetchCreateTargets: vi.fn() }))
vi.mock("@/context/OrgContext", () => ({
  useActiveOrgOptional: () => ({ orgs: [{ id: 10, name: "Kalam", role: { level: 600, name: "maintainer" } }], guestOrgs: [] }),
}))
vi.mock("@/lib/langquest/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/langquest/api")>()
  return {
    ...actual,
    fetchLangQuestConnections: vi.fn().mockResolvedValue([]),
    connectLangQuest: vi.fn(),
    linkLangQuestFromConnection: vi.fn().mockResolvedValue({}),
  }
})

import { createCloudProject } from "@/lib/sync/cloud-projects"
import { createProjectLane } from "@/lib/sync/project-settings"
import { fetchCreateTargets } from "@/lib/sync/create-targets"
import { connectLangQuest, linkLangQuestFromConnection } from "@/lib/langquest/api"
import type { LangQuestConnection, LangQuestLanguage } from "@/lib/langquest/types"

const ORG: CreateTarget = { kind: "org", orgId: 10, name: "Kalam", path: ["Kalam"], role: 600, teams: [] }
const TOKEN = "lqp_Sq3k1yA0bJxL6tWm9cZr2eVu"

function connected(release: boolean): { connection: LangQuestConnection; languages: LangQuestLanguage[] } {
  const can = { read: "all" as const, review: false, release, externalValues: { read: false, write: false } }
  return {
    connection: {
      id: "conn-1",
      apiBase: "https://next.langquest.org/api/v1",
      org: { id: "lq-org", name: "Kalam Team" },
      token: { id: "tok-1", name: "Aquilla", scopes: release ? ["read", "release"] : ["read"], expiresAt: null, allLanguages: true },
      health: "ok",
      lastCheckedAt: null,
      lastError: null,
      linkedProjects: 0,
      connectedAt: null,
      updatedAt: null,
    },
    languages: [
      { languageId: "lang-kal", name: "Kalam", code: "kmh", country: "PG", can },
      { languageId: "lang-x", name: "Hidden", code: "xxx", country: null, can: { ...can, read: null } },
    ],
  }
}

async function openLangQuestPath() {
  render(<ProjectCreateDialog onCreated={vi.fn()} orgId={10} />)
  fireEvent.click(screen.getByRole("button", { name: "New project" }))
  fireEvent.click(await screen.findByTestId("project-create-langquest"))
  // No saved connection: the first LangQuest step is connecting one.
  await screen.findByTestId("langquest-connect-step")
  fireEvent.change(screen.getByLabelText("LangQuest access token"), { target: { value: TOKEN } })
  fireEvent.click(screen.getByTestId("langquest-connect-submit"))
}

describe("ProjectCreateDialog — Import from LangQuest (AQU-2105)", () => {
  beforeEach(() => {
    vi.mocked(createCloudProject).mockClear()
    vi.mocked(createProjectLane).mockClear()
    vi.mocked(linkLangQuestFromConnection).mockClear()
    vi.mocked(fetchCreateTargets).mockResolvedValue([ORG])
  })

  it("asks where the project comes from first, with LangQuest as one of the three answers", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} orgId={10} />)
    fireEvent.click(screen.getByRole("button", { name: "New project" }))
    await screen.findByTestId("project-source-step")
    expect(screen.getByTestId("project-source-scratch")).toBeInTheDocument()
    expect(screen.getByTestId("project-source-linked")).toBeInTheDocument()
    expect(screen.getByTestId("project-create-langquest")).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Project name$/i)).toBeNull()
  })

  it("a connected token lists the org's languages, and the details step names the scope a missing capability needs — nothing created yet", async () => {
    vi.mocked(connectLangQuest).mockResolvedValue(connected(false))
    await openLangQuestPath()
    expect((await screen.findByTestId("langquest-token-org")).textContent).toContain("Kalam Team")
    expect(screen.getByTestId("langquest-language-lang-x")).toBeDisabled()
    fireEvent.click(screen.getByTestId("langquest-language-lang-kal"))
    const list = await screen.findByTestId("langquest-permissions")
    expect(list.textContent).toContain("Read only")
    expect(list.textContent).toContain("Needs the “release” scope")
    expect(createCloudProject).not.toHaveBeenCalled()
    expect(linkLangQuestFromConnection).not.toHaveBeenCalled()
  })

  it("creates the project, puts the LangQuest language on a target lane, and links it from the saved connection", async () => {
    vi.mocked(connectLangQuest).mockResolvedValue(connected(true))
    await openLangQuestPath()
    fireEvent.click(await screen.findByTestId("langquest-language-lang-kal"))
    expect((await screen.findByTestId("langquest-permissions")).textContent).toContain("Read and write")
    const submit = screen.getByTestId("langquest-create-submit")
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)
    await waitFor(() => expect(linkLangQuestFromConnection).toHaveBeenCalled())
    const [, projectId, connectionId, languageId] = vi.mocked(linkLangQuestFromConnection).mock.calls[0]!
    expect(vi.mocked(createCloudProject).mock.calls[0]![1]).toMatchObject({ id: projectId, name: "Kalam", orgId: 10 })
    expect(createProjectLane).toHaveBeenCalledWith("tok", projectId, { name: "Kalam", language: "kmh" })
    expect(connectionId).toBe("conn-1")
    expect(languageId).toBe("lang-kal")
  })

  it("the header's Back retraces the wizard to the source choice", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} orgId={10} />)
    fireEvent.click(screen.getByRole("button", { name: "New project" }))
    fireEvent.click(await screen.findByTestId("project-create-langquest"))
    await screen.findByTestId("langquest-connect-step")
    fireEvent.click(screen.getByTestId("project-create-back"))
    await screen.findByTestId("project-source-step")
  })
})
