// AQU-1519: the Create New Project modal must lock itself while it works —
// and must never become a dead end doing so.
//
// Before this guard only the submit button disabled (AQU-711). Everything else
// stayed live for the whole create: the fields, the shape radios, the Upstream
// picker, the "Add as lane on ‹upstream›" button, and all three ways out (X,
// Escape, outside press). On the slow Linked Target → Its Source path that
// meant a stray click could add a lane to the upstream *while* its clone was
// being built, or close the dialog and reset the form out from under a request
// that carried on regardless.
//
// The contract this file pins:
//   * busy  → every control inside the body is disabled and the dialog refuses
//             to close (create path AND the mirror "Add as lane" path);
//   * done  → it closes itself;
//   * failed→ it unlocks with the error and the user's values intact;
//   * overran → it says so and lets the user out again, fields still locked,
//             and reopening gives a fresh, usable form.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { pickComboboxOption } from "@/test-utils/combobox"
import { ProjectCreateDialog } from "./ProjectCreateDialog"
import type { CreateTarget } from "@/lib/sync/create-targets"

// AQU-1352: the destination picker fetches create-targets on open and submit
// waits for it. Each test resolves it (Personal unless it says otherwise).
// AQU-1561: the dialog reads the chosen upstream's file list so the lead can
// pick which files to bring in. These tests are about everything else in the
// create flow, so the list resolves to one file and stays all-checked — the
// whole-project default, which keeps `linkProjectSource` carrying no `fileIds`
// exactly as it did before that slice.
vi.mock("@/lib/sync/link-source-preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/link-source-preview")>()
  return {
    ...actual,
    loadUpstreamFileChoices: vi
      .fn()
      .mockResolvedValue([{ id: "up-file-1", name: "MAT", clashes: false }]),
  }
})

vi.mock("@/lib/sync/create-targets", () => ({ fetchCreateTargets: vi.fn() }))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "tok", username: "wendi" },
    loading: false,
  }),
}))

vi.mock("@/hooks/useAccessibleProjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAccessibleProjects")>()
  return {
    ...actual,
    useProjectsForNavigation: () => ({
      projects: [
        {
          id: "upstream-1",
          name: "English Source",
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
  createProjectLane: vi.fn().mockResolvedValue({ kind: "ok", lane: { id: "lane" } }),
  renameProjectLane: vi.fn().mockResolvedValue({ kind: "ok", lane: { id: "source-lane" } }),

  fetchProjectSettings: vi.fn(),
  patchProjectSettings: vi.fn(),
  PROJECT_SETTINGS_VERSION_INITIAL: 0,
}))

vi.mock("@/lib/sync/archive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/archive")>()
  return {
    ...actual,
    linkProjectSource: vi.fn().mockResolvedValue({
      projectId: "new-proj",
      sourceProjectId: "upstream-1",
      mode: "live",
      consumes: "source",
      gate: "validated",
      previousSourceProjectId: null,
      seeded: true,
    }),
    triggerLinkSync: vi.fn().mockResolvedValue(true),
  }
})

vi.mock("@/lib/store/project-index", () => ({
  createProject: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))
vi.mock("@/components/ui/toast", () => ({
  toast: { add: vi.fn(), close: vi.fn(), update: vi.fn(), promise: vi.fn() },
}))

import { createCloudProject } from "@/lib/sync/cloud-projects"
import { fetchCreateTargets } from "@/lib/sync/create-targets"
import { fetchProjectSettings, patchProjectSettings } from "@/lib/sync/project-settings"

const mockCreateCloudProject = vi.mocked(createCloudProject)
const mockFetchProjectSettings = vi.mocked(fetchProjectSettings)
const mockPatchProjectSettings = vi.mocked(patchProjectSettings)
const mockCreateTargets = vi.mocked(fetchCreateTargets)

const PERSONAL: CreateTarget = {
  kind: "personal", orgId: null, name: "Personal", path: ["Personal"], role: 700, teams: [],
}
/** An org the caller maintains, with a team to create into (AQU-1352 P2). */
const ORG_WITH_TEAM: CreateTarget = {
  kind: "org", orgId: 10, name: "Biblica ETT", path: ["Biblica ETT"], role: 600,
  teams: [{ teamId: 1, name: "Pattani Malay", role: 500 }],
}

/** Matches the dialog's own LONG_RUNNING_WORK_MS. */
const OVERRUN_MS = 120_000

/** The destination picker landing is what enables submit (AQU-1352). */
const destinationLoaded = () => screen.findByTestId("project-create-destination")

async function openDialog(orgId?: number) {
  render(<ProjectCreateDialog onCreated={vi.fn()} orgId={orgId} />)
  fireEvent.click(screen.getByRole("button", { name: /new project/i }))
  await destinationLoaded()
}

function fillBasics(title = "Russian BSB") {
  fireEvent.change(screen.getByPlaceholderText("My Translation Project"), {
    target: { value: title },
  })
  fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), {
    target: { value: "English" },
  })
  fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), {
    target: { value: "Russian" },
  })
}

/** Park `createCloudProject` so the create is observably mid-flight. */
function holdCreateInFlight() {
  let release!: () => void
  mockCreateCloudProject.mockImplementation(
    () => new Promise<void>((resolve) => { release = () => resolve() }),
  )
  return () => release()
}

const closeButton = () => screen.getByRole("button", { name: /^close$/i })

/**
 * Base UI renders a radio as a `<span role="radio">`, not a native input, so
 * jest-dom's `toBeDisabled` (form elements only) never sees it. Its disabled
 * state travels as `aria-disabled` + `data-disabled`, which is also what the
 * library's own click handling gates on.
 */
function expectRadioDisabled(radio: HTMLElement) {
  expect(radio).toHaveAttribute("aria-disabled", "true")
  expect(radio).toHaveAttribute("data-disabled")
}
const dialogIsOpen = () => screen.queryByText("Create New Project") != null

/** Every way out of the dialog, fired in turn. */
function tryEveryWayOut() {
  fireEvent.click(closeButton())
  fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" })
  fireEvent.pointerDown(document.body)
  fireEvent.click(document.body)
}

describe("ProjectCreateDialog — locks while it works (AQU-1519)", () => {
  beforeEach(() => {
    mockCreateCloudProject.mockReset()
    mockCreateCloudProject.mockResolvedValue(undefined)
    mockFetchProjectSettings.mockReset()
    mockPatchProjectSettings.mockReset()
    mockPatchProjectSettings.mockResolvedValue({ kind: "ok" } as never)
    mockCreateTargets.mockReset()
    mockCreateTargets.mockResolvedValue([PERSONAL])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("disables every control in the body while a plain create is in flight", async () => {
    const release = holdCreateInFlight()
    await openDialog()
    fillBasics()

    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))
    await waitFor(() => expect(mockCreateCloudProject).toHaveBeenCalledTimes(1))

    // One disabled fieldset carries the lock, so jest-dom reports every form
    // control inside it as disabled — fields, radios and buttons alike.
    expect(screen.getByTestId("create-project-fields")).toBeDisabled()
    expect(screen.getByLabelText(/^Project title$/i)).toBeDisabled()
    expect(screen.getByLabelText(/^Source language$/i)).toBeDisabled()
    expect(screen.getByLabelText(/^Target language/i)).toBeDisabled()
    expectRadioDisabled(screen.getByTestId("create-shape-linked-target"))
    expect(screen.getByRole("combobox", { name: /Upstream project/i })).toBeDisabled()
    // AQU-1352: where the project lives is part of the request in flight too.
    expect(screen.getByTestId("project-create-destination")).toBeDisabled()
    expect(closeButton()).toBeDisabled()

    // …and the shape radio really is inert: clicking it leaves the form on
    // self-contained, so no upstream/corpus question appears mid-create.
    fireEvent.click(screen.getByTestId("create-shape-linked-target"))
    expect(screen.queryByRole("radio", { name: /^Its Source/i })).toBeNull()

    release()
  })

  it("locks the destination and teams pickers of an org create (AQU-1352)", async () => {
    mockCreateTargets.mockResolvedValue([ORG_WITH_TEAM])
    const release = holdCreateInFlight()
    await openDialog(10)
    fillBasics()
    expect(screen.getByTestId("project-create-destination")).toBeEnabled()
    expect(screen.getByTestId("project-create-teams")).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))
    await waitFor(() => expect(mockCreateCloudProject).toHaveBeenCalledTimes(1))

    expect(screen.getByTestId("project-create-destination")).toBeDisabled()
    expect(screen.getByTestId("project-create-teams")).toBeDisabled()
    // …and a click on the locked teams picker opens nothing to choose from.
    fireEvent.click(screen.getByTestId("project-create-teams"))
    expect(screen.queryByRole("option", { name: "Pattani Malay" })).toBeNull()

    release()
  })

  it("refuses to close by X, Escape or an outside press during a create", async () => {
    const release = holdCreateInFlight()
    await openDialog()
    fillBasics()

    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))
    await waitFor(() => expect(mockCreateCloudProject).toHaveBeenCalledTimes(1))

    tryEveryWayOut()
    expect(dialogIsOpen()).toBe(true)

    // …and closes itself the moment the create lands.
    release()
    await waitFor(() => expect(dialogIsOpen()).toBe(false))
  })

  it("locks the Linked Target path too, Add as lane included", async () => {
    const release = holdCreateInFlight()
    await openDialog()
    fillBasics("French Episode 1")
    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickComboboxOption(/Upstream project/i, /English Source/i)
    fireEvent.click(screen.getByRole("radio", { name: /^Its Source/i }))

    expect(screen.getByTestId("add-as-lane-btn")).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))
    await waitFor(() => expect(mockCreateCloudProject).toHaveBeenCalledTimes(1))

    // The headline regression: a stray click here used to add a lane to the
    // upstream while its clone was still being built.
    expect(screen.getByTestId("add-as-lane-btn")).toBeDisabled()
    fireEvent.click(screen.getByTestId("add-as-lane-btn"))
    expect(mockFetchProjectSettings).not.toHaveBeenCalled()

    expectRadioDisabled(screen.getByRole("radio", { name: /^One of its Targets/i }))
    tryEveryWayOut()
    expect(dialogIsOpen()).toBe(true)

    release()
  })

  it("locks the dialog the other way round too: while Add as lane is in flight", async () => {
    let releaseFetch!: () => void
    mockFetchProjectSettings.mockImplementation(
      () => new Promise((resolve) => {
        releaseFetch = () =>
          resolve({
            version: 1,
            updatedAt: "2026-10-01T00:00:00.000Z",
            updatedBy: null,
            settings: { targetLanes: ["es"] },
          } as never)
      }),
    )

    await openDialog()
    fillBasics("French Episode 1")
    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickComboboxOption(/Upstream project/i, /English Source/i)
    fireEvent.click(screen.getByRole("radio", { name: /^Its Source/i }))

    fireEvent.click(screen.getByTestId("add-as-lane-btn"))
    await waitFor(() => expect(mockFetchProjectSettings).toHaveBeenCalledTimes(1))

    const submit = screen.getByRole("button", { name: /Create & Link/i })
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    fireEvent.submit(document.getElementById("project-create-form")!)
    expect(mockCreateCloudProject).not.toHaveBeenCalled()

    expect(screen.getByLabelText(/^Project title$/i)).toBeDisabled()
    tryEveryWayOut()
    expect(dialogIsOpen()).toBe(true)

    releaseFetch()
  })

  it("unlocks with the error and the user's values intact when the create fails", async () => {
    mockCreateCloudProject.mockRejectedValueOnce(new Error("network blip"))
    await openDialog()
    fillBasics()
    fireEvent.click(screen.getByText("Advanced: project shape"))
    fireEvent.click(screen.getByText(/Linked target/i))
    await pickComboboxOption(/Upstream project/i, /English Source/i)
    fireEvent.click(screen.getByRole("radio", { name: /^Its Source/i }))

    fireEvent.click(screen.getByRole("button", { name: /Create & Link/i }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/network blip/i))

    expect(screen.getByTestId("create-project-fields")).toBeEnabled()
    expect(closeButton()).toBeEnabled()
    // Nothing the user entered was thrown away by the failure.
    expect(screen.getByLabelText(/^Project title$/i)).toHaveValue("Russian BSB")
    expect(screen.getByRole("radio", { name: /^Its Source/i })).toBeChecked()
    expect(screen.getByRole("combobox", { name: /Upstream project/i })).toHaveTextContent(
      /English Source/i,
    )
  })

  it("never locks on a create that a validation error stopped before it started", async () => {
    await openDialog()
    // No title, no languages: the form rejects it, so nothing goes in flight.
    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))

    expect(mockCreateCloudProject).not.toHaveBeenCalled()
    expect(screen.getByTestId("create-project-fields")).toBeEnabled()
    expect(closeButton()).toBeEnabled()
    expect(dialogIsOpen()).toBe(true)
  })

  it("admits an overrun, hands back the X, and still reopens as a fresh usable form", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const release = holdCreateInFlight()
    await openDialog()
    fillBasics()

    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))
    await waitFor(() => expect(mockCreateCloudProject).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("create-taking-long")).toBeNull()

    act(() => { vi.advanceTimersByTime(OVERRUN_MS) })

    expect(screen.getByTestId("create-taking-long")).toBeTruthy()
    // Fields stay locked — the request is still in flight and editing it
    // would change nothing — but the user is no longer trapped.
    expect(screen.getByTestId("create-project-fields")).toBeDisabled()
    expect(closeButton()).toBeEnabled()

    fireEvent.click(closeButton())
    await waitFor(() => expect(dialogIsOpen()).toBe(false))

    // Reopening is a brand-new form, not the locked one it was abandoned in.
    fireEvent.click(screen.getByRole("button", { name: /new project/i }))
    await destinationLoaded()
    expect(screen.getByTestId("create-project-fields")).toBeEnabled()
    expect(screen.getByLabelText(/^Project title$/i)).toHaveValue("")
    expect(screen.queryByTestId("create-taking-long")).toBeNull()

    release()
  })
})
