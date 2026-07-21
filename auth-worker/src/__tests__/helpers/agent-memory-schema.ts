// SWARM-TODO(aqu-agent): remove once W1C's 0066_agent_memory.sql lands in
// db/postgres/schema.sql. Until then these tables don't exist in the test
// schema, so W1B's memory-write tests create them (matching AQU-AGENT §3 DDL)
// so the branch's tests run standalone.
import { env } from "cloudflare:test"

/** Create the agent-memory / brief tables if the merged schema hasn't yet. */
export async function ensureAgentMemoryTables(): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `CREATE TABLE IF NOT EXISTS agent_memories (
       id uuid PRIMARY KEY,
       project_id text NOT NULL,
       path text NOT NULL,
       content text NOT NULL,
       status text NOT NULL DEFAULT 'proposed'
         CHECK (status IN ('proposed','approved','rejected','archived')),
       human_edited boolean NOT NULL DEFAULT false,
       rationale text,
       provenance jsonb,
       created_by text,
       reviewed_by text,
       version integer NOT NULL DEFAULT 1,
       created_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `CREATE TABLE IF NOT EXISTS project_briefs (
       project_id text PRIMARY KEY,
       content text NOT NULL DEFAULT '',
       updated_by text,
       version integer NOT NULL DEFAULT 1,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `CREATE TABLE IF NOT EXISTS project_brief_proposals (
       id uuid PRIMARY KEY,
       project_id text NOT NULL,
       content text NOT NULL,
       rationale text,
       status text NOT NULL DEFAULT 'proposed'
         CHECK (status IN ('proposed','approved','rejected')),
       created_by text,
       reviewed_by text,
       created_at timestamptz NOT NULL DEFAULT now(),
       reviewed_at timestamptz
     )`,
  ).run()
}
