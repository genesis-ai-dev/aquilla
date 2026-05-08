/**
 * CI guard against migration drift at the source level — the partner of the
 * runtime check in MigrationDriftError. Compares each committed migration's
 * canonicalized hash against MIGRATIONS_LOCK.json. Editing a migration file
 * fails this test; adding a new migration requires updating the manifest in
 * the same PR.
 *
 * See DATA_PERSISTENCE_PLAN.md §13.
 */

import { describe, expect, test } from "vitest"
import { MIGRATIONS } from "."
import lockfile from "./MIGRATIONS_LOCK.json"

async function canonicalHash(sql: string): Promise<string> {
  const canonical = sql.replace(/\r\n/g, "\n").trim()
  const data = new TextEncoder().encode(canonical)
  const buffer = await globalThis.crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

describe("migrations lockfile", () => {
  test("every committed migration matches its recorded SHA-256", async () => {
    const expectedHashes = lockfile.hashes as Record<string, string>
    for (const m of MIGRATIONS) {
      const actual = await canonicalHash(m.sql)
      const expected = expectedHashes[String(m.version)]
      expect(
        expected,
        `MIGRATIONS_LOCK.json is missing an entry for migration version ${m.version}. ` +
          `Add: "${m.version}": "${actual}"`,
      ).toBeDefined()
      expect(
        actual,
        `migration ${m.version} hash drift. ` +
          `Existing migrations are append-only — never edit a file once merged. ` +
          `If this is a deliberate fix to an unshipped change, update MIGRATIONS_LOCK.json: "${m.version}": "${actual}"`,
      ).toBe(expected)
    }
  })

  test("lockfile has no stale entries for migrations that were removed", () => {
    const known = new Set(MIGRATIONS.map((m) => String(m.version)))
    const inLock = Object.keys(lockfile.hashes as Record<string, string>)
    const stale = inLock.filter((v) => !known.has(v))
    expect(
      stale,
      `MIGRATIONS_LOCK.json has entries for versions that no longer exist: ${stale.join(", ")}. ` +
        "Remove the entries (we treat removal as a deliberate decision worth a PR).",
    ).toEqual([])
  })
})
