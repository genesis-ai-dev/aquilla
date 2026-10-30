import { describe, expect, it } from "vitest"
import { decide, jevDecision } from "./release-deploy-check.mjs"

const MARKER = "<!-- aquilla-smart-tests -->"
const jev = (line: string) => `${MARKER}\n\n## Smart tests\n\n| Journey | Result |\n\n${line}\n\nA journey FAIL holds this HEAD.`

// The hourly deploy reads only these two signals. Reading them wrong in
// either direction is a production incident: too strict and the line
// stalls silently, too loose and a FAIL ships.
describe("jevDecision", () => {
  it("reads each of the four decision lines the comment renderer writes", () => {
    expect(jevDecision([jev("**FAIL — this release HEAD does not deploy.**")])).toBe("fail")
    expect(jevDecision([jev("**PASS — a person may deploy this release HEAD.**")])).toBe("pass")
    expect(jevDecision([jev("**INCONCLUSIVE — this does not hold the deploy.**")])).toBe("inconclusive")
    expect(jevDecision([jev("**HARNESS UNAVAILABLE does not hold this deploy.**")])).toBe("unavailable")
  })

  it("ignores comments without the marker, even ones quoting the decision text", () => {
    expect(jevDecision(["**PASS — a person may deploy this release HEAD.**", "release notes", 42])).toBeNull()
  })

  it("is null for a marker comment with no decision line yet", () => {
    expect(jevDecision([`${MARKER} queued`])).toBeNull()
  })

  it("lets the newest marker comment win", () => {
    expect(jevDecision([jev("**PASS — a person may deploy this release HEAD.**"), jev("**FAIL — this release HEAD does not deploy.**")])).toBe("fail")
  })
})

describe("decide", () => {
  it("deploys only on release-verify success plus a non-FAIL Jev result", () => {
    expect(decide({ verify: "success", jev: "pass" })).toEqual({ deploy: true, reason: "release-verify success, Jev pass" })
    expect(decide({ verify: "success", jev: "inconclusive" }).deploy).toBe(true)
    expect(decide({ verify: "success", jev: "unavailable" }).deploy).toBe(true)
  })

  it("waits while Jev has not reported, rather than deploying past it", () => {
    expect(decide({ verify: "success", jev: null })).toEqual({ deploy: false, reason: "Jev has not reported on this HEAD yet" })
  })

  it("holds on a Jev FAIL and on anything but a verify success", () => {
    expect(decide({ verify: "success", jev: "fail" }).deploy).toBe(false)
    expect(decide({ verify: "failure", jev: "pass" })).toEqual({ deploy: false, reason: "release-verify is failure" })
    expect(decide({ verify: "in_progress", jev: "pass" }).deploy).toBe(false)
    expect(decide({ verify: undefined, jev: "pass" })).toEqual({ deploy: false, reason: "release-verify is missing" })
  })
})
