import { Events, Schema, State, makeSchema } from "@livestore/livestore"

/**
 * AQU-1614: prefix for a lane key derived from a lane's legacy tag rather than
 * its `lanes.id`. The cells read API sends `laneId` only once AQU-1616's
 * backfill has populated `cells.lane_id` (it is nullable until then — see
 * sync-worker/src/events/cells-read-route.ts), so a row that arrives without
 * one is keyed by its tag instead of being dropped. Prefixed so a tag can
 * never collide with a real lane id.
 */
export const LANE_TAG_KEY_PREFIX = "tag:"

/**
 * AQU-1614: the lane a local cell row belongs to. The lane's `lanes.id` when
 * the server sent one, else its legacy tag (`targetLang`) under
 * {@link LANE_TAG_KEY_PREFIX}. A tag-keyed row is replaced by its id-keyed one
 * on the next catch-up of that file (replaceCells removes every lane/side the
 * server no longer reports for a cell), so the two never linger side by side
 * once the backfill lands.
 */
export function localLaneKey(laneId: string | null | undefined, targetLang: string | null | undefined): string {
  return laneId != null && laneId !== "" ? laneId : `${LANE_TAG_KEY_PREFIX}${targetLang ?? ""}`
}

/**
 * AQU-1614: the lane key of the former default lane (legacy tag `''`), which is
 * also the key every row written by the pre-lane schema carries — the `v1.Cell*`
 * materializers below map old eventlog entries onto it.
 */
export const DEFAULT_LANE_KEY = `${LANE_TAG_KEY_PREFIX}`

// Composite key for a cell row: cells are addressed by (project, file, cell,
// side, lane) upstream, but LiveStore SQLite tables need a single-column
// primary key. AQU-1614 added the lane segment — before it, a second lane's
// row overwrote the default lane's translation, so only the default lane was
// ever stored.
export const cellRowId = (
  projectId: string,
  fileId: string,
  cellId: string,
  side: "source" | "target",
  laneKey: string,
) => `${projectId}:${fileId}:${cellId}:${side}:${laneKey}`

const projects = State.SQLite.table({
  name: "projects",
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    name: State.SQLite.text(),
    orgId: State.SQLite.text(),
    settings: State.SQLite.json({ nullable: true }),
    syncedAt: State.SQLite.datetime({ nullable: true }),
  },
})

const files = State.SQLite.table({
  name: "files",
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    projectId: State.SQLite.text(),
    name: State.SQLite.text(),
    type: State.SQLite.text(),
    sequenceIndex: State.SQLite.integer(),
  },
  indexes: [{ name: "idx_files_project", columns: ["projectId"] }],
})

const cells = State.SQLite.table({
  name: "cells",
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    projectId: State.SQLite.text(),
    fileId: State.SQLite.text(),
    cellId: State.SQLite.text(),
    side: State.SQLite.text({ schema: Schema.Literal("source", "target") }),
    // AQU-1614: lane identity. `laneKey` is what the primary key carries (see
    // localLaneKey); `targetLang` is the legacy tag every lane-aware client
    // read still filters on (useCells.ts's `laneOf`), and `laneId` is the
    // server's `lanes.id` when it sent one.
    laneKey: State.SQLite.text({ default: DEFAULT_LANE_KEY }),
    targetLang: State.SQLite.text({ default: "" }),
    laneId: State.SQLite.text({ nullable: true }),
    value: State.SQLite.text({ nullable: true }),
    valueHtml: State.SQLite.text({ nullable: true }),
    eventId: State.SQLite.text({ nullable: true }),
    sourceEventId: State.SQLite.text({ nullable: true }),
    validated: State.SQLite.boolean({ default: false }),
    aiDrafted: State.SQLite.boolean({ default: false }),
    sequenceIndex: State.SQLite.integer(),
    canonicalRef: State.SQLite.text({ nullable: true }),
  },
  indexes: [
    { name: "idx_cells_project_file", columns: ["projectId", "fileId"] },
    // AQU-1614: catch-up and the lane-scoped reads both narrow a file to one lane.
    { name: "idx_cells_file_lane", columns: ["projectId", "fileId", "laneKey"] },
  ],
})

const eventQueue = State.SQLite.table({
  name: "event_queue",
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    projectId: State.SQLite.text(),
    fileId: State.SQLite.text({ nullable: true }),
    cellId: State.SQLite.text({ nullable: true }),
    kind: State.SQLite.text(),
    // The event's typed payload only (OutboxRawEvent["payload"]) — NOT the
    // full envelope. `author`/`schemaVersion` are separate columns below so
    // the sync adapter can reassemble a wire-valid OutboxRawEvent for
    // POST /events without guessing at this column's shape.
    payload: State.SQLite.json(),
    parentId: State.SQLite.text({ nullable: true }),
    // Username the event is attributed to — required on the wire envelope
    // (OutboxRawEvent.author) and checked against the JWT claim server-side.
    author: State.SQLite.text(),
    // OUTBOX_SCHEMA_VERSION at enqueue time (src/lib/sync/outbox-types.ts).
    schemaVersion: State.SQLite.integer(),
    clientTs: State.SQLite.datetime(),
    createdAt: State.SQLite.datetime(),
    status: State.SQLite.text({
      schema: Schema.Literal("pending", "flushing", "failed"),
      default: "pending",
    }),
  },
  indexes: [
    { name: "idx_event_queue_project", columns: ["projectId"] },
    { name: "idx_event_queue_status", columns: ["status"] },
  ],
})

const offlineProjects = State.SQLite.table({
  name: "offline_projects",
  columns: {
    projectId: State.SQLite.text({ primaryKey: true }),
    status: State.SQLite.text({ schema: Schema.Literal("downloading", "ready", "removing") }),
    syncedAt: State.SQLite.datetime({ nullable: true }),
    queueDepth: State.SQLite.integer({ default: 0 }),
  },
})

// Per-file `?since=` delta cursor for catch-up (catch-up.ts): the server
// watermark (`maxServerSeq`) this device's copy of the file is known to be
// complete up to, plus the project incarnation it was minted against
// (AQU-943). Both null = no trusted cursor; the next catch-up full-streams.
const syncCursors = State.SQLite.table({
  name: "sync_cursors",
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    projectId: State.SQLite.text(),
    fileId: State.SQLite.text(),
    serverSeq: State.SQLite.integer({ nullable: true }),
    projectEpoch: State.SQLite.integer({ nullable: true }),
  },
  indexes: [{ name: "idx_sync_cursors_project", columns: ["projectId"] }],
})

export const syncCursorId = (projectId: string, fileId: string) => `${projectId}:${fileId}`

export const tables = { projects, files, cells, eventQueue, offlineProjects, syncCursors }

// All events are client-only: the server projection is authoritative and reaches
// LiveStore only through the custom sync adapter (Phase 3), never through LiveStore's
// own sync backend. These events exist purely to drive local SQLite materialization.
const events = {
  projectSynced: Events.clientOnly({
    name: "v1.ProjectSynced",
    schema: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      orgId: Schema.String,
      settings: Schema.Unknown,
      syncedAt: Schema.NullOr(Schema.Date),
    }),
  }),
  projectRemoved: Events.clientOnly({
    name: "v1.ProjectRemoved",
    schema: Schema.Struct({ id: Schema.String }),
  }),
  fileSynced: Events.clientOnly({
    name: "v1.FileSynced",
    schema: Schema.Struct({
      id: Schema.String,
      projectId: Schema.String,
      name: Schema.String,
      type: Schema.String,
      sequenceIndex: Schema.Number,
    }),
  }),
  fileRemoved: Events.clientOnly({
    name: "v1.FileRemoved",
    schema: Schema.Struct({ id: Schema.String }),
  }),
  cellSynced: Events.clientOnly({
    name: "v2.CellSynced",
    schema: Schema.Struct({
      projectId: Schema.String,
      fileId: Schema.String,
      cellId: Schema.String,
      side: Schema.Literal("source", "target"),
      // AQU-1614: the lane this row belongs to, straight off the wire — the
      // legacy tag (always '' on a source row) plus `lanes.id` when the server
      // has one. The materializer derives the row key from the pair.
      targetLang: Schema.String,
      laneId: Schema.NullOr(Schema.String),
      value: Schema.NullOr(Schema.String),
      valueHtml: Schema.NullOr(Schema.String),
      eventId: Schema.NullOr(Schema.String),
      sourceEventId: Schema.NullOr(Schema.String),
      validated: Schema.Boolean,
      aiDrafted: Schema.Boolean,
      sequenceIndex: Schema.Number,
      canonicalRef: Schema.NullOr(Schema.String),
    }),
  }),
  cellRemoved: Events.clientOnly({
    name: "v2.CellRemoved",
    schema: Schema.Struct({
      projectId: Schema.String,
      fileId: Schema.String,
      cellId: Schema.String,
      side: Schema.Literal("source", "target"),
      // AQU-1614: which lane's row to drop (localLaneKey).
      laneKey: Schema.String,
    }),
  }),
  // Batched forms of cellSynced/cellRemoved for bulk writes (download and
  // catch-up). One event per page of rows instead of one per row: a download
  // was ~16k events, and the leader worker takes long enough to persist a
  // backlog that size that a reload in the meantime can strand it holding the
  // OPFS files (see leader-watchdog.ts, livestorejs/livestore#244).
  cellsSynced: Events.clientOnly({
    name: "v2.CellsSynced",
    schema: Schema.Struct({
      projectId: Schema.String,
      fileId: Schema.String,
      rows: Schema.Array(
        Schema.Struct({
          cellId: Schema.String,
          side: Schema.Literal("source", "target"),
          targetLang: Schema.String,
          laneId: Schema.NullOr(Schema.String),
          value: Schema.NullOr(Schema.String),
          valueHtml: Schema.NullOr(Schema.String),
          eventId: Schema.NullOr(Schema.String),
          sourceEventId: Schema.NullOr(Schema.String),
          validated: Schema.Boolean,
          aiDrafted: Schema.Boolean,
          sequenceIndex: Schema.Number,
          canonicalRef: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  }),
  cellsRemoved: Events.clientOnly({
    name: "v2.CellsRemoved",
    schema: Schema.Struct({
      projectId: Schema.String,
      fileId: Schema.String,
      cells: Schema.Array(
        Schema.Struct({
          cellId: Schema.String,
          side: Schema.Literal("source", "target"),
          laneKey: Schema.String,
        }),
      ),
    }),
  }),

  // AQU-1614 — legacy cell events. Nothing emits these any more; they stay
  // declared so a device's existing eventlog still decodes, and their
  // materializers below land those rows on the former default lane
  // (DEFAULT_LANE_KEY). That replay IS the local-store migration: LiveStore
  // rematerializes the state tables from the eventlog when the state schema
  // changes, so it is idempotent and safe to interrupt, and the `v1.Event*`
  // queue events are untouched — a device upgrading with unsynced writes keeps
  // them. Do not re-point these at a lane-aware shape: that would rewrite
  // history.
  cellSyncedLegacy: Events.clientOnly({
    name: "v1.CellSynced",
    schema: Schema.Struct({
      projectId: Schema.String,
      fileId: Schema.String,
      cellId: Schema.String,
      side: Schema.Literal("source", "target"),
      value: Schema.NullOr(Schema.String),
      valueHtml: Schema.NullOr(Schema.String),
      eventId: Schema.NullOr(Schema.String),
      sourceEventId: Schema.NullOr(Schema.String),
      validated: Schema.Boolean,
      aiDrafted: Schema.Boolean,
      sequenceIndex: Schema.Number,
      canonicalRef: Schema.NullOr(Schema.String),
    }),
  }),
  cellRemovedLegacy: Events.clientOnly({
    name: "v1.CellRemoved",
    schema: Schema.Struct({
      projectId: Schema.String,
      fileId: Schema.String,
      cellId: Schema.String,
      side: Schema.Literal("source", "target"),
    }),
  }),
  cellsSyncedLegacy: Events.clientOnly({
    name: "v1.CellsSynced",
    schema: Schema.Struct({
      projectId: Schema.String,
      fileId: Schema.String,
      rows: Schema.Array(
        Schema.Struct({
          cellId: Schema.String,
          side: Schema.Literal("source", "target"),
          value: Schema.NullOr(Schema.String),
          valueHtml: Schema.NullOr(Schema.String),
          eventId: Schema.NullOr(Schema.String),
          sourceEventId: Schema.NullOr(Schema.String),
          validated: Schema.Boolean,
          aiDrafted: Schema.Boolean,
          sequenceIndex: Schema.Number,
          canonicalRef: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  }),
  cellsRemovedLegacy: Events.clientOnly({
    name: "v1.CellsRemoved",
    schema: Schema.Struct({
      projectId: Schema.String,
      fileId: Schema.String,
      cells: Schema.Array(Schema.Struct({ cellId: Schema.String, side: Schema.Literal("source", "target") })),
    }),
  }),
  eventQueued: Events.clientOnly({
    name: "v1.EventQueued",
    schema: Schema.Struct({
      id: Schema.String,
      projectId: Schema.String,
      fileId: Schema.NullOr(Schema.String),
      cellId: Schema.NullOr(Schema.String),
      kind: Schema.String,
      payload: Schema.Unknown,
      parentId: Schema.NullOr(Schema.String),
      author: Schema.String,
      schemaVersion: Schema.Number,
      clientTs: Schema.Date,
      createdAt: Schema.Date,
    }),
  }),
  eventQueueStatusSet: Events.clientOnly({
    name: "v1.EventQueueStatusSet",
    schema: Schema.Struct({
      id: Schema.String,
      status: Schema.Literal("pending", "flushing", "failed"),
    }),
  }),
  eventDequeued: Events.clientOnly({
    name: "v1.EventDequeued",
    schema: Schema.Struct({ id: Schema.String }),
  }),
  offlineProjectStatusSet: Events.clientOnly({
    name: "v1.OfflineProjectStatusSet",
    schema: Schema.Struct({
      projectId: Schema.String,
      status: Schema.Literal("downloading", "ready", "removing"),
      syncedAt: Schema.NullOr(Schema.Date),
      queueDepth: Schema.Number,
    }),
  }),
  offlineProjectRemoved: Events.clientOnly({
    name: "v1.OfflineProjectRemoved",
    schema: Schema.Struct({ projectId: Schema.String }),
  }),
  syncCursorSet: Events.clientOnly({
    name: "v1.SyncCursorSet",
    schema: Schema.Struct({
      projectId: Schema.String,
      fileId: Schema.String,
      serverSeq: Schema.NullOr(Schema.Number),
      projectEpoch: Schema.NullOr(Schema.Number),
    }),
  }),
  syncCursorsRemoved: Events.clientOnly({
    name: "v1.SyncCursorsRemoved",
    schema: Schema.Struct({ projectId: Schema.String }),
  }),
}

export { events }

const materializers = State.SQLite.materializers(events, {
  "v1.ProjectSynced": ({ id, name, orgId, settings, syncedAt }) =>
    tables.projects.insert({ id, name, orgId, settings, syncedAt }).onConflict("id", "update", {
      name,
      orgId,
      settings,
      syncedAt,
    }),
  "v1.ProjectRemoved": ({ id }) => tables.projects.delete().where({ id }),

  "v1.FileSynced": ({ id, projectId, name, type, sequenceIndex }) =>
    tables.files.insert({ id, projectId, name, type, sequenceIndex }).onConflict("id", "update", {
      projectId,
      name,
      type,
      sequenceIndex,
    }),
  "v1.FileRemoved": ({ id }) => tables.files.delete().where({ id }),

  "v2.CellSynced": (args) => {
    const laneKey = localLaneKey(args.laneId, args.targetLang)
    const row = { ...args, laneKey }
    const id = cellRowId(args.projectId, args.fileId, args.cellId, args.side, laneKey)
    return tables.cells.insert({ id, ...row }).onConflict("id", "update", row)
  },
  "v2.CellRemoved": ({ projectId, fileId, cellId, side, laneKey }) =>
    tables.cells.delete().where({ id: cellRowId(projectId, fileId, cellId, side, laneKey) }),
  "v2.CellsSynced": ({ projectId, fileId, rows }) =>
    rows.map((row) => {
      const laneKey = localLaneKey(row.laneId, row.targetLang)
      const args = { projectId, fileId, ...row, laneKey }
      const id = cellRowId(projectId, fileId, row.cellId, row.side, laneKey)
      return tables.cells.insert({ id, ...args }).onConflict("id", "update", args)
    }),
  "v2.CellsRemoved": ({ projectId, fileId, cells }) =>
    cells.map(({ cellId, side, laneKey }) =>
      tables.cells.delete().where({ id: cellRowId(projectId, fileId, cellId, side, laneKey) }),
    ),

  // AQU-1614: pre-lane eventlog entries replay onto the former default lane.
  "v1.CellSynced": (args) => {
    const row = { ...args, laneKey: DEFAULT_LANE_KEY, targetLang: "", laneId: null }
    const id = cellRowId(args.projectId, args.fileId, args.cellId, args.side, DEFAULT_LANE_KEY)
    return tables.cells.insert({ id, ...row }).onConflict("id", "update", row)
  },
  "v1.CellRemoved": ({ projectId, fileId, cellId, side }) =>
    tables.cells.delete().where({ id: cellRowId(projectId, fileId, cellId, side, DEFAULT_LANE_KEY) }),
  "v1.CellsSynced": ({ projectId, fileId, rows }) =>
    rows.map((row) => {
      const args = { projectId, fileId, ...row, laneKey: DEFAULT_LANE_KEY, targetLang: "", laneId: null }
      const id = cellRowId(projectId, fileId, row.cellId, row.side, DEFAULT_LANE_KEY)
      return tables.cells.insert({ id, ...args }).onConflict("id", "update", args)
    }),
  "v1.CellsRemoved": ({ projectId, fileId, cells }) =>
    cells.map(({ cellId, side }) =>
      tables.cells.delete().where({ id: cellRowId(projectId, fileId, cellId, side, DEFAULT_LANE_KEY) }),
    ),

  "v1.EventQueued": ({ id, projectId, fileId, cellId, kind, payload, parentId, author, schemaVersion, clientTs, createdAt }) =>
    tables.eventQueue.insert({
      id,
      projectId,
      fileId,
      cellId,
      kind,
      payload,
      parentId,
      author,
      schemaVersion,
      clientTs,
      createdAt,
      status: "pending",
    }),
  "v1.EventQueueStatusSet": ({ id, status }) => tables.eventQueue.update({ status }).where({ id }),
  "v1.EventDequeued": ({ id }) => tables.eventQueue.delete().where({ id }),

  "v1.OfflineProjectStatusSet": ({ projectId, status, syncedAt, queueDepth }) =>
    tables.offlineProjects.insert({ projectId, status, syncedAt, queueDepth }).onConflict("projectId", "update", {
      status,
      syncedAt,
      queueDepth,
    }),
  "v1.OfflineProjectRemoved": ({ projectId }) => tables.offlineProjects.delete().where({ projectId }),

  "v1.SyncCursorSet": ({ projectId, fileId, serverSeq, projectEpoch }) =>
    tables.syncCursors
      .insert({ id: syncCursorId(projectId, fileId), projectId, fileId, serverSeq, projectEpoch })
      .onConflict("id", "update", { serverSeq, projectEpoch }),
  "v1.SyncCursorsRemoved": ({ projectId }) => tables.syncCursors.delete().where({ projectId }),
})

const state = State.SQLite.makeState({ tables, materializers })

export const schema = makeSchema({ events, state })
