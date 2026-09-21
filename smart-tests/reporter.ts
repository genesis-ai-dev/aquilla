import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Persist only our allowlisted JSON evidence, including successful runs. */
export default class SmartReporter implements Reporter {
  private planned: string[] = []
  private build = ""
  private dirty = true
  private started = Date.now()
  private readonly results: {
    title: string; status: string; durationMs: number; evidence: Record<string, unknown>;
  }[] = []
  private readonly directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    "results", (process.env.SMART_TEST_RUN_ID ?? new Date().toISOString()).replace(/[^\w-]/g, "-"))

  onBegin(_config: FullConfig, suite: Suite) {
    this.planned = suite.allTests().map((test) => test.title)
    this.started = Date.now()
    if (process.env.SMART_TEST_COLLECT_ONLY === "1") {
      console.log(`SMART_PLAN=${JSON.stringify(this.planned)}`)
      return
    }
    this.build = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    this.dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
    this.save("running")
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const evidence: Record<string, unknown> = {}
    for (const attachment of result.attachments) {
      if (!["smart-testing-evidence", "oracle-qualification", "dom-audit"].includes(attachment.name)) continue
      const body = attachment.body ?? (attachment.path ? readFileSync(attachment.path) : undefined)
      if (body) evidence[attachment.name] = JSON.parse(body.toString())
    }
    this.results.push({ title: test.title, status: result.status, durationMs: result.duration, evidence })
    this.save("running")
  }

  onEnd(result: FullResult) {
    if (process.env.SMART_TEST_COLLECT_ONLY === "1") return
    this.save(result.status)
    console.log(`Smart-testing evidence: ${path.join(this.directory, "suite.json")}`)
  }

  private save(status: string) {
    mkdirSync(this.directory, { recursive: true })
    writeFileSync(path.join(this.directory, "suite.json"), JSON.stringify({
      schemaVersion: 2, build: this.build, dirty: this.dirty,
      planned: this.planned, status, tests: this.results,
      testWallMs: Date.now() - this.started,
    }, null, 2))
    const rows = this.results.map((result) => `| ${result.title} | ${result.status} | ${(result.durationMs / 1000).toFixed(1)} s |`)
    writeFileSync(path.join(this.directory, "summary.md"), [
      `Smart testing: ${status}`, "", "| Journey | Result | Duration |", "| --- | --- | --- |", ...rows,
      "", "See suite.json for independent outcome checks, actions, conditions, and DOM coverage.",
      "An inconclusive journey is never a release pass. Qualification checks are not Jev reliability measurements.", "",
    ].join("\n"))
  }
}
