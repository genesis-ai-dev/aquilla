import { describe, expect, it } from "vitest"
import { buildIdentity } from "./build"

describe("external app identity", () => {
  it("keeps the tested app distinct from the reviewed harness", () => {
    const identity = buildIdentity({ SMART_TEST_APP_SHA: "a".repeat(40), SMART_TEST_HARNESS_SHA: "b".repeat(40) })
    expect(identity).toEqual({ build: "a".repeat(40), harnessBuild: "b".repeat(40), dirty: false, trackedDiffHash: null })
  })
  it("refuses partial and malformed external attestations", () => {
    for (const env of [
      { SMART_TEST_APP_SHA: "a".repeat(40) },
      { SMART_TEST_HARNESS_SHA: "b".repeat(40) },
      { SMART_TEST_APP_SHA: "main", SMART_TEST_HARNESS_SHA: "b".repeat(40) },
    ]) expect(() => buildIdentity(env)).toThrow("External testing requires exact app and harness commits")
  })
})
