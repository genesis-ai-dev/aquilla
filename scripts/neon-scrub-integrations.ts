#!/usr/bin/env tsx
// Delete every external-integration connection — and, by cascade, its board
// links and item links — from a NON-production database (AQU-1775).
//
// WHY: the dev Neon branch is restored from production
// (scripts/refresh-neon-branch.ts). That copy carried every org's encrypted
// Monday tokens, and the dev identity worker, which holds the same signing key
// as production, could decrypt them, refresh them (rotating production's
// refresh token away) and push dev's numbers onto a board linked on
// production. The worker now refuses rows made by another environment
// (auth-worker/src/lib/monday/tokens.ts foreignConnectionError); this removes
// them so that refusal is a backstop, not the only line.
//
// Runs under neon-target (`pnpm neon:scrub:dev`, `pnpm neon:scrub:local`) or
// from the refresh itself. AQUILLA_NEON_TARGET names the database it is
// pointed at: production, or no target at all, is refused.
//
//   --dry-run   count what would go and delete nothing

import process from "node:process"
import { neonClient } from "./pg"
import { scrubRefusal } from "./neon-scrub-guard"

async function main() {
  const target = process.env.AQUILLA_NEON_TARGET
  const refusal = scrubRefusal(target)
  if (refusal) throw new Error(refusal)
  const dryRun = process.argv.includes("--dry-run")

  const client = neonClient()
  await client.connect()
  try {
    const counts = await client.query<{ connections: string; links: string; items: string }>(
      `SELECT (SELECT count(*) FROM integration_connections) AS connections,
              (SELECT count(*) FROM integration_links) AS links,
              (SELECT count(*) FROM integration_item_links) AS items`,
    )
    const { connections, links, items } = counts.rows[0]
    console.log(
      `${target}: ${connections} integration connection(s), ${links} board link(s), ${items} item link(s)`,
    )
    if (dryRun) {
      console.log("dry run — nothing deleted")
      return
    }
    const deleted = await client.query("DELETE FROM integration_connections")
    console.log(
      `deleted ${deleted.rowCount ?? 0} integration connection(s); their board links and item links went with them (ON DELETE CASCADE)`,
    )
  } finally {
    await client.end()
  }
}

if (process.argv[1]?.endsWith("neon-scrub-integrations.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
