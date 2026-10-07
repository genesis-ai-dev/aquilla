// The session recorded into each generation's eventlog fixture
// (eventlog-compat.test.ts): a download, some edits queued offline, some sent
// and some stuck, using every event the schema declares. Only read when a new
// generation's fixture is written — the frozen fixtures are what later builds
// are tested against, so edit this freely for the next generation.
import { events } from "../schema"

const at = new Date("2026-10-05T12:00:00Z")

const queued = (id: string, cellId: string, text: string) =>
  events.eventQueued({
    id,
    projectId: "proj1",
    fileId: "file1",
    cellId,
    kind: "target.cell.commit",
    payload: { html: `<p>${text}</p>`, text },
    parentId: `srv-${cellId}`,
    author: "translator@example.test",
    schemaVersion: 1,
    clientTs: at,
    createdAt: at,
  })

const sourceRow = (cellId: string, sequenceIndex: number) => ({
  cellId,
  side: "source" as const,
  value: `Source ${cellId}`,
  valueHtml: `<p>Source ${cellId}</p>`,
  eventId: `src-${cellId}`,
  sourceEventId: null,
  validated: false,
  aiDrafted: false,
  sequenceIndex,
  canonicalRef: cellId,
})

export function buildSampleSession() {
  return [
    events.offlineProjectStatusSet({ projectId: "proj1", status: "downloading", syncedAt: null, queueDepth: 0 }),
    events.projectSynced({ id: "proj1", name: "Genesis", orgId: "org1", settings: { targetLanguage: "es" }, syncedAt: at }),
    events.fileSynced({ id: "file1", projectId: "proj1", name: "GEN", type: "usfm", sequenceIndex: 0 }),
    events.fileSynced({ id: "file2", projectId: "proj1", name: "EXO", type: "usfm", sequenceIndex: 1 }),
    // Rows an earlier build landed before lanes existed (AQU-1614).
    events.cellsSyncedLegacy({ projectId: "proj1", fileId: "file1", rows: [sourceRow("GEN 1:1", 0), sourceRow("GEN 1:2", 1)] }),
    events.cellSyncedLegacy({ ...sourceRow("GEN 1:3", 2), projectId: "proj1", fileId: "file1" }),
    events.cellRemovedLegacy({ projectId: "proj1", fileId: "file1", cellId: "GEN 1:3", side: "source" }),
    events.cellsRemovedLegacy({ projectId: "proj1", fileId: "file1", cells: [{ cellId: "GEN 1:2", side: "source" }] }),
    events.cellsSynced({
      projectId: "proj1",
      fileId: "file1",
      rows: [
        { ...sourceRow("GEN 1:1", 0), targetLang: "", laneId: null },
        { ...sourceRow("GEN 1:2", 1), targetLang: "", laneId: null },
        { ...sourceRow("GEN 1:1", 0), side: "target", value: "En el principio", targetLang: "es", laneId: "lane-es" },
      ],
    }),
    events.cellSynced({ ...sourceRow("EXO 1:1", 0), projectId: "proj1", fileId: "file2", targetLang: "", laneId: null }),
    events.cellSynced({ ...sourceRow("EXO 1:2", 1), projectId: "proj1", fileId: "file2", targetLang: "", laneId: null }),
    events.cellRemoved({ projectId: "proj1", fileId: "file2", cellId: "EXO 1:2", side: "source", laneKey: "tag:" }),
    events.cellsRemoved({ projectId: "proj1", fileId: "file1", cells: [{ cellId: "GEN 1:2", side: "source", laneKey: "tag:" }] }),
    events.syncCursorSet({ projectId: "proj1", fileId: "file1", serverSeq: 42, projectEpoch: 1 }),
    events.syncCursorSet({ projectId: "proj1", fileId: "file2", serverSeq: 17, projectEpoch: 1 }),
    events.offlineProjectStatusSet({ projectId: "proj1", status: "ready", syncedAt: at, queueDepth: 0 }),

    // Offline editing: q1 reached the server, q2 is mid-flush, q3 was refused
    // (403), q4 is still waiting. q2–q4 must survive every later build.
    queued("q1", "GEN 1:1", "En el principio creó Dios"),
    queued("q2", "GEN 1:2", "Y la tierra estaba desordenada"),
    queued("q3", "EXO 1:1", "Estos son los nombres"),
    queued("q4", "GEN 1:1", "En el principio creó Dios los cielos"),
    events.eventQueueStatusSet({ id: "q1", status: "flushing" }),
    events.eventDequeued({ id: "q1" }),
    events.eventQueueStatusSet({ id: "q2", status: "flushing" }),
    events.eventQueueStatusSet({ id: "q3", status: "failed" }),

    // A second project downloaded and then removed again.
    events.offlineProjectStatusSet({ projectId: "proj2", status: "ready", syncedAt: at, queueDepth: 0 }),
    events.projectSynced({ id: "proj2", name: "Mark", orgId: "org1", settings: null, syncedAt: at }),
    events.fileSynced({ id: "file3", projectId: "proj2", name: "MRK", type: "usfm", sequenceIndex: 0 }),
    events.syncCursorSet({ projectId: "proj2", fileId: "file3", serverSeq: 3, projectEpoch: 2 }),
    events.syncCursorsRemoved({ projectId: "proj2" }),
    events.fileRemoved({ id: "file3" }),
    events.projectRemoved({ id: "proj2" }),
    events.offlineProjectRemoved({ projectId: "proj2" }),
  ]
}
