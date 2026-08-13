// AQU-711: the Create Project submit button must reflect and enforce the
// in-flight submission state.
//
// Regression guard for the bug where the button's form.Subscribe selector only
// tracked the project-shape field, so form.state.isSubmitting was read stale:
// during a slow create the button never disabled, never showed the spinner /
// "Creating…" label, and each extra click (or Enter press) started another
// create — producing duplicate projects.
//
// We hold createCloudProject in flight with a deferred promise so the submit is
// observably mid-flight, then assert the button state and that re-entrant
// submits do NOT fire a second create.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ProjectCreateDialog } from "./ProjectCreateDialog"

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
    useProjectsForNavigation: () => ({ projects: [], isLoading: false, refresh: vi.fn() }),
  }
})

vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cloud-projects")>()
  return { ...actual, createCloudProject: vi.fn() }
})
vi.mock("@/lib/sync/project-settings", () => ({
  fetchProjectSettings: vi.fn().mockResolvedValue({ version: 0, settings: {} }),
  patchProjectSettings: vi.fn().mockResolvedValue({ kind: "ok" }),
  PROJECT_SETTINGS_VERSION_INITIAL: 0,
}))
vi.mock("@/lib/store/project-index", () => ({
  createProject: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))

import { createCloudProject } from "@/lib/sync/cloud-projects"

const mockCreateCloudProject = vi.mocked(createCloudProject)

function fillValidSelfContained() {
  fireEvent.change(screen.getByPlaceholderText("My Translation Project"), { target: { value: "Russian BSB" } })
  fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), { target: { value: "English" } })
  fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), { target: { value: "Russian" } })
}

describe("ProjectCreateDialog — submit in-flight state (AQU-711)", () => {
  beforeEach(() => {
    mockCreateCloudProject.mockReset()
  })

  it("opts create fields out of Chrome contact autocomplete", () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "New project" }))

    const name = screen.getByLabelText(/^Project title$/i)
    expect(name).toHaveAttribute("autocomplete", "off")
    expect(name).toHaveAttribute("name", "aquilla-project-title")
    expect(name.getAttribute("name")).not.toBe("name")

    const source = screen.getByLabelText(/^Source language$/i)
    expect(source).toHaveAttribute("autocomplete", "off")
    expect(source).toHaveAttribute("name", "aquilla-project-source-language")

    const target = screen.getByLabelText(/^Target language/i)
    expect(target).toHaveAttribute("autocomplete", "off")
    expect(target).toHaveAttribute("name", "aquilla-project-target-language")

    expect(document.getElementById("project-create-form")).toHaveAttribute(
      "autocomplete",
      "off",
    )
  })

  it("disables the button and shows the Creating… spinner while a create is in flight", async () => {
    let release!: () => void
    mockCreateCloudProject.mockImplementation(
      () => new Promise<void>((resolve) => { release = () => resolve() }),
    )

    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "New project" }))
    fillValidSelfContained()

    const button = screen.getByRole("button", { name: /Create Project/i })
    fireEvent.click(button)

    await waitFor(() => {
      expect(mockCreateCloudProject).toHaveBeenCalledTimes(1)
    })
    // Mid-flight: button is disabled and reflects the in-flight label.
    const busyButton = screen.getByRole("button", { name: /Creating…/i })
    expect(busyButton).toBeDisabled()

    release()
  })

  it("ignores re-entrant clicks and Enter while a create is in flight — exactly one create fires", async () => {
    let release!: () => void
    mockCreateCloudProject.mockImplementation(
      () => new Promise<void>((resolve) => { release = () => resolve() }),
    )

    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "New project" }))
    fillValidSelfContained()

    const button = screen.getByRole("button", { name: /Create Project/i })
    fireEvent.click(button)

    await waitFor(() => {
      expect(mockCreateCloudProject).toHaveBeenCalledTimes(1)
    })

    // Extra click on the (now disabled) button + an explicit form submit
    // (the Enter-key path) must NOT start a second create.
    fireEvent.click(screen.getByRole("button", { name: /Creating…/i }))
    fireEvent.submit(document.getElementById("project-create-form")!)

    // Give any errant submit a chance to fire before asserting it didn't.
    await Promise.resolve()
    expect(mockCreateCloudProject).toHaveBeenCalledTimes(1)

    release()
  })

  it("re-enables the button with the error shown when the create fails, and a retry works", async () => {
    mockCreateCloudProject.mockRejectedValueOnce(new Error("network blip"))

    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "New project" }))
    fillValidSelfContained()

    fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/network blip/i)
    })
    // Back to the enabled idle state after failure.
    const retryButton = screen.getByRole("button", { name: /Create Project/i })
    expect(retryButton).toBeEnabled()

    // A deliberate retry still fires a create.
    mockCreateCloudProject.mockResolvedValueOnce(undefined)
    fireEvent.click(retryButton)
    await waitFor(() => {
      expect(mockCreateCloudProject).toHaveBeenCalledTimes(2)
    })
  })
})
