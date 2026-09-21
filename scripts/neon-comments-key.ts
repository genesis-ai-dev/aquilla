import type { Client } from "pg"

/** Expand only. Never remove the global key before the worker rollout. */
export async function prepareCommentsKey(client: Pick<Client, "query">): Promise<number> {
  const { rows } = await client.query<{ columns: string[] }>(`
    SELECT ARRAY(
      SELECT a.attname::text
      FROM unnest(c.conkey) WITH ORDINALITY k(n, pos)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
      ORDER BY k.pos
    ) AS columns
    FROM pg_constraint c
    WHERE c.conrelid = 'comments'::regclass AND c.contype = 'p'
  `)
  const columns = rows[0]?.columns.join(",")
  if (columns === "project_id,comment_id") {
    console.log("✓ comments primary key is already project-scoped")
    return 0
  }
  if (columns !== "comment_id") {
    throw new Error(`Unexpected comments primary key: ${columns ?? "missing"}`)
  }

  // A separate query, with no BEGIN: CONCURRENTLY cannot run in a transaction.
  // IF NOT EXISTS alone cannot certify an index left invalid by a failed build.
  await client.query(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
    comments_project_comment_pk ON comments (project_id, comment_id)`)
  const { rows: indexes } = await client.query<{ valid: boolean }>(`
    SELECT (
      i.indrelid = 'comments'::regclass
      AND i.indisvalid AND i.indisready AND i.indisunique
      AND NOT i.indisprimary AND am.amname = 'btree'
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnkeyatts = 2 AND i.indnatts = 2
      AND ARRAY(
        SELECT a.attname::text
        FROM unnest(i.indkey) WITH ORDINALITY k(n, pos)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n
        ORDER BY k.pos
      ) = ARRAY['project_id', 'comment_id']
    ) AS valid
    FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_am am ON am.oid = idx.relam
    WHERE i.indexrelid = to_regclass('comments_project_comment_pk')
  `)
  if (indexes[0]?.valid !== true) {
    throw new Error(
      "comments_project_comment_pk is not a valid unique index on " +
      "(project_id, comment_id). Inspect it before retrying; the old key is unchanged.",
    )
  }
  console.log("✓ comments index prepared and verified; original primary key preserved")
  console.log("Deploy and verify the compatible sync-worker BEFORE neon:apply")
  return 0
}
