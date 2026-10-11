// AQU-1845 — the Autopilot wave's per-model-call checkpoint.
//
// `runOneTick` advances a run's cursor past a wave in ONE guarded write, so a
// driver killed mid-wave replays that whole wave. Before the checkpoint, the
// replay re-issued every call the dead attempt had already finished: the
// provider was paid twice and the first reply was thrown away. Autopilot's
// throughput ceiling made that the NORMAL case, not an edge one — every run
// longer than a `waitUntil` budget was cut off mid-wave.
//
// What this guards, in order of severity:
//   1. The replay re-paying. A second attempt over the same prompts must read
//      the first attempt's replies back and not reach the provider at all.
//   2. The cache answering a call it should not. A changed prompt, a different
//      span, a different node, a different tier and a legitimately repeated
//      identical call must each MISS — a cache that returns the wrong reply
//      stages the wrong translation, which is far worse than paying twice.
//   3. The checkpoint becoming a new way to fail. An unreachable table (a
//      deploy running ahead of its migration) must degrade to calling the
//      provider, never to failing the run.
//   4. Cleanup. A completed wave's rows must not survive to be read by a
//      later, unrelated wave of the same run.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkpointedLlm, discardCheckpoints } from "../lib/contextual/checkpoint"
import {
  contextualPromptHash,
  contextualStepKey,
  sweepContextualRunSteps,
} from "../../../db/shared/contextual-run-steps"
import type { LlmCall, LlmRequest } from "../lib/contextual/types"

const RUN = { runId: "run-1845", projectId: "proj-1845" }

function req(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    system: "you translate",
    user: "John 1:1",
    tier: "mid",
    maxTokens: 512,
    temperature: 0.2,
    label: "draft",
    spanId: "span-a",
    ...over,
  }
}

/** A base LlmCall that counts how many times the provider was actually dialed
 *  and returns a distinguishable reply each time. */
function counting(prefix = "reply"): { llm: LlmCall; calls: LlmRequest[] } {
  const calls: LlmRequest[] = []
  const llm: LlmCall = async (r) => {
    calls.push(r)
    return `${prefix}-${calls.length}`
  }
  return { llm, calls }
}

describe("contextual run checkpoints (AQU-1845)", () => {
  it("serves a replayed wave from the checkpoint without dialing the provider", async () => {
    const first = counting()
    const attemptOne = checkpointedLlm(env.AQUILLA_PG, RUN, first.llm)
    const construed = await attemptOne.llm(req({ label: "construe" }))
    const drafted = await attemptOne.llm(req({ label: "draft" }))
    expect(first.calls).toHaveLength(2)
    expect(attemptOne.reused).toBe(0)

    // The driver dies here: the cursor never advanced, so the next attempt
    // replays the same wave — same spans, same nodes, same prompts.
    const second = counting("second")
    const attemptTwo = checkpointedLlm(env.AQUILLA_PG, RUN, second.llm)
    expect(await attemptTwo.llm(req({ label: "construe" }))).toBe(construed)
    expect(await attemptTwo.llm(req({ label: "draft" }))).toBe(drafted)
    expect(second.calls).toHaveLength(0)
    expect(attemptTwo.reused).toBe(2)
  })

  it("misses on anything that could change the reply", async () => {
    const base = counting()
    const attemptOne = checkpointedLlm(env.AQUILLA_PG, RUN, base.llm)
    await attemptOne.llm(req())

    const replay = counting("fresh")
    const attemptTwo = checkpointedLlm(env.AQUILLA_PG, RUN, replay.llm)
    // Each of these differs from the checkpointed call in exactly one field.
    await attemptTwo.llm(req({ user: "John 1:2" }))
    await attemptTwo.llm(req({ system: "you translate carefully" }))
    await attemptTwo.llm(req({ spanId: "span-b" }))
    await attemptTwo.llm(req({ label: "verify" }))
    await attemptTwo.llm(req({ tier: "deep" }))
    await attemptTwo.llm(req({ maxTokens: 1024 }))
    await attemptTwo.llm(req({ temperature: 0.9 }))
    expect(replay.calls).toHaveLength(7)
    expect(attemptTwo.reused).toBe(0)
  })

  it("gives a node that repeats an identical prompt its own checkpoint", async () => {
    // A redraft loop can re-send an unchanged prompt. The second call must be
    // a real call, not a read-back of the first reply — otherwise the loop
    // sees its own previous output and can never converge.
    const base = counting()
    const attempt = checkpointedLlm(env.AQUILLA_PG, RUN, base.llm)
    expect(await attempt.llm(req())).toBe("reply-1")
    expect(await attempt.llm(req())).toBe("reply-2")
    expect(base.calls).toHaveLength(2)
    expect(attempt.reused).toBe(0)

    // And the replay reproduces both, in order, from the two checkpoints.
    const replay = counting("fresh")
    const second = checkpointedLlm(env.AQUILLA_PG, RUN, replay.llm)
    expect(await second.llm(req())).toBe("reply-1")
    expect(await second.llm(req())).toBe("reply-2")
    expect(replay.calls).toHaveLength(0)
  })

  it("keeps runs separate", async () => {
    const base = counting()
    await checkpointedLlm(env.AQUILLA_PG, RUN, base.llm).llm(req())
    const other = counting("other")
    const otherRun = checkpointedLlm(env.AQUILLA_PG, { runId: "run-other", projectId: "proj-1845" }, other.llm)
    await otherRun.llm(req())
    expect(other.calls).toHaveLength(1)
    expect(otherRun.reused).toBe(0)
  })

  it("discards a completed wave's checkpoints so a later wave cannot read them", async () => {
    const base = counting()
    await checkpointedLlm(env.AQUILLA_PG, RUN, base.llm).llm(req())
    await discardCheckpoints(env.AQUILLA_PG, RUN.runId)

    const later = counting("later")
    const attempt = checkpointedLlm(env.AQUILLA_PG, RUN, later.llm)
    expect(await attempt.llm(req())).toBe("later-1")
    expect(attempt.reused).toBe(0)
  })

  it("calls the provider rather than failing the run when the table is unreachable", async () => {
    const broken = {
      prepare: () => {
        throw new Error("relation \"contextual_run_steps\" does not exist")
      },
    } as unknown as typeof env.AQUILLA_PG
    const base = counting()
    const attempt = checkpointedLlm(broken, RUN, base.llm)
    expect(await attempt.llm(req())).toBe("reply-1")
    expect(base.calls).toHaveLength(1)
    // And the cleanup path is equally non-fatal.
    await expect(discardCheckpoints(broken, RUN.runId)).resolves.toBeUndefined()
  })

  it("propagates a provider failure instead of checkpointing it", async () => {
    const failing: LlmCall = async () => {
      throw new Error("provider_http_error status=429")
    }
    const attempt = checkpointedLlm(env.AQUILLA_PG, RUN, failing)
    await expect(attempt.llm(req())).rejects.toThrow("provider_http_error")

    // Nothing was stored, so the retry is a real call.
    const base = counting()
    const retry = checkpointedLlm(env.AQUILLA_PG, RUN, base.llm)
    expect(await retry.llm(req())).toBe("reply-1")
  })

  it("sweeps abandoned checkpoints and leaves fresh ones alone", async () => {
    const base = counting()
    await checkpointedLlm(env.AQUILLA_PG, RUN, base.llm).llm(req())
    const stepKey = contextualStepKey({
      spanId: "span-a",
      label: "draft",
      tier: "mid",
      promptHash: contextualPromptHash({
        system: "you translate",
        user: "John 1:1",
        maxTokens: 512,
        temperature: 0.2,
      }),
      occurrence: 0,
    })
    await env.AQUILLA_PG
      .prepare("INSERT INTO contextual_run_steps (run_id, project_id, step_key, output, created_at) VALUES (?, ?, ?, ?, now() - make_interval(hours => 48))")
      .bind("run-abandoned", "proj-1845", stepKey, "stale")
      .run()

    await sweepContextualRunSteps(env.AQUILLA_PG)

    const remaining = await env.AQUILLA_PG
      .prepare("SELECT run_id FROM contextual_run_steps ORDER BY run_id")
      .all<{ run_id: string }>()
    expect((remaining.results ?? []).map((row) => row.run_id)).toEqual([RUN.runId])
  })
})

// The policies and grants live in the migration, not in schema.sql — the same
// split every other contextual table uses (0074). Asserting them against a
// live database needs the 0074 RLS migration loaded, which rls-backstop's own
// harness does; this is the cheap guard that the migration was written at all,
// because without the GRANT the runtime role silently cannot use the table and
// the decorator above degrades to calling the provider every time — a feature
// that quietly does nothing rather than a visible failure.
describe("contextual_run_steps migration 0158", () => {
  const sql = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../db/postgres/migrations/0158_contextual_run_steps.sql",
    ),
    "utf8",
  )

  it("scopes the table like its sibling contextual tables", () => {
    expect(sql).toContain("ALTER TABLE contextual_run_steps ENABLE ROW LEVEL SECURITY")
    expect(sql).toContain("ALTER TABLE contextual_run_steps FORCE ROW LEVEL SECURITY")
    for (const cmd of ["SELECT", "INSERT", "DELETE"]) {
      expect(sql).toContain(`FOR ${cmd} TO app_runtime`)
    }
    expect(sql).toContain("app_contextual_project_scope(project_id)")
  })

  it("grants the runtime role exactly what it uses, and no UPDATE", () => {
    // A checkpoint is written once and then only read or dropped.
    expect(sql).toContain("GRANT SELECT, INSERT, DELETE ON TABLE contextual_run_steps TO app_runtime;")
    expect(sql).not.toContain("FOR UPDATE")
  })

  it("matches the table that schema.sql will create", () => {
    const schema = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../db/postgres/schema.sql",
      ),
      "utf8",
    )
    // The live schema is the authority the test harness loads; a column that
    // exists in only one of the two is a deploy that half-works.
    for (const column of ["run_id", "project_id", "step_key", "output", "created_at"]) {
      expect(schema).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS contextual_run_steps[^;]*\\b${column}\\b`, "s"))
    }
  })
})
