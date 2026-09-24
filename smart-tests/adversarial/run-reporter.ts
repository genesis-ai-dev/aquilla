import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { LinearClient, rollupBody, ticketBody, ticketTitle, type Finding, type RunSummary } from "./linear"
import { archiveProject, readRunContext } from "./state"

/** The evidence fields the reporter reads; run.ts and canary.spec.ts write them. */
export interface Evidence {
  canary?: boolean
  attackId?: string
  mode?: string
  journey?: string
  tags?: string[]
  goal?: string
  secondGoal?: string | null
  mutator?: string | null
  fuzzSeed?: number | null
  fingerprint?: string | null
  outcome: { verdict: string; reason: string; checks: Record<string, boolean>; diffs?: string[]; unmet?: string[] }
  projects: { projectId: string; owner: string }[]
}

export interface Recorded { project: string; status: string; evidence: Evidence | null }

/**
 * Decide whether the run said anything about the build. The canary must
 * have run and passed, and at least one attack must have reached a verdict.
 */
export function harnessHealth(recorded: Recorded[], attacksPlanned: number): { available: boolean; reason: string } {
  const canary = recorded.filter((entry) => entry.project === "canary")
  if (canary.length === 0) return { available: false, reason: "The canary health check did not run." }
  const failed = canary.filter((entry) => entry.status !== "passed")
  if (failed.length) return { available: false, reason: `The canary health check failed (${failed.length} of ${canary.length}).` }
  const attacks = recorded.filter((entry) => entry.project === "attacks")
  if (attacksPlanned > 0 && attacks.length === 0) return { available: false, reason: "No attack ran after the canary." }
  if (attacks.length > 0 && attacks.every((entry) => entry.evidence?.outcome.verdict === "inconclusive" || !entry.evidence)) {
    return { available: false, reason: "Every attack ended inconclusive." }
  }
  return { available: true, reason: "" }
}

export function toFinding(evidence: Evidence, run: { runId: string; target: string; deployedSha: string | null }, evidencePath: string): Finding {
  return {
    fingerprint: evidence.fingerprint ?? "",
    attackId: evidence.attackId ?? "unknown", mode: evidence.mode ?? "", journey: evidence.journey ?? "",
    reason: evidence.outcome.reason,
    failedChecks: Object.entries(evidence.outcome.checks).filter(([, ok]) => !ok).map(([name]) => name),
    diffs: evidence.outcome.diffs ?? [], unmet: evidence.outcome.unmet ?? [],
    goal: evidence.goal ?? "", secondGoal: evidence.secondGoal ?? null,
    mutator: evidence.mutator ?? null, fuzzSeed: evidence.fuzzSeed ?? null,
    ...run, evidencePath, projectIds: evidence.projects.map((project) => project.projectId),
  }
}

/** Files each product failure as it happens, then posts a rollup and cleans up. */
export default class AdversarialRunReporter implements Reporter {
  private readonly recorded: Recorded[] = []
  private readonly pending: Promise<void>[] = []
  private readonly tickets: string[] = []
  private attacksPlanned = 0
  private readonly directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "results",
    (process.env.SMART_TEST_RUN_ID ?? "adversarial").replace(/[^\w-]/g, "-"))
  private readonly linear = process.env.LINEAR_API_KEY && process.env.ADVERSARIAL_NO_REPORT !== "1"
    ? new LinearClient(process.env.LINEAR_API_KEY) : null

  onBegin(_config: unknown, suite: { allTests(): TestCase[] }) {
    this.attacksPlanned = suite.allTests().filter((test) => test.parent.project()?.name === "attacks").length
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const project = test.parent.project()?.name ?? ""
    const attachment = result.attachments.find((entry) => entry.name === "smart-testing-evidence")
    const raw = attachment?.body ?? (attachment?.path ? readFileSync(attachment.path) : undefined)
    const evidence = raw ? JSON.parse(raw.toString()) as Evidence : null
    this.recorded.push({ project, status: result.status, evidence })
    // Attacks only run after the canary passed (a project dependency), so a
    // product failure here always comes from a qualified harness.
    if (project === "attacks" && evidence?.outcome.verdict === "product_failure" && evidence.fingerprint) {
      this.pending.push(this.file(evidence))
    }
  }

  private async file(evidence: Evidence): Promise<void> {
    const run = readRunContext()
    const finding = toFinding(evidence, { runId: run.runId, target: run.kind, deployedSha: run.deployedBuild?.sha ?? null },
      path.join(path.relative(process.cwd(), this.directory), "suite.json"))
    if (!this.linear) {
      console.log(`\n[adversarial] Would file:\n${ticketTitle(finding)}\n${ticketBody(finding)}\n`)
      return
    }
    try {
      this.tickets.push(await this.linear.fileFinding(finding))
    } catch (error) {
      // Evidence is on disk; print the ticket so the finding is not lost silently.
      process.exitCode = 1
      console.error(`[adversarial] Linear filing failed: ${(error as Error).message}\n${ticketTitle(finding)}\n${ticketBody(finding)}`)
    }
  }

  async onEnd() {
    await Promise.all(this.pending)
    let run: ReturnType<typeof readRunContext>
    try { run = readRunContext() } catch {
      console.error("[adversarial] HARNESS UNAVAILABLE: global setup did not complete (login or run org).")
      process.exitCode = 1
      return
    }
    const health = harnessHealth(this.recorded, this.attacksPlanned)
    const attacks = this.recorded.filter((entry) => entry.project === "attacks")
    const counts: Record<string, number> = {}
    for (const entry of attacks) {
      const verdict = entry.evidence?.outcome.verdict ?? "no evidence"
      counts[verdict] = (counts[verdict] ?? 0) + 1
    }
    const inconclusive = attacks.filter((entry) => entry.evidence?.outcome.verdict === "inconclusive")
    const summary: RunSummary = {
      runId: run.runId, target: run.kind, deployedSha: run.deployedBuild?.sha ?? null,
      harnessAvailable: health.available, harnessReason: health.reason, counts,
      inconclusive: inconclusive.map((entry) => ({ attackId: entry.evidence?.attackId ?? "?", reason: entry.evidence?.outcome.reason ?? "" })),
      navigability: inconclusive.filter((entry) => entry.evidence?.tags?.includes("navigability"))
        .map((entry) => entry.evidence?.attackId ?? "?"),
      tickets: this.tickets,
      evidencePath: path.relative(process.cwd(), this.directory),
    }
    mkdirSync(this.directory, { recursive: true })
    writeFileSync(path.join(this.directory, "adversarial.md"), rollupBody(summary) + "\n")
    console.log(`\n${rollupBody(summary)}\n`)
    if (!health.available) process.exitCode = 1
    if (this.linear && attacks.length > 0) {
      await this.linear.postRollup(summary).catch((error: Error) => {
        process.exitCode = 1
        console.error(`[adversarial] Linear rollup failed: ${error.message}`)
      })
    }
    await this.cleanup(run)
  }

  /** Archive fixtures unless something failed; a failing run keeps its evidence projects. */
  private async cleanup(run: ReturnType<typeof readRunContext>) {
    if (this.recorded.some((entry) => entry.evidence?.outcome.verdict === "product_failure" && entry.project === "attacks")) {
      console.log(`[adversarial] Kept fixture projects in org adv-${run.runId} for reproduction.`)
      return
    }
    const owners = new Map(run.sessions.map((session) => [session.username, session]))
    for (const entry of this.recorded) {
      for (const project of entry.evidence?.projects ?? []) {
        const owner = owners.get(project.owner)
        if (!owner) continue
        await archiveProject(owner, project.projectId).catch((error: Error) =>
          console.error(`[adversarial] Could not archive ${project.projectId}: ${error.message}`))
      }
    }
  }
}
