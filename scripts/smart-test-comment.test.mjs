import { describe, it, expect } from "vitest"
import { renderReport, publishReport, evidenceDefect } from "./smart-test-comment.mjs"

const sha = "a".repeat(40)
const title = "Jev project outcome: comment"
function suite() {
  return { schemaVersion: 2, build: sha, dirty: false, status: "passed", planned: [title],
    tests: [{ title, status: "passed", durationMs: 1200, evidence: {
      "smart-testing-evidence": { build: sha, dirty: false, inputObserved: true,
        outcome: { verdict: "passed", checks: { durable: true, fresh: true } },
        agent: { status: "done", modelCalls: [{ usage: { cost: 0.001 } }] } },
    } }] }
}
const render = (value) => renderReport({ sha, phase: "finished", suite: value })
describe("truthful outcome report", () => {
  it("allows only scoped opaque Hetzner evidence links", () => {
    const url = `https://aquilla-qa.5-161-201-46.sslip.io/aquilla-qa/artifacts/${"a".repeat(64)}/suite.json`
    const report = renderReport({ sha, phase: "finished", suite: suite(), runUrl: url })
    expect(report).toContain("expires after seven days")
    for (const runUrl of ["https://evil.example/suite.json", url + "?redirect=evil", url.replace("https:", "http:")]) {
      expect(() => renderReport({ sha, phase: "finished", runUrl })).toThrow("Invalid workflow URL")
    }
  })
  it("renders independent passes, cost, and commit identity", () => {
    expect(render(suite())).toContain("**PASS — all listed outcomes verified.**")
    expect(render(suite())).toContain("VERIFIED PASS")
    expect(render(suite())).toContain("$0.001000 (1/1 calls")
    expect(render(suite())).toContain(sha)
  })
  it("never treats setup as a pass", () => {
    const report = renderReport({ sha, phase: "running" })
    expect(report).toContain("No outcome has passed yet")
    expect(report).not.toContain("VERIFIED PASS")
  })
  it("reports elapsed parallel time rather than adding overlapping test durations", () => {
    const value = { ...suite(), parallel: { shards: 4, wallMs: 51000, longestShardTestMs: 30000 } }
    expect(render(value)).toContain("4 isolated stacks; 51.0 s including setup; 30.0 s for the slowest test shard")
  })
  for (const [name, change] of [
    ["dirty checkout", (s) => { s.dirty = true }],
    ["wrong commit", (s) => { s.build = "b".repeat(40) }],
    ["unfinished suite", (s) => { s.status = "running" }],
    ["missing test", (s) => { s.planned.push("missing") }],
    ["duplicate result", (s) => { s.tests.push(s.tests[0]) }],
    ["no planned tests", (s) => { s.planned = [] }],
    ["failed Playwright result", (s) => { s.tests[0].status = "failed" }],
    ["stale journey evidence", (s) => { s.tests[0].evidence["smart-testing-evidence"].build = "b".repeat(40) }],
    ["wrong server outcome", (s) => { s.tests[0].evidence["smart-testing-evidence"].outcome.checks.durable = false }],
    ["empty checks", (s) => { s.tests[0].evidence["smart-testing-evidence"].outcome.checks = {} }],
    ["unobserved input", (s) => { s.tests[0].evidence["smart-testing-evidence"].inputObserved = false }],
    ["driver error", (s) => { s.tests[0].evidence["smart-testing-evidence"].agent.status = "driver_error" }],
    ["no evidence", (s) => { s.tests[0].evidence = {} }],
  ]) {
    it(`does not pass ${name}`, () => {
      const value = suite()
      change(value)
      expect(render(value)).not.toContain("**PASS — all listed outcomes verified.**")
    })
  }
  it("does not pass a setup failure or missing artifact", () => {
    expect(render(undefined)).toContain("INCONCLUSIVE")
    expect(renderReport({ sha, phase: "finished", suite: suite(), jobStatus: "failure" }))
      .not.toContain("**PASS — all listed outcomes verified.**")
  })
  it("preserves a product failure and lists missing journeys", () => {
    const value = suite()
    value.tests[0].evidence["smart-testing-evidence"].outcome.verdict = "product_failure"
    value.planned.push("Unrun journey")
    expect(render(value)).toContain("PRODUCT FAILURE")
    expect(render(value)).toContain("| Unrun journey | NOT RUN |")
  })
  it("names which precondition disqualified the evidence", () => {
    // AQU-1354: the wholesale mode said only "setup, execution, or evidence
    // collection failed", so an operator could not tell a stale harness image
    // from a dirty checkout without root-only host logs.
    expect(render(undefined)).toContain("No evidence file reached the reporter")
    expect(render({ ...suite(), schemaVersion: 1 })).toContain("does not match this reporter")
    expect(render({ ...suite(), build: "b".repeat(40) })).toContain("not this PR head")
    expect(render({ ...suite(), dirty: true })).toContain("was not clean")
    expect(render({ ...suite(), planned: [] })).toContain("no journey plan")
    expect(render({ ...suite(), tests: null })).toContain("no journey results")
    expect(evidenceDefect(suite(), sha)).toBe(null)
  })
  it("does not let hostile evidence fields break out of the reason sentence", () => {
    // Evidence is written by the harness container, so a defect reason must not
    // become a new table row or a new line in the report.
    const report = render({ ...suite(), build: "bb|x\n**PASS - verified.**" })
    expect(report).toContain("&#124;")
    expect(report).not.toContain("|x")
    // The reason stays one line inside one sentence: no new row, no new line,
    // and no verdict of its own.
    expect(report.split("\n").length).toBe(render({ ...suite(), build: "b".repeat(40) }).split("\n").length)
    expect(report).not.toContain("**PASS — all listed outcomes verified.**")
    // Long values are truncated, so evidence cannot append prose of its own.
    const long = render({ ...suite(), build: "c".repeat(200) })
    expect(long).toContain("c".repeat(40))
    expect(long).not.toContain("c".repeat(41))
  })
  it("separates a real model-free failure from an unknown outcome", () => {
    // Both are "not a pass", but only one is evidence about the product. Sharing
    // one word is what made the DOM-audit row unreadable for weeks.
    const domAudit = (status) => {
      const value = suite()
      value.tests[0].title = "DOM audit: project surfaces and editor activation use Jev's actual snapshot"
      value.tests[0].status = status
      value.tests[0].evidence = { "dom-audit": { reports: [] } }
      value.planned = [value.tests[0].title]
      return render(value)
    }
    expect(domAudit("failed")).toContain("FAIL (model-free check)")
    expect(domAudit("failed")).not.toContain("INCONCLUSIVE")
    expect(domAudit("failed")).toContain("**NOT A PASS")
    for (const status of ["timedOut", "interrupted", "skipped"]) {
      expect(domAudit(status)).toContain("INCONCLUSIVE")
      expect(domAudit(status)).not.toContain("FAIL (model-free check)")
    }
    expect(domAudit("passed")).toContain("PASS (model-free check)")
  })
  it("states plainly that the same commit cannot be re-run, and who can requeue it", () => {
    for (const value of [suite(), undefined]) {
      const report = render(value)
      expect(report).toContain("Re-runs on this commit are not available")
      expect(report).toContain("discarded as a duplicate")
      expect(report).toContain("Push a new commit")
      expect(report).toContain("QA host operator")
    }
  })
  it("escapes title markup instead of manufacturing table rows", () => {
    const value = suite()
    value.tests[0].title = "Jev test | fake\n<b>"
    value.planned = [value.tests[0].title]
    expect(render(value)).toContain("Jev test &#124; fake &lt;b&gt;")
  })
})

function harness({ comments = [], currentSha = sha, secondSha = currentSha, state = "open" } = {}) {
  const writes = []
  let reads = 0
  const pull = (head) => ({ state, head: { sha: head, repo: { full_name: "genesis-ai-dev/aquilla" } } })
  const fetchImpl = async (url, options) => {
    let result
    if (options.method !== "GET") {
      result = { id: 12, ...JSON.parse(options.body) }
      writes.push({ url, method: options.method, ...result })
    } else if (url.includes("/comments?")) {
      const page = Number(new URL(url).searchParams.get("page"))
      result = comments.slice((page - 1) * 100, page * 100)
    } else result = pull(++reads === 1 ? currentSha : secondSha)
    return { ok: true, json: async () => result }
  }
  return { writes, options: { pr: 716, sha, body: render(suite()), token: "fake", author: "qa", fetchImpl } }
}
describe("PR publication", () => {
  it("posts and updates only the reporting identity's comment", async () => {
    const h = harness()
    expect(await publishReport(h.options)).toBe("created")
    expect(h.writes[0].method).toBe("POST")
    const own = { id: 12, user: { login: "qa" }, body: "<!-- aquilla-smart-tests --> old" }
    const update = harness({ comments: [own] })
    expect(await publishReport(update.options)).toBe("updated")
    expect(update.writes[0].method).toBe("PATCH")
    const unchanged = harness({ comments: [{ ...own, body: h.options.body }] })
    expect(await publishReport(unchanged.options)).toBe("unchanged")
    expect(unchanged.writes).toEqual([])
    const other = harness({ comments: [{ ...own, user: { login: "someone-else" } }] })
    expect(await publishReport(other.options)).toBe("created")
  })
  it("finds its existing comment beyond the first page", async () => {
    const comments = Array.from({ length: 100 }, (_, id) => ({ id, body: "other" }))
    comments.push({ id: 101, user: { login: "qa" }, body: "<!-- aquilla-smart-tests --> old" })
    const h = harness({ comments })
    expect(await publishReport(h.options)).toBe("updated")
    expect(h.writes[0].url).toContain("/issues/comments/101")
  })
  for (const config of [{ currentSha: "b".repeat(40) }, { secondSha: "b".repeat(40) }, { state: "closed" }]) {
    it(`does not overwrite a newer or closed PR: ${JSON.stringify(config)}`, async () => {
      const h = harness(config)
      expect(await publishReport(h.options)).toBe("superseded")
      expect(h.writes).toEqual([])
    })
  }
})
