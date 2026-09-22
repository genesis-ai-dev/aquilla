import { describe, it, expect, beforeEach } from "vitest"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { schema, events, tables } from "./schema"
import {
  downloadProjectOffline,
  removeOfflineProject,
  getDownloadProgress,
  __resetDownloadProgressForTests,
  type DownloadProjectDeps,
} from "./download"
import type { CellRow, FileSummary } from "@/lib/sync/cells-read-types"
import type { ResolveProjectResult } from "@/lib/sync/cloud-projects"

let store: Store<typeof schema>
let storeId = 0

beforeEach(async () => {
  storeId += 1
  store = await createStorePromise({
    schema,
    storeId: `download-test-${storeId}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
  __resetDownloadProgressForTests()
})

function cellRow(overrides: Partial<CellRow> & Pick<CellRow, "cellId" | "side">): CellRow {
  return {
    value: "hello",
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: "evt1",
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 1,
    sequenceIndex: 0,
    ...overrides,
  }
}

function fakeDeps(overrides: Partial<DownloadProjectDeps> = {}): DownloadProjectDeps {
  const files: FileSummary[] = [
    {
      fileId: "file1",
      projectId: "proj1",
      name: "Genesis",
      fileType: "usfm",
      sourceLanguage: "en",
      targetLanguage: "fr",
      cellCount: 1,
      approvedCount: 0,
      filledCount: 0,
      wordCount: 1,
      lastEditAt: null,
    },
  ]
  const okResult: ResolveProjectResult = {
    ok: true,
    project: {
      id: "proj1",
      name: "Genesis Project",
      gitlabProjectId: null,
      orgId: 42,
      archivedAt: null,
      archivedBy: null,
      role: { level: 5, name: "owner", source: "membership" },
    },
  }
  return {
    resolveCloudProjectResult: async () => okResult,
    fetchSyncToken: async () => ({ token: "sync-tok", expiresIn: 900, role: { level: 700, name: "owner", source: "creator" } }),
    fetchProjectFiles: async () => files,
    streamFileCells: async (_p, _fileId, _jwt, onPage) => {
      await onPage(
        [
          cellRow({ cellId: "c1", side: "source", value: "Hello" }),
          cellRow({ cellId: "c1", side: "target", value: "Bonjour" }),
        ],
        true,
      )
    },
    ...overrides,
  }
}

describe("downloadProjectOffline", () => {
  it("writes project, file, and cell rows and marks the project ready", async () => {
    await downloadProjectOffline(store, "proj1", "jwt", fakeDeps())

    const project = store.query(tables.projects.select().where({ id: "proj1" }).first())
    expect(project?.name).toBe("Genesis Project")
    expect(project?.orgId).toBe("42")

    const files = store.query(tables.files.select().where({ projectId: "proj1" }))
    expect(files.map((f) => f.id)).toEqual(["file1"])

    const cells = store.query(tables.cells.select().where({ projectId: "proj1" }))
    expect(cells).toHaveLength(2)
    expect(cells.find((c) => c.side === "target")?.value).toBe("Bonjour")

    const offlineRow = store.query(tables.offlineProjects.select().where({ projectId: "proj1" }).first())
    expect(offlineRow?.status).toBe("ready")
  })

  it("clears progress after completion", async () => {
    await downloadProjectOffline(store, "proj1", "jwt", fakeDeps())
    expect(getDownloadProgress("proj1")).toBeNull()
  })

  it("reports progress while a download is in flight", async () => {
    let seenDuringStream: ReturnType<typeof getDownloadProgress> = null
    const deps = fakeDeps({
      streamFileCells: async (_p, _fileId, _jwt, onPage) => {
        await onPage([cellRow({ cellId: "c1", side: "source" })], true)
        seenDuringStream = getDownloadProgress("proj1")
      },
    })
    await downloadProjectOffline(store, "proj1", "jwt", deps)
    expect(seenDuringStream).toEqual({ projectId: "proj1", filesTotal: 1, filesDone: 0, cellsDone: 1 })
  })

  it("is a no-op when the project is already downloading or ready", async () => {
    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj1", status: "ready", syncedAt: new Date(), queueDepth: 0 }),
    )
    let called = false
    await downloadProjectOffline(store, "proj1", "jwt", fakeDeps({
      fetchProjectFiles: async () => {
        called = true
        return []
      },
    }))
    expect(called).toBe(false)
  })

  it("rolls back all rows and clears progress on failure", async () => {
    const deps = fakeDeps({
      fetchProjectFiles: async () => {
        throw new Error("network down")
      },
    })
    await expect(downloadProjectOffline(store, "proj1", "jwt", deps)).rejects.toThrow("network down")

    expect(store.query(tables.offlineProjects.select().where({ projectId: "proj1" }))).toHaveLength(0)
    expect(store.query(tables.projects.select().where({ id: "proj1" }))).toHaveLength(0)
    expect(getDownloadProgress("proj1")).toBeNull()
  })

  it("rolls back partial file/cell rows when a later file fails mid-stream", async () => {
    const files: FileSummary[] = [
      {
        fileId: "file1",
        projectId: "proj1",
        name: "Genesis",
        fileType: "usfm",
        sourceLanguage: "en",
        targetLanguage: "fr",
        cellCount: 1,
        approvedCount: 0,
        filledCount: 0,
        wordCount: 1,
        lastEditAt: null,
      },
      {
        fileId: "file2",
        projectId: "proj1",
        name: "Exodus",
        fileType: "usfm",
        sourceLanguage: "en",
        targetLanguage: "fr",
        cellCount: 1,
        approvedCount: 0,
        filledCount: 0,
        wordCount: 1,
        lastEditAt: null,
      },
    ]
    const deps = fakeDeps({
      fetchProjectFiles: async () => files,
      streamFileCells: async (_p, fileId, _jwt, onPage) => {
        if (fileId === "file2") throw new Error("boom")
        await onPage([cellRow({ cellId: "c1", side: "source" })], true)
      },
    })
    await expect(downloadProjectOffline(store, "proj1", "jwt", deps)).rejects.toThrow("boom")
    expect(store.query(tables.cells.select().where({ projectId: "proj1" }))).toHaveLength(0)
    expect(store.query(tables.files.select().where({ projectId: "proj1" }))).toHaveLength(0)
    expect(store.query(tables.offlineProjects.select().where({ projectId: "proj1" }))).toHaveLength(0)
  })

  it("throws (and rolls back) when project resolution fails", async () => {
    const deps = fakeDeps({
      resolveCloudProjectResult: async () => ({ ok: false, reason: "not-found" }) as ResolveProjectResult,
    })
    await expect(downloadProjectOffline(store, "proj1", "jwt", deps)).rejects.toThrow(/not-found/)
    expect(store.query(tables.offlineProjects.select().where({ projectId: "proj1" }))).toHaveLength(0)
  })
})

describe("removeOfflineProject", () => {
  it("returns not-downloaded when there is no offline copy", () => {
    expect(removeOfflineProject(store, "proj1")).toEqual({ ok: false, reason: "not-downloaded" })
  })

  it("deletes project/file/cell rows and reports ok when the queue is empty", async () => {
    await downloadProjectOffline(store, "proj1", "jwt", fakeDeps())
    const result = removeOfflineProject(store, "proj1")
    expect(result).toEqual({ ok: true })
    expect(store.query(tables.cells.select().where({ projectId: "proj1" }))).toHaveLength(0)
    expect(store.query(tables.files.select().where({ projectId: "proj1" }))).toHaveLength(0)
    expect(store.query(tables.projects.select().where({ id: "proj1" }))).toHaveLength(0)
    expect(store.query(tables.offlineProjects.select().where({ projectId: "proj1" }))).toHaveLength(0)
  })

  it("blocks removal when a pending write is queued, and reports the depth", async () => {
    await downloadProjectOffline(store, "proj1", "jwt", fakeDeps())
    store.commit(
      events.eventQueued({
        id: "q1",
        projectId: "proj1",
        fileId: "file1",
        cellId: "c1",
        kind: "target.cell.commit",
        payload: {},
        parentId: "evt1",
        author: "alice",
        schemaVersion: 1,
        clientTs: new Date(),
        createdAt: new Date(),
      }),
    )
    expect(removeOfflineProject(store, "proj1")).toEqual({ ok: false, reason: "queue-not-empty", queueDepth: 1 })
    // Nothing was deleted.
    expect(store.query(tables.offlineProjects.select().where({ projectId: "proj1" }))).toHaveLength(1)
  })

  it("blocks removal when a write is stuck failed (not just pending/flushing)", async () => {
    await downloadProjectOffline(store, "proj1", "jwt", fakeDeps())
    store.commit(
      events.eventQueued({
        id: "q1",
        projectId: "proj1",
        fileId: "file1",
        cellId: "c1",
        kind: "target.cell.commit",
        payload: {},
        parentId: "evt1",
        author: "alice",
        schemaVersion: 1,
        clientTs: new Date(),
        createdAt: new Date(),
      }),
    )
    store.commit(events.eventQueueStatusSet({ id: "q1", status: "failed" }))
    expect(removeOfflineProject(store, "proj1")).toEqual({ ok: false, reason: "queue-not-empty", queueDepth: 1 })
  })
})
