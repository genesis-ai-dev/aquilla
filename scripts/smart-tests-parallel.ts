import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  balanceShards, mergeSuites, recordDurations, shardLayout, type SuiteEvidence,
} from "../smart-tests/parallel"
import { killChildTree } from "./lib/spawn-worker"

/** Playwright --grep is a JS regex; a journey title is literal text. */
function escapeForGrep(title: string): string {
  return title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export async function runParallel(root: string, count: number, args: string[]) {
  if (args.some((arg) => /^--(?:workers|shard|reporter|config)(?:=|$)|^-[jc]/.test(arg))) {
    throw new Error("Parallel smart testing owns workers, shards, config, and reporters")
  }
  const started = Date.now()
  const id = (process.env.SMART_TEST_RUN_ID ?? new Date().toISOString()).replace(/[^\w-]/g, "-")
  const directory = path.join(root, "smart-tests/results", id)
  if (existsSync(directory)) {
    throw new Error("Use a new SMART_TEST_RUN_ID; existing evidence must not be overwritten")
  }
  const build = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim())
  // Collect the entire selected suite before splitting it. An absent shard
  // cannot quietly reduce the expected coverage in the final PR report.
  const collection = execFileSync("pnpm", ["exec", "playwright", "test",
    "--config", "smart-tests/config.ts", ...args, "--list", "--reporter=./smart-tests/reporter.ts"], {
    cwd: root, encoding: "utf8", env: { ...process.env, SMART_TEST_COLLECT_ONLY: "1" },
  })
  const line = collection.split("\n").find((line) => line.startsWith("SMART_PLAN="))
  if (!line) throw new Error("Smart test collection produced no manifest")
  const planned: string[] = JSON.parse(line.slice("SMART_PLAN=".length))
  if (!Array.isArray(planned) || !planned.length || planned.some((title) => typeof title !== "string")) {
    throw new Error("Smart test manifest is empty or invalid")
  }
  // Split by measured cost, not by Playwright's duration-blind contiguous
  // --shard. The aim is a suite that finishes with its longest journey.
  const durationsPath = path.join(root, "smart-tests/durations.json")
  let durations: Record<string, number> = {}
  try {
    durations = JSON.parse(readFileSync(durationsPath, "utf8")) as Record<string, number>
  } catch { /* No baseline yet: every journey is costed as the slowest. */ }
  const assignments = balanceShards(planned, count, durations)
  // The caller's own --grep already narrowed the collected manifest. Drop it
  // from the child argv so the last --grep is this stack's assignment.
  const passthrough = args.filter((arg, index) =>
    !/^--grep(?:-invert)?(?:=|$)/.test(arg)
    && !/^--grep(?:-invert)?$/.test(args[index - 1] ?? ""))
  const layouts = shardLayout(assignments.length)
  if (layouts.some((layout) => existsSync(`${directory}-${layout.suffix}`))) {
    throw new Error("Use a new SMART_TEST_RUN_ID; shard evidence already exists")
  }
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, "suite.json"), JSON.stringify({
    schemaVersion: 2, build, dirty, status: "running", planned, tests: [],
  }, null, 2))
  const children: ChildProcess[] = []
  let interrupted = false
  const stop = () => { interrupted = true; void Promise.all(children.map(killChildTree)) }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    const results = await Promise.all(layouts.map(async (layout, index) => {
      const childId = `${id}-${layout.suffix}`
      // Select this stack's assigned titles explicitly. --shard would
      // re-split the manifest and undo the balancing.
      const selection = `^(?:${assignments[index].map(escapeForGrep).join("|")})$`
      const child = spawn("pnpm", ["exec", "tsx", "scripts/e2e-up.ts", "--",
        "--shard=1/1", "--workers=1", ...passthrough, "--grep", selection], {
        cwd: root, stdio: "inherit", env: {
          ...process.env, E2E_SHARD: layout.stack, E2E_CONFIG: "smart-tests/config.ts",
          SMART_TEST_RUN_ID: childId,
        },
      })
      children.push(child)
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("error", () => resolve(null))
        child.once("exit", resolve)
      })
      let suite: SuiteEvidence | null = null
      try {
        suite = JSON.parse(readFileSync(path.join(root, "smart-tests/results", childId, "suite.json"), "utf8"))
      } catch { /* Missing or malformed evidence fails the aggregate. */ }
      return { exitCode, suite }
    }))
    const suite = mergeSuites(planned, build, dirty, results, Date.now() - started)
    if (interrupted) suite.status = "interrupted"
    writeFileSync(path.join(directory, "suite.json"), JSON.stringify(suite, null, 2))
    writeFileSync(path.join(directory, "summary.md"), [
      `Smart testing: ${suite.status}`, "",
      `${layouts.length} isolated stacks; ${(suite.parallel.wallMs / 1000).toFixed(1)} seconds including setup.`,
      `${(suite.parallel.longestShardTestMs / 1000).toFixed(1)} seconds for the slowest test shard.`,
      "", ...suite.tests.map((test) => `- ${test.title}: ${test.status}`), "",
    ].join("\n"))
    // Feed the next split. Only a complete run can retrain the baseline.
    if (suite.parallel.complete) {
      writeFileSync(durationsPath,
        JSON.stringify(recordDurations(durations, suite.tests), null, 2) + "\n")
    }
    console.log(`Smart-testing evidence: ${path.join(directory, "suite.json")}`)
    console.log(JSON.stringify(suite.parallel))
    return suite.status === "passed" ? 0 : 1
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }
}
