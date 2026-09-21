import { describe, expect, it } from "vitest"
import { mergeSuites, shardCount, shardLayout, type SuiteEvidence, balanceShards, recordDurations } from "./parallel"

const build = "a".repeat(40)
const suite = (title: string): SuiteEvidence => ({
  schemaVersion: 2, build, dirty: false, status: "passed", planned: [title],
  tests: [{ title, status: "passed", durationMs: 10, evidence: {} }], testWallMs: 15,
})
describe("isolated smart shards", () => {
  it("reserves distinct stack slots outside the existing smoke range", () => {
    expect(shardLayout(4)).toEqual([
      { shard: "1/4", stack: "9/12", suffix: "shard-1" },
      { shard: "2/4", stack: "10/12", suffix: "shard-2" },
      { shard: "3/4", stack: "11/12", suffix: "shard-3" },
      { shard: "4/4", stack: "12/12", suffix: "shard-4" },
    ])
  })
  it("defaults to serial and rejects invalid or excessive concurrency", () => {
    expect(shardCount()).toBe(1)
    expect(shardCount("6")).toBe(6)
    for (const value of ["0", "7", "2.5", "", "2workers"]) {
      expect(() => shardCount(value)).toThrow()
    }
  })
  const good = () => [
    { exitCode: 0, suite: suite("one") }, { exitCode: 0, suite: suite("two") },
  ]
  const merge = (shards: Parameters<typeof mergeSuites>[3]) =>
    mergeSuites(["one", "two"], build, false, shards, 40)
  it("merges complete evidence and retains wall time separately from work", () => {
    const result = merge(good())
    expect(result.status).toBe("passed")
    expect(result.tests.map((test) => test.title)).toEqual(["one", "two"])
    expect(result.parallel).toMatchObject({
      shards: 2, complete: true, wallMs: 40, cumulativeTestMs: 20, longestShardTestMs: 15,
    })
  })
  it("rejects missing, dirty, or wrong-build evidence", () => {
    for (const second of [null, { ...suite("two"), dirty: true },
      { ...suite("two"), build: "b".repeat(40) }]) {
      const result = merge([{ exitCode: 0, suite: suite("one") }, { exitCode: 0, suite: second }])
      expect(result.status).toBe("failed")
      expect(result.parallel.complete).toBe(false)
      expect(result.planned).toEqual(["one", "two"])
    }
  })
  it("cannot replace a missing test with a duplicate pass", () => {
    expect(merge([good()[0], good()[0]]).status).toBe("failed")
  })
  it("keeps process failures, partial results, and failed tests", () => {
    for (const mutate of [
      (s: ReturnType<typeof good>) => { s[1].exitCode = 1 },
      (s: ReturnType<typeof good>) => { s[1].suite.status = "interrupted" },
      (s: ReturnType<typeof good>) => { s[1].suite.tests = [] },
      (s: ReturnType<typeof good>) => { s[1].suite.tests[0].status = "failed" },
      (s: ReturnType<typeof good>) => { s[1].suite.planned = [] },
    ]) {
      const shards = good()
      mutate(shards)
      expect(merge(shards).status).toBe("failed")
    }
  })
  it("preserves requested repetitions without mistaking them for missing tests", () => {
    expect(mergeSuites(["one", "one"], build, false, [good()[0], good()[0]], 40).status).toBe("passed")
  })
  it("never passes an empty selection", () => {
    expect(mergeSuites([], build, false, [], 0).status).toBe("failed")
  })
})

describe("balanceShards", () => {
  const durations = { a: 18_000, b: 6_000, c: 6_000, d: 5_000, e: 2_000 }
  const planned = ["a", "b", "c", "d", "e"]

  it("keeps the wall time near the longest journey, not the serial total", () => {
    const shards = balanceShards(planned, 3, durations)
    const load = (titles: string[]) => titles.reduce((sum, t) => sum + durations[t as keyof typeof durations], 0)
    const serial = Object.values(durations).reduce((sum, value) => sum + value)
    expect(Math.max(...shards.map(load))).toBe(18_000)
    expect(serial).toBe(37_000)
  })

  it("assigns every planned test exactly once", () => {
    expect(balanceShards(planned, 3, durations).flat().sort()).toEqual([...planned].sort())
  })

  it("gives an unmeasured journey its own stack rather than loading one further", () => {
    // "new" has no record, so it is costed as the slowest known journey.
    const shards = balanceShards(["a", "new"], 2, durations)
    expect(shards.map((titles) => titles.length)).toEqual([1, 1])
  })

  it("never creates more shards than there are tests", () => {
    expect(balanceShards(["a"], 4, durations)).toEqual([["a"]])
  })

  it("is deterministic for equal durations", () => {
    expect(balanceShards(["b", "c"], 2, durations))
      .toEqual(balanceShards(["c", "b"], 2, durations))
  })

  it("works with no recorded durations at all", () => {
    expect(balanceShards(planned, 2, {}).flat().sort()).toEqual([...planned].sort())
  })
})

describe("recordDurations", () => {
  it("keeps earlier measurements and overwrites re-run ones", () => {
    expect(recordDurations({ a: 1, b: 2 },
      [{ title: "a", status: "passed", durationMs: 9 }])).toEqual({ a: 9, b: 2 })
  })

  it("records a failure's duration, because a failing journey still costs that time", () => {
    expect(recordDurations({}, [{ title: "a", status: "failed", durationMs: 7 }])).toEqual({ a: 7 })
  })

  it("ignores interrupted and skipped runs", () => {
    expect(recordDurations({ a: 5 }, [
      { title: "a", status: "interrupted", durationMs: 1 },
      { title: "b", status: "skipped", durationMs: 1 },
    ])).toEqual({ a: 5 })
  })
})
