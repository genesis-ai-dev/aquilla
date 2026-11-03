import { makePostgres, type AquillaDb } from "../../../db/shim/postgres"
import type { Env } from "../types"

/** A Postgres handle a post-response task owns, plus the release that hands
 *  it back. `withPostResponseDb` always awaits `close`, so it runs exactly
 *  once per handle. */
export interface PostResponseDb {
  db: AquillaDb
  close(): Promise<void>
}

/** Open a connection the task owns, or null when this worker has no
 *  connection string to open one from (the vitest harness injects
 *  `AQUILLA_PG` directly and sets none, so the task then runs on it inline). */
export function openPostResponseDb(env: Pick<Env, "PG_CONNECTION_STRING">): PostResponseDb | null {
  if (!env.PG_CONNECTION_STRING) return null
  const shim = makePostgres(env.PG_CONNECTION_STRING)
  return { db: shim as unknown as AquillaDb, close: () => shim.close() }
}

/** Run DB work that outlives the Response on a connection the work owns.
 *
 *  The request-scoped `AQUILLA_PG` shim is closed by index.ts in its `finally`
 *  the moment the Response returns (`ctx.waitUntil(shim.close())`), and
 *  postgres.js rejects every query issued after `end()` with
 *  `CONNECTION_ENDED`. Anything handed to `executionCtx.waitUntil` that still
 *  writes to Postgres must therefore open its own connection — the contract
 *  routes/agent.ts (`runShim`), routes/chat.ts (`afterResponse`) and
 *  routes/knowledge.ts (`indexDocOnOwnConnection`) already follow. This is
 *  that contract for the small post-response writers: open, run, release.
 *
 *  Without a connection string (tests) the work runs on `env.AQUILLA_PG`,
 *  which the harness keeps alive for the whole test. `open` is injectable so a
 *  test can supply a live handle while the request-scoped one is already dead. */
export async function withPostResponseDb(
  env: Pick<Env, "PG_CONNECTION_STRING" | "AQUILLA_PG">,
  work: (db: AquillaDb) => Promise<void>,
  open: (env: Pick<Env, "PG_CONNECTION_STRING">) => PostResponseDb | null = openPostResponseDb,
): Promise<void> {
  const own = open(env)
  const db = own?.db ?? env.AQUILLA_PG
  try {
    await work(db)
  } finally {
    await own?.close()
  }
}
