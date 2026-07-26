import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import { ExperimentalFlagsSection } from "./ExperimentalFlagsSection"
import { createProject, getProject, _resetDbForTesting } from "@/lib/store/project-index"
import { isFlagEnabled } from "@/lib/features/flags"
import type { ProjectRecord } from "@/lib/parsers/types"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p1",
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
  cleanup()
  await _resetDbForTesting()
  const dbs = await indexedDB.databases()
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name)
  }
})

describe("ExperimentalFlagsSection", () => {
  it("renders the contextual drafting toggle, off by default", async () => {
    await createProject(makeProject())
    render(<ExperimentalFlagsSection projectId="p1" />)
    const toggle = await screen.findByRole("switch", { name: "Contextual drafting" })
    expect(toggle).not.toBeChecked()
  })

  it("toggle persists to the IDB record and isFlagEnabled reads it back", async () => {
    await createProject(makeProject())
    render(<ExperimentalFlagsSection projectId="p1" />)
    const toggle = await screen.findByRole("switch", { name: "Contextual drafting" })
    fireEvent.click(toggle)
    await waitFor(async () => {
      const stored = await getProject("p1")
      expect(stored?.experimentalFlags).toEqual({ contextualTranslation: true })
      expect(isFlagEnabled(stored!, "contextualTranslation")).toBe(true)
    })
  })

  it("seeds from an already-enabled record", async () => {
    await createProject(makeProject({ experimentalFlags: { contextualTranslation: true } }))
    render(<ExperimentalFlagsSection projectId="p1" />)
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Contextual drafting" })).toBeChecked()
    })
  })
})
