/**
 * AQU-2455: the first save the server refuses because the member (or the team
 * that was their only path) is gone shows the AQU-2452 sentence once, then the
 * org project list. The list's own query does not keep the project or its stats.
 *
 * The mint is the real client minter, the quarantine is the real outbox flush,
 * and the screen is the one ProjectWorkspace returns for that refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"

import { ProjectNoAccess } from "./ProjectNoAccess"
import { useRevokedOpenProject } from "@/hooks/useRevokedOpenProject"
import { useForbiddenOutboxRecords } from "@/hooks/useForbiddenOutboxRecords"
import { useProjectDirectory } from "@/hooks/useProjectDirectory"
import type { PortfolioProject } from "@/lib/frontier/portfolio"
import { clearPortfolioSeeds, rememberDirectoryPage } from "@/lib/frontier/portfolio-seed"
import { leaveRevokedOpenProject } from "@/lib/sync/lost-project-access"
import {
  enqueueOutboxEvent,
  resetOutboxConnectionForTests,
} from "@/lib/sync/outbox"
import { flushOutboxBatch } from "@/lib/sync/outbox-flush"
import { CQRS_SCHEMA_VERSION, type CqrsRawEvent } from "@/lib/sync/outbox-types"
import { makeSyncTokenMinter } from "@/lib/sync/sync-token"

const getPortfolioPage = vi.hoisted(() => vi.fn())
vi.mock("@/lib/frontier/portfolio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontier/portfolio")>()
  return {
    ...actual,
    getPortfolioPage: (...args: unknown[]) => getPortfolioPage(...args),
  }
})

vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => ({ activeOrgId: 7, isAllOrgs: false }),
}))

const refreshAccessibleProjects = vi.fn(async () => [])

function project(id: string, name: string, filledCells: number): PortfolioProject {
  return {
    id,
    name,
    totalCells: 100,
    validatedCells: filledCells,
    filledCells,
    aiDraftedCells: 0,
    lastEditAt: null,
    audioCells: 0,
    validatedAudioCells: 0,
    recordedMs: 0,
    deadlineAt: null,
  } as PortfolioProject
}

const alpha = project("alpha", "PMR Alpha", 80)
const beta = project("beta", "Beta Notes", 1)

function event(id: string): CqrsRawEvent<"target.cell.commit"> {
  return {
    id,
    schemaVersion: CQRS_SCHEMA_VERSION,
    kind: "target.cell.commit",
    projectId: "alpha",
    fileId: "f1",
    cellId: "cell-1",
    author: "tester",
    payload: { value: "v", valueHtml: "<p>v</p>" },
    clientTs: 1,
  }
}

async function resetIdb(): Promise<void> {
  await resetOutboxConnectionForTests()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
    request.onblocked = () => resolve()
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

async function refuseSave(id: string): Promise<void> {
  await enqueueOutboxEvent(event(id))
  const mint = makeSyncTokenMinter(() => "jwt", "alpha", "f1", {}, "https://auth.example.test")
  await flushOutboxBatch({
    getTokenForFile: () => mint(),
    fetchImpl: vi.fn() as unknown as typeof fetch,
  })
}

function OpenEditor() {
  const records = useForbiddenOutboxRecords(true)
  const leave = useRevokedOpenProject({
    projectId: "alpha",
    settled: true,
    status: "ready",
    ejected: false,
    records,
  })
  const navigate = useNavigate()
  if (leave) {
    return (
      <ProjectNoAccess
        onBack={() => {
          leaveRevokedOpenProject({
            jwt: "jwt",
            projectId: "alpha",
            activeOrgId: 7,
            isAllOrgs: false,
            refreshAccessibleProjects,
            navigate,
          })
        }}
      />
    )
  }
  return <div data-testid="open-editor">editor</div>
}

function ProjectList() {
  const directory = useProjectDirectory({
    jwt: "jwt",
    enabled: true,
    query: "",
    orgIds: [7],
  })
  return (
    <ul data-testid="project-list">
      {directory.projects.map((row) => (
        <li key={row.id}>{`${row.name} · ${row.filledCells} translated`}</li>
      ))}
    </ul>
  )
}

beforeEach(async () => {
  refreshAccessibleProjects.mockClear()
  getPortfolioPage.mockReset()
  clearPortfolioSeeds()
  await resetIdb()
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ error: "No access to project" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("a removed member with the project open (AQU-2455)", () => {
  it("shows the refusal once, then the org project list without that project", async () => {
    rememberDirectoryPage("jwt", "7", { projects: [alpha, beta], nextCursor: null })
    let releasePage!: (page: { projects: PortfolioProject[]; nextCursor: null }) => void
    getPortfolioPage.mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePage = resolve
        }),
    )

    render(
      <MemoryRouter initialEntries={["/projects/alpha"]}>
        <Routes>
          <Route path="/projects/:id" element={<OpenEditor />} />
          <Route path="/orgs/:orgId/projects" element={<ProjectList />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByTestId("open-editor")).toBeInTheDocument()

    await refuseSave("save-1")
    await waitFor(() => expect(screen.getByTestId("project-no-access")).toBeInTheDocument())
    expect(screen.queryByTestId("open-editor")).not.toBeInTheDocument()
    expect(screen.getAllByTestId("project-no-access")).toHaveLength(1)
    expect(screen.getByTestId("project-no-access")).toHaveTextContent(
      "Either this project does not exist, or you do not have access",
    )
    expect(screen.queryByText(/weren't saved/)).not.toBeInTheDocument()

    await refuseSave("save-2")
    await waitFor(() => expect(screen.getAllByTestId("project-no-access")).toHaveLength(1))
    expect(screen.queryByText(/weren't saved/)).not.toBeInTheDocument()
    expect(screen.queryByTestId("open-editor")).not.toBeInTheDocument()

    screen.getByRole("button", { name: "Back to dashboard" }).click()

    await waitFor(() => expect(screen.queryByTestId("project-no-access")).not.toBeInTheDocument())
    expect(screen.getByTestId("project-list")).toBeInTheDocument()
    expect(screen.queryByText(/PMR Alpha/)).not.toBeInTheDocument()
    expect(screen.queryByText(/80 translated/)).not.toBeInTheDocument()
    expect(screen.getByText("Beta Notes · 1 translated")).toBeInTheDocument()
    expect(getPortfolioPage).toHaveBeenCalled()
    expect(refreshAccessibleProjects).toHaveBeenCalledTimes(1)

    releasePage({ projects: [beta], nextCursor: null })
    await waitFor(() => expect(screen.getByText("Beta Notes · 1 translated")).toBeInTheDocument())
    expect(screen.queryByText(/PMR Alpha/)).not.toBeInTheDocument()
    expect(screen.queryByText(/80 translated/)).not.toBeInTheDocument()
  })
})
