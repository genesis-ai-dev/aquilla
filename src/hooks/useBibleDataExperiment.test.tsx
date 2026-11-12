// AQU-1685 — autopilot's panels read the Bible data experiment by project id.
//
// WHY: the switch is device-local, kept on this device's IndexedDB record of
// the project. Autopilot's panels have only the project id, so they must read
// that record: off for a project this device never switched on (or has no
// record of), and following the switch when Project settings writes it,
// without a reload, as the editor's own Bible data does.

import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { createProject, patchProject, _resetDbForTesting } from "@/lib/store/project-index"
import { useBibleDataExperiment } from "./useBibleDataExperiment"

function localRecord(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    name: `Project ${id}`,
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-10-06T00:00:00.000Z",
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

describe("useBibleDataExperiment", () => {
  it("is off for a project with no local record, and for one that never switched it on", async () => {
    const missing = renderHook(() => useBibleDataExperiment("p-none"))
    await createProject(localRecord("p-off"))
    const off = renderHook(() => useBibleDataExperiment("p-off"))
    // Give both reads time to land; neither may turn the experiment on.
    await createProject(localRecord("p-on", { experimentalFlags: { bibleData: true } }))
    const on = renderHook(() => useBibleDataExperiment("p-on"))
    await waitFor(() => expect(on.result.current).toBe(true))
    expect(missing.result.current).toBe(false)
    expect(off.result.current).toBe(false)
  })

  it("follows the switch when Project settings writes it", async () => {
    await createProject(localRecord("p-1"))
    const { result } = renderHook(() => useBibleDataExperiment("p-1"))
    expect(result.current).toBe(false)
    await act(async () => {
      await patchProject("p-1", (p) => ({ ...p, experimentalFlags: { bibleData: true } }))
    })
    await waitFor(() => expect(result.current).toBe(true))
    await act(async () => {
      await patchProject("p-1", (p) => ({ ...p, experimentalFlags: { bibleData: false } }))
    })
    await waitFor(() => expect(result.current).toBe(false))
  })
})
