export interface SuiteEvidence {
  schemaVersion: number
  build: string
  dirty: boolean
  status: string
  planned: string[]
  tests: { title: string; status: string; durationMs: number; evidence: Record<string, unknown> }[]
  testWallMs?: number
}

export function shardCount(value = "1"): number {
  if (!/^[1-4]$/.test(value)) throw new Error("SMART_TEST_SHARDS must be 1, 2, 3, or 4")
  return Number(value)
}

export function shardLayout(count: number) {
  shardCount(String(count))
  return Array.from({ length: count }, (_, index) => ({
    shard: `${index + 1}/${count}`,
    // Existing smoke uses slots 1–8; serial smart testing uses slot 4.
    // Parallel smart stacks reserve 9–12, including DBs and inspector ports.
    stack: `${index + 9}/${count + 8}`,
    suffix: `shard-${index + 1}`,
  }))
}

const sorted = (titles: string[]) => JSON.stringify([...titles].sort())

/** A missing shard or a duplicate replacement must never make a suite green. */
export function mergeSuites(
  planned: string[], build: string, dirty: boolean,
  shards: { exitCode: number | null; suite: SuiteEvidence | null }[],
  wallMs: number,
) {
  const usable = shards.filter((shard) => shard.suite?.schemaVersion === 2
    && shard.suite.build === build && shard.suite.dirty === dirty
    && Array.isArray(shard.suite.planned) && Array.isArray(shard.suite.tests))
  const tests = usable.flatMap(({ suite }) => suite!.tests)
  const complete = planned.length > 0 && usable.length === shards.length
    && sorted(usable.flatMap(({ suite }) => suite!.planned)) === sorted(planned)
    && sorted(tests.map((test) => test.title)) === sorted(planned)
  const passed = complete && shards.every(({ exitCode, suite }) =>
    exitCode === 0 && suite?.status === "passed")
    && tests.every((test) => test.status === "passed")
  return {
    schemaVersion: 2, build, dirty, planned, tests,
    status: passed ? "passed" : "failed",
    parallel: {
      shards: shards.length, complete, wallMs,
      cumulativeTestMs: tests.reduce((sum, test) => sum + test.durationMs, 0),
      longestShardTestMs: Math.max(0, ...usable.map(({ suite }) => suite!.testWallMs ?? 0)),
      results: shards.map(({ exitCode, suite }, index) => ({
        shard: index + 1, exitCode, status: suite?.status ?? "missing",
      })),
    },
  }
}
