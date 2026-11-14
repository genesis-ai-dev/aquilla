import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { scrubRefusal } from "./neon-scrub-guard"

// AQU-1775: the scrub exists to strip production's integration tokens out of
// a COPY of production. The one thing it must never do is run on production.
describe("neon-scrub-integrations refuses the wrong database", () => {
  it("refuses production under every alias, and an unnamed target", () => {
    expect(scrubRefusal("production")).toMatch(/refusing/)
    expect(scrubRefusal("prod")).toMatch(/refusing/)
    expect(scrubRefusal("main")).toMatch(/refusing/)
    expect(scrubRefusal(" Production ")).toMatch(/refusing/)
    expect(scrubRefusal(undefined)).toMatch(/AQUILLA_NEON_TARGET is unset/)
    expect(scrubRefusal("")).toMatch(/AQUILLA_NEON_TARGET is unset/)
  })

  it("allows the refreshable targets", () => {
    expect(scrubRefusal("dev")).toBeNull()
    expect(scrubRefusal("local")).toBeNull()
  })
})

// A table that stores a third-party token arrived (0196 langquest_connections)
// and the scrub was not told. Every table with a `token_enc` column is one the
// dev copy must not keep, either deleted by name or reached by a cascade.
describe("neon-scrub-integrations covers every stored token", () => {
  it("names each schema table that has a token_enc column", () => {
    const schema = readFileSync("db/postgres/schema.sql", "utf8")
    const script = readFileSync("scripts/neon-scrub-integrations.ts", "utf8")
    const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)]
      .filter((match) => /^\s*token_enc\s/m.test(match[2]!))
      .map((match) => match[1]!)
    expect(tables).toContain("langquest_connections")
    for (const table of tables) expect(script).toContain(`DELETE FROM ${table}`)
  })
})
