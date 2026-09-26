import { describe, expect, it } from "vitest"
import { assertOwnedStack, verifyEdit } from "./outcome"
import type { ProjectedCellRow } from "../e2e/helpers/seed-project"

const source: ProjectedCellRow = {
  cellId: "first", side: "source", value: "source", eventId: "s1",
  validated: false, aiDrafted: false,
}
const untouched = { ...source, cellId: "second", eventId: "s2" }
const target: ProjectedCellRow = {
  ...source, side: "target", value: "correction", eventId: "t1",
}
const contract = { cellId: "first", expected: "correction", baseline: [source, untouched] }
const correct = [source, untouched, target]

describe("independent edit outcome", () => {
  it("requires storage, a fresh session and an observed edit to agree", () => {
    expect(verifyEdit(contract, correct, "correction", true).verdict).toBe("passed")
    expect(verifyEdit(contract, correct, "stale", true).verdict).toBe("product_failure")
    expect(verifyEdit(contract, [source, untouched], "correction", true).verdict).toBe("product_failure")
    expect(verifyEdit(contract, correct, "correction", false).verdict).toBe("inconclusive")
  })

  it("rejects an edit in the wrong cell even when its value is correct", () => {
    const wrong = [source, untouched, { ...target, cellId: "second" }]
    expect(verifyEdit(contract, wrong, "correction", true).verdict).toBe("product_failure")
  })

  it("rejects collateral edits, source deletion, and duplicate target rows", () => {
    for (const rows of [
      [source, { ...untouched, value: "changed" }, target],
      [untouched, target],
      [...correct, target],
    ]) expect(verifyEdit(contract, rows, "correction", true).verdict).toBe("product_failure")
  })

  it("ignores response order but protects event heads even when text is unchanged", () => {
    expect(verifyEdit(contract, [...correct].reverse(), "correction", true).verdict).toBe("passed")
    expect(verifyEdit(contract, [source, { ...untouched, eventId: "new" }, target],
      "correction", true).verdict).toBe("product_failure")
  })
})

describe("reset ownership", () => {
  const env = {
    E2E_DATABASE_URL: "postgresql://aquilla:aquilla@localhost:5432/aquilla_e2e_s3",
    E2E_BASE_URL: "http://127.0.0.1:6473",
    VITE_FRONTIER_BASE: "http://127.0.0.1:10087",
    VITE_SYNC_WORKER_HOST: "127.0.0.1:10088",
  }
  it("accepts the explicit local E2E stack", () => {
    expect(() => assertOwnedStack(env)).not.toThrow()
  })
  it("refuses a developer database, remote host, preview or missing ownership", () => {
    for (const override of [
      { E2E_DATABASE_URL: "postgresql://localhost:5432/aquilla_dev" },
      { E2E_DATABASE_URL: "postgresql://production.example/aquilla_e2e" },
      { E2E_BASE_URL: "https://dev.aquilla.app" },
      { VITE_FRONTIER_BASE: "https://api.aquilla.app" },
      { VITE_SYNC_WORKER_HOST: "api.dev.aquilla.app" },
      { E2E_DATABASE_URL: undefined },
    ]) expect(() => assertOwnedStack({ ...env, ...override })).toThrow()
  })
})
