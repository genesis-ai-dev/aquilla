import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { events, schema } from "./schema"
import { readProjectSnapshot, writeProjectSnapshot } from "./project-snapshot"

let store: Store<typeof schema>
let seq = 0

const summary = (overrides: Partial<CloudProjectSummary> = {}): CloudProjectSummary => ({
  id: "proj1",
  name: "Genesis",
  gitlabProjectId: null,
  orgId: 1,
  role: { level: 300, name: "translator", source: "org" },
  ...overrides,
}) as CloudProjectSummary

function seedProject(status: "downloading" | "ready") {
  store.commit(events.projectSynced({ id: "proj1", name: "Genesis", orgId: "1", settings: null, syncedAt: new Date() }))
  store.commit(events.offlineProjectStatusSet({ projectId: "proj1", status, syncedAt: null, queueDepth: 0 }))
}

beforeEach(async () => {
  store = await createStorePromise({ schema, storeId: `snapshot-${++seq}`, adapter: makeInMemoryAdapter() })
})

describe("project snapshot", () => {
  it("round-trips for a downloaded project", () => {
    seedProject("ready")
    writeProjectSnapshot(store, summary())
    expect(readProjectSnapshot(store, "proj1")).toEqual(summary())
  })

  it("is not written for a project with no local row", () => {
    writeProjectSnapshot(store, summary())
    seedProject("ready")
    expect(readProjectSnapshot(store, "proj1")).toBeNull()
  })

  it("is not read back until the download is ready", () => {
    seedProject("downloading")
    writeProjectSnapshot(store, summary())
    expect(readProjectSnapshot(store, "proj1")).toBeNull()
  })

  it("keeps the newest snapshot", () => {
    seedProject("ready")
    writeProjectSnapshot(store, summary())
    writeProjectSnapshot(store, summary({ name: "Genesis (renamed)" }))
    expect(readProjectSnapshot(store, "proj1")?.name).toBe("Genesis (renamed)")
  })

  it("commits nothing when an online open re-reads an unchanged project", () => {
    seedProject("ready")
    writeProjectSnapshot(store, summary())
    const commit = vi.spyOn(store, "commit")
    writeProjectSnapshot(store, summary())
    expect(commit).not.toHaveBeenCalled()
  })
})
