// AQU-1605: Create New Project — WHICH of the upstream's translations a chain
// link consumes.
//
// The chain case ("One of its Targets") used to send no lane at all, and the
// server read whichever of the upstream's lanes carried the empty legacy tag. An
// upstream translating into three languages could therefore only be chained from
// on one of them, by accident. The dialog now asks, offering only the lanes the
// server says this caller may see.
//
// Covered here (RTL, per AGENTS.md — this is dialog UI, not a cross-layer
// journey):
//   1. The question appears for the chain case only, and the request carries the
//      picked lane id.
//   2. A single lane is pre-filled rather than asked (AQU-1419: no forced
//      chooser at one lane) and still travels on the request.
//   3. The picker offers exactly the lanes the loader returned — it never
//      invents a default lane, which is how a lane the read wall hides would
//      reappear in the list.
//   4. Several lanes and no pick: the create is refused with the field's own
//      error rather than defaulting the lane server-side.
//   5. A failed lane read is said out loud, with a retry — never an empty list,
//      which reads as "this project has no translations".

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ProjectCreateDialog } from "./ProjectCreateDialog"
import { pickComboboxOption } from "@/test-utils/combobox"
import { pickSelectOption } from "@/test-utils/select"

vi.mock("@/lib/sync/link-source-preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/link-source-preview")>()
  return {
    ...actual,
    loadUpstreamFileChoices: vi
      .fn()
      .mockResolvedValue([{ id: "up-file-1", name: "MAT", clashes: false }]),
    loadUpstreamLaneChoices: vi.fn(),
  }
})
vi.mock("@/lib/sync/create-targets", () => ({
  fetchCreateTargets: vi.fn().mockResolvedValue([
    { kind: "personal", orgId: null, name: "Personal", path: ["Personal"], role: 700, teams: [] },
  ]),
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "wendi" }, loading: false }),
}))
vi.mock("@/hooks/useAccessibleProjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAccessibleProjects")>()
  return {
    ...actual,
    useProjectsForNavigation: () => ({
      projects: [
        {
          id: "upstream-1",
          name: "French NT",
          gitlabProjectId: null,
          role: { level: 700, name: "owner", source: "creator" },
        },
      ],
      isLoading: false,
      refresh: vi.fn(),
    }),
  }
})
vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cloud-projects")>()
  return { ...actual, createCloudProject: vi.fn().mockResolvedValue(undefined) }
})
vi.mock("@/lib/sync/project-settings", () => ({
  PROJECT_SETTINGS_VERSION_INITIAL: 0,
  fetchProjectSettings: vi.fn(),
  patchProjectSettings: vi.fn().mockResolvedValue({
    kind: "ok",
    value: {
      version: 1,
      updatedAt: "2026-10-03T00:00:00.000Z",
      updatedBy: { id: 1, username: "wendi" },
      settings: {},
    },
  }),
}))
vi.mock("@/lib/sync/archive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/archive")>()
  return {
    ...actual,
    linkProjectSource: vi.fn(),
    triggerLinkSync: vi.fn().mockResolvedValue(true),
  }
})
vi.mock("@/lib/store/project-index", () => ({ createProject: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))

import { loadUpstreamLaneChoices } from "@/lib/sync/link-source-preview"
import { linkProjectSource } from "@/lib/sync/archive"

const mockLoadLanes = vi.mocked(loadUpstreamLaneChoices)
const mockLink = vi.mocked(linkProjectSource)

const LANES_TWO = [
  { id: "lane-quebec", label: "Quebec French" },
  { id: "lane-france", label: "France French" },
]

function fillBasics(): void {
  fireEvent.click(screen.getByRole("button", { name: /new project/i }))
  fireEvent.change(screen.getByPlaceholderText("My Translation Project"), {
    target: { value: "Chaluba NT" },
  })
  fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), {
    target: { value: "French" },
  })
  fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), {
    target: { value: "Chaluba" },
  })
}

/** Through the shape → upstream → corpus answers, to the lane question. */
async function reachLaneQuestion(corpus: RegExp = /^One of its Targets/i): Promise<void> {
  fireEvent.click(screen.getByText("Advanced: project shape"))
  fireEvent.click(screen.getByText(/Linked target/i))
  await pickComboboxOption(/Upstream project/i, /French NT/i)
  fireEvent.click(screen.getByRole("radio", { name: corpus }))
}

describe("ProjectCreateDialog — which upstream translation (AQU-1605)", () => {
  beforeEach(() => {
    mockLink.mockReset()
    mockLink.mockResolvedValue({
      projectId: "new-proj",
      sourceProjectId: "upstream-1",
      mode: "live",
      consumes: "target",
      gate: "validated",
      laneId: "lane-quebec",
      previousSourceProjectId: null,
      seeded: true,
    })
    mockLoadLanes.mockReset()
    mockLoadLanes.mockResolvedValue(LANES_TWO)
  })

  it("asks which translation for the chain case, and sends the picked lane", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fillBasics()
    await reachLaneQuestion()

    await screen.findByRole("combobox", { name: /Which of its translations\?/i })
    await pickSelectOption(/Which of its translations\?/i, "France French")

    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))
    await waitFor(() => expect(mockLink).toHaveBeenCalledTimes(1))
    expect(mockLink.mock.calls[0]![2]).toMatchObject({
      sourceProjectId: "upstream-1",
      consumes: "target",
      laneId: "lane-france",
    })
  })

  it("does not ask for the sibling case, and sends no lane", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fillBasics()
    await reachLaneQuestion(/^Its Source/i)

    expect(screen.queryByText(/Which of its translations\?/i)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))
    await waitFor(() => expect(mockLink).toHaveBeenCalledTimes(1))
    expect(mockLink.mock.calls[0]![2]).not.toHaveProperty("laneId")
    // The lane list is never even read for a link that consumes the source.
    expect(mockLoadLanes).not.toHaveBeenCalled()
  })

  it("pre-fills a single lane rather than asking, and still sends it", async () => {
    mockLoadLanes.mockResolvedValue([{ id: "lane-only", label: "French" }])
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fillBasics()
    await reachLaneQuestion()

    // Named on screen — the choice stays visible — but needing no answer.
    const select = await screen.findByRole("combobox", { name: /Which of its translations\?/i })
    await waitFor(() => expect(select.textContent).toMatch(/French/))

    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))
    await waitFor(() => expect(mockLink).toHaveBeenCalledTimes(1))
    expect(mockLink.mock.calls[0]![2]).toMatchObject({ laneId: "lane-only" })
  })

  it("offers exactly the lanes the server returned — no invented default lane", async () => {
    // What a read-walled member gets back: one granted lane of an upstream that
    // has several. The dialog must not add the upstream's default lane to that.
    mockLoadLanes.mockResolvedValue([{ id: "lane-granted", label: "Quebec French" }])
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fillBasics()
    await reachLaneQuestion()

    const select = await screen.findByRole("combobox", { name: /Which of its translations\?/i })
    fireEvent.click(select)
    const options = await screen.findAllByRole("option")
    expect(options.map((o) => o.textContent)).toEqual(["Quebec French"])
  })

  it("refuses to create with several lanes and no pick", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fillBasics()
    await reachLaneQuestion()
    await screen.findByRole("combobox", { name: /Which of its translations\?/i })

    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))
    expect(
      await screen.findByText(/Choose which of the upstream project's translations to use/i),
    ).toBeTruthy()
    expect(mockLink).not.toHaveBeenCalled()
  })

  it("says so, with a retry, when the lane list cannot be read", async () => {
    mockLoadLanes.mockRejectedValueOnce(new Error("boom"))
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fillBasics()
    await reachLaneQuestion()

    expect(await screen.findByText(/Couldn't load this project's translations/i)).toBeTruthy()
    expect(screen.queryByRole("combobox", { name: /Which of its translations\?/i })).toBeNull()

    mockLoadLanes.mockResolvedValue(LANES_TWO)
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }))
    expect(await screen.findByRole("combobox", { name: /Which of its translations\?/i })).toBeTruthy()
  })
})
