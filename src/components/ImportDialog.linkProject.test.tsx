/**
 * AQU-1527 — "From another project" on the Import dialog's landing screen.
 *
 * WHY these tests exist. AQU-1525 made an established project linkable to
 * another project's source, but only from Project Settings → Source & sync.
 * Someone who wants "the source files from that other project" in the project
 * they are working in does not think of that as a settings change — they open
 * the Import dialog. So the capability existed and the place people look did not
 * mention it. These tests pin the entry point: that the tile is there, that it
 * reaches the SAME flow the settings card mounts (including AQU-1526's pre-link
 * preview — the acceptance criterion is that the two entry points never
 * diverge), that backing out links nothing, and that the two cases where the
 * flow cannot be used say so instead of silently vanishing.
 *
 * AQU-1528 put the corpus question ("Its Source" / "One of its Targets") into
 * that shared flow, so this entry point gets it for free — which is the point,
 * and what the walk-through below asserts rather than assumes.
 *
 * The flow's own contract — picker contents, the live/consumes-source shape it
 * posts, the cycle refusal, the seed self-heal — stays pinned where it was, in
 * `ProjectSettings/LinkSourceSection.test.tsx`. These tests are about the door.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

const linkProjectSource = vi.fn()
const triggerLinkSync = vi.fn()

vi.mock("@/lib/sync/archive", () => ({
  linkProjectSource: (...args: unknown[]) => linkProjectSource(...args),
  triggerLinkSync: (...args: unknown[]) => triggerLinkSync(...args),
}))

// AQU-1526's confirm step, mocked at the loader: the clash arithmetic is pinned
// in `lib/sync/link-source-preview.test.ts`. Here it only has to prove the step
// appears on THIS entry point too.
const loadLinkSourcePreview = vi.fn()

vi.mock("@/lib/sync/link-source-preview", () => ({
  loadLinkSourcePreview: (...args: unknown[]) => loadLinkSourcePreview(...args),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "lead" }, loading: false }),
}))

let navigationProjects: CloudProjectSummary[] = []

vi.mock("@/hooks/useAccessibleProjects", () => ({
  useProjectsForNavigation: () => ({
    projects: navigationProjects,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))

// Heavy deps ImportDialog pulls in (mirrors ImportDialog.dcs.test.tsx's stubs).
vi.mock("@/components/dcs/DcsCatalogBrowser", () => ({
  DcsCatalogBrowser: () => <div>catalog browser</div>,
}))
vi.mock("@/lib/dcs/import-dcs", () => ({ importDcsResource: vi.fn() }))
vi.mock("@/lib/dcs/catalog", () => ({ DcsClient: class {} }))
vi.mock("@/lib/import", () => ({
  importFile: vi.fn(),
  importEBible: vi.fn(),
  importObs: vi.fn(),
  importHelloao: vi.fn(),
  importMacula: vi.fn(),
  importTranslationNotes: vi.fn(),
  prepareParatextProject: vi.fn(),
  commitParatextProject: vi.fn(),
  importParatextAsTarget: vi.fn(),
  prepareEBibleTargetImport: vi.fn(),
  applyEBibleTargetImport: vi.fn(),
  parseFile: vi.fn(async () => []),
  prepareImportFile: vi.fn(async () => ({ fileType: "txt", results: [] })),
}))
vi.mock("@/lib/import-sdbh", () => ({ importSdbh: vi.fn() }))
vi.mock("@/lib/import/cast-from-speakers", () => ({ buildCastAdditions: vi.fn(() => ({})) }))
vi.mock("@/lib/import/file-entries", () => ({ filesToProjectEntries: vi.fn(async () => []) }))
vi.mock("@/lib/parsers/paratext-project", () => ({ detectParatextProject: vi.fn(() => null) }))
vi.mock("@/lib/parsers/ebible", () => ({
  fetchTranslationsList: vi.fn(async () => []),
  fetchTranslationText: vi.fn(async () => ""),
  parseEBibleCorpus: vi.fn(() => []),
}))
vi.mock("@/lib/parsers/helloao", () => ({
  fetchHelloaoTranslations: vi.fn(async () => []),
  fetchHelloaoBooks: vi.fn(async () => []),
}))
vi.mock("uuid", () => ({ v7: () => "mock-uuid" }))

import { ImportDialog } from "./ImportDialog"

const PROJECT_ID = "proj-established"
const TILE = "From another project"

const onOpenChange = vi.fn()
const onLinked = vi.fn()

const baseProps = {
  open: true,
  onOpenChange,
  projectId: PROJECT_ID,
  username: "lead",
  sourceLanguage: "en",
  targetLanguage: "fr",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
}

function summary(id: string, name: string): CloudProjectSummary {
  return { id, name, role: { level: 100, name: "viewer", source: "member" } } as unknown as CloudProjectSummary
}

/** OWNER-level by default — the lead-and-above case the tile is built for. */
async function renderDialog(
  linkSource: { roleLevel: number | null; alreadyLinked: boolean } | null = {
    roleLevel: 900,
    alreadyLinked: false,
  },
) {
  await act(async () => {
    render(
      <ImportDialog
        {...baseProps}
        {...(linkSource ? { linkSource: { ...linkSource, onLinked } } : {})}
      />,
    )
  })
}

const tile = () => screen.getByText(TILE).closest("[role=button]")!

beforeEach(() => {
  vi.clearAllMocks()
  loadLinkSourcePreview.mockResolvedValue({
    upstreamName: "English Source",
    fileCount: 3,
    clashingNames: [],
  })
  navigationProjects = [summary("proj-upstream", "English Source"), summary(PROJECT_ID, "This Project")]
})

describe("ImportDialog — From another project (AQU-1527)", () => {
  // WHY: the whole slice. The landing screen listed upload and catalogue
  // sources and said nothing about other Aquilla projects, so the capability
  // was reachable only from a settings page most contributors never open.
  it("offers the tile and routes to the link flow's picker", async () => {
    await renderDialog()

    expect(screen.getByText(TILE)).toBeTruthy()
    await act(async () => {
      fireEvent.click(tile())
    })

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Source project" })).toBeTruthy()
    })
  })

  // WHY: the tile must be absent, not merely inert, in a host that cannot
  // refresh the project record afterwards — the user would be left looking at a
  // file list that does not yet know about the link.
  it("does not offer the tile when the host does not support linking", async () => {
    await renderDialog(null)
    expect(screen.queryByText(TILE)).toBeNull()
  })

  // WHY: the back control is the one way out of a screen the user opened by
  // mistake. It must leave the project exactly as it was.
  it("returns to the landing screen on back without linking anything", async () => {
    const user = userEvent.setup()
    await renderDialog()
    await act(async () => {
      fireEvent.click(tile())
    })
    await screen.findByRole("combobox", { name: "Source project" })

    await user.click(screen.getByRole("button", { name: "Back to import types" }))

    expect(await screen.findByText(TILE)).toBeTruthy()
    expect(screen.queryByRole("combobox", { name: "Source project" })).toBeNull()
    expect(linkProjectSource).not.toHaveBeenCalled()
  })

  // WHY: AQU-1526's confirm step shipped on the settings card. The acceptance
  // criterion is that the two entry points never diverge, so the same preview
  // has to stand between the pick and the link here — and the link that lands
  // is the "Its Source" shape (live, consumes source), not a clone.
  it("previews what the link adds, then links and closes the dialog", async () => {
    const user = userEvent.setup()
    linkProjectSource.mockResolvedValue({
      projectId: PROJECT_ID,
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "source",
      gate: "validated",
      previousSourceProjectId: null,
      seeded: true,
    })
    await renderDialog()
    await act(async () => {
      fireEvent.click(tile())
    })

    await user.click(await screen.findByRole("combobox", { name: "Source project" }))
    await user.click(await screen.findByRole("option", { name: "English Source" }))
    // AQU-1528: the corpus question is part of the shared flow, so it stands
    // between the pick and the review here too.
    expect(
      screen.getByText("Which corpus should become this project's source?"),
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Review what will be added" }).hasAttribute("disabled"),
    ).toBe(true)
    await user.click(screen.getByRole("radio", { name: /^Its Source/i }))
    await user.click(screen.getByRole("button", { name: "Review what will be added" }))

    // The shared preview, not a second one grown for this entry point.
    expect(await screen.findByText("Link to English Source?")).toBeTruthy()
    expect(
      screen.getByText("3 source files will be added to this project."),
    ).toBeTruthy()
    expect(loadLinkSourcePreview).toHaveBeenCalledWith("tok", PROJECT_ID, "proj-upstream")

    await user.click(screen.getByRole("button", { name: "Link source project" }))

    await waitFor(() => {
      expect(linkProjectSource).toHaveBeenCalledWith("tok", PROJECT_ID, {
        sourceProjectId: "proj-upstream",
        mode: "live",
        consumes: "source",
      })
    })
    // Refresh first, close second: the file list behind the dialog is what has
    // to know about the mirrored files.
    expect(onLinked).toHaveBeenCalled()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  // WHY: a project follows one upstream at a time, so this flow would be
  // refused. Hiding the tile is what caused this issue in the first place —
  // state the reason and name the page that owns the existing link.
  it("disables the tile on an already-linked project and points at settings", async () => {
    await renderDialog({ roleLevel: 900, alreadyLinked: true })

    const card = tile()
    expect(card.getAttribute("aria-disabled")).toBe("true")
    expect(card.getAttribute("data-tooltip")).toContain("Project Settings → Source & sync")

    await act(async () => {
      fireEvent.click(card)
    })
    expect(screen.queryByRole("combobox", { name: "Source project" })).toBeNull()
  })

  // WHY: the server floor is project_lead(500). A contributor gets no working
  // option — but one that says who can do it, so they know what to ask for.
  it("disables the tile below project lead", async () => {
    await renderDialog({ roleLevel: 200, alreadyLinked: false })

    const card = tile()
    expect(card.getAttribute("aria-disabled")).toBe("true")
    expect(card.getAttribute("data-tooltip")).toBe(
      "Project lead or above required to link a source project.",
    )

    await act(async () => {
      fireEvent.click(card)
    })
    expect(screen.queryByRole("combobox", { name: "Source project" })).toBeNull()
    expect(linkProjectSource).not.toHaveBeenCalled()
  })
})
