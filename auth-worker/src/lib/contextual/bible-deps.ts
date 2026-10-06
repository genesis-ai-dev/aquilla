// bible-deps — the Bible data side effects one autopilot run uses (AQU-1690).
//
// Built ONCE per run by the run driver (routes/contextual.ts selfTickLoop),
// so anything that should last a run (the Jev answer cache, the fact
// questions already raised) lives in this closure and spans every wave.
//
// `db` is the run loop's own connection. The request's env.AQUILLA_PG may be
// closed by the time a background wave runs, and the flag reader fails
// closed — Bible data would switch off without a word.

import type { Env } from "../../types"
import type { AquillaDb } from "../../../../db/shim/postgres"
import { readBibleEnrichmentFlags } from "../aquifer/gate"
import { loadBookPack } from "../bkp/pack-loader"
import type { BibleTickDeps } from "./bible-run"

export function makeBibleTickDeps(env: Env, db: AquillaDb, run: { projectId: string }): BibleTickDeps {
  const runEnv: Env = { ...env, AQUILLA_PG: db }
  return {
    flags: async () => {
      // Bible data off already turns every enrichment off.
      const flags = await readBibleEnrichmentFlags(runEnv, run.projectId)
      return { autopilot: flags.autopilot, checks: flags.autopilot && flags.checks }
    },
    loadPack: (book, opts) => loadBookPack(env, book, opts),
  }
}
