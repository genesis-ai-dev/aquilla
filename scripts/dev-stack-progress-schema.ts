import { readFileSync } from "node:fs"
import type { RunSchemaSql } from "./dev-stack-artifact-schema"

/** Column reconciliation cannot upgrade CHECKs on an existing database.
 * Use the same idempotent migration as deployed databases, including both
 * the scope and shape constraints. Adding columns alone leaves saves broken.
 */
export async function finalizeProgressSchema(run: RunSchemaSql): Promise<void> {
  const sql = readFileSync(new URL("../db/postgres/migrations/0088_file_section_progress_book_audio.sql", import.meta.url), "utf8")
  await run(sql, "upgrading book/audio progress constraints (migration 0088)")
}
