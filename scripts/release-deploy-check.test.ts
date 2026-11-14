import { describe, expect, it } from "vitest"
import { commitComments, decide, jevDecision, jevTrustedLogins, verifyState } from "./release-deploy-check.mjs"

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

describe("verifyState", () => {
  const run = (over: Record<string, unknown>) => ({ name: "release-verify", status: "completed", conclusion: "success", started_at: "2026-11-13T10:00:00Z", app: { slug: "github-actions" }, ...over })

  it("is the newest GitHub Actions run of release-verify", () => {
    expect(verifyState([run({})])).toBe("success")
    expect(verifyState([run({}), run({ conclusion: "failure", started_at: "2026-11-13T11:00:00Z" })])).toBe("failure")
    expect(verifyState([run({ status: "in_progress", conclusion: null, started_at: "2026-11-13T11:00:00Z" }), run({})])).toBe("in_progress")
    expect(verifyState([])).toBeUndefined()
    expect(verifyState(undefined)).toBeUndefined()
  })

  // Any GitHub App with checks:write could post a check of this name.
  it("does not read a release-verify check another app produced", () => {
    expect(verifyState([run({ app: { slug: "some-app" } })])).toBeUndefined()
    expect(verifyState([run({ app: { slug: "some-app" }, started_at: "2026-11-13T12:00:00Z" }), run({ conclusion: "failure" })])).toBe("failure")
    expect(verifyState([run({ name: "unit" })])).toBeUndefined()
  })
})

describe("commitComments", () => {
  const page = (count: number, login: string) => Array.from({ length: count }, () => ({ body: "noise", user: { login } }))

  // A hundred comments from anyone fill the first page. The trusted FAIL
  // after them must still be read.
  it("reads past the first page, so a FAIL behind a hundred comments still holds", async () => {
    const fail = { body: `${MARKER}\n**FAIL — this release HEAD does not deploy.**`, user: { login: TRUSTED } }
    const pass = { body: `${MARKER}\n**PASS — a person may deploy this release HEAD.**`, user: { login: TRUSTED } }
    const pages = [[pass, ...page(99, "stranger")], [fail]]
    const asked: string[] = []
    const comments = await commitComments("abc", "t", async (path) => {
      asked.push(path)
      return pages[asked.length - 1] ?? []
    })
    expect(asked).toEqual(["/commits/abc/comments?per_page=100&page=1", "/commits/abc/comments?per_page=100&page=2"])
    expect(jevDecision(comments.map((comment) => ({ body: comment.body, login: comment.user?.login })), [TRUSTED])).toBe("fail")
  })

  it("refuses to decide on a list it could not read to the end", async () => {
    await expect(commitComments("abc", "t", async () => page(100, "stranger"))).rejects.toThrow(/truncated/)
  })
})
