import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { events, schema } from "./schema"
import type { ProjectSettingsResponse } from "@/lib/sync/project-settings"
import {
  readProjectSettingsSnapshot,
  readProjectSnapshot,
  writeProjectSettingsSnapshot,
  writeProjectSnapshot,
} from "./project-snapshot"

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
    writeProjectSnapshot(store, summary(), "anna")
    expect(readProjectSnapshot(store, "proj1", "anna")).toEqual(summary())
  })

  it("is not written for a project with no local row", () => {
    writeProjectSnapshot(store, summary(), "anna")
    seedProject("ready")
    expect(readProjectSnapshot(store, "proj1", "anna")).toBeNull()
  })

  it("is not read back until the download is ready", () => {
    seedProject("downloading")
    writeProjectSnapshot(store, summary(), "anna")
    expect(readProjectSnapshot(store, "proj1", "anna")).toBeNull()
  })

  it("keeps the newest snapshot", () => {
    seedProject("ready")
    writeProjectSnapshot(store, summary(), "anna")
    writeProjectSnapshot(store, summary({ name: "Genesis (renamed)" }), "anna")
    expect(readProjectSnapshot(store, "proj1", "anna")?.name).toBe("Genesis (renamed)")
  })

  it("is never handed to another account on the device", () => {
    seedProject("ready")
    writeProjectSnapshot(store, summary({ role: { level: 700, name: "owner", source: "org" } }), "owner")
    expect(readProjectSnapshot(store, "proj1", "translator")).toBeNull()
  })

  it("belongs to whichever account last stored it", () => {
    seedProject("ready")
    writeProjectSnapshot(store, summary(), "anna")
    writeProjectSnapshot(store, summary({ name: "Ben's view" }), "ben")
    expect(readProjectSnapshot(store, "proj1", "anna")).toBeNull()
    expect(readProjectSnapshot(store, "proj1", "ben")?.name).toBe("Ben's view")
  })

  it("commits nothing when an online open re-reads an unchanged project", () => {
    seedProject("ready")
    writeProjectSnapshot(store, summary(), "anna")
    const commit = vi.spyOn(store, "commit")
    writeProjectSnapshot(store, summary(), "anna")
    expect(commit).not.toHaveBeenCalled()
  })
})

const settingsResponse = (version = 1) =>
  ({
    version,
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: null,
    settings: {},
    lanes: [{ id: "lane1", role: "target", legacyTag: "en", position: 0, archivedAt: null }],
  }) as unknown as ProjectSettingsResponse

describe("project settings snapshot", () => {
  it("round-trips for a downloaded project", () => {
    seedProject("ready")
    writeProjectSettingsSnapshot(store, "proj1", settingsResponse(), "anna")
    expect(readProjectSettingsSnapshot(store, "proj1", "anna")).toEqual(settingsResponse())
  })

  it("is not read back until the download is ready", () => {
    seedProject("downloading")
    writeProjectSettingsSnapshot(store, "proj1", settingsResponse(), "anna")
    expect(readProjectSettingsSnapshot(store, "proj1", "anna")).toBeNull()
  })

  it("is never handed to another account on the device", () => {
    seedProject("ready")
    writeProjectSettingsSnapshot(store, "proj1", settingsResponse(), "owner")
    expect(readProjectSettingsSnapshot(store, "proj1", "translator")).toBeNull()
  })

  it("survives a re-download of the project", () => {
    seedProject("ready")
    writeProjectSettingsSnapshot(store, "proj1", settingsResponse(2), "anna")
    store.commit(events.projectSynced({ id: "proj1", name: "Genesis", orgId: "1", settings: null, syncedAt: new Date() }))
    expect(readProjectSettingsSnapshot(store, "proj1", "anna")?.version).toBe(2)
  })
})
