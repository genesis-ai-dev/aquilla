// AQU-2126: when the LangQuest link fails after the project is created, the
// panel stays open with the reason and Create retries only the link. Nothing
// else in the app can link an unlinked project (the badge renders nothing for
// one), so closing the dialog on a failed link stranded the project.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { LangQuestCreatePanel } from "./LangQuestCreatePanel"
import type { LangQuestInspection } from "@/lib/langquest/types"

vi.mock("@/lib/sync/create-targets", () => ({
  fetchCreateTargets: vi.fn().mockResolvedValue([
    { kind: "personal", orgId: null, name: "Personal", path: ["Personal"], role: 700, teams: [] },
  ]),
}))

vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cloud-projects")>()
  return { ...actual, createCloudProject: vi.fn().mockResolvedValue(undefined) }
})

vi.mock("@/lib/sync/project-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/project-settings")>()
  return {
    ...actual,
    fetchProjectSettings: vi.fn().mockResolvedValue({ lanes: [{ id: "source-lane", role: "source" }] }),
    createProjectLane: vi.fn().mockResolvedValue({ kind: "ok", lane: { id: "lane" } }),
    renameProjectLane: vi.fn().mockResolvedValue({ kind: "ok", lane: { id: "source-lane" } }),
  }
})

vi.mock("@/lib/store/project-index", () => ({
  createProject: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))

vi.mock("@/lib/langquest/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/langquest/api")>()
  return { ...actual, inspectLangQuestToken: vi.fn(), linkLangQuest: vi.fn() }
})

import { createCloudProject } from "@/lib/sync/cloud-projects"
import { createProjectLane } from "@/lib/sync/project-settings"
import { createProject } from "@/lib/store/project-index"
import { inspectLangQuestToken, LangQuestLinkError, linkLangQuest } from "@/lib/langquest/api"

const inspection: LangQuestInspection = {
  apiBase: "https://next.langquest.org/api",
  org: { id: "org-1", name: "Test Org" },
  token: { id: "t1", name: "Aquilla", scopes: ["read"], expiresAt: null, allLanguages: true },
  languages: [
    {
      languageId: "lang-1",
      name: "Kumam",
      code: "kdi",
      country: null,
      can: { read: "all", review: false, release: false, externalValues: { read: false, write: false } },
    },
  ],
}

async function fillAndCheck() {
  fireEvent.change(screen.getByLabelText("LangQuest access token"), {
    target: { value: "lqp_abcdefghijklmnop1234" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Check token" }))
  await screen.findByTestId("langquest-token-org")
}

describe("LangQuestCreatePanel — a failed link can be retried (AQU-2126)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(inspectLangQuestToken).mockResolvedValue(inspection)
  })

  it("keeps the dialog open on a failed link, then links on retry without re-creating", async () => {
    vi.mocked(linkLangQuest)
      .mockRejectedValueOnce(new LangQuestLinkError("HTTP 502", 502, null, false))
      .mockResolvedValueOnce({} as never)
    const onCreated = vi.fn()
    render(
      <LangQuestCreatePanel
        jwt="tok"
        username="wendi"
        getProjectId={() => "draft-1"}
        onBack={vi.fn()}
        onCreated={onCreated}
      />,
    )
    await fillAndCheck()
    const submit = screen.getByTestId("langquest-create-submit")
    await waitFor(() => expect(submit).toBeEnabled())

    fireEvent.click(submit)
    expect(
      await screen.findByText("The project was created but isn't linked to LangQuest yet. Couldn't reach LangQuest. Try again."),
    ).toBeInTheDocument()
    expect(onCreated).not.toHaveBeenCalled()
    expect(createProject).not.toHaveBeenCalled()
    expect(submit).toHaveTextContent("Try linking again")
    expect(screen.getByLabelText("Project name")).toBeDisabled()

    fireEvent.click(submit)
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(linkLangQuest).toHaveBeenCalledTimes(2)
    expect(createCloudProject).toHaveBeenCalledTimes(1)
    expect(createProjectLane).toHaveBeenCalledTimes(1)
    expect(createProject).toHaveBeenCalledTimes(1)
  })

  it("links on the first try exactly as before", async () => {
    vi.mocked(linkLangQuest).mockResolvedValueOnce({} as never)
    const onCreated = vi.fn()
    render(
      <LangQuestCreatePanel
        jwt="tok"
        username="wendi"
        getProjectId={() => "draft-2"}
        onBack={vi.fn()}
        onCreated={onCreated}
      />,
    )
    await fillAndCheck()
    const submit = screen.getByTestId("langquest-create-submit")
    await waitFor(() => expect(submit).toBeEnabled())
    expect(submit).toHaveTextContent("Create and import")

    fireEvent.click(submit)
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(onCreated.mock.calls[0]![0]).toMatchObject({ id: "draft-2", name: "Kumam", targetLanguage: "kdi" })
    expect(createCloudProject).toHaveBeenCalledTimes(1)
  })
})
