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
// where most of the app actually gets them. The static asset router may answer
// SPA documents without invoking the Worker, so a header tightened only in
// security-headers.ts would read as broader than its real coverage.
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

describe("YouTube iframe API script policy", () => {
  it.each([
    ["worker", REPORT_ONLY_CSP],
    ["static assets", STATIC_HEADERS["Content-Security-Policy-Report-Only"]],
  ])("permits the YouTube API in %s script-src", (_surface, policy) => {
    const directive = policy.split("; ").find((part) =>
      part.startsWith("script-src "),
    )
    expect(directive?.split(" ")).toContain("https://www.youtube.com")
  })
})

describe("third-party font hosts stay out of the CSP (AQU-2244)", () => {
  // Geist ships from our own origin (`@fontsource-variable/geist`), so no
  // surface needs Google's font CDNs. Allowing them would let a later change
  // pull fonts from Google and hand every visitor's IP to a recipient the
  // privacy policy does not name — the kind of regression that shows up in a
  // legal review, not in a failing page.
  const GOOGLE_FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"]

  const TAURI_CSPS = ["../src-tauri/tauri.conf.json", "../src-tauri/tauri.mitm.conf.json"].map(
    (file) =>
      [
        file,
        JSON.stringify(JSON.parse(readFileSync(resolve(__dirname, file), "utf8")).app.security.csp),
      ] as const,
  )

  it.each([
    ["worker enforced", ENFORCED_CSP],
    ["worker report-only", REPORT_ONLY_CSP],
    ["static assets enforced", STATIC_HEADERS["Content-Security-Policy"]],
    ["static assets report-only", STATIC_HEADERS["Content-Security-Policy-Report-Only"]],
    ...TAURI_CSPS,
  ])("%s policy allows no Google font host", (_surface, policy) => {
    for (const host of GOOGLE_FONT_HOSTS) expect(policy).not.toContain(host)
  })

  it.each([
    ["worker report-only", REPORT_ONLY_CSP],
    ["static assets report-only", STATIC_HEADERS["Content-Security-Policy-Report-Only"]],
  ])("%s keeps font-src to our own origin", (_surface, policy) => {
    const directive = policy.split("; ").find((part) => part.startsWith("font-src "))
    expect(directive).toBe("font-src 'self' data:")
  })
})

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

// AQU-2092: fingerprinted build files are kept for a year; the page is not.
describe("public/_headers — caching", () => {
  it("keeps /assets/* (fingerprinted build output) for a year without re-checking", () => {
    expect(parseRule(HEADERS_FILE, "/assets/*")["Cache-Control"]).toBe("public, max-age=31536000, immutable")
  })

  it("leaves the page itself to revalidate, so a deploy shows up at once", () => {
    expect(findCaseInsensitive(STATIC_HEADERS, "Cache-Control")).toBeUndefined()
  })
})

function findCaseInsensitive(record: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : record[key]
}
