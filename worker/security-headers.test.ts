import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it, expect } from "vitest"
import {
  ENFORCED_CSP,
  HSTS,
  PERMISSIONS_POLICY,
  REPORT_ONLY_CSP,
  withSecurityHeaders,
} from "./security-headers"

// public/_headers is not a convenience copy of the Worker's headers — it is
// where most of the site actually gets them. `run_worker_first = ["/"]` plus
// `not_found_handling = "single-page-application"` means the asset router
// answers every path but the bare root without invoking the Worker, so a
// header tightened only in security-headers.ts would cover one URL out of the
// whole app while reading, in code review, as though it covered everything.
//
// These tests exist so that failure mode is a red build rather than a silent
// gap nobody notices for two months (which is exactly what happened to the
// assertion in index.test.ts — see OPS-4/OPS-7 in
// docs/OPSEC-REVIEW-2026-08-10.md).
const HEADERS_FILE = readFileSync(resolve(__dirname, "../public/_headers"), "utf8")

/** Parse the `/*` rule out of the Cloudflare `_headers` format: a bare path
 *  line, then `  Name: value` continuation lines until the next path line. */
function parseRule(source: string, path: string): Record<string, string> {
  const lines = source.split("\n")
  const start = lines.findIndex((line) => line.trim() === path)
  if (start === -1) throw new Error(`_headers declares no ${path} rule`)

  const out: Record<string, string> = {}
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(" ") && line.trim() !== "") break // next rule
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const separator = trimmed.indexOf(":")
    if (separator === -1) continue
    out[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim()
  }
  return out
}

const STATIC_HEADERS = parseRule(HEADERS_FILE, "/*")

describe("public/_headers — covers what the Worker cannot", () => {
  it("declares a catch-all rule (anything narrower would leave paths bare)", () => {
    expect(Object.keys(STATIC_HEADERS).length).toBeGreaterThan(0)
  })

  it("carries the same enforced CSP the Worker sets", () => {
    expect(STATIC_HEADERS["Content-Security-Policy"]).toBe(ENFORCED_CSP)
  })

  it("carries the same report-only CSP the Worker sets", () => {
    expect(STATIC_HEADERS["Content-Security-Policy-Report-Only"]).toBe(REPORT_ONLY_CSP)
  })

  it("carries the same Permissions-Policy, keeping microphone=(self)", () => {
    expect(STATIC_HEADERS["Permissions-Policy"]).toBe(PERMISSIONS_POLICY)
    // Pinned separately: dropping this silently kills cell audio recording and
    // the MMS dictation flow, which fail as a denied getUserMedia rather than
    // as anything that looks like a headers problem.
    expect(STATIC_HEADERS["Permissions-Policy"]).toContain("microphone=(self)")
  })

  it("carries the same HSTS max-age, still without includeSubDomains", () => {
    expect(STATIC_HEADERS["Strict-Transport-Security"]).toBe(HSTS)
    expect(STATIC_HEADERS["Strict-Transport-Security"]).not.toContain("includeSubDomains")
  })
})

describe("public/_headers ↔ worker/security-headers.ts parity", () => {
  // Derive the Worker's real output rather than restating it: a header added to
  // withSecurityHeaders() and not to _headers must fail here.
  const workerHeaders = withSecurityHeaders(new Response("body"), "aquilla.app").headers

  it("declares every header the Worker sets, with an identical value", () => {
    const missing: string[] = []
    const mismatched: string[] = []
    for (const [name, value] of workerHeaders.entries()) {
      if (name.toLowerCase() === "content-type") continue // set by the response, not by us
      const declared = STATIC_HEADERS[name] ?? findCaseInsensitive(STATIC_HEADERS, name)
      if (declared === undefined) missing.push(name)
      else if (declared !== value) mismatched.push(`${name}\n  worker:  ${value}\n  _headers: ${declared}`)
    }
    expect(
      { missing, mismatched },
      "public/_headers must be updated in the same change as worker/security-headers.ts",
    ).toEqual({ missing: [], mismatched: [] })
  })

  it("does not declare headers the Worker omits, so the two surfaces agree", () => {
    const workerNames = new Set([...workerHeaders.keys()].map((n) => n.toLowerCase()))
    const extra = Object.keys(STATIC_HEADERS).filter((n) => !workerNames.has(n.toLowerCase()))
    expect(extra).toEqual([])
  })
})

function findCaseInsensitive(record: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : record[key]
}
