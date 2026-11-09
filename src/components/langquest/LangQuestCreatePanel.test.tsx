// The LangQuest branch of the New-project wizard (AQU-2105 follow-up).
//
// Three things matter: a token pasted once makes the org a saved connection
// and goes straight on to its languages; a second project picks a saved org
// and links FROM THE CONNECTION, so no token is pasted or sent; and AQU-2126
// still holds — a failed link keeps the dialog open and Create retries only
// the link.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { useReducer } from "react"
import { LangQuestCreatePanel, type LangQuestCreatePanelProps } from "./LangQuestCreatePanel"
import { INITIAL_WIZARD_STATE, wizardReducer, type WizardState } from "@/lib/langquest/wizard"
import type { LangQuestConnection, LangQuestLanguage } from "@/lib/langquest/types"

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

vi.mock("@/lib/posthog", () => ({ default: { scope() { return { ...this, enabled: () => true } }, capture: vi.fn() } }))

vi.mock("@/lib/langquest/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/langquest/api")>()
  return {
    ...actual,
    connectLangQuest: vi.fn(),
    fetchLangQuestConnectionLanguages: vi.fn(),
    linkLangQuestFromConnection: vi.fn(),
  }
})

import { createCloudProject } from "@/lib/sync/cloud-projects"
import { createProjectLane } from "@/lib/sync/project-settings"
import { createProject } from "@/lib/store/project-index"
import {
  connectLangQuest,
  fetchLangQuestConnectionLanguages,
  LangQuestLinkError,
  linkLangQuestFromConnection,
} from "@/lib/langquest/api"

const TOKEN = "lqp_abcdefghijklmnop1234"

const connection = (over: Partial<LangQuestConnection> = {}): LangQuestConnection => ({
  id: "conn-1",
  apiBase: "https://next.langquest.org/api/v1",
  org: { id: "org-1", name: "Test Org" },
  token: { id: "t1", name: "Aquilla", scopes: ["read"], expiresAt: null, allLanguages: true },
  health: "ok",
  lastCheckedAt: null,
  lastError: null,
  linkedProjects: 1,
  connectedAt: "2026-10-01T00:00:00Z",
  updatedAt: null,
  ...over,
})

const languages: LangQuestLanguage[] = [
  {
    languageId: "lang-1",
    name: "Kumam",
    code: "kdi",
    country: null,
    can: { read: "all", review: false, release: false, externalValues: { read: false, write: false } },
  },
]

/** The dialog's half of the wizard: owns the state the panel renders from. */
function Harness({ initial, onCreated }: { initial: WizardState; onCreated: LangQuestCreatePanelProps["onCreated"] }) {
  const [state, dispatch] = useReducer(wizardReducer, initial)
  return (
    <LangQuestCreatePanel
      jwt="tok"
      username="wendi"
      getProjectId={() => "draft-1"}
      state={state}
      dispatch={dispatch}
      onCreated={onCreated}
    />
  )
}

const connectState: WizardState = { ...INITIAL_WIZARD_STATE, connectionsKnown: true, step: { kind: "connect" } }
const orgState = (conns: LangQuestConnection[]): WizardState => ({ connections: conns, connectionsKnown: true, step: { kind: "org" } })

async function pasteAndConnect() {
  fireEvent.change(screen.getByLabelText("LangQuest access token"), { target: { value: TOKEN } })
  fireEvent.click(screen.getByTestId("langquest-connect-submit"))
  await screen.findByTestId("langquest-language-step")
}

describe("LangQuestCreatePanel — connecting an organization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(connectLangQuest).mockResolvedValue({ connection: connection(), languages })
    vi.mocked(linkLangQuestFromConnection).mockResolvedValue({} as never)
  })

  it("opens LangQuest Connect in a new tab and, once a token is pasted, goes straight to the org's languages", async () => {
    render(<Harness initial={connectState} onCreated={vi.fn()} />)
    const open = screen.getByTestId("langquest-open-connect")
    expect(open).toHaveAttribute("href", "https://next.langquest.org/connect")
    expect(open).toHaveAttribute("target", "_blank")
    await pasteAndConnect()
    expect(connectLangQuest).toHaveBeenCalledWith("tok", TOKEN)
    expect(screen.getByTestId("langquest-token-org").textContent).toContain("Test Org")
    expect(screen.getByTestId("langquest-language-lang-1")).toBeEnabled()
  })

  it("refuses something that is not a LangQuest token without asking the server", async () => {
    render(<Harness initial={connectState} onCreated={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("LangQuest access token"), { target: { value: "sk-not-a-token" } })
    fireEvent.click(screen.getByTestId("langquest-connect-submit"))
    expect(await screen.findByText(/start with lqp_/)).toBeInTheDocument()
    expect(connectLangQuest).not.toHaveBeenCalled()
  })

  it("names a rejected token and stays on the connect step", async () => {
    vi.mocked(connectLangQuest).mockRejectedValueOnce(new LangQuestLinkError("nope", 401, "unauthorized", true))
    render(<Harness initial={connectState} onCreated={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("LangQuest access token"), { target: { value: TOKEN } })
    fireEvent.click(screen.getByTestId("langquest-connect-submit"))
    expect(await screen.findByText(/didn't accept that token/)).toBeInTheDocument()
    expect(screen.getByTestId("langquest-connect-step")).toBeInTheDocument()
  })

  it("creates the project, puts the language on a target lane, and links from the connection — no token is sent", async () => {
    const onCreated = vi.fn()
    render(<Harness initial={connectState} onCreated={onCreated} />)
    await pasteAndConnect()
    fireEvent.click(screen.getByTestId("langquest-language-lang-1"))
    await screen.findByTestId("langquest-details-step")
    expect(screen.getByTestId("langquest-permissions").textContent).toContain("Read only")
    expect(screen.getByLabelText("Project name")).toHaveValue("Kumam")
    const submit = screen.getByTestId("langquest-create-submit")
    await waitFor(() => expect(submit).toBeEnabled())
    fireEvent.click(submit)
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(onCreated.mock.calls[0]![0]).toMatchObject({ id: "draft-1", name: "Kumam", targetLanguage: "kdi" })
    expect(createProjectLane).toHaveBeenCalledWith("tok", "draft-1", { name: "Kumam", language: "kdi" })
    expect(linkLangQuestFromConnection).toHaveBeenCalledWith("tok", "draft-1", "conn-1", "lang-1")
    expect(JSON.stringify(vi.mocked(linkLangQuestFromConnection).mock.calls)).not.toContain(TOKEN)
  })

  it("keeps the dialog open on a failed link, then links on retry without re-creating (AQU-2126)", async () => {
    vi.mocked(linkLangQuestFromConnection)
      .mockRejectedValueOnce(new LangQuestLinkError("HTTP 502", 502, null, false))
      .mockResolvedValueOnce({} as never)
    const onCreated = vi.fn()
    render(<Harness initial={connectState} onCreated={onCreated} />)
    await pasteAndConnect()
    fireEvent.click(screen.getByTestId("langquest-language-lang-1"))
    const submit = await screen.findByTestId("langquest-create-submit")
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
    expect(linkLangQuestFromConnection).toHaveBeenCalledTimes(2)
    expect(createCloudProject).toHaveBeenCalledTimes(1)
    expect(createProjectLane).toHaveBeenCalledTimes(1)
    expect(createProject).toHaveBeenCalledTimes(1)
  })
})

describe("LangQuestCreatePanel — a second project from a saved organization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchLangQuestConnectionLanguages).mockResolvedValue({ connection: connection(), languages })
    vi.mocked(linkLangQuestFromConnection).mockResolvedValue({} as never)
  })

  it("picks the org, asks LangQuest for its languages, and never shows a token field", async () => {
    render(<Harness initial={orgState([connection()])} onCreated={vi.fn()} />)
    expect(screen.getByTestId("langquest-org-org-1").textContent).toContain("1 linked project")
    fireEvent.click(screen.getByTestId("langquest-org-org-1"))
    await screen.findByTestId("langquest-language-lang-1")
    expect(fetchLangQuestConnectionLanguages).toHaveBeenCalledWith("tok", "conn-1")
    expect(screen.queryByLabelText("LangQuest access token")).toBeNull()
    expect(connectLangQuest).not.toHaveBeenCalled()
  })

  it("a broken org cannot be picked: it offers Reconnect, which opens the token step", async () => {
    render(<Harness initial={orgState([connection({ health: "needs_reauth" })])} onCreated={vi.fn()} />)
    const org = screen.getByTestId("langquest-org-org-1")
    expect(org.textContent).toContain("Needs reconnecting")
    fireEvent.click(org)
    await screen.findByTestId("langquest-connect-step")
    expect(fetchLangQuestConnectionLanguages).not.toHaveBeenCalled()
  })

  it("LangQuest rejecting the saved token mid-wizard says so and offers Reconnect", async () => {
    vi.mocked(fetchLangQuestConnectionLanguages).mockRejectedValueOnce(new LangQuestLinkError("nope", 401, "unauthorized", true))
    render(<Harness initial={orgState([connection()])} onCreated={vi.fn()} />)
    fireEvent.click(screen.getByTestId("langquest-org-org-1"))
    expect(await screen.findByText(/didn't accept that token/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }))
    await screen.findByTestId("langquest-connect-step")
  })

  it("'Connect another organization' opens the token step", async () => {
    render(<Harness initial={orgState([connection()])} onCreated={vi.fn()} />)
    fireEvent.click(screen.getByTestId("langquest-connect-another"))
    await screen.findByTestId("langquest-connect-step")
  })
})
