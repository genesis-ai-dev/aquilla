import { describe, expect, it } from "vitest"
import {
  AuditUnavailableError,
  evaluate,
  loadAllowlist,
  parseAuditJson,
  type Advisory,
  type AllowEntry,
} from "./dependency-audit"

const advisory = (over: Partial<Advisory> = {}): Advisory => ({
  id: "GHSA-aaaa-bbbb-cccc",
  module: "left-pad",
  severity: "high",
  title: "Something bad",
  paths: [".>left-pad"],
  ...over,
})

const entry = (over: Partial<AllowEntry> = {}): AllowEntry => ({
  id: "GHSA-aaaa-bbbb-cccc",
  module: "left-pad",
  reason: "Not reachable from anything we ship.",
  until: "2099-01-01",
  ...over,
})

describe("evaluate", () => {
  it("passes an advisory that is triaged and unexpired", () => {
    expect(evaluate([advisory()], [entry()], "2026-08-12")).toEqual([])
  })

  it("fails an advisory with no allowlist entry", () => {
    const verdicts = evaluate([advisory()], [], "2026-08-12")
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0].kind).toBe("untriaged")
  })

  it("fails an allowlist entry whose review date has passed", () => {
    const verdicts = evaluate([advisory()], [entry({ until: "2026-08-11" })], "2026-08-12")
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0].kind).toBe("expired")
  })

  it("treats the review date as inclusive", () => {
    expect(evaluate([advisory()], [entry({ until: "2026-08-12" })], "2026-08-12")).toEqual([])
  })

  it("matches on advisory id, not on module name", () => {
    // A second advisory against an already-triaged package is a new decision.
    const verdicts = evaluate(
      [advisory(), advisory({ id: "GHSA-zzzz-yyyy-xxxx" })],
      [entry()],
      "2026-08-12",
    )
    expect(verdicts.map((v) => v.advisory.id)).toEqual(["GHSA-zzzz-yyyy-xxxx"])
  })

  it("reports nothing for an empty audit", () => {
    expect(evaluate([], [entry()], "2026-08-12")).toEqual([])
  })
})

describe("parseAuditJson", () => {
  it("flattens findings into advisories keyed by GitHub advisory id", () => {
    const raw = JSON.stringify({
      advisories: {
        "1234": {
          github_advisory_id: "GHSA-55q2-fjhq-7xh7",
          module_name: "dompurify",
          severity: "moderate",
          title: "DOMPurify: IN_PLACE hook removal…",
          findings: [{ paths: [".>dompurify"] }, { paths: [".>a>dompurify"] }],
        },
      },
    })
    expect(parseAuditJson(raw)).toEqual([
      {
        id: "GHSA-55q2-fjhq-7xh7",
        module: "dompurify",
        severity: "moderate",
        title: "DOMPurify: IN_PLACE hook removal…",
        paths: [".>dompurify", ".>a>dompurify"],
      },
    ])
  })

  it("falls back to the map key when no github_advisory_id is present", () => {
    const raw = JSON.stringify({ advisories: { "999": { module_name: "x" } } })
    expect(parseAuditJson(raw)[0].id).toBe("999")
  })

  it("handles a clean audit, which reports an empty advisories map", () => {
    expect(parseAuditJson(JSON.stringify({ advisories: {}, metadata: { foo: 1 } }))).toEqual([])
  })

  it("accepts a payload carrying metadata alone", () => {
    expect(parseAuditJson(JSON.stringify({ metadata: { vulnerabilities: {} } }))).toEqual([])
  })

  it("throws AuditUnavailableError rather than reporting an unreadable payload clean", () => {
    // The gate passing because it could not read the output is the one failure
    // mode that would make it worse than having no gate.
    expect(() => parseAuditJson(JSON.stringify({}))).toThrow(AuditUnavailableError)
  })

  it("surfaces the registry's own error, so a build log says why", () => {
    // pnpm reports an unreachable advisory endpoint as an `error` object on
    // stdout. Without this the failure reads as "unrecognised output" and the
    // reader goes looking for a parser bug instead of a network problem.
    const raw = JSON.stringify({
      error: { code: "ECONNREFUSED", message: "request to https://registry/-/npm/v1/security/audits failed" },
    })
    expect(() => parseAuditJson(raw)).toThrow(/ECONNREFUSED/)
  })

  it("distinguishes an unavailable audit from a found advisory", () => {
    // These need different reactions: an untriaged advisory is the PR author's
    // decision, an unreachable endpoint is the builder's problem. Callers
    // branch on the type, so it has to be the type and not just the message.
    let caught: unknown
    try {
      parseAuditJson(JSON.stringify({}))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AuditUnavailableError)
    expect((caught as Error).name).toBe("AuditUnavailableError")
  })
})

describe("the committed allowlist", () => {
  const allowlist = loadAllowlist()

  it("gives every entry a real reason and an ISO review date", () => {
    for (const e of allowlist) {
      expect(e.id, "every entry needs an advisory id").toMatch(/^GHSA-|^\d+$/)
      expect(e.until, `${e.id} needs an ISO review date`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      // A one-word reason is how an allowlist rots into a mute button.
      expect(e.reason.length, `${e.id} needs a reason worth reading`).toBeGreaterThan(40)
    }
  })

  it("does not suppress the DOMPurify advisory", () => {
    // GHSA-55q2-fjhq-7xh7 was fixed by raising the floor to ^3.4.13, not by
    // triage. DOMPurify is the SPA's only sanitizer for user-authored HTML
    // (comments, editor content), so an advisory against it is never
    // allowlistable — if this ever gains an entry, something went wrong.
    expect(allowlist.map((e) => e.module)).not.toContain("dompurify")
  })

  it("has no duplicate ids", () => {
    const ids = allowlist.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
