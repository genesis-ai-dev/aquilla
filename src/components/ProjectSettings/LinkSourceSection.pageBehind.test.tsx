// AQU-1570 — the page behind Project Settings shows a newly linked source's
// files without a reload.
//
// Project Settings is a route modal over the still-mounted workspace or project
// overview, and each resolves the project through its own `useProject`. The link
// flow's `onLinked` refreshes only the dialog's copy, so the upstream's files
// arrived and the page behind kept its old file list until a reload. Every layer
// was green on its own; the bug lived in the composition. So this renders the
// real link flow next to a real `useProject` consumer standing in for the page
// behind, with the server answering the project read before and after the link.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { useProject } from "@/hooks/useProject"
import { clearResolvedProjectSeeds } from "@/lib/sync/project-record-seed"
import { resetLinkSeedStatusForTests } from "@/lib/sync/link-seed-status"
import { LinkSourceSection } from "./LinkSourceSection"

const PROJECT_ID = "proj-page-behind"
const UPSTREAM_ID = "proj-upstream"

const linkProjectSource = vi.fn()
const triggerLinkSync = vi.fn()

vi.mock("@/lib/sync/archive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sync/archive")>()),
  linkProjectSource: (...args: unknown[]) => linkProjectSource(...args),
  triggerLinkSync: (...args: unknown[]) => triggerLinkSync(...args),
}))

vi.mock("@/lib/sync/link-source-preview", () => ({
  loadLinkSourcePreview: async () => ({
    upstreamName: "English Source",
    files: [{ id: "up-MAT", name: "MAT", clashes: false }],
    fileCount: 1,
    clashingNames: [],
  }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "lead" }, loading: false }),
}))

vi.mock("@/hooks/useAccessibleProjects", () => ({
  useProjectsForNavigation: () => ({
    projects: [
      { id: UPSTREAM_ID, name: "English Source", role: { level: 100, name: "viewer", source: "member" } },
    ] as unknown as CloudProjectSummary[],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))

/** What the server holds for the project. The link flips it; every
 *  `GET /api/v2/projects/:id` answers from it, as the auth-worker would. */
let serverFiles: Array<{ id: string; name: string; type: string; cellCount: number }> = []
const originalFetch = global.fetch

function projectReads(): number {
  return vi.mocked(global.fetch).mock.calls.filter(([url]) =>
    String(url).endsWith(`/api/v2/projects/${PROJECT_ID}`),
  ).length
}

/** Stands in for the workspace / overview behind the dialog: its own
 *  `useProject` instance, listing what that instance currently holds. */
function PageBehind() {
  const { project } = useProject(PROJECT_ID, { includeSettings: false })
  return (
    <ul aria-label="Files on the page behind">
      {(project?.files ?? []).map((f) => (
        <li key={f.id}>{f.name}</li>
      ))}
    </ul>
  )
}

function renderDialogOverPage() {
  const onLinked = vi.fn()
  render(
    <I18nProvider>
      <PageBehind />
      <LinkSourceSection projectId={PROJECT_ID} onLinked={onLinked} roleLevel={700} />
    </I18nProvider>,
  )
  return { onLinked }
}

async function linkToUpstream(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox", { name: "Source project" }))
  await user.click(await screen.findByRole("option", { name: "English Source" }))
  await user.click(screen.getByRole("radio", { name: /^Its Source/i }))
  await user.click(screen.getByRole("button", { name: "Review what will be added" }))
  await user.click(await screen.findByRole("button", { name: "Link source project" }))
}

beforeEach(() => {
  serverFiles = []
  linkProjectSource.mockReset()
  triggerLinkSync.mockReset()
  resetLinkSeedStatusForTests()
  global.fetch = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith(`/api/v2/projects/${PROJECT_ID}`)) {
      return new Response(
        JSON.stringify({
          id: PROJECT_ID,
          name: "Established project",
          gitlabProjectId: null,
          role: { level: 700, name: "owner", source: "creator" },
          files: serverFiles,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  global.fetch = originalFetch
  clearResolvedProjectSeeds()
})

describe("LinkSourceSection — the page behind the dialog (AQU-1570)", () => {
  it("lists the upstream's files on the page behind as soon as the link succeeds", async () => {
    const user = userEvent.setup()
    // The server seeds inside the link call: once it answers, the mirrored
    // file is in the project.
    linkProjectSource.mockImplementation(async () => {
      serverFiles = [{ id: "down-MAT", name: "MAT", type: "usfm", cellCount: 1071 }]
      return { projectId: PROJECT_ID, sourceProjectId: UPSTREAM_ID, mode: "live", consumes: "source", seeded: true }
    })
    const { onLinked } = renderDialogOverPage()
    const pageBehind = screen.getByRole("list", { name: "Files on the page behind" })
    await waitFor(() => expect(projectReads()).toBe(1))
    expect(within(pageBehind).queryByText("MAT")).toBeNull()

    await linkToUpstream(user)

    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1))
    expect(await within(pageBehind).findByText("MAT")).toBeTruthy()
  })

  it("leaves the page behind alone when the link is saved but its files did not arrive", async () => {
    const user = userEvent.setup()
    linkProjectSource.mockResolvedValue({
      projectId: PROJECT_ID, sourceProjectId: UPSTREAM_ID, mode: "live", consumes: "source", seeded: false,
    })
    triggerLinkSync.mockResolvedValue(false)
    const { onLinked } = renderDialogOverPage()
    await waitFor(() => expect(projectReads()).toBe(1))

    await linkToUpstream(user)

    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy()
    expect(onLinked).not.toHaveBeenCalled()
    expect(projectReads()).toBe(1)
  })

  it("lists the files on the page behind once Try again brings them in", async () => {
    const user = userEvent.setup()
    linkProjectSource.mockResolvedValue({
      projectId: PROJECT_ID, sourceProjectId: UPSTREAM_ID, mode: "live", consumes: "source", seeded: false,
    })
    triggerLinkSync.mockResolvedValueOnce(false)
    renderDialogOverPage()
    const pageBehind = screen.getByRole("list", { name: "Files on the page behind" })
    await linkToUpstream(user)
    await screen.findByRole("button", { name: "Try again" })

    triggerLinkSync.mockImplementationOnce(async () => {
      serverFiles = [{ id: "down-MAT", name: "MAT", type: "usfm", cellCount: 1071 }]
      return true
    })
    await user.click(screen.getByRole("button", { name: "Try again" }))

    expect(await within(pageBehind).findByText("MAT")).toBeTruthy()
  })
})
