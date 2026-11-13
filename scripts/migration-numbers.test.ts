// Migration numbers stay unique from here on (AQU-2492, Nov 13 2026).
//
// WHY THIS EXISTS. Postgres migrations run and are recorded by file name, so two
// files sharing a number both apply and nothing complains — which is how a branch
// cut before dev took 0198–0201 ended up with 0201_cell_audio_cut_votes beside
// dev's 0201_admin_totp, and a merge showed no conflict. The numbers below were
// shared before this guard existed and are left as they are; any other number
// used twice fails here, so the branch that lands second renumbers.

import { describe, expect, it } from "vitest"
import { readdirSync } from "node:fs"
import path from "node:path"

const migrationsDir = path.resolve(import.meta.dirname, "..", "db/postgres/migrations")

// Shared before Nov 13 2026; never add to this list — renumber instead.
const SHARED_BEFORE_THE_GUARD = new Set([
  "0034", "0035", "0036", "0050", "0054", "0066", "0067", "0068", "0069", "0070",
  "0073", "0074", "0076", "0079", "0080", "0083", "0090", "0091", "0092", "0093",
  "0094", "0095", "0096", "0097", "0098", "0126", "0130", "0158",
])

describe("Postgres migration numbers", () => {
  it("no number is used by two migrations, apart from the ones shared before this guard", () => {
    const byNumber = new Map<string, string[]>()
    for (const name of readdirSync(migrationsDir)) {
      const m = /^(\d{4})_.+\.sql$/.exec(name)
      if (!m) continue
      byNumber.set(m[1], [...(byNumber.get(m[1]) ?? []), name])
    }
    const clashes = [...byNumber.entries()]
      .filter(([n, names]) => names.length > 1 && !SHARED_BEFORE_THE_GUARD.has(n))
      .map(([n, names]) => `${n}: ${names.sort().join(", ")}`)
    expect(clashes).toEqual([])
  })
})
