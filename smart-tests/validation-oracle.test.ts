import { describe, expect, it } from "vitest"
import {
  translationsUntouched, validationLanded, validationLogClean,
  type ValidationContract,
} from "./validation-oracle"
import type { ProjectedCellRow, SeededFileEvent } from "../e2e/helpers/seed-project"

const source = (cellId: string): ProjectedCellRow => ({
  cellId, side: "source", value: `source ${cellId}`, eventId: `s-${cellId}`,
  validated: false, aiDrafted: false,
})
const target = (cellId: string, validated = false): ProjectedCellRow => ({
  cellId, side: "target", value: `target ${cellId}`, eventId: `t-${cellId}`,
  validated, aiDrafted: false,
})
const baseline = [source("c1"), target("c1"), source("c2"), target("c2")]
const contract: ValidationContract = { cellId: "c1", author: "alice", baseline }
const signOff = (overrides: Partial<SeededFileEvent> = {}): SeededFileEvent => ({
  id: "v1", kind: "cell.validate", author: "alice", payload: {}, ...overrides,
})
const commit: SeededFileEvent = {
  id: "t1", kind: "target.cell.commit", author: "alice", payload: {},
}

describe("validationLanded", () => {
  it("accepts the intended target carrying the only sign-off", () => {
    expect(validationLanded(contract,
      [source("c1"), target("c1", true), source("c2"), target("c2")])).toBe(true)
  })

  it("rejects a missing sign-off", () => {
    expect(validationLanded(contract, baseline)).toBe(false)
  })

  it("rejects a sign-off on the wrong cell", () => {
    expect(validationLanded(contract,
      [source("c1"), target("c1"), source("c2"), target("c2", true)])).toBe(false)
  })

  it("rejects signing off every cell at once", () => {
    expect(validationLanded(contract,
      [target("c1", true), target("c2", true)])).toBe(false)
  })
})

describe("validationLogClean", () => {
  it("accepts one validate by the reviewer among unrelated events", () => {
    expect(validationLogClean(contract, [commit, signOff()])).toBe(true)
  })

  it("rejects a duplicate sign-off", () => {
    expect(validationLogClean(contract, [signOff(), signOff({ id: "v2" })])).toBe(false)
  })

  it("rejects a validate that was withdrawn again", () => {
    // The projection can read `validated: false` here, but a run that
    // toggled twice never demonstrated the reviewer's intended outcome.
    expect(validationLogClean(contract,
      [signOff(), signOff({ id: "v2", kind: "cell.unvalidate" })])).toBe(false)
  })

  it("rejects a sign-off attributed to another author", () => {
    expect(validationLogClean(contract, [signOff({ author: "bob" })])).toBe(false)
  })

  it("rejects an absent sign-off", () => {
    expect(validationLogClean(contract, [commit])).toBe(false)
  })
})

describe("translationsUntouched", () => {
  it("ignores the intended cell's validation flag and row order", () => {
    expect(translationsUntouched(contract,
      [target("c2"), source("c2"), target("c1", true), source("c1")])).toBe(true)
  })

  it("rejects a rewritten translation", () => {
    expect(translationsUntouched(contract, baseline.map((row) =>
      row.cellId === "c2" && row.side === "target"
        ? { ...row, value: "rewritten" } : row))).toBe(false)
  })

  it("rejects a new chain head on the signed-off cell", () => {
    expect(translationsUntouched(contract, baseline.map((row) =>
      row.cellId === "c1" && row.side === "target"
        ? { ...row, validated: true, eventId: "t-new" } : row))).toBe(false)
  })

  it("rejects another cell becoming validated", () => {
    expect(translationsUntouched(contract, baseline.map((row) =>
      row.cellId === "c2" && row.side === "target"
        ? { ...row, validated: true } : row))).toBe(false)
  })

  it("rejects a lost row", () => {
    expect(translationsUntouched(contract, baseline.slice(1))).toBe(false)
  })
})
