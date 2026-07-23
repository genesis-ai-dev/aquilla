import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter"

const DEFAULT_HEARTBEAT_MS = 15_000

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`
}

function title(test: TestCase): string {
  const location = test.location
  const file = location.file.replace(`${process.cwd()}/`, "")
  return `${file}:${location.line} › ${test.titlePath().slice(1).join(" › ")}`
}

/**
 * A deliberately small companion to Playwright's normal line/GitHub reporter.
 * It makes a quiet, slow test distinguishable from a wedged test by printing
 * the active test and elapsed time at a fixed cadence. Playwright's per-test
 * and global timeouts remain the authoritative watchdogs.
 */
export default class ProgressReporter implements Reporter {
  private total = 0
  private completed = 0
  private active: { test: TestCase; startedAt: number } | null = null
  private heartbeat: NodeJS.Timeout | null = null

  onBegin(_config: FullConfig, suite: Suite): void {
    this.total = suite.allTests().length
    const heartbeatMs = positiveInteger(
      process.env.E2E_HEARTBEAT_MS,
      DEFAULT_HEARTBEAT_MS,
    )
    console.log(`[e2e-progress] 0/${this.total} complete · heartbeat every ${Math.round(heartbeatMs / 1_000)}s`)
    this.heartbeat = setInterval(() => {
      if (!this.active) {
        console.log(`[e2e-progress] ${this.completed}/${this.total} complete · runner active between tests`)
        return
      }
      console.log(
        `[e2e-progress] ${this.completed}/${this.total} complete · ` +
          `running ${elapsed(this.active.startedAt)} · ${title(this.active.test)}`,
      )
    }, heartbeatMs)
    this.heartbeat.unref()
  }

  onTestBegin(test: TestCase): void {
    this.active = { test, startedAt: Date.now() }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.completed += 1
    const duration = `${(result.duration / 1_000).toFixed(1)}s`
    if (result.status !== "passed" || result.duration >= DEFAULT_HEARTBEAT_MS) {
      console.log(
        `[e2e-progress] ${this.completed}/${this.total} complete · ` +
          `${result.status} in ${duration} · ${title(test)}`,
      )
    }
    this.active = null
  }

  onEnd(result: FullResult): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.active = null
    console.log(`[e2e-progress] finished ${this.completed}/${this.total} · ${result.status}`)
  }
}
