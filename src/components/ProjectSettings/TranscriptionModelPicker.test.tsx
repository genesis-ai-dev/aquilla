// AQU-2052 — the hosted model picker's "Supports {language}" lines.
//
// WHY: the picker read `project.targetLanguage` and only believed a value that
// looked like a BCP 47 code. The create dialog saves the language NAME, so on
// every normally-created project the value was "Spanish" and no support line
// ever rendered. The language belongs to the LANE row (AQU-1593), so these
// lock: a name-tagged lane produces the lines, a freeform label produces none,
// and no project at all still lists each model's languages.

import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { username: "tester", jwt: "jwt" } }),
}))
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({ settings: {} }),
}))
vi.mock("@/lib/audio/transcription-model", () => ({
  useTranscriptionModel: () => "auto",
  setTranscriptionModel: vi.fn(),
}))
vi.mock("@/lib/audio/transcription-examples", () => ({
  fetchTranscriptionExamples: vi.fn(async () => []),
}))
vi.mock("@/lib/audio/omni-warmup", () => ({ warmZeroShot: vi.fn() }))

const project = vi.hoisted(() => ({ current: null as ProjectRecord | null }))
vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project: project.current }),
}))

type Lane = NonNullable<ProjectRecord["lanes"]>[number]

function lane(overrides: Partial<Lane> = {}): Lane {
  return {
    id: "aaaa0001", role: "target", language: null, name: null, langCode: null,
    legacyTag: "", position: 1, archivedAt: null, ...overrides,
  }
}

function renderPicker(record: ProjectRecord | null) {
  project.current = record
  window.history.replaceState({}, "", record ? "/preferences?project=p1" : "/preferences")
  return render(
    <I18nProvider>
      <TranscriptionModelPicker />
    </I18nProvider>,
  )
}

/** The Omnilingual catalog loads async; its row has no language list until it
 *  lands, so every assertion about three rows waits for that. */
async function allThreeCatalogsLoaded() {
  await waitFor(() => expect(screen.getAllByText(/^See all \d+ languages$/)).toHaveLength(3))
}

// Imported after the mocks so the component picks them up.
const { TranscriptionModelPicker } = await import("./TranscriptionModelPicker")

function projectWith(lanes: Lane[], targetLanguage = "Spanish"): ProjectRecord {
  return {
    id: "p1", name: "Demo", sourceLanguage: "English", targetLanguage, lanes,
    createdAt: "2026-01-01T00:00:00Z", files: [], members: [],
  } as unknown as ProjectRecord
}

describe("TranscriptionModelPicker support lines (AQU-2052)", () => {
  it("names the lane's language when the lane was tagged by NAME, not by code", async () => {
    renderPicker(projectWith([lane({ language: "Spanish" })]))
    await allThreeCatalogsLoaded()
    expect(screen.getAllByText("Supports Spanish")).toHaveLength(3)
  })

  it("reads the lane, not the retired project-level language", async () => {
    renderPicker(projectWith([lane({ language: "French" })], "Spanish"))
    await allThreeCatalogsLoaded()
    expect(screen.getAllByText("Supports French")).toHaveLength(3)
    expect(screen.queryByText("Supports Spanish")).toBeNull()
  })

  it("says which models do not know the language", async () => {
    // Swahili: Whisper and Omnilingual know it, Qwen3-ASR does not.
    renderPicker(projectWith([lane({ language: "Swahili" })]))
    await allThreeCatalogsLoaded()
    expect(screen.getByText("Does not support Swahili")).toBeInTheDocument()
    expect(screen.getAllByText("Supports Swahili")).toHaveLength(2)
  })

  it("shows no line for a freeform label no catalog matches", async () => {
    renderPicker(projectWith([lane({ language: "Grade 7 English" })]))
    await allThreeCatalogsLoaded()
    expect(screen.queryByText(/^Supports /)).toBeNull()
    expect(screen.queryByText(/^Does not support /)).toBeNull()
  })

  it("stays silent for a project whose lane rows have not loaded", async () => {
    renderPicker(projectWith([], "Spanish"))
    await allThreeCatalogsLoaded()
    expect(screen.queryByText(/^Supports /)).toBeNull()
    expect(screen.queryByText(/^Does not support /)).toBeNull()
  })

  it("lists each model's languages but no support line without a project", async () => {
    renderPicker(null)
    await allThreeCatalogsLoaded()
    expect(screen.queryByText(/^Supports /)).toBeNull()
    expect(screen.queryByText(/^Does not support /)).toBeNull()
  })
})
