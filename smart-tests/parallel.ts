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
  // Six is the point where a balanced split of today's suite reaches its
  // longest journey; more stacks cannot finish it any sooner, and each one
  // costs a database, a build, and a browser. The default stays one.
  if (!/^[1-6]$/.test(value)) throw new Error("SMART_TEST_SHARDS must be 1 to 6")
  return Number(value)
}

export function shardLayout(count: number) {
  shardCount(String(count))
  return Array.from({ length: count }, (_, index) => ({
    shard: `${index + 1}/${count}`,
    // Existing smoke uses slots 1–8; serial smart testing uses slot 4.
    // Parallel smart stacks reserve 9–14, including DBs and inspector ports.
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

/**
 * Longest-processing-time assignment. Playwright's own `--shard` splits the
 * manifest into contiguous blocks with no idea what anything costs, so one
 * stack can hold every slow journey. Starting the longest journeys first and
 * backfilling short ones around them keeps the suite's wall time close to its
 * single longest journey instead of its serial total.
 *
 * A journey with no recorded duration is assumed to be the slowest known one.
 * A new journey therefore claims its own stack rather than being appended to
 * an already loaded one, and an under-estimate can only cost wall time — it
 * can never drop a test, because `mergeSuites` still checks the full manifest.
 */
export function balanceShards(
  planned: string[], count: number, durationsMs: Record<string, number>,
): string[][] {
  const known = Object.values(durationsMs).filter((value) => value > 0)
  const unknown = known.length ? Math.max(...known) : 1
  const shards = Array.from({ length: Math.max(1, Math.min(count, planned.length)) },
    () => ({ titles: [] as string[], load: 0 }))
  const ordered = [...planned].sort((left, right) =>
    (durationsMs[right] ?? unknown) - (durationsMs[left] ?? unknown)
    || left.localeCompare(right))
  for (const title of ordered) {
    const lightest = shards.reduce((best, shard) => shard.load < best.load ? shard : best)
    lightest.titles.push(title)
    lightest.load += durationsMs[title] ?? unknown
  }
  return shards.map((shard) => shard.titles)
}

/** Record what each journey actually cost, so the next split is better. */
export function recordDurations(
  previous: Record<string, number>,
  tests: { title: string; status: string; durationMs: number }[],
): Record<string, number> {
  const next = { ...previous }
  for (const test of tests) {
    // An interrupted or crashed test's duration says nothing about its cost.
    if (test.status === "passed" || test.status === "failed") next[test.title] = test.durationMs
  }
  return Object.fromEntries(Object.entries(next).sort(([left], [right]) => left.localeCompare(right)))
}

/**
 * Build the `--grep` that selects one stack's assigned journeys.
 *
 * Playwright greps the whole title path, which carries a file prefix, so the
 * pattern can only be anchored at its end. That makes selection ambiguous if
 * one planned title ends with another: the shorter pattern would silently
 * pull in the longer test. Refuse that manifest rather than run a split whose
 * contents cannot be predicted.
 */
export function selectionPattern(assigned: string[], planned: string[]): string {
  if (assigned.length === 0) throw new Error("A stack must be assigned at least one journey")
  for (const title of assigned) {
    const shadowed = planned.find((other) => other !== title && other.endsWith(title))
    if (shadowed) {
      throw new Error(`Journey title "${title}" is a suffix of "${shadowed}"; rename one`)
    }
  }
  return `(?:${assigned.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`
}
