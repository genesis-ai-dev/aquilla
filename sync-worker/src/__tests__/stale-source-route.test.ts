// Integration tests for the AD-9 stale-source read route.
//
// Covers the pointer-comparison query in three project shapes (linked
// target / self-contained / source-only-isn't-applicable) plus the
// edge cases: missing token, no upstream, no target rows, all in-sync.

import { describe, it, expect } from "vitest"
import { handleStaleSourceRequest } from "../events/stale-source-route"
import {
  makeInMemoryD1,
  type CellRow,
  type ProjectRow,
} from "./helpers/d1-fake"
import { makeTestToken } from "./helpers/auth"

const SECRET = "stale-source-secret"

function envWith(db: ReturnType<typeof makeInMemoryD1>) {
  return { AQUILLA_DB: db, SYNC_SECRET_KEY: SECRET }
}

function makeCell(over: Partial<CellRow> & Pick<CellRow, "cell_id" | "event_id" | "side">): CellRow {
  return {
    project_id: "p-target",
    file_id: "f1",
    value: "x",
    value_html: null,
    type: null,
    canonical_ref: null,
    anchor_cell_id: null,
    last_editor: "alice",
    last_edit_at: 1700000000000,
    validated: 0,
    word_count: 1,
    content_hash: null,
    source_event_id: null,
    ...over,
  }
}

function makeProject(over: Partial<ProjectRow> & Pick<ProjectRow, "id">): ProjectRow {
  return {
    source_project_id: null,
    ...over,
  }
}

describe("GET /api/v1/projects/:projectId/files/:fileId/stale-source", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const db = makeInMemoryD1()
    const req = new Request(
      "https://w/api/v1/projects/p1/files/f1/stale-source",
    )
    const res = (await handleStaleSourceRequest(req, envWith(db)))!
    expect(res.status).toBe(401)
  })

  it("returns null for non-matching paths (so the dispatcher can chain)", async () => {
    const db = makeInMemoryD1()
    const req = new Request("https://w/api/v1/something-else")
    const res = await handleStaleSourceRequest(req, envWith(db))
    expect(res).toBeNull()
  })

  it("returns the stale cell ids for a linked-target project", async () => {
    // Setup: target project p-target links to upstream p-src.
    // Source rows live in p-src; target rows live in p-target.
    // c1 is stale (source advanced); c2 is in-sync.
    const db = makeInMemoryD1({
      projects: [
        makeProject({ id: "p-target", source_project_id: "p-src" }),
        makeProject({ id: "p-src" }),
      ],
      cells: [
        // Upstream source rows.
        makeCell({
          project_id: "p-src",
          cell_id: "c1",
          side: "source",
          event_id: "e-src-c1-v2", // advanced
        }),
        makeCell({
          project_id: "p-src",
          cell_id: "c2",
          side: "source",
          event_id: "e-src-c2-v1",
        }),
        // Local target rows. source_event_id pins what the translator saw.
        makeCell({
          project_id: "p-target",
          cell_id: "c1",
          side: "target",
          event_id: "e-tgt-c1",
          source_event_id: "e-src-c1-v1", // stale — upstream is now v2
        }),
        makeCell({
          project_id: "p-target",
          cell_id: "c2",
          side: "target",
          event_id: "e-tgt-c2",
          source_event_id: "e-src-c2-v1", // matches
        }),
      ],
    })
    const token = await makeTestToken(SECRET, {
      projectId: "p-target",
      fileId: "f1",
    })
    const req = new Request(
      "https://w/api/v1/projects/p-target/files/f1/stale-source",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleStaleSourceRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projectId: string
      fileId: string
      staleCellIds: string[]
      upstreamProjectId: string | null
    }
    expect(body.projectId).toBe("p-target")
    expect(body.fileId).toBe("f1")
    expect(body.upstreamProjectId).toBe("p-src")
    expect(body.staleCellIds).toEqual(["c1"])
  })

  it("falls back to the project's own source side for a self-contained project (COALESCE)", async () => {
    // No source_project_id on p-target — JOIN should read its own source rows.
    const db = makeInMemoryD1({
      projects: [makeProject({ id: "p-target", source_project_id: null })],
      cells: [
        makeCell({
          project_id: "p-target",
          cell_id: "c1",
          side: "source",
          event_id: "e-src-v2",
        }),
        makeCell({
          project_id: "p-target",
          cell_id: "c1",
          side: "target",
          event_id: "e-tgt",
          source_event_id: "e-src-v1", // pinned at older value
        }),
      ],
    })
    const token = await makeTestToken(SECRET, {
      projectId: "p-target",
      fileId: "f1",
    })
    const req = new Request(
      "https://w/api/v1/projects/p-target/files/f1/stale-source",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleStaleSourceRequest(req, envWith(db)))!
    const body = (await res.json()) as {
      staleCellIds: string[]
      upstreamProjectId: string | null
    }
    expect(body.upstreamProjectId).toBeNull()
    expect(body.staleCellIds).toEqual(["c1"])
  })

  it("returns [] when every target cell is in-sync with its source", async () => {
    const db = makeInMemoryD1({
      projects: [makeProject({ id: "p-target", source_project_id: "p-src" })],
      cells: [
        makeCell({
          project_id: "p-src",
          cell_id: "c1",
          side: "source",
          event_id: "e1",
        }),
        makeCell({
          project_id: "p-target",
          cell_id: "c1",
          side: "target",
          event_id: "e-tgt",
          source_event_id: "e1",
        }),
      ],
    })
    const token = await makeTestToken(SECRET, {
      projectId: "p-target",
      fileId: "f1",
    })
    const req = new Request(
      "https://w/api/v1/projects/p-target/files/f1/stale-source",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleStaleSourceRequest(req, envWith(db)))!
    const body = (await res.json()) as { staleCellIds: string[] }
    expect(body.staleCellIds).toEqual([])
  })

  it("skips target cells with null source_event_id (target-owned cells)", async () => {
    // Target-owned cells don't pin a source; they should never appear in
    // the stale list even if a same-id source exists.
    const db = makeInMemoryD1({
      projects: [makeProject({ id: "p-target", source_project_id: "p-src" })],
      cells: [
        makeCell({
          project_id: "p-src",
          cell_id: "c1",
          side: "source",
          event_id: "e-src",
        }),
        makeCell({
          project_id: "p-target",
          cell_id: "c1",
          side: "target",
          event_id: "e-tgt",
          source_event_id: null, // target-owned
        }),
      ],
    })
    const token = await makeTestToken(SECRET, {
      projectId: "p-target",
      fileId: "f1",
    })
    const req = new Request(
      "https://w/api/v1/projects/p-target/files/f1/stale-source",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleStaleSourceRequest(req, envWith(db)))!
    const body = (await res.json()) as { staleCellIds: string[] }
    expect(body.staleCellIds).toEqual([])
  })

  it("rejects a token scoped to a different project", async () => {
    const db = makeInMemoryD1({
      projects: [makeProject({ id: "p-target" })],
    })
    const token = await makeTestToken(SECRET, {
      projectId: "other-project",
      fileId: "f1",
    })
    const req = new Request(
      "https://w/api/v1/projects/p-target/files/f1/stale-source",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleStaleSourceRequest(req, envWith(db)))!
    expect(res.status).toBe(403)
  })
})
