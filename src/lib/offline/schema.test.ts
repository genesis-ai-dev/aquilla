import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { beforeEach, describe, expect, it } from "vitest"
import { cellRowId, DEFAULT_LANE_KEY, events, localLaneKey, schema, tables } from "./schema"

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
    targetLang: "",
    laneId: null,
  }

  it("derives a stable composite row id and upserts on sync", () => {
    const id = cellRowId("proj1", "file1", "GEN 1:1", "source", DEFAULT_LANE_KEY)
    store.commit(events.cellSynced(cellArgs))
    expect(store.query(tables.cells.select().where({ id }).first())).toMatchObject({ id, value: "In the beginning" })

    store.commit(events.cellSynced({ ...cellArgs, value: "In the beginning...", validated: true }))
    const rows = store.query(tables.cells.select().where({ projectId: "proj1", fileId: "file1" }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ value: "In the beginning...", validated: true })
  })

  it("removes a cell by its logical key", () => {
    store.commit(events.cellSynced(cellArgs))
    store.commit(events.cellRemoved({ ...cellArgs, laneKey: DEFAULT_LANE_KEY }))
    expect(store.query(tables.cells.select())).toHaveLength(0)
  })

  it("keeps one row per lane instead of letting a second lane overwrite the first (AQU-1614)", () => {
    store.commit(events.cellSynced(cellArgs))
    store.commit(
      events.cellSynced({ ...cellArgs, targetLang: "es", laneId: "lane-es", value: "En el principio" }),
    )

    const rows = store.query(tables.cells.select().where({ projectId: "proj1", fileId: "file1" }))
    expect(rows).toHaveLength(2)
    expect(
      store.query(
        tables.cells.select().where({ id: cellRowId("proj1", "file1", "GEN 1:1", "source", DEFAULT_LANE_KEY) }).first(),
      ),
    ).toMatchObject({ value: "In the beginning", laneKey: DEFAULT_LANE_KEY })
    expect(
      store.query(tables.cells.select().where({ id: cellRowId("proj1", "file1", "GEN 1:1", "source", "lane-es") }).first()),
    ).toMatchObject({ value: "En el principio", laneId: "lane-es", targetLang: "es" })

    // Removing one lane leaves the other standing.
    store.commit(events.cellRemoved({ ...cellArgs, laneKey: "lane-es" }))
    expect(store.query(tables.cells.select().where({ projectId: "proj1", fileId: "file1" }))).toHaveLength(1)
  })

  it("replays a pre-lane eventlog entry onto the former default lane (AQU-1614 local-store migration)", () => {
    const { targetLang: _t, laneId: _l, ...legacyArgs } = cellArgs
    store.commit(events.cellSyncedLegacy(legacyArgs))

    const migrated = store.query(
      tables.cells.select().where({ id: cellRowId("proj1", "file1", "GEN 1:1", "source", DEFAULT_LANE_KEY) }).first(),
    )
    expect(migrated).toMatchObject({
      value: "In the beginning",
      laneKey: DEFAULT_LANE_KEY,
      targetLang: "",
      laneId: null,
    })
    expect(localLaneKey(null, "")).toBe(DEFAULT_LANE_KEY)

    // Replaying is idempotent, and a lane-aware default-lane write lands on the
    // SAME row rather than duplicating it.
    store.commit(events.cellSyncedLegacy(legacyArgs))
    store.commit(events.cellSynced({ ...cellArgs, value: "In the beginning," }))
    const rows = store.query(tables.cells.select().where({ projectId: "proj1", fileId: "file1" }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ value: "In the beginning,", laneKey: DEFAULT_LANE_KEY })
  })

  it("replays a pre-lane batch/remove eventlog entry onto the former default lane (AQU-1614)", () => {
    const { targetLang: _t, laneId: _l, projectId: _p, fileId: _f, ...rowArgs } = cellArgs
    store.commit(events.cellsSyncedLegacy({ projectId: "proj1", fileId: "file1", rows: [rowArgs] }))
    expect(
      store.query(
        tables.cells.select().where({ id: cellRowId("proj1", "file1", "GEN 1:1", "source", DEFAULT_LANE_KEY) }).first(),
      ),
    ).toMatchObject({ laneKey: DEFAULT_LANE_KEY })

    store.commit(
      events.cellsRemovedLegacy({ projectId: "proj1", fileId: "file1", cells: [{ cellId: "GEN 1:1", side: "source" }] }),
    )
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
        author: "dev@local.test",
        schemaVersion: 1,
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
