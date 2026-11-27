// Vitest globalSetup: build the schema'd test database once for the whole
// run, so every test database is a copy of it instead of a fresh initdb plus
// schema.sql. The why and the numbers are in db/shared/test-pg-harness.ts.
import { PGlite } from "@electric-sql/pglite"
import { writeTestPgTemplate } from "../../../../db/shared/test-pg-harness"

export default function setup(): Promise<() => Promise<void>> {
  return writeTestPgTemplate(() => new PGlite())
}
