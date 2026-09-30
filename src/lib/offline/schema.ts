import { Events, Schema, State, makeSchema } from "@livestore/livestore"

// Composite key for a cell row: cells are addressed by (project, file, cell, side)
// upstream, but LiveStore SQLite tables need a single-column primary key.
export const cellRowId = (projectId: string, fileId: string, cellId: string, side: "source" | "target") =>
  `${projectId}:${fileId}:${cellId}:${side}`

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
    value: State.SQLite.text({ nullable: true }),
    valueHtml: State.SQLite.text({ nullable: true }),
    eventId: State.SQLite.text({ nullable: true }),
    sourceEventId: State.SQLite.text({ nullable: true }),
    validated: State.SQLite.boolean({ default: false }),
    aiDrafted: State.SQLite.boolean({ default: false }),
    sequenceIndex: State.SQLite.integer(),
    canonicalRef: State.SQLite.text({ nullable: true }),
  },
  indexes: [{ name: "idx_cells_project_file", columns: ["projectId", "fileId"] }],
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

export const tables = { projects, files, cells, eventQueue, offlineProjects }

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
  cellRemoved: Events.clientOnly({
    name: "v1.CellRemoved",
    schema: Schema.Struct({
      projectId: Schema.String,
      fileId: Schema.String,
      cellId: Schema.String,
      side: Schema.Literal("source", "target"),
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

  "v1.CellSynced": (args) => {
    const id = cellRowId(args.projectId, args.fileId, args.cellId, args.side)
    return tables.cells.insert({ id, ...args }).onConflict("id", "update", args)
  },
  "v1.CellRemoved": ({ projectId, fileId, cellId, side }) =>
    tables.cells.delete().where({ id: cellRowId(projectId, fileId, cellId, side) }),

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
})

const state = State.SQLite.makeState({ tables, materializers })

export const schema = makeSchema({ events, state })
