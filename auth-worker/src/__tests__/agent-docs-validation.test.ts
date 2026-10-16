// The validation cookbook is SQL the agent copies verbatim. Its threshold
// recipe used to read a 'validationCountThreshold' settings key that nothing
// has ever written (it came in with the first agent-library commit), so it
// returned 1 for every project and the agent told users that a project which
// needs two validators needs one. The real keys are validationCount and
// validationCountAudio (db/shared/project-settings-keys.ts). These tests run
// the cookbook's own recipe through the guard the agent's sql tool uses, on
// the real schema, and hold its answer to the bar the app enforces.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { getCookbook } from "../lib/agent/docs"
import { runGuardedSql, type SqlVarContext } from "../lib/agent/sql-guard"
import { AliasMap } from "../lib/agent/compress"
import { normalizeSettings } from "../../../db/shared/projects"
import { sqlStatements } from "./helpers/cookbook-sql"

const PROJECT = "11111111-1111-4111-8111-111111111111"
const vars: SqlVarContext = { projectId: PROJECT, userId: 42 }

const text = getCookbook("validation").text
const recipe = sqlStatements(text).find((s) => /\bFROM project_settings\b/.test(s))

async function runRecipe(settings: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  await env.AQUILLA_PG.prepare("INSERT INTO project_settings (project_id, settings) VALUES (?, ?)")
    .bind(PROJECT, JSON.stringify(settings))
    .run()
  const r = await runGuardedSql(env.AQUILLA_PG, recipe!, vars, new AliasMap())
  expect(r, recipe).toMatchObject({ ok: true })
  return r.ok ? r.rows : []
}

/** The bar the app enforces: normalizeSettings() puts both keys through
 *  validationThreshold()'s clamp on every write, and every reader takes an
 *  unset key as 1. */
function enforced(settings: Record<string, unknown>, key: "validationCount" | "validationCountAudio"): number {
  return (normalizeSettings(settings)[key] as number | undefined) ?? 1
}

const CLAMP_CASES: { label: string; settings: Record<string, unknown> }[] = [
  { label: "unset keys", settings: {} },
  { label: "a separate audio bar", settings: { validationCount: 2, validationCountAudio: 3 } },
  // A blob an old client wrote before writes were clamped.
  { label: "out-of-range counts", settings: { validationCount: 999, validationCountAudio: 0 } },
  // Must read as 1, not abort the recipe with a cast error.
  { label: "a non-numeric count", settings: { validationCount: "two" } },
]

describe("validation cookbook — the threshold recipe reads the real settings keys", () => {
  it("documents a project_settings read and never names the retired key", () => {
    expect(recipe).toBeDefined()
    expect(text).not.toContain("validationCountThreshold")
  })

  it("returns 2 for a project that requires two validators", async () => {
    expect(await runRecipe({ validationCount: 2 })).toEqual([{ threshold: 2, audio_threshold: 1 }])
  })

  it.each(CLAMP_CASES)("agrees with the app's clamp for $label", async ({ settings }) => {
    expect(await runRecipe(settings)).toEqual([
      {
        threshold: enforced(settings, "validationCount"),
        audio_threshold: enforced(settings, "validationCountAudio"),
      },
    ])
  })
})
