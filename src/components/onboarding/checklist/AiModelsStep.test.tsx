/**
 * AiModelsStep — the AQU-701 "We don't use voice or transcription — skip this"
 * flow.
 *
 * Regression (level it escaped at): the skip wrote through patchProject, a
 * read-then-write over IDB. Thin-client projects are server-loaded and often
 * have NO IDB row, so the patch silently returned undefined — onUpdated never
 * fired and the link did nothing. The unit-level fixture that seeded a row
 * first could never catch that, so these tests cover both shapes: no row
 * (seed-on-skip) and existing row (patch + revert).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AiModelsStep } from "./AiModelsStep"
import {
  createProject,
  getProject,
  _resetDbForTesting,
} from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"

// The step only reads model statuses to size the download button; the skip
// flow under test never touches the prefetch workers.
vi.mock("@/lib/audio/prefetch", () => ({
  useModelStatus: () => ({ kind: "idle" }),
  prefetchAiModels: vi.fn(),
}))

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "test-" + Math.random().toString(36).slice(2),
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    ...overrides,
  }
}

beforeEach(async () => {
  await _resetDbForTesting()
  const dbs = await indexedDB.databases()
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name)
  }
})

describe("AiModelsStep skip (AQU-701)", () => {
  it("skip seeds an IDB row for a server-loaded project and reports the flag", async () => {
    const project = makeProject({ id: "srv-1" })
    const onUpdated = vi.fn()
    render(<AiModelsStep project={project} onUpdated={onUpdated} />)

    fireEvent.click(screen.getByRole("button", { name: /skip this/i }))

    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1))
    expect(onUpdated.mock.calls[0][0].aiSetupSkipped).toBe(true)
    // The device-local row now exists so the flag survives server refetches
    // (via mergeServerProjectWithLocalCache).
    const row = await getProject("srv-1")
    expect(row?.aiSetupSkipped).toBe(true)
  })

  it("renders the skipped state and Set up anyway clears the flag on the existing row", async () => {
    const project = makeProject({ id: "p-skip", aiSetupSkipped: true })
    await createProject(project)
    const onUpdated = vi.fn()
    render(<AiModelsStep project={project} onUpdated={onUpdated} />)

    expect(screen.getByText(/skipped for this project/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /set up anyway/i }))

    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1))
    expect(onUpdated.mock.calls[0][0].aiSetupSkipped).toBe(false)
    const row = await getProject("p-skip")
    expect(row?.aiSetupSkipped).toBe(false)
  })
})
