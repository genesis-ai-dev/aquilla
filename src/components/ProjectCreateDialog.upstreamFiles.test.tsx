// AQU-1561: picking which of the upstream's files a new project brings in.
//
// The question Create New Project now asks once an upstream is chosen, for both
// shapes that take one: a Linked Target project (live link) and a Self Contained
// project taking a one-time clone. The list, its check-all control and its
// wording are `UpstreamFileChoiceList`, shared with the Source & sync link flow
// (AQU-1559), so what is covered here is this dialog's half of the contract:
//
//  - the list appears, all checked, for either shape, and resets when the
//    upstream changes;
//  - nothing checked blocks the create and says so;
//  - the selection reaches `linkProjectSource` — omitted when everything is
//    checked (follow/copy the whole upstream, the pre-slice behaviour) and sent
//    as the picked upstream file ids when it is a subset;
//  - an upstream with no files shows no list and still creates;
//  - a file list that cannot be read is said, with a retry, rather than being
//    rendered as an empty list — which would read as "that project has no
//    files", a different and creatable situation.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProjectCreateDialog } from "./ProjectCreateDialog"
import { pickComboboxOption } from "@/test-utils/combobox"

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
        { id: "upstream-a", name: "English Source", gitlabProjectId: null, role: { level: 700, name: "owner", source: "creator" } },
        { id: "upstream-a2", name: "Greek Source", gitlabProjectId: null, role: { level: 700, name: "owner", source: "creator" } },
        { id: "upstream-empty", name: "Empty Source", gitlabProjectId: null, role: { level: 700, name: "owner", source: "creator" } },
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
    value: { version: 1, updatedAt: "2026-10-02T00:00:00.000Z", updatedBy: { id: 1, username: "wendi" }, settings: {} },
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

// The one seam this slice adds to the dialog: the chosen upstream's file list.
vi.mock("@/lib/sync/link-source-preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/link-source-preview")>()
  return { ...actual, loadUpstreamFileChoices: vi.fn() }
})

import { linkProjectSource } from "@/lib/sync/archive"
import { loadUpstreamFileChoices } from "@/lib/sync/link-source-preview"

const mockLink = vi.mocked(linkProjectSource)
const mockLoadFiles = vi.mocked(loadUpstreamFileChoices)

/** A's three files, the setup the issue's test checklist describes. */
const A_FILES = [
  { id: "a-mat", name: "MAT", clashes: false },
  { id: "a-mrk", name: "MRK", clashes: false },
  { id: "a-luk", name: "LUK", clashes: false },
]
const A2_FILES = [
  { id: "a2-jhn", name: "JHN", clashes: false },
  { id: "a2-act", name: "ACT", clashes: false },
]

function fillRequiredFields() {
  fireEvent.change(screen.getByPlaceholderText("My Translation Project"), {
    target: { value: "Burmese Gospels" },
  })
  fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), {
    target: { value: "English" },
  })
  fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), {
    target: { value: "Burmese" },
  })
}

/** Open the dialog with the required fields filled and Advanced expanded. */
function openAdvanced() {
  render(<ProjectCreateDialog onCreated={vi.fn()} />)
  fireEvent.click(screen.getByRole("button", { name: /new project/i }))
  fillRequiredFields()
  fireEvent.click(screen.getByText("Advanced: project shape"))
}

describe("ProjectCreateDialog — picking the upstream's files (AQU-1561)", () => {
  beforeEach(() => {
    mockLink.mockReset()
    mockLink.mockResolvedValue({
      projectId: "new-proj",
      sourceProjectId: "upstream-a",
      mode: "live",
      consumes: "source",
      gate: "validated",
      previousSourceProjectId: null,
      seeded: true,
    })
    mockLoadFiles.mockReset()
    mockLoadFiles.mockImplementation(async (_jwt, upstreamId) => {
      if (upstreamId === "upstream-a2") return A2_FILES
      if (upstreamId === "upstream-empty") return []
      return A_FILES
    })
  })

  it("lists the upstream's files, all checked, for a Linked Target project", async () => {
    openAdvanced()
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickComboboxOption(/Upstream project/i, /English Source/i)

    for (const name of ["MAT", "MRK", "LUK"]) {
      const box = await screen.findByRole("checkbox", { name })
      expect(box.getAttribute("aria-checked")).toBe("true")
    }
    expect((await screen.findByRole("checkbox", { name: "All files" })).getAttribute("aria-checked")).toBe("true")
    expect(screen.getByText(/3 files will be brought into the new project/i)).toBeTruthy()
  })

  it("lists the same files for a Self Contained clone", async () => {
    openAdvanced()
    // Default shape — no shape press, just an upstream: that IS the clone path.
    await pickComboboxOption(/Upstream project/i, /English Source/i)

    expect(await screen.findByRole("checkbox", { name: "MAT" })).toBeTruthy()
    expect(await screen.findByRole("checkbox", { name: "All files" })).toBeTruthy()
    // A clone has no "later", so it must not promise to follow anything.
    expect(screen.getByText(/A copy is taken once/i)).toBeTruthy()
    expect(screen.queryByText(/files it adds later will arrive/i)).toBeNull()
  })

  it("replaces the list, all checked again, when the upstream changes", async () => {
    const user = userEvent.setup()
    openAdvanced()
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickComboboxOption(/Upstream project/i, /English Source/i)
    await user.click(await screen.findByRole("checkbox", { name: "MRK" }))
    expect((await screen.findByRole("checkbox", { name: "MRK" })).getAttribute("aria-checked")).toBe("false")

    await pickComboboxOption(/Upstream project/i, /Greek Source/i)

    // A2's files, not A's, and the earlier uncheck did not carry over.
    expect(await screen.findByRole("checkbox", { name: "JHN" })).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "MRK" })).toBeNull())
    expect((await screen.findByRole("checkbox", { name: "ACT" })).getAttribute("aria-checked")).toBe("true")
  })

  it("blocks the create with nothing checked and says at least one file is needed", async () => {
    const user = userEvent.setup()
    openAdvanced()
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickComboboxOption(/Upstream project/i, /English Source/i)

    await user.click(await screen.findByRole("checkbox", { name: "All files" }))

    for (const name of ["MAT", "MRK", "LUK"]) {
      expect((await screen.findByRole("checkbox", { name })).getAttribute("aria-checked")).toBe("false")
    }
    expect(await screen.findByText(/Pick at least one file to bring in/i)).toBeTruthy()
    const create = screen.getByRole("button", { name: /Create & Link/i })
    await waitFor(() => expect(create).toHaveProperty("disabled", true))

    // The check-all control is the way back: pressing it again re-arms the create.
    await user.click(await screen.findByRole("checkbox", { name: "All files" }))
    await waitFor(() => expect(create).toHaveProperty("disabled", false))
  })

  it("sends only the picked file ids when a Linked Target create takes a subset", async () => {
    const user = userEvent.setup()
    openAdvanced()
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickComboboxOption(/Upstream project/i, /English Source/i)
    await user.click(await screen.findByRole("checkbox", { name: "MRK" }))
    await user.click(await screen.findByRole("checkbox", { name: "LUK" }))

    fireEvent.click(screen.getByRole("radio", { name: /^Its Source/i }))
    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))

    await waitFor(() => expect(mockLink).toHaveBeenCalledTimes(1))
    const [, , input] = mockLink.mock.calls[0]!
    expect(input).toMatchObject({ sourceProjectId: "upstream-a", mode: "live", consumes: "source" })
    expect(input.fileIds).toEqual(["a-mat"])
  })

  it("honours the selection for the chain corpus answer too", async () => {
    const user = userEvent.setup()
    openAdvanced()
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickComboboxOption(/Upstream project/i, /English Source/i)
    await user.click(await screen.findByRole("checkbox", { name: "MAT" }))

    fireEvent.click(screen.getByRole("radio", { name: /^One of its Targets/i }))
    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))

    await waitFor(() => expect(mockLink).toHaveBeenCalledTimes(1))
    const [, , input] = mockLink.mock.calls[0]!
    expect(input.consumes).toBe("target")
    expect(input.fileIds).toEqual(["a-mrk", "a-luk"])
  })

  it("omits fileIds entirely when everything stays checked", async () => {
    openAdvanced()
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickComboboxOption(/Upstream project/i, /English Source/i)
    await screen.findByRole("checkbox", { name: "All files" })

    fireEvent.click(screen.getByRole("radio", { name: /^Its Source/i }))
    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))

    await waitFor(() => expect(mockLink).toHaveBeenCalledTimes(1))
    const [, , input] = mockLink.mock.calls[0]!
    // Absent, not `[...all three]`: the whole-project link is what keeps files
    // the upstream gains LATER arriving, and sending the current list would
    // silently pin the link to today's files.
    expect("fileIds" in input).toBe(false)
  })

  it("narrows a Self Contained clone's one-time copy to the picked files", async () => {
    const user = userEvent.setup()
    mockLink.mockResolvedValue({
      projectId: "new-proj",
      sourceProjectId: "upstream-a",
      mode: "clone",
      consumes: "source",
      gate: "validated",
      previousSourceProjectId: null,
      seeded: true,
    })
    openAdvanced()
    await pickComboboxOption(/Upstream project/i, /English Source/i)
    await user.click(await screen.findByRole("checkbox", { name: "MRK" }))

    fireEvent.click(screen.getByRole("radio", { name: /^Its Source/i }))
    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))

    await waitFor(() => expect(mockLink).toHaveBeenCalledTimes(1))
    const [, , input] = mockLink.mock.calls[0]!
    expect(input.mode).toBe("clone")
    expect(input.fileIds).toEqual(["a-mat", "a-luk"])
  })

  it("shows no list for an upstream with no files and still creates", async () => {
    openAdvanced()
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickComboboxOption(/Upstream project/i, /Empty Source/i)

    expect(await screen.findByText(/has no files yet/i)).toBeTruthy()
    expect(screen.queryByRole("checkbox", { name: "All files" })).toBeNull()

    fireEvent.click(screen.getByRole("radio", { name: /^Its Source/i }))
    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))

    await waitFor(() => expect(mockLink).toHaveBeenCalledTimes(1))
    const [, , input] = mockLink.mock.calls[0]!
    expect("fileIds" in input).toBe(false)
  })

  it("says so with a retry when the upstream's file list cannot be read", async () => {
    mockLoadFiles.mockRejectedValueOnce(new Error("boom"))
    openAdvanced()
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickComboboxOption(/Upstream project/i, /English Source/i)

    expect(await screen.findByText(/Couldn't load that project's file list/i)).toBeTruthy()
    // Not an empty list — that would read as "no files" and would create.
    expect(screen.queryByRole("checkbox", { name: "All files" })).toBeNull()
    expect(screen.queryByText(/has no files yet/i)).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Create & Link/i })).toHaveProperty("disabled", true),
    )

    fireEvent.click(screen.getByRole("button", { name: /Try again/i }))

    // The retry re-reads the same upstream and the list arrives.
    expect(await screen.findByRole("checkbox", { name: "MAT" })).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Create & Link/i })).toHaveProperty("disabled", false),
    )
  })

  it("asks nothing and links nothing for a plain create with no upstream", async () => {
    openAdvanced()

    expect(screen.queryByRole("checkbox", { name: "All files" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))

    await waitFor(() => expect(mockLoadFiles).not.toHaveBeenCalled())
    expect(mockLink).not.toHaveBeenCalled()
  })
})
