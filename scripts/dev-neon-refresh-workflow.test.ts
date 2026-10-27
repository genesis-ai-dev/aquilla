// AQU-2115 — the nightly dev refresh's WIRING. The copy step's own decisions
// are unit-tested in dev-audio-copy-all.test.ts; what is left is YAML, and YAML
// is the part that rots silently.
//
// The failure to guard against is specific and bad: the audio copy runs in the
// same job as the restore of the dev database. If a copy failure could ever
// reach back and undo the restore, or if the restore were reordered after it,
// a bad R2 key would cost dev its whole database for a day. So the ORDER, the
// isolation, and the two dispatch gates are pinned here. Shape assertions
// cannot prove the shell inside a `run:` block behaves — only a dispatch does
// that — but they do pin the wiring.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

interface WorkflowStep {
  name?: string
  id?: string
  if?: string
  env?: Record<string, string>
  run?: string
  "continue-on-error"?: boolean
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workflowPath = path.join(repoRoot, ".github/workflows/dev-neon-refresh.yml")
const workflow = parse(readFileSync(workflowPath, "utf8")) as {
  on: { workflow_dispatch: { inputs: Record<string, { type: string; default?: boolean }> } }
  jobs: { refresh: { "timeout-minutes"?: number; env: Record<string, string>; steps: WorkflowStep[] } }
}
const job = workflow.jobs.refresh
const steps = job.steps
const step = (id: string): WorkflowStep => {
  const found = steps.find((s) => s.id === id)
  if (!found) throw new Error(`no step with id "${id}" in dev-neon-refresh.yml`)
  return found
}
const indexOfStep = (id: string): number => steps.findIndex((s) => s.id === id)

describe("the copy never endangers the restore", () => {
  it("runs after the restore", () => {
    // The restore has already succeeded when the copy starts, so a copy
    // failure leaves dev showing last night's production data.
    expect(indexOfStep("restore")).toBeGreaterThan(-1)
    expect(indexOfStep("media_copy")).toBeGreaterThan(indexOfStep("restore"))
  })

  it("is the last step in the job, so nothing after it can undo the restore", () => {
    expect(indexOfStep("media_copy")).toBe(steps.length - 1)
  })

  it("does not hide its own failure", () => {
    // A copy that fails has to turn its step red — `continue-on-error` here
    // would make a silently broken backfill look like a healthy night.
    expect(step("media_copy")["continue-on-error"]).toBeUndefined()
  })

  it("never runs `if: always()`, which would copy on a dead restore", () => {
    expect(step("media_copy").if).not.toMatch(/always\(\)/)
  })
})

describe("dispatch gates", () => {
  it("offers media_copy_only, defaulting off", () => {
    const input = workflow.on.workflow_dispatch.inputs.media_copy_only
    expect(input?.type).toBe("boolean")
    expect(input?.default).toBe(false)
  })

  it("skips the restore on a media_copy_only dispatch, so last_reset_at is untouched", () => {
    expect(step("restore").if).toMatch(/inputs\.media_copy_only != true/)
  })

  it("still copies on a media_copy_only dispatch", () => {
    expect(step("media_copy").if).not.toMatch(/media_copy_only/)
  })

  it("copies nothing on a preflight_only dispatch", () => {
    expect(step("media_copy").if).toMatch(/inputs\.preflight_only != true/)
  })

  it("keeps both gated on the Eastern-hour gate, like every other step", () => {
    for (const id of ["restore", "media_copy"]) {
      expect(step(id).if).toMatch(/steps\.eastern_gate\.outputs\.should_run == 'true'/)
    }
  })
})

describe("the copy's credentials and bounds", () => {
  it("passes AQU-2113's dedicated copy key, not the general R2 token", () => {
    // R2_ACCESS_KEY_ID would be the migration key, which can write the PROD
    // bucket. This job must only ever be able to write the dev one.
    expect(job.env.R2_DEV_MEDIA_COPY_ACCESS_KEY_ID).toBe(
      "${{ secrets.R2_DEV_MEDIA_COPY_ACCESS_KEY_ID }}",
    )
    expect(job.env.R2_DEV_MEDIA_COPY_SECRET_ACCESS_KEY).toBe(
      "${{ secrets.R2_DEV_MEDIA_COPY_SECRET_ACCESS_KEY }}",
    )
    // R2_ACCOUNT_ID is not always provisioned, and it is not a secret: the
    // delta-sync workflow already carries the same fallback. Without it the
    // copy would skip on a missing account id even with AQU-2113's key set.
    expect(job.env.R2_ACCOUNT_ID).toMatch(/^\$\{\{ secrets\.R2_ACCOUNT_ID \|\| '[0-9a-f]{32}' \}\}$/)
    expect(Object.keys(job.env)).not.toContain("R2_ACCESS_KEY_ID")
  })

  it("warns and skips, rather than failing the refresh, when those secrets are absent", () => {
    // AQU-2113 has not landed yet. A missing key must cost the audio copy and
    // nothing else — and must ANNOUNCE itself on the run page, not in a step
    // log nobody opens (the AQU-1344 lesson).
    const run = step("media_copy").run ?? ""
    expect(run).toMatch(/if \[ -z "\$R2_ACCOUNT_ID" \]/)
    expect(run).toMatch(/::warning title=Dev audio copy skipped::/)
    expect(run).toMatch(/exit 0/)
  })

  it("passes the per-run budget and concurrency explicitly", () => {
    // A run with no budget would spend the whole job's wall clock and be killed
    // by Actions before it could report anything.
    expect(step("media_copy").run).toMatch(/--budget-minutes "\$DEV_AUDIO_COPY_BUDGET_MINUTES"/)
    expect(step("media_copy").run).toMatch(/--concurrency "\$DEV_AUDIO_COPY_CONCURRENCY"/)
    expect(Number(job.env.DEV_AUDIO_COPY_BUDGET_MINUTES)).toBeGreaterThan(0)
    expect(Number(job.env.DEV_AUDIO_COPY_CONCURRENCY)).toBeGreaterThan(0)
  })

  it("gives the job more wall clock than it gives the copy", () => {
    // Otherwise Actions kills the step mid-copy and the run page says nothing.
    expect(job["timeout-minutes"]).toBeGreaterThan(Number(job.env.DEV_AUDIO_COPY_BUDGET_MINUTES))
  })

  it("runs the copy through neon-target, so the branch it reads is recorded", () => {
    // Bare, the script cannot tell which branch it is pointed at; AQU-2114's
    // guard reads AQUILLA_NEON_TARGET, which only neon-target sets.
    expect(step("media_copy").run).toMatch(/pnpm neon:copy-dev-audio-all:dev/)
  })
})
