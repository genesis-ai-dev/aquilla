// AQU-1424 — a parked cell is not work, in this worker's selection and search.
//
// "Hide cell" (AQU-1422) parks a cell without deleting anything. The half this
// worker owns: the cell a hidden row must never be picked as — an autopilot
// target, an agent `read`/`draft` target, or a search hit. `selectCellPairs` is
// THE selector behind all three of the first kind (the contextual tick calls it
// too), so the predicate sits there and every caller inherits it.
//
// The one that costs real money if it regresses is drafting: a hidden cell that
// stays in the work list gets AI credits spent on text nobody will read or
// export, and the draft then sits waiting the next time someone shows the cell.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { seedUser } from "./helpers/db"
import { AliasMap } from "../lib/agent/compress"
import { selectCellPairs } from "../lib/agent/tools/select-cells"
import { executeRead } from "../lib/agent/tools/read"
import { executeSearch } from "../lib/agent/tools/search"

const PROJECT = "44444444-4444-4444-8444-444444444444"
const FILE = "55555555-5555-4555-8555-555555555555"

function cellId(suffix: string): string {
  return `66666666-6666-4666-8666-${suffix.padStart(12, "0")}`
}

/** Four cells in MRK 4. `h1` carries a word that appears nowhere else, so a
 *  search for it proves the exclusion rather than merely failing to rank. */
const CELLS = [
  { id: "v1", ref: "MRK 4:1", source: "And he began again to teach", target: "Y comenzó", hidden: false },
  { id: "v2", ref: "MRK 4:2", source: "And he taught them many things", target: "", hidden: false },
  { id: "h1", ref: "MRK 4:3", source: "Behold a quokka went out to sow", target: "", hidden: true },
  { id: "v4", ref: "MRK 4:4", source: "And it came to pass", target: "", hidden: false },
] as const

async function seedWorld() {
  await seedUser(1, "alice")
  await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, created_by) VALUES (?, 'P', 1)`)
    .bind(PROJECT).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, book_code, event_id) VALUES (?, ?, 'Mark', 'MRK', ?)`,
  ).bind(FILE, PROJECT, crypto.randomUUID()).run()
  for (const c of CELLS) {
    const id = cellId(c.id)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at, hidden_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 0, ?)`,
    ).bind(PROJECT, FILE, id, c.source, c.ref, crypto.randomUUID(), c.hidden ? 1 : null).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, validated, last_edit_at)
       VALUES (?, ?, ?, 'target', ?, ?, ?, 0, 0)`,
    ).bind(PROJECT, FILE, id, c.target, c.ref, crypto.randomUUID()).run()
  }
}

async function show(suffix: string) {
  await env.AQUILLA_PG.prepare(
    `UPDATE cells SET hidden_at = NULL WHERE project_id = ? AND cell_id = ? AND side = 'source'`,
  ).bind(PROJECT, cellId(suffix)).run()
}

function toolCtx() {
  return { projectId: PROJECT, focusedFileId: FILE, aliases: new AliasMap() }
}

describe("AQU-1424 — selectCellPairs never offers a hidden cell", () => {
  it("leaves a parked cell out of the work list the tick and the tools share", async () => {
    await seedWorld()
    const pairs = await selectCellPairs(env.AQUILLA_PG, PROJECT, { fileId: FILE })
    expect(pairs.map((p) => p.canonicalRef)).toEqual(["MRK 4:1", "MRK 4:2", "MRK 4:4"])
    // Specifically: the UNTRANSLATED set autopilot and Draft-all work from.
    expect(pairs.filter((p) => !p.target.trim()).map((p) => p.canonicalRef))
      .toEqual(["MRK 4:2", "MRK 4:4"])
  })

  it("offers it again the moment it is shown", async () => {
    await seedWorld()
    await show("h1")
    const pairs = await selectCellPairs(env.AQUILLA_PG, PROJECT, { fileId: FILE })
    expect(pairs.map((p) => p.canonicalRef)).toEqual(["MRK 4:1", "MRK 4:2", "MRK 4:3", "MRK 4:4"])
  })

  it("returns every cell of a file with nothing hidden, unchanged", async () => {
    await seedWorld()
    await show("h1")
    const pairs = await selectCellPairs(env.AQUILLA_PG, PROJECT, { fileId: FILE })
    expect(pairs).toHaveLength(CELLS.length)
  })
})

describe("AQU-1424 — the in-app agent neither reports nor drafts a hidden cell", () => {
  it('answers "everything untranslated in this file" with the visible cells only', async () => {
    await seedWorld()
    const out = await executeRead(env.AQUILLA_PG, { ref: "MRK 4", filter: "untranslated" }, toolCtx())
    expect(out.ok).toBe(true)
    expect(out.data?.cells?.map((c) => c.ref)).toEqual(["MRK 4:2", "MRK 4:4"])
    // The hidden cell is not merely unlisted — its text never reaches the model,
    // so it cannot be drafted by a follow-up the model writes from this reply.
    expect(out.text).not.toContain("quokka")
  })
})

describe("AQU-1424 — the agent's search skips hidden cells", () => {
  it("finds nothing for a word that lives only on a parked cell", async () => {
    await seedWorld()
    const out = await executeSearch(env.AQUILLA_PG, { q: "quokka" }, toolCtx())
    expect(out.ok).toBe(true)
    expect(out.data?.hits ?? []).toEqual([])
  })

  it("finds it once the cell is shown", async () => {
    await seedWorld()
    await show("h1")
    const out = await executeSearch(env.AQUILLA_PG, { q: "quokka" }, toolCtx())
    expect(out.data?.hits?.map((h) => h.cellId)).toEqual([cellId("h1")])
  })
})
