import "fake-indexeddb/auto"
import { describe, it, expect, beforeEach } from "vitest"
import type { ProjectRecord } from "@/lib/parsers/types"
import { createProject, getProject } from "@/lib/store/project-index"
import { setFeatureFlag } from "./useFeatureFlag"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p-flag-test",
    name: "Test",
    sourceLanguage: "en",
    targetLanguage: "sw",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    ...overrides,
  }
}

describe("setFeatureFlag", () => {
  beforeEach(async () => {
    // fake-indexeddb resets per-test automatically with the auto-register, but
    // we create fresh records per test to keep things explicit.
    const p = await getProject("p-flag-test")
    if (p) {
      // no delete helper needed; overwrite in tests
    }
  })

  it("sets a flag on a project with no experimentalFlags", async () => {
    await createProject(makeProject())
    await setFeatureFlag("p-flag-test", "living-memory-view", true)
    const p = await getProject("p-flag-test")
    expect(p?.experimentalFlags?.["living-memory-view"]).toBe(true)
  })

  it("merges into existing experimentalFlags without clobbering", async () => {
    await createProject(
      makeProject({
        experimentalFlags: { "some-other-flag": true },
      }),
    )
    await setFeatureFlag("p-flag-test", "living-memory-view", true)
    const p = await getProject("p-flag-test")
    expect(p?.experimentalFlags).toEqual({
      "some-other-flag": true,
      "living-memory-view": true,
    })
  })

  it("overwrites an existing value for the same key", async () => {
    await createProject(
      makeProject({
        experimentalFlags: { "living-memory-view": true },
      }),
    )
    await setFeatureFlag("p-flag-test", "living-memory-view", false)
    const p = await getProject("p-flag-test")
    expect(p?.experimentalFlags?.["living-memory-view"]).toBe(false)
  })

  it("no-ops when project does not exist", async () => {
    // Does not throw, does not create.
    await setFeatureFlag("nonexistent-project", "living-memory-view", true)
    expect(await getProject("nonexistent-project")).toBeUndefined()
  })
})
