// Migration numbers stay unique from here on (AQU-2492, Nov 13 2026).
//
// WHY THIS EXISTS. Postgres migrations run and are recorded by file name, so two
// files sharing a number both apply and nothing complains — which is how a branch
// cut before dev took 0198–0201 ended up with 0201_cell_audio_cut_votes beside
// dev's 0201_admin_totp, and a merge showed no conflict. The numbers below were
// shared before this guard existed and are left as they are.
//
// WHEN IT FAILS. An unlanded branch takes the next free number on dev only as the
// last step before its PR, so until then a clash with dev is expected: locally a
// clash is only a warning. It fails in CI, or with MIGRATION_NUMBERS=strict.

import { describe, expect, it } from "vitest"
import { readdirSync } from "node:fs"
import path from "node:path"
// The real Node process: the app project gives every test a browser shim
// whose `process.env` is empty, so CI and MIGRATION_NUMBERS would never be seen.
import process from "node:process"

const migrationsDir = path.resolve(import.meta.dirname, "..", "db/postgres/migrations")

// Shared before Nov 13 2026; never add to this list — renumber instead.
const SHARED_BEFORE_THE_GUARD = new Set([
  "0034", "0035", "0036", "0050", "0054", "0066", "0067", "0068", "0069", "0070",
  "0073", "0074", "0076", "0079", "0080", "0083", "0090", "0091", "0092", "0093",
  "0094", "0095", "0096", "0097", "0098", "0126", "0130", "0158",
])

const STRICT = Boolean(process.env.CI) || process.env.MIGRATION_NUMBERS === "strict"

const RULE =
  "Two migrations share a number: an unlanded branch renumbers at the PR step, to the next free number on dev."

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
    if (STRICT) {
      expect(clashes, RULE).toEqual([])
    } else if (clashes.length > 0) {
      // stderr, not console.warn: vitest hides a passing test's console output.
      process.stderr.write(`${RULE} (run with MIGRATION_NUMBERS=strict to enforce)\n  ${clashes.join("\n  ")}\n`)
    }
  })
})
