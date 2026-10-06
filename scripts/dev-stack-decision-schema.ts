// AQU-1691 (migration 0151): bring a long-lived local contextual_decisions
// table up to fact questions.
//
// The generic reconciler in dev-stack.ts adds the new columns (fact_key,
// options, fact_scope) but never touches CHECK constraints or NOT NULL, so a
// container created before 0151 would reject every 'bible-fact' question
// (readiness_item check) and every question without a file (file_id NOT
// NULL). This repairs both, idempotently. Same pattern as
// finalizeChangesetSchema in ./dev-stack-artifact-schema.ts.

import type { PgSchemaClient, RunSchemaSql } from "./dev-stack-artifact-schema"

export async function finalizeDecisionSchema(client: PgSchemaClient, run: RunSchemaSql): Promise<string[]> {
  const { rows: table } = await client.query("SELECT to_regclass('public.contextual_decisions') AS table_name")
  if (table[0]?.table_name == null) return []
  const patched: string[] = []

  const { rows: check } = await client.query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'contextual_decisions'::regclass
        AND conname = 'contextual_decisions_readiness_item_check'`,
  )
  const definition = typeof check[0]?.definition === "string" ? check[0].definition : ""
  if (!definition.includes("bible-fact")) {
    await run(
      `ALTER TABLE contextual_decisions DROP CONSTRAINT IF EXISTS contextual_decisions_readiness_item_check;
       ALTER TABLE contextual_decisions
         ADD CONSTRAINT contextual_decisions_readiness_item_check
         CHECK (readiness_item IS NULL OR
                readiness_item IN ('terminology','brief','examples','rules','languages','bible-fact'))`,
      "widening contextual_decisions.readiness_item for fact questions (migration 0151)",
    )
    patched.push("widened contextual_decisions.readiness_item for bible-fact")
  }

  const { rows: fileId } = await client.query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'contextual_decisions' AND column_name = 'file_id'`,
  )
  if (fileId[0]?.is_nullable === "NO") {
    await run(
      "ALTER TABLE contextual_decisions ALTER COLUMN file_id DROP NOT NULL",
      "making contextual_decisions.file_id nullable (migration 0151)",
    )
    patched.push("made contextual_decisions.file_id nullable")
  }
  return patched
}
