// AQU-641: cell-confidence route — batched (single-query) neighbor retrieval.
//
// Runs the REAL route against a real Postgres (PGlite) behind the shim, so the
// JOIN LATERAL / to_tsquery SQL in queryFileSourceNeighbors is validated for
// real. Two guarantees:
//   1. Graded health (not binary 0/100): a translated-unvalidated cell that
//      lexically resembles a validated cell scores strictly between 0 and 100,
//      gated by how well its target matches; an unrelated cell stays at 0.
//   2. Bounded query count: the route issues a small constant number of SQL
//      statements per file regardless of cell count — NOT one FTS query per cell
//      (the N+1 that forced this route off by default).

import { describe, it, expect } from "vitest"
import { handleCellConfidenceRequest } from "../events/cell-confidence-route"
import { makeTestDb, type Seed } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "cell-confidence-secret"
const PROJECT = "proj-a"
const FILE = "file-x"

function src(cellId: string, value: string): Record<string, unknown> {
  return { project_id: PROJECT, file_id: FILE, cell_id: cellId, side: "source", value, event_id: `s-${cellId}`, last_edit_at: 0 }
}
function tgt(cellId: string, value: string, validated = 0): Record<string, unknown> {
  return { project_id: PROJECT, file_id: FILE, cell_id: cellId, side: "target", value, validated, event_id: `t-${cellId}`, last_edit_at: 0 }
}

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

async function callRoute(db: AquillaDb, cellIds?: string[]) {
  const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
  const qs = new URLSearchParams({ fileId: FILE })
  if (cellIds) qs.set("cellIds", cellIds.join(","))
  const req = new Request(`https://w/api/v1/projects/${PROJECT}/cell-confidence?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const res = (await handleCellConfidenceRequest(req, envWith(db)))!
  expect(res.status).toBe(200)
  return (await res.json()) as {
    confidence: Record<string, number>
    detail: Record<string, { validated: boolean; neighbors: number; topCellId: string | null }>
    nodes: number
  }
}

/** Proxy that counts db.prepare() calls (each = one SQL round-trip). */
function countingDb(db: AquillaDb): { db: AquillaDb; count: () => number } {
  let n = 0
  const proxy = new Proxy(db as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          n += 1
          return (target.prepare as (s: string) => unknown)(sql)
        }
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === "function" ? v.bind(target) : v
    },
  })
  return { db: proxy as unknown as AquillaDb, count: () => n }
}

describe("cell-confidence route — batched retrieval (AQU-641)", () => {
  it("produces GRADED health from similarity, not a binary 0/100 split", async () => {
    const seed: Seed = {
      cells: [
        // V: validated anchor.
        src("V", "the quick brown fox jumps over"),
        tgt("V", "le renard brun rapide saute par dessus", 1),
        // X: shares source words with V, target closely matches V's target → high, graded.
        src("X", "the quick brown fox runs fast"),
        tgt("X", "le renard brun rapide court vite", 0),
        // Y: shares source words with V, but target is unrelated → gated low.
        src("Y", "the quick brown fox sleeps now"),
        tgt("Y", "zzz totally unrelated translation here", 0),
        // Z: no lexical overlap with anything validated → stays 0.
        src("Z", "wholly different vocabulary altogether"),
        tgt("Z", "aucun rapport lexical distinct", 0),
      ],
    }
    const { db } = await makeTestDb(seed)
    const body = await callRoute(db)

    // Validated anchor reads 100.
    expect(body.confidence["V"]).toBe(1)
    // Unrelated translated cell has no validated/translated neighbor → 0.
    expect(body.confidence["Z"]).toBe(0)
    // X is GRADED: strictly between 0 and 100 (the binary bug would give 0 or 1).
    expect(body.confidence["X"]).toBeGreaterThan(0)
    expect(body.confidence["X"]).toBeLessThan(1)
    // Target-consistency gates the transfer: X (matching target) > Y (unrelated target).
    expect(body.confidence["X"]).toBeGreaterThan(body.confidence["Y"])
    // X actually found neighbors via the batched query.
    expect(body.detail["X"].neighbors).toBeGreaterThan(0)
  })

  it("validating a cell raises a similar neighbor's health on the next fetch", async () => {
    const before: Seed = {
      cells: [
        src("A", "the morning sun rises east"),
        tgt("A", "le soleil du matin se leve", 0), // NOT yet validated
        src("B", "the morning sun rises bright"),
        tgt("B", "le soleil du matin brille", 0),
      ],
    }
    const { db, pg } = await makeTestDb(before)
    const first = await callRoute(db)
    // Nobody validated yet → B has no validated anchor to draw from → 0.
    expect(first.confidence["B"]).toBe(0)

    // Validate A, then re-fetch: B now resembles a validated neighbor → graded > 0.
    await pg.query("UPDATE cells SET validated = 1 WHERE cell_id = 'A' AND side = 'target'")
    const second = await callRoute(db)
    expect(second.confidence["A"]).toBe(1)
    expect(second.confidence["B"]).toBeGreaterThan(0)
    expect(second.confidence["B"]).toBeLessThan(1)
  })

  it("issues a bounded, constant number of SQL statements per file (not one per cell)", async () => {
    // Many unvalidated cells that all overlap a single validated anchor.
    const rows: Record<string, unknown>[] = [
      src("V", "shared anchor words here"),
      tgt("V", "mots ancre partages ici", 1),
    ]
    const N = 40
    for (let i = 0; i < N; i++) {
      rows.push(src(`c${i}`, `shared anchor words number ${i}`))
      rows.push(tgt(`c${i}`, `mots ancre partages numero ${i}`, 0))
    }
    const { db } = await makeTestDb({ cells: rows })
    const counted = countingDb(db)
    const body = await callRoute(counted.db)

    // All N cells scored.
    expect(body.nodes).toBe(N + 1)
    // The N+1 version would issue ~N FTS queries; the batched version is
    // loadFileCells (1) + queryFileSourceNeighbors (1) = 2. Allow generous slack
    // but assert it stays far below the per-cell count.
    expect(counted.count()).toBeLessThanOrEqual(4)
    expect(counted.count()).toBeLessThan(N)
  })
})
