// @vitest-environment node
//
// AQU-1629 migration 0147: the backfill is the retroactive half of the fix —
// the reported bug is older behaviour, so assignments that already exist have
// to start growing too. Their scope is still in the immutable
// `assignment.create` payload, and this pins that we read it correctly: a
// 'books' / 'chapters' entry becomes a scope row, an explicit line selection
// ('cells', AQU-1628) does not, and the view resolves the result against live
// cells.
import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const migration = readFileSync(
  new URL("../db/postgres/migrations/0147_assignment_scopes.sql", import.meta.url),
  "utf8",
)

let db: PGlite

// The pre-0147 shape of just the tables 0147 reads and writes.
beforeEach(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE events (
      id text PRIMARY KEY, project_id text NOT NULL, kind text NOT NULL, payload text NOT NULL
    );
    CREATE TABLE assignments (
      assignment_id text PRIMARY KEY, project_id text NOT NULL, scope_kind text NOT NULL
    );
    CREATE TABLE assignment_cells (
      assignment_id text NOT NULL, file_id text NOT NULL, cell_id text NOT NULL,
      PRIMARY KEY (assignment_id, file_id, cell_id)
    );
    CREATE TABLE cells (
      project_id text NOT NULL, file_id text NOT NULL, cell_id text NOT NULL,
      side text NOT NULL, canonical_ref text, start_ms bigint, type text,
      PRIMARY KEY (project_id, file_id, cell_id, side)
    );
    -- 0145 (AQU-1493): where a line with no reference counts, as the full
    -- progress recompute stored it. The view resolves a chapter scope by it.
    CREATE TABLE cell_plan_keys (
      project_id text NOT NULL, file_id text NOT NULL, cell_id text NOT NULL,
      section_key text NOT NULL, place_ref text NOT NULL DEFAULT '', depth integer NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, file_id, cell_id)
    );

    INSERT INTO assignments VALUES
      ('as-book', 'p1', 'books'),
      ('as-chap', 'p1', 'chapters'),
      ('as-pick', 'p1', 'cells'),
      ('as-gone', 'p1', 'books');

    -- What each scope resolved to when it was created: GEN 2:1 did not exist
    -- yet, so nobody's snapshot has it.
    INSERT INTO assignment_cells VALUES
      ('as-book', 'f1', 'c1'), ('as-book', 'f1', 'c2'),
      ('as-chap', 'f1', 'c1'), ('as-chap', 'f1', 'c2'),
      ('as-pick', 'f1', 'c1');

    INSERT INTO cells (project_id, file_id, cell_id, side, canonical_ref) VALUES
      ('p1', 'f1', 'c1', 'source', 'GEN 1:1'),
      ('p1', 'f1', 'c2', 'source', 'GEN 1:2'),
      -- the line added after every assignment above was handed out
      ('p1', 'f1', 'c3', 'source', 'GEN 2:1'),
      -- a target row, and a cell in another file: neither is membership
      ('p1', 'f1', 'c1', 'target', NULL),
      ('p1', 'f2', 'x1', 'source', 'EXO 1:1');

    INSERT INTO events VALUES
      ('e1', 'p1', 'assignment.create',
       '{"assignmentId":"as-book","scopeKind":"books","scope":[{"fileId":"f1"}]}'),
      ('e2', 'p1', 'assignment.create',
       '{"assignmentId":"as-chap","scopeKind":"chapters","scope":[{"fileId":"f1","chapter":"GEN 1"}]}'),
      ('e3', 'p1', 'assignment.create',
       '{"assignmentId":"as-pick","scopeKind":"cells","scope":[{"fileId":"f1","cellIds":["c1"]}]}'),
      -- an assignment.create whose assignments row is gone (hard-deleted
      -- project): nothing to attach a scope to
      ('e4', 'p1', 'assignment.create',
       '{"assignmentId":"as-vanished","scopeKind":"books","scope":[{"fileId":"f1"}]}'),
      -- an unrelated kind, and a payload with no scope at all
      ('e5', 'p1', 'assignment.unassign', '{"assignmentId":"as-book"}'),
      ('e6', 'p1', 'file.create', '{}');
  `)
}, 30_000)

afterEach(async () => {
  await db.close()
})

async function apply() {
  await db.exec(migration)
}

async function scopes() {
  return (
    await db.query<{ assignment_id: string; file_id: string; chapter: string }>(
      "SELECT assignment_id, file_id, chapter FROM assignment_scopes ORDER BY assignment_id, file_id, chapter",
    )
  ).rows
}

async function membership(assignmentId: string) {
  return (
    await db.query<{ cell_id: string }>(
      "SELECT cell_id FROM assignment_member_cells WHERE assignment_id = $1 ORDER BY cell_id",
      [assignmentId],
    )
  ).rows.map((r) => r.cell_id)
}

describe("0147_assignment_scopes", () => {
  it("backfills a range scope from the assignment.create payload", async () => {
    await apply()
    expect(await scopes()).toEqual([
      { assignment_id: "as-book", file_id: "f1", chapter: "" },
      { assignment_id: "as-chap", file_id: "f1", chapter: "GEN 1" },
    ])
  })

  it("skips an explicit line selection, an unrelated kind, and a vanished assignment", async () => {
    await apply()
    const ids = (await scopes()).map((s) => s.assignment_id)
    expect(ids).not.toContain("as-pick")
    expect(ids).not.toContain("as-vanished")
  })

  it("resolves a backfilled whole-file scope against live cells", async () => {
    await apply()
    // c3 was added to the file after as-book was handed out, and is not in its
    // snapshot — this is the bug AQU-1629 reports.
    expect(await membership("as-book")).toEqual(["c1", "c2", "c3"])
  })

  it("resolves a backfilled chapter scope to that chapter only", async () => {
    await apply()
    expect(await membership("as-chap")).toEqual(["c1", "c2"])
  })

  it("places a line with no reference by the plan board's own key (AQU-1493)", async () => {
    await apply()
    // A heading, or a line added in the editor, carries no reference. The full
    // progress recompute stores the chapter it counts in; assignment.create
    // resolves a chapter scope by that key, and so does the live read — c4 is
    // in Genesis 1, c5 nobody has placed yet, so it is in no chapter but still
    // in the whole file.
    await db.exec(`
      INSERT INTO cells (project_id, file_id, cell_id, side, canonical_ref, type) VALUES
        ('p1', 'f1', 'c4', 'source', NULL, 'heading'),
        ('p1', 'f1', 'c5', 'source', NULL, NULL);
      INSERT INTO cell_plan_keys (project_id, file_id, cell_id, section_key, place_ref, depth)
        VALUES ('p1', 'f1', 'c4', 'GEN 1', 'GEN 1:1', -1);
    `)
    expect(await membership("as-chap")).toEqual(["c1", "c2", "c4"])
    expect(await membership("as-book")).toEqual(["c1", "c2", "c3", "c4", "c5"])
  })

  it("leaves an assignment with no scope row on its frozen snapshot", async () => {
    await apply()
    expect(await membership("as-pick")).toEqual(["c1"])
    // as-gone has no assignment.create event to read a scope from, so the
    // backfill cannot reach it and it keeps exactly what it resolved to.
    expect(await membership("as-gone")).toEqual([])
  })

  it("is idempotent — a second apply changes nothing", async () => {
    await apply()
    const before = await scopes()
    await apply()
    expect(await scopes()).toEqual(before)
    expect(await membership("as-book")).toEqual(["c1", "c2", "c3"])
  })
})
