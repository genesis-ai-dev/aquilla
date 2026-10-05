/**
 * AQU-1669 — the CORS allowlist is a CONTRACT with this client, enforced here.
 *
 * Twice now a custom request header has shipped in the client ahead of
 * `sync-worker/src/cors.ts`'s `Access-Control-Allow-Headers`, and both times the
 * browser killed the request at the preflight so nothing ever reached the
 * worker: `X-Source-Format` took out every DOCX/PPTX source upload, and
 * `X-Artifact-Target-Lang` took out every target import into a non-default lane
 * (AQU-1631). The hand-written header list in `sync-worker`'s own cors test
 * could not catch either one — it enumerated the headers a human remembered, so
 * a header nobody remembered was absent from the allowlist and from the test in
 * the same commit.
 *
 * This test derives both sides from source instead: the headers this module
 * actually sends, and the allowlist the worker actually answers preflights
 * with. Add a header to the source PUT without allowlisting it and this fails
 * here, in the root suite, rather than in a partner's browser.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

function readRepoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
}

/** Every `"X-…":` / `"Mcp-…":` request-header literal this module sends. */
function headersSentBy(moduleSource: string): string[] {
  const found = new Set<string>()
  for (const [, name] of moduleSource.matchAll(/"((?:X|Mcp)-[A-Za-z0-9-]+)"\s*:/g)) {
    found.add(name.toLowerCase())
  }
  return [...found].sort()
}

/** The worker's `Access-Control-Allow-Headers` array, read off its source. */
function syncWorkerAllowedHeaders(): string[] {
  const cors = readRepoFile("../../../sync-worker/src/cors.ts")
  const block = cors.match(/"Access-Control-Allow-Headers":\s*\[([\s\S]*?)\]\.join/)
  expect(block, "could not locate the Allow-Headers array in sync-worker/src/cors.ts").not.toBeNull()
  return [...block![1].matchAll(/"([A-Za-z0-9-]+)"/g)].map(([, name]) => name.toLowerCase())
}

describe("source-upload ↔ sync-worker CORS contract", () => {
  const sent = headersSentBy(readRepoFile("./source-upload.ts"))

  it("finds the headers the source PUT sends (guards the extraction itself)", () => {
    // If this ever reads as an empty list the contract assertion below passes
    // vacuously, which is the one way this test could go quietly useless.
    expect(sent.length).toBeGreaterThan(5)
    expect(sent).toContain("x-source-format")
    expect(sent).toContain("x-artifact-target-lang")
  })

  it("allowlists every custom header the source PUT sends", () => {
    const allowed = syncWorkerAllowedHeaders()
    const missing = sent.filter((header) => !allowed.includes(header))
    expect(
      missing,
      `sync-worker/src/cors.ts must allow these headers or the browser blocks the PUT at preflight: ${missing.join(", ")}`,
    ).toEqual([])
  })
})
