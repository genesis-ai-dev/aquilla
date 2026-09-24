// The nightly delta sync's REPORT is the only thing anyone reads, so the
// report is what has to be tested. (AQU-1347)
//
// The failure this guards against is not a bug in a function — it is a wiring
// gap in YAML. The workflow ran the users pass, the users pass died, and the
// report summarised the audio pass only, so the message said "✅ ok" for sixty
// consecutive nights while Codex accounts silently stopped arriving
// (AQU-1344). Nothing in the repo could have caught that, because nothing
// asserted that the users step's outcome reaches the headline.
//
// These are shape assertions over the workflow file. They cannot prove the
// shell inside a `run:` block behaves — only a dispatch does that — but they
// do pin the wiring, which is the part that silently rots.

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
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workflowPath = path.join(repoRoot, ".github/workflows/audio-delta-sync.yml")
const source = readFileSync(workflowPath, "utf8")
const workflow = parse(source) as {
  jobs: { sync: { steps: WorkflowStep[] } }
}
const steps = workflow.jobs.sync.steps
const step = (id: string): WorkflowStep => {
  const found = steps.find((s) => s.id === id)
  if (!found) throw new Error(`no step with id "${id}" in audio-delta-sync.yml`)
  return found
}

describe("delta sync — users pass", () => {
  it("applies on the scheduled run, while the script itself stays dry-run by default", () => {
    expect(step("users").run).toMatch(/migrate-users\.ts --apply/)
  })

  it("keeps both credential paths in the environment so the fall-through has something to fall to", () => {
    const env = step("users").env ?? {}
    expect(Object.keys(env)).toEqual(
      expect.arrayContaining([
        "FRONTIER_TOKEN",
        "GITLAB_URL",
        "FRONTIER_USERNAME",
        "FRONTIER_PASSWORD",
      ]),
    )
  })
})

describe("delta sync — report", () => {
  const report = step("report")

  it("reads the users step's outcome", () => {
    expect(report.env?.USERS_OUTCOME).toBe("${{ steps.users.outcome }}")
  })

  it("runs even when the users step failed", () => {
    expect(report.if).toBe("always()")
  })

  it("parses the users summary as JSON rather than echoing the log's last line", () => {
    expect(report.run).toMatch(/jq/)
    expect(report.run).not.toMatch(/u_summary=\$\(tail -1/)
  })

  it("reports all six user outcome counts", () => {
    for (const label of [
      "imported",
      "already present",
      "conflicts",
      "unsupported hash",
      "unresolved access",
      "failed",
    ]) {
      expect(report.run).toContain(label)
    }
  })

  it("never says ok when the users step did not succeed", () => {
    // The headline is built from `problems`, which a non-success users
    // outcome must contribute to — this is the AQU-1344 regression itself.
    expect(report.run).toMatch(/u_outcome" != "success".*problems="users failed"/s)
  })

  // Actions runs `run:` blocks under `bash -e`. `grep -c` prints 0 and exits
  // 1 when nothing matches, so an unguarded `x=$(grep -c …)` aborts the whole
  // step on a quiet night — before any output is written, and without printing
  // anything to say so. The Discord post then interpolates empty strings.
  it("guards every bare grep -c against bash -e", () => {
    const unguarded = (report.run ?? "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .filter((line) => /=\$\(grep -c/.test(line))
      .filter((line) => !line.includes("|| true"))
    expect(unguarded).toEqual([])
  })

  it("exports the users outcome and counts for the Discord step", () => {
    expect(report.run).toMatch(/echo "u_outcome=/)
    expect(report.run).toMatch(/echo "u_counts=/)
  })
})

describe("delta sync — Discord report", () => {
  const discord = steps.find((s) => s.name === "Post to Discord")!

  it("carries the users outcome and counts into the message", () => {
    expect(discord.env?.R_UOUTCOME).toBe("${{ steps.report.outputs.u_outcome }}")
    expect(discord.env?.R_UCOUNTS).toBe("${{ steps.report.outputs.u_counts }}")
    expect(discord.run).toMatch(/Users \(%s\): %s/)
  })

  it("links the run", () => {
    expect(discord.env?.RUN_URL).toContain("actions/runs/${{ github.run_id }}")
    expect(discord.run).toMatch(/RUN_URL/)
  })

  it("annotates the run when the webhook secret is missing, instead of quietly skipping", () => {
    expect(discord.run).toMatch(
      /if \[ -z "\$WEBHOOK" \][\s\S]*::warning title=Delta sync report not posted::[\s\S]*DISCORD_WEBHOOK_URL/,
    )
    expect(discord.run).not.toMatch(/no DISCORD_WEBHOOK_URL secret — skipping/)
  })

  it("annotates rather than silently swallowing a failed webhook call", () => {
    expect(discord.run).toMatch(/curl[\s\S]*\|\| echo "::warning/)
  })
})
