#!/usr/bin/env tsx
// Discovery-only: list every GitLab Codex project, map each to its projectId,
// and report which ones are NOT yet in Neon (no events row). No git clones —
// just the GitLab REST discovery + a PG existence check. Prints the missing
// gitlab IDs so pg-import-content.ts --only <id> can backfill just the gap.
//   set -a; . ./.env; set +a; export FRONTIER_TOKEN="$GITLAB_ROOT_TOKEN"
//   npx tsx scripts/pg-import-gap.ts
import { Pool } from "pg"
import { resolveCredentialsFromEnv } from "../src/lib/migrate/gitlab/auth"
import { discoverCodexProjects } from "../src/lib/migrate/gitlab/api"
import { projectIdFor } from "../src/lib/migrate/ids"
import { neonConfig } from "./pg"

async function main() {
  const creds = await resolveCredentialsFromEnv(process.env)
  const pg = new Pool({ ...neonConfig() })
  const all = await discoverCodexProjects(creds, {})
  const have = new Set(
    (await pg.query<{ project_id: string }>("SELECT DISTINCT project_id FROM events")).rows.map((r) => r.project_id),
  )
  const missing = all.filter((p) => !have.has(projectIdFor(String(p.id), "gitlab")))
  console.log(`GitLab Codex projects: ${all.length}`)
  console.log(`Already in Neon (have events): ${have.size}`)
  console.log(`Missing (need import): ${missing.length}`)
  for (const p of missing) console.log(`  ${p.id}\t${p.namespace}/${p.name}`)
  await pg.end()
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.stack : String(e)))
  process.exit(1)
})
