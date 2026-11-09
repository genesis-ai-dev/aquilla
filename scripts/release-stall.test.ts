import { describe, expect, it } from "vitest"
import { decideStall, failureExcerpt, isInfraFailure } from "./release-stall.mjs"

// The log that held the 2026-11-06 release for eleven hours: an install
// download timed out on one unit shard, and nothing retried it.
const ONNX_TIMEOUT = [
  "2026-11-06T05:15:17.2774520Z .../node_modules/onnxruntime-node postinstall: AggregateError [ETIMEDOUT]: ",
  "2026-11-06T05:15:17.2786992Z .../node_modules/onnxruntime-node postinstall:     Error: connect ETIMEDOUT 150.171.109.118:443",
  "2026-11-06T05:15:18.1821918Z  ELIFECYCLE  Command failed with exit code 1.",
  "2026-11-06T05:15:18.3218298Z ##[error]Process completed with exit code 1.",
].join("\n")

const TEST_FAILURE = [
  "2026-11-06T05:20:00.0000000Z  FAIL  src/lib/parsers/usfm.test.ts > splits by verse",
  "2026-11-06T05:20:00.0000000Z AssertionError: expected 3 to be 4",
  "2026-11-06T05:20:01.0000000Z ##[error]Process completed with exit code 1.",
].join("\n")

// Reruns are only for faults the slice did not cause. Rerunning a real test
// failure would just burn an hour per attempt and hide a regression behind
// "flake"; not rerunning a network timeout holds production for nothing.
describe("isInfraFailure", () => {
  it("reads an install download timeout as infra", () => {
    expect(isInfraFailure(ONNX_TIMEOUT)).toBe(true)
  })
  it("reads a failing assertion as code, even with the same exit-code footer", () => {
    expect(isInfraFailure(TEST_FAILURE)).toBe(false)
  })
})

describe("decideStall", () => {
  it("reruns once when every failed job is infra on the first attempt", () => {
    const d = decideStall({ jobs: [{ name: "unit (shard 2/3)", log: ONNX_TIMEOUT }], attempt: 1 })
    expect(d.action).toBe("rerun")
    expect(d.kind).toBe("infra")
  })
  it("never reruns a second time: a repeated infra fault needs a person", () => {
    const d = decideStall({ jobs: [{ name: "unit (shard 2/3)", log: ONNX_TIMEOUT }], attempt: 2 })
    expect(d.action).toBe("alert")
    expect(d.kind).toBe("infra")
  })
  it("alerts without a rerun when any failed job is a code failure", () => {
    const d = decideStall({ jobs: [{ name: "unit (shard 1/3)", log: ONNX_TIMEOUT }, { name: "unit (shard 2/3)", log: TEST_FAILURE }], attempt: 1 })
    expect(d.action).toBe("alert")
    expect(d.kind).toBe("code")
    expect(d.jobs?.map((j) => j.infra)).toEqual([true, false])
  })
  it("alerts when the verify check failed without a failing job to blame", () => {
    expect(decideStall({ jobs: [], attempt: 1 }).action).toBe("alert")
  })
})

describe("failureExcerpt", () => {
  it("quotes the infra line without its timestamp", () => {
    expect(failureExcerpt(ONNX_TIMEOUT)).toContain("ETIMEDOUT")
    expect(failureExcerpt(ONNX_TIMEOUT)).not.toMatch(/^2026-/)
  })
  it("falls back to the ::error:: line for a code failure", () => {
    expect(failureExcerpt(TEST_FAILURE)).toBe("Process completed with exit code 1.")
  })
})
