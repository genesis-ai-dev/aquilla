import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { beforeEach, describe, expect, it } from "vitest"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { events, schema } from "./schema"
import { writeProjectSnapshot } from "./project-snapshot"
import { listOfflineProjects } from "./offline-project-list"

let store: Store<typeof schema>
let seq = 0

function seed(id: string, name: string, orgId: string, status: "downloading" | "ready", owner = "anna") {
  store.commit(events.projectSynced({ id, name, orgId, settings: null, syncedAt: new Date(0) }))
  store.commit(events.offlineProjectStatusSet({ projectId: id, status, syncedAt: new Date(1000), queueDepth: 0 }))
  const summary = { id, name, gitlabProjectId: null, orgId: Number(orgId) || null } as CloudProjectSummary
  writeProjectSnapshot(store, summary, owner)
}

beforeEach(async () => {
  store = await createStorePromise({ schema, storeId: `offline-list-${++seq}`, adapter: makeInMemoryAdapter() })
})

describe("listOfflineProjects", () => {
  it("lists ready downloads by name, with their org", () => {
    seed("p2", "Ruth", "7", "ready")
    seed("p1", "Genesis", "3", "ready")
    expect(listOfflineProjects(store, "anna")).toEqual([
      { id: "p1", name: "Genesis", orgId: 3, syncedAt: new Date(1000) },
      { id: "p2", name: "Ruth", orgId: 7, syncedAt: new Date(1000) },
    ])
  })

  it("leaves out a download that hasn't finished", () => {
    seed("p1", "Genesis", "3", "downloading")
    expect(listOfflineProjects(store, "anna")).toEqual([])
  })

  it("leaves out a project downloaded under another account", () => {
    seed("p1", "Genesis", "3", "ready", "ben")
    expect(listOfflineProjects(store, "anna")).toEqual([])
    expect(listOfflineProjects(store, "ben").map((p) => p.id)).toEqual(["p1"])
  })

  it("falls back to the snapshot's org when the row has none", () => {
    seed("p1", "Genesis", "", "ready")
    expect(listOfflineProjects(store, "anna")[0].orgId).toBeNull()
  })
})
