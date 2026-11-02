// AQU-2259: the New Project submit button was hard-coded English, so it stayed
// English in every language. Rendered here through a marking translator: a
// label that skips t() comes out unmarked.
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { translate } from "@/lib/i18n/translate"
import { ProjectCreateDialog } from "./ProjectCreateDialog"

vi.mock("@/lib/i18n/I18nProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/I18nProvider")>()
  const marked = (key: string, vars?: Record<string, unknown>) =>
    `⟦${translate(undefined, key as never, vars as never)}⟧`
  return { ...actual, useT: () => marked }
})
// AQU-1352: the destination picker fetches create-targets on open; submit waits
// for it, so resolve to Personal (the server always lists it).
vi.mock("@/lib/sync/create-targets", () => ({
  fetchCreateTargets: vi.fn().mockResolvedValue([
    { kind: "personal", orgId: null, name: "Personal", path: ["Personal"], role: 700, teams: [] },
  ]),
}))
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
  createProjectLane: vi.fn().mockResolvedValue({ kind: "ok", lane: { id: "lane" } }),
  renameProjectLane: vi.fn().mockResolvedValue({ kind: "ok", lane: { id: "source-lane" } }),

  fetchProjectSettings: vi.fn().mockResolvedValue({ version: 0, settings: {} }),
  patchProjectSettings: vi.fn().mockResolvedValue({ kind: "ok" }),
  PROJECT_SETTINGS_VERSION_INITIAL: 0,
}))
vi.mock("@/lib/store/project-index", () => ({
  createProject: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))


describe("New Project's submit button goes through translation (AQU-2259)", () => {
  it("labels the submit button from the catalog", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    screen.getAllByRole("button")[0].click()
    const submit = await screen.findByRole("button", { name: /Create project/ })
    expect(submit.textContent).toBe("⟦Create project⟧")
  })
})
