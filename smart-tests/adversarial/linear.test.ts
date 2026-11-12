import { describe, expect, it } from "vitest"
import { LinearClient, rollupBody, ticketBody, type Finding, type RunSummary } from "./linear"

const finding: Finding = {
  fingerprint: "abc123def456", attackId: "edit.reload-mid-type", mode: "condition", journey: "edit",
  reason: "Failed: requirementsMet.", failedChecks: ["requirementsMet"], diffs: [], unmet: ["target-value"],
  goal: "Change row one.", secondGoal: null, mutator: "reload", fuzzSeed: null,
  runId: "run-1", target: "dev", deployedSha: "6cf6da7", evidencePath: "smart-tests/results/adv-run-1/suite.json",
  projectIds: ["p1"],
}

/** Records every GraphQL call and answers by operation. */
function fakeLinear(openIssue: { id: string; identifier: string } | null) {
  const calls: { query: string; variables: Record<string, unknown> }[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> }
    calls.push(body)
    const data = body.query.includes("issues(first: 1") ? { issues: { nodes: openIssue ? [openIssue] : [] } }
      : body.query.includes("parent: issue") ? {
        parent: { id: "parent-id", team: { id: "team", states: { nodes: [
          { id: "todo", name: "Todo" }, { id: "triage", name: "Triage" }] } } },
        rollup: { id: "rollup-id" },
        issueLabels: { nodes: [{ id: "other-bug", team: { id: "else" } }, { id: "bug", team: { id: "team" } }] },
        projects: { nodes: [{ id: "proto" }] },
      }
        : body.query.includes("issueCreate") ? { issueCreate: { issue: { identifier: "AQU-9999" } } }
          : { commentCreate: { success: true } }
    return new Response(JSON.stringify({ data }), { status: 200 })
  }) as typeof fetch
  return { calls, client: new LinearClient("key", fetchImpl) }
}

describe("Linear filing", () => {
  it("creates new findings in Triage under the navigability parent, never in Todo", async () => {
    const { calls, client } = fakeLinear(null)
    expect(await client.fileFinding(finding)).toBe("AQU-9999")
    const input = calls.find((call) => call.query.includes("issueCreate"))?.variables.i as Record<string, unknown>
    expect(input).toMatchObject({ teamId: "team", stateId: "triage", parentId: "parent-id", projectId: "proto", labelIds: ["bug"] })
    expect(String(input.description)).toContain("adv-fp:abc123def456")
  })

  it("comments on the open ticket with the same fingerprint instead of opening a duplicate", async () => {
    const { calls, client } = fakeLinear({ id: "open-id", identifier: "AQU-1400" })
    expect(await client.fileFinding(finding)).toBe("AQU-1400")
    expect(calls.some((call) => call.query.includes("issueCreate"))).toBe(false)
    expect(calls.find((call) => call.query.includes("commentCreate"))?.variables.i).toMatchObject({ issueId: "open-id" })
  })

  it("posts the rollup on the smart-testing ticket", async () => {
    const { calls, client } = fakeLinear(null)
    const summary: RunSummary = { runId: "run-1", target: "dev", deployedSha: null, harnessAvailable: true, harnessReason: "",
      counts: { passed: 3 }, inconclusive: [], navigability: [], tickets: [], evidencePath: "x" }
    await client.postRollup(summary)
    expect(calls.at(-1)?.variables.i).toMatchObject({ issueId: "rollup-id" })
  })
})

describe("ticket and rollup text", () => {
  it("carries the exact goal, condition and build, so a human can reproduce it", () => {
    const body = ticketBody(finding)
    expect(body).toContain("> Change row one.")
    expect(body).toContain("`reload`")
    expect(body).toContain("`6cf6da7`")
  })

  it("leads with HARNESS UNAVAILABLE when the harness is dead", () => {
    const text = rollupBody({ runId: "r", target: "dev", deployedSha: null, harnessAvailable: false,
      harnessReason: "The canary health check failed (1 of 2).", counts: {}, inconclusive: [], navigability: [], tickets: [], evidencePath: "x" })
    expect(text.startsWith("**HARNESS UNAVAILABLE**")).toBe(true)
    expect(text).toContain("No tickets were filed")
  })
})
