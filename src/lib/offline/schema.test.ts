import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { beforeEach, describe, expect, it } from "vitest"
import { cellRowId, events, schema, tables } from "./schema"

let store: Store<typeof schema>
let storeId = 0

beforeEach(async () => {
  storeId += 1
  store = await createStorePromise({
    schema,
    storeId: `test-${storeId}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
})

describe("projects", () => {
  it("upserts and removes a project", () => {
    store.commit(
      events.projectSynced({
        id: "proj1",
        name: "Test Project",
        orgId: "org1",
        settings: { theme: "dark" },
        syncedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    )
    expect(store.query(tables.projects.select().where({ id: "proj1" }).first())).toMatchObject({
      id: "proj1",
      name: "Test Project",
      orgId: "org1",
      settings: { theme: "dark" },
    })

    store.commit(
      events.projectSynced({
        id: "proj1",
        name: "Renamed Project",
        orgId: "org1",
        settings: null,
        syncedAt: null,
      }),
    )
    expect(store.query(tables.projects.select().where({ id: "proj1" }).first())).toMatchObject({
      name: "Renamed Project",
      settings: null,
    })

    store.commit(events.projectRemoved({ id: "proj1" }))
    expect(store.query(tables.projects.select().where({ id: "proj1" }).first())).toBeUndefined()
  })
})

describe("files", () => {
  it("upserts and removes a file", () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    expect(store.query(tables.files.select())).toHaveLength(1)

    store.commit(events.fileRemoved({ id: "file1" }))
    expect(store.query(tables.files.select())).toHaveLength(0)
  })
})

describe("cells", () => {
  const cellArgs = {
    projectId: "proj1",
    fileId: "file1",
    cellId: "GEN 1:1",
    side: "source" as const,
    value: "In the beginning",
    valueHtml: "<p>In the beginning</p>",
    eventId: "evt1",
    sourceEventId: null,
    validated: false,
    aiDrafted: false,
    sequenceIndex: 0,
    canonicalRef: "GEN.1.1",
  }

  it("derives a stable composite row id and upserts on sync", () => {
    const id = cellRowId("proj1", "file1", "GEN 1:1", "source")
    store.commit(events.cellSynced(cellArgs))
    expect(store.query(tables.cells.select().where({ id }).first())).toMatchObject({ id, value: "In the beginning" })

    store.commit(events.cellSynced({ ...cellArgs, value: "In the beginning...", validated: true }))
    const rows = store.query(tables.cells.select().where({ projectId: "proj1", fileId: "file1" }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ value: "In the beginning...", validated: true })
  })

  it("removes a cell by its logical key", () => {
    store.commit(events.cellSynced(cellArgs))
    store.commit(events.cellRemoved(cellArgs))
    expect(store.query(tables.cells.select())).toHaveLength(0)
  })
})

describe("event queue", () => {
  it("enqueues, transitions status, and dequeues", () => {
    store.commit(
      events.eventQueued({
        id: "q1",
        projectId: "proj1",
        fileId: "file1",
        cellId: "GEN 1:1",
        kind: "target.cell.commit",
        payload: { text: "En el principio" },
        parentId: "evt1",
        clientTs: new Date("2026-01-01T00:00:00Z"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
    )
    expect(store.query(tables.eventQueue.select().where({ id: "q1" }).first())).toMatchObject({ status: "pending" })

    store.commit(events.eventQueueStatusSet({ id: "q1", status: "flushing" }))
    expect(store.query(tables.eventQueue.select().where({ id: "q1" }).first())).toMatchObject({ status: "flushing" })

    store.commit(events.eventDequeued({ id: "q1" }))
    expect(store.query(tables.eventQueue.select())).toHaveLength(0)
  })
})

describe("offline projects", () => {
  it("tracks and clears offline availability", () => {
    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj1", status: "downloading", syncedAt: null, queueDepth: 0 }),
    )
    expect(store.query(tables.offlineProjects.select().where({ projectId: "proj1" }).first())).toMatchObject({
      status: "downloading",
    })

    store.commit(
      events.offlineProjectStatusSet({
        projectId: "proj1",
        status: "ready",
        syncedAt: new Date("2026-01-01T00:00:00Z"),
        queueDepth: 2,
      }),
    )
    expect(store.query(tables.offlineProjects.select().where({ projectId: "proj1" }).first())).toMatchObject({
      status: "ready",
      queueDepth: 2,
    })

    store.commit(events.offlineProjectRemoved({ projectId: "proj1" }))
    expect(store.query(tables.offlineProjects.select().where({ projectId: "proj1" }).first())).toBeUndefined()
  })
})
