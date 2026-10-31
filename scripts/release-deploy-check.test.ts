import { describe, expect, it } from "vitest"
import { decide, jevDecision, jevTrustedLogins } from "./release-deploy-check.mjs"

const MARKER = "<!-- aquilla-smart-tests -->"
const TRUSTED = "jev-reporter"
const jevBody = (line: string) => `${MARKER}\n\n## Smart tests\n\n| Journey | Result |\n\n${line}\n\nA journey FAIL holds this HEAD.`
// A marker comment from the trusted reporting identity, the normal case.
const jev = (line: string, login = TRUSTED) => ({ body: jevBody(line), login })
const decideWith = (comments: Array<{ body?: unknown; login?: string }>) => jevDecision(comments, [TRUSTED])

// The hourly deploy reads only these two signals. Reading them wrong in
// either direction is a production incident: too strict and the line
// stalls silently, too loose and a FAIL ships.
describe("jevDecision", () => {
  it("reads each of the four decision lines the comment renderer writes", () => {
    expect(decideWith([jev("**FAIL — this release HEAD does not deploy.**")])).toBe("fail")
    expect(decideWith([jev("**PASS — a person may deploy this release HEAD.**")])).toBe("pass")
    expect(decideWith([jev("**INCONCLUSIVE — this does not hold the deploy.**")])).toBe("inconclusive")
    expect(decideWith([jev("**HARNESS UNAVAILABLE does not hold this deploy.**")])).toBe("unavailable")
  })

  it("ignores comments without the marker, even ones quoting the decision text", () => {
    expect(decideWith([{ body: "**PASS — a person may deploy this release HEAD.**", login: TRUSTED }, { body: "release notes", login: TRUSTED }, { body: 42 }])).toBeNull()
  })

  it("is null for a marker comment with no decision line yet", () => {
    expect(decideWith([{ body: `${MARKER} queued`, login: TRUSTED }])).toBeNull()
  })

  it("lets the newest marker comment win, except that a FAIL holds whatever follows it", () => {
    expect(decideWith([jev("**PASS — a person may deploy this release HEAD.**"), jev("**FAIL — this release HEAD does not deploy.**")])).toBe("fail")
    expect(decideWith([jev("**FAIL — this release HEAD does not deploy.**"), jev("**PASS — a person may deploy this release HEAD.**")])).toBe("fail")
    expect(decideWith([jev("**INCONCLUSIVE — this does not hold the deploy.**"), jev("**PASS — a person may deploy this release HEAD.**")])).toBe("pass")
  })

  // Any collaborator can post a commit comment with the marker. Only the
  // reporting identity decides a production deploy; everyone else is noise.
  it("ignores a marker comment from anyone but a trusted login, even a PASS", () => {
    expect(decideWith([jev("**PASS — a person may deploy this release HEAD.**", "someone-else")])).toBeNull()
    expect(decideWith([jev("**FAIL — this release HEAD does not deploy.**"), jev("**PASS — a person may deploy this release HEAD.**", "someone-else")])).toBe("fail")
    expect(decideWith([jev("**PASS — a person may deploy this release HEAD.**", "someone-else"), jev("**PASS — a person may deploy this release HEAD.**")])).toBe("pass")
  })

  it("reads trusted logins from JEV_TRUSTED_LOGINS, falling back to the runbook's reporter", () => {
    expect(jevTrustedLogins({ JEV_TRUSTED_LOGINS: "a, b" })).toEqual(["a", "b"])
    expect(jevTrustedLogins({})).toEqual(["ryderwishart"])
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
