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
import type { LangQuestInspection } from "@/lib/langquest/types"

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
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))
vi.mock("@/lib/sync/create-targets", () => ({ fetchCreateTargets: vi.fn() }))
vi.mock("@/context/OrgContext", () => ({
  useActiveOrgOptional: () => ({ orgs: [{ id: 10, name: "Kalam", role: { level: 600, name: "maintainer" } }], guestOrgs: [] }),
}))
vi.mock("@/lib/langquest/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/langquest/api")>()
  return { ...actual, inspectLangQuestToken: vi.fn(), linkLangQuest: vi.fn().mockResolvedValue({}) }
})

import { createCloudProject } from "@/lib/sync/cloud-projects"
import { createProjectLane } from "@/lib/sync/project-settings"
import { fetchCreateTargets } from "@/lib/sync/create-targets"
import { inspectLangQuestToken, linkLangQuest } from "@/lib/langquest/api"

const ORG: CreateTarget = { kind: "org", orgId: 10, name: "Kalam", path: ["Kalam"], role: 600, teams: [] }
const TOKEN = "lqp_Sq3k1yA0bJxL6tWm9cZr2eVu"

function inspection(release: boolean): LangQuestInspection {
  const can = { read: "all" as const, review: false, release, externalValues: { read: false, write: false } }
  return {
    apiBase: "https://next.langquest.org/api/v1",
    org: { id: "lq-org", name: "Kalam Team" },
    token: { id: "tok-1", name: "Aquilla", scopes: release ? ["read", "release"] : ["read"], expiresAt: null, allLanguages: true },
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
  fireEvent.change(await screen.findByLabelText("LangQuest access token"), { target: { value: TOKEN } })
  fireEvent.click(screen.getByRole("button", { name: "Check token" }))
}

describe("ProjectCreateDialog — Import from LangQuest (AQU-2105)", () => {
  beforeEach(() => {
    vi.mocked(createCloudProject).mockClear()
    vi.mocked(createProjectLane).mockClear()
    vi.mocked(linkLangQuest).mockClear()
    vi.mocked(fetchCreateTargets).mockResolvedValue([ORG])
  })

  it("states what the token allows, names the scope a missing capability needs, and creates nothing on a check", async () => {
    vi.mocked(inspectLangQuestToken).mockResolvedValue(inspection(false))
    await openLangQuestPath()
    const list = await screen.findByTestId("langquest-permissions")
    expect(list.textContent).toContain("Read only")
    expect(list.textContent).toContain("Needs the “release” scope")
    expect(screen.getByTestId("langquest-token-org").textContent).toContain("Kalam Team")
    expect(createCloudProject).not.toHaveBeenCalled()
    expect(linkLangQuest).not.toHaveBeenCalled()
  })

  it("creates the project, puts the LangQuest language on a target lane, and links it with the token", async () => {
    vi.mocked(inspectLangQuestToken).mockResolvedValue(inspection(true))
    await openLangQuestPath()
    expect((await screen.findByTestId("langquest-permissions")).textContent).toContain("Read and write")
    const submit = screen.getByTestId("langquest-create-submit")
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)
    await waitFor(() => expect(linkLangQuest).toHaveBeenCalled())
    const [, projectId, token, languageId] = vi.mocked(linkLangQuest).mock.calls[0]!
    expect(vi.mocked(createCloudProject).mock.calls[0]![1]).toMatchObject({ id: projectId, name: "Kalam", orgId: 10 })
    expect(createProjectLane).toHaveBeenCalledWith("tok", projectId, { name: "Kalam", language: "kmh" })
    expect(token).toBe(TOKEN)
    expect(languageId).toBe("lang-kal")
  })

  it("refuses something that is not a LangQuest token without asking LangQuest", async () => {
    vi.mocked(inspectLangQuestToken).mockClear()
    render(<ProjectCreateDialog onCreated={vi.fn()} orgId={10} />)
    fireEvent.click(screen.getByRole("button", { name: "New project" }))
    fireEvent.click(await screen.findByTestId("project-create-langquest"))
    fireEvent.change(await screen.findByLabelText("LangQuest access token"), { target: { value: "sk-not-a-token" } })
    fireEvent.click(screen.getByRole("button", { name: "Check token" }))
    expect(await screen.findByText(/start with lqp_/)).toBeTruthy()
    expect(inspectLangQuestToken).not.toHaveBeenCalled()
  })
})
