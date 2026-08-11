// The cost meter ships dark. These tests guard that property, because the
// meter runs `CREATE TABLE IF NOT EXISTS` and writes rows on every autopilot
// wave and agent run — a regression that flips the default on would create a
// table and start writing in every deployed environment.

import { describe, it, expect, vi } from "vitest"
import { CostMeter, makeCostMeter, type CostRow } from "./cost-meter"
import type { AquillaDb } from "../../../db/shim/postgres"

/** Records every statement so a test can assert the DB was never touched. */
function spyDb() {
  const statements: string[] = []
  const run = vi.fn(async () => ({}))
  const db = {
    prepare: vi.fn((sql: string) => {
      statements.push(sql)
      return { bind: () => ({ run }), run }
    }),
  } as unknown as AquillaDb
  return { db, statements, run }
}

const row = (over: Partial<CostRow> = {}): CostRow => ({
  surface: "autopilot",
  runId: "run_1",
  projectId: "proj_1",
  kind: "llm",
  label: "draft",
  promptTokens: 100,
  completionTokens: 50,
  ...over,
})

describe("makeCostMeter gating", () => {
  it("is disabled when COST_METER is unset — no DDL, no writes", async () => {
    const { db, statements } = spyDb()
    const meter = makeCostMeter({}, db)
    for (let i = 0; i < 200; i++) meter.add(row())
    await meter.flush()
    expect(statements).toEqual([])
  })

  it("stays disabled for any value other than \"1\"", async () => {
    for (const value of ["0", "true", "yes", ""]) {
      const { db, statements } = spyDb()
      const meter = makeCostMeter({ COST_METER: value }, db)
      meter.add(row())
      await meter.flush()
      expect(statements, `COST_METER=${JSON.stringify(value)}`).toEqual([])
    }
  })

  it("writes once enabled", async () => {
    const { db, statements } = spyDb()
    const meter = makeCostMeter({ COST_METER: "1" }, db)
    meter.add(row())
    await meter.flush()
    expect(statements.some((s) => s.includes("CREATE TABLE IF NOT EXISTS agent_cost_meter"))).toBe(true)
    expect(statements.some((s) => s.includes("INSERT INTO agent_cost_meter"))).toBe(true)
  })
})

describe("CostMeter buffering", () => {
  it("batches rows into a single INSERT rather than one per call", async () => {
    const { db, statements } = spyDb()
    const meter = new CostMeter(db, { enabled: true })
    for (let i = 0; i < 10; i++) meter.add(row())
    await meter.flush()
    const inserts = statements.filter((s) => s.includes("INSERT INTO agent_cost_meter"))
    expect(inserts).toHaveLength(1)
  })

  it("never throws when the write fails — the meter must not break the run it measures", async () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error("relation does not exist")
      }),
    } as unknown as AquillaDb
    const meter = new CostMeter(db, { enabled: true })
    meter.add(row())
    await expect(meter.flush()).resolves.toBeUndefined()
  })

  it("drops the buffer on flush so a second flush cannot double-count", async () => {
    const { db, statements } = spyDb()
    const meter = new CostMeter(db, { enabled: true })
    meter.add(row())
    await meter.flush()
    await meter.flush()
    expect(statements.filter((s) => s.includes("INSERT INTO"))).toHaveLength(1)
  })
})
