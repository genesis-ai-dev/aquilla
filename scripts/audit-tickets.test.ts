import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { marker } from "../smart-tests/adversarial/fingerprint"
import {
  AuditLinearClient, auditFingerprint, cargoFindings, groupFindings, holdFor, parseHolds, planTickets,
  ticketBody, ticketTitle, type AuditFinding,
} from "./audit-tickets"

const finding = (over: Partial<AuditFinding>): AuditFinding => ({
  dir: ".", ecosystem: "npm", module: "nanoid", severity: "high", title: "nanoid: loop", ghsa: "GHSA-aaaa-bbbb-cccc",
  url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", path: ".>@livestore/utils>nanoid", fixedIn: ">=5.1.0",
  allowlisted: false, ...over,
})

const holds = parseHolds(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs/DEPENDENCY-RULES.md"), "utf8"))

describe("grouping and fingerprint", () => {
  it("makes one ticket per dir and package, skips allowlisted findings, and takes the highest severity", () => {
    const groups = groupFindings([
      finding({ ghsa: "GHSA-1", severity: "moderate" }),
      finding({ ghsa: "GHSA-2", severity: "high" }),
      finding({ ghsa: "GHSA-3", allowlisted: true }),
      finding({ dir: "zapier", module: "nanoid" }),
    ])
    expect(groups.map((g) => [g.dir, g.module, g.findings.length, g.severity])).toEqual([
      [".", "nanoid", 2, "high"], ["zapier", "nanoid", 1, "high"],
    ])
  })

  it("fingerprints dir + ecosystem + package, not the advisory set", () => {
    const a = auditFingerprint({ dir: ".", ecosystem: "npm", module: "nanoid" })
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(auditFingerprint({ dir: "zapier", ecosystem: "npm", module: "nanoid" })).not.toBe(a)
    expect(auditFingerprint({ dir: ".", ecosystem: "cargo", module: "nanoid" })).not.toBe(a)
  })

  it("files cargo findings one ticket per crate", () => {
    const rows = cargoFindings({ vulnerabilities: { list: [
      { advisory: { id: "RUSTSEC-1", title: "a" }, package: { name: "rustls", version: "0.23.38" }, versions: { patched: [">=0.23.40"] } },
      { advisory: { id: "RUSTSEC-2", title: "b" }, package: { name: "rustls", version: "0.23.38" } },
      { advisory: { id: "RUSTSEC-3", title: "c" }, package: { name: "quinn-proto", version: "0.11.17" } },
    ] } })
    expect(groupFindings(rows).map((g) => [g.module, g.findings.length])).toEqual([["quinn-proto", 1], ["rustls", 2]])
    expect(rows[0]).toMatchObject({ dir: "src-tauri", ecosystem: "cargo", fixedIn: ">=0.23.40" })
  })
})

describe("HITL rule", () => {
  it("reads holds from the rules doc, including prefix patterns", () => {
    expect(holds.flatMap((h) => h.packages)).toEqual(expect.arrayContaining(["postgres", "@livestore/*", "@cloudflare/sandbox", "@tanstack/react-table", "python"]))
  })

  it("holds a package named in a hold, or one pulled in through a held package", () => {
    const [direct] = groupFindings([finding({ module: "postgres", path: null })])
    expect(holdFor(direct, holds)?.heading).toContain("postgres")
    const [viaPath] = groupFindings([finding({})])
    expect(holdFor(viaPath, holds)?.heading).toContain("@livestore")
    const [free] = groupFindings([finding({ module: "form-data", dir: "zapier", path: "zapier-platform-core > form-data" })])
    expect(holdFor(free, holds)).toBeNull()
  })

  it("adds HITL to the planned labels only for held packages", () => {
    const plan = planTickets([finding({}), finding({ module: "form-data", dir: "zapier", path: "zapier-platform-core > form-data" })], holds)
    expect(plan.map((t) => t.labels.includes("HITL"))).toEqual([true, false])
  })
})

describe("ticket text", () => {
  const [group] = groupFindings([finding({ ghsa: "GHSA-1" }), finding({ ghsa: "GHSA-2", severity: "moderate" })])
  const body = ticketBody(group, holdFor(group, holds))

  it("has a plain title", () => {
    expect(ticketTitle(group)).toBe("Dependency audit: nanoid in root has 2 advisories (high)")
    expect(ticketTitle(groupFindings([finding({ dir: "zapier" })])[0])).toBe("Dependency audit: nanoid in zapier has 1 advisory (high)")
  })

  it("puts the readable part first, then a closed Agent notes block, then the marker", () => {
    expect(body.indexOf("GHSA-1")).toBeLessThan(body.indexOf("+++ Agent notes"))
    expect(body).toContain("**Does it ship?** Unknown.")
    expect(body).toContain("[GHSA-1](https://github.com/advisories/GHSA-aaaa-bbbb-cccc)")
    expect(body).toContain("> LiveStore is pre-1.0")
    const lines = body.split("\n")
    expect(lines.filter((l) => l === "+++ Agent notes")).toHaveLength(1)
    expect(lines.filter((l) => l === "+++")).toHaveLength(1)
    expect(lines.indexOf("+++")).toBeGreaterThan(lines.indexOf("+++ Agent notes"))
    expect(body).toContain("never a major version bump without a human")
    expect(body.trimEnd().endsWith(marker(auditFingerprint(group)))).toBe(true)
  })

  it("is deterministic, so an unchanged advisory set leaves the ticket alone", () => {
    expect(ticketBody(group, holdFor(group, holds))).toBe(body)
  })
})

/** Answers Linear GraphQL by operation and records every call. */
function fakeLinear(existing: { id: string; identifier: string; description: string } | null) {
  const calls: { query: string; variables: Record<string, any> }[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const call = JSON.parse(String(init.body))
    calls.push(call)
    const q: string = call.query
    const data = q.includes("parent: issue") ? {
      parent: { id: "p", team: { id: "team", states: { nodes: [{ id: "todo", name: "Todo" }, { id: "triage", name: "Triage" }] } } },
      rollup: { id: "r" }, issueLabels: { nodes: [] }, projects: { nodes: [] },
    } : q.includes("issueLabels(first: 250)") ? { issueLabels: { nodes: [
      { id: "bug", name: "Bug", team: { id: "team" } }, { id: "hitl", name: "HITL", team: { id: "team" } },
      { id: "dep", name: "Infra & Deploy", team: null }, { id: "otherbug", name: "Bug", team: { id: "else" } },
    ] } } : q.includes("issues(first: 1") ? { issues: { nodes: existing ? [existing] : [] } }
      : q.includes("issueCreate") ? { issueCreate: { issue: { identifier: "AQU-5000" } } }
        : { issueUpdate: { success: true } }
    return new Response(JSON.stringify({ data }), { status: 200 })
  }) as typeof fetch
  return { calls, client: new AuditLinearClient("key", fetchImpl) }
}

describe("create versus update", () => {
  const [ticket] = planTickets([finding({})], holds)

  it("creates in Triage with Bug, the dependency label and HITL, never creating a label", async () => {
    const { calls, client } = fakeLinear(null)
    expect(await client.fileTicket(ticket)).toEqual({ identifier: "AQU-5000", action: "created" })
    const input = calls.find((c) => c.query.includes("issueCreate"))?.variables.i
    expect(input).toMatchObject({ teamId: "team", stateId: "triage", labelIds: ["bug", "dep", "hitl"], title: ticket.title })
    expect(calls.some((c) => c.query.includes("issueLabelCreate"))).toBe(false)
  })

  it("updates title and description only when the advisory set changed, and never touches state", async () => {
    const { calls, client } = fakeLinear({ id: "x", identifier: "AQU-4000", description: `old\n\n${marker(ticket.fingerprint)}` })
    expect(await client.fileTicket(ticket)).toEqual({ identifier: "AQU-4000", action: "updated" })
    const update = calls.find((c) => c.query.includes("issueUpdate"))
    expect(Object.keys(update!.variables.i).sort()).toEqual(["description", "title"])
    expect(calls.some((c) => c.query.includes("issueCreate"))).toBe(false)
  })

  it("leaves a ticket untouched when its description already matches", async () => {
    const { calls, client } = fakeLinear({ id: "x", identifier: "AQU-4000", description: `${ticket.body}\n` })
    expect(await client.fileTicket(ticket)).toEqual({ identifier: "AQU-4000", action: "unchanged" })
    expect(calls.some((c) => c.query.includes("issueUpdate") || c.query.includes("issueCreate"))).toBe(false)
  })

  it("finds the ticket in any state by its marker", async () => {
    const { calls, client } = fakeLinear(null)
    await client.fileTicket(ticket)
    const search = calls.find((c) => c.query.includes("issues(first: 1"))!
    expect(search.query).not.toContain("state")
    expect(search.variables.m).toBe(marker(ticket.fingerprint))
  })
})
