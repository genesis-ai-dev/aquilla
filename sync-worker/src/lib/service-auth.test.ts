import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { serviceBearerMatches } from "./service-auth"

// OPS-11 (docs/OPSEC-REVIEW-2026-08-17.md). Two halves:
//
//   1. the helper behaves (below), and
//   2. nothing hand-rolls the comparison again (the drift scan at the bottom).
//
// Half 2 is the half that matters. `contextual-activity-notify.ts` shipped a
// `!==` compare against the token-signing key months after `audio.ts` had been
// fixed for exactly that, because there was no test that could see the second
// occurrence. A unit test on the helper cannot catch a caller that never uses
// the helper — only a scan over the source can.

describe("serviceBearerMatches", () => {
  it("accepts the configured bearer", () => {
    expect(serviceBearerMatches("Bearer signing", { SYNC_SECRET_KEY: "signing" })).toBe(true)
  })

  it("rejects a wrong bearer", () => {
    expect(serviceBearerMatches("Bearer nope", { SYNC_SECRET_KEY: "signing" })).toBe(false)
  })

  it("rejects a bare secret sent without the Bearer scheme", () => {
    expect(serviceBearerMatches("signing", { SYNC_SECRET_KEY: "signing" })).toBe(false)
  })

  it("fails closed when no secret is bound", () => {
    // The hazard this replaces: `Bearer ${undefined}` is a real string, so an
    // unconfigured environment must not be talked into matching it.
    expect(serviceBearerMatches("Bearer undefined", {})).toBe(false)
    expect(serviceBearerMatches("Bearer ", { SYNC_SECRET_KEY: "" })).toBe(false)
    expect(serviceBearerMatches("", {})).toBe(false)
  })

  it("tolerates a missing header (null from Headers.get)", () => {
    expect(serviceBearerMatches(null, { SYNC_SECRET_KEY: "signing" })).toBe(false)
    expect(serviceBearerMatches(undefined, { SYNC_SECRET_KEY: "signing" })).toBe(false)
  })

  it("does not trim either side", () => {
    // Deliberate, and asserted so nobody 'tidies' it: the sender builds
    // `Bearer ${SYNC_SECRET_KEY}` from its own binding. Trimming here but not
    // there turns a secret stored with a trailing newline from working into a
    // production 401. Trim both sides together or neither.
    expect(serviceBearerMatches("Bearer signing", { SYNC_SECRET_KEY: "signing\n" })).toBe(false)
    expect(serviceBearerMatches("Bearer signing\n", { SYNC_SECRET_KEY: "signing\n" })).toBe(true)
  })
})

// ── Drift scan ─────────────────────────────────────────────────────────────

const SRC = join(__dirname, "..")

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out)
      continue
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(path)
  }
  return out
}

describe("service bearer gates do not drift", () => {
  const files = sourceFiles(SRC)

  it("finds the worker source (guards against a scan that silently matches nothing)", () => {
    expect(files.length).toBeGreaterThan(20)
  })

  /** Comment lines describe the bug; only code can commit it. */
  const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line)

  // A short-circuiting compare on attacker-supplied input against a shared
  // secret is the bug lib/secure-compare.ts exists to prevent.
  const comparesHeaderDirectly = (line: string) =>
    /headers\.get\(\s*["'`][Aa]uthorization["'`]\s*\)\s*[!=]==/.test(line)

  it("never compares an Authorization header with === or !==", () => {
    // Self-test first: this is the literal line contextual-activity-notify.ts
    // carried until 2026-08-17.
    expect(comparesHeaderDirectly("  if (!expected || request.headers.get('Authorization') !== expected) {"))
      .toBe(true)

    const offenders: string[] = []
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (isComment(line)) return
          if (comparesHeaderDirectly(line)) offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}`)
        })
    }
    expect(offenders).toEqual([])
  })

  // The other shape of the same drift: a receiver building the expected header
  // itself and comparing by hand instead of calling serviceBearerMatches.
  //
  // The discriminator is which side of the wire the line is on. A *sender*
  // writes the template inside a headers literal (`Authorization: \`Bearer …\``);
  // a *receiver* assigns it to a variable to compare against. That distinction
  // matters: events/route.ts and events/link-sync-route.ts both read an
  // Authorization header (to verify a sync-token JWT — a signature check, not a
  // secret compare) AND send `Bearer ${env.SYNC_SECRET_KEY}` onward to the DO.
  // Neither is a bearer gate, and flagging them would only train the next
  // person to silence this test.
  const buildsExpectedBearer = (line: string) =>
    /`Bearer \$\{[^}]*SYNC_SECRET_KEY\}`/.test(line) && !/Authorization:/.test(line)

  it("recognises a hand-rolled gate when it sees one", () => {
    // Self-test. A scan that has quietly stopped matching anything reads as
    // "clean" — the same failure mode `pnpm audit:deps` guards against with its
    // implausible-dependency-count check. These are the exact lines that stood
    // in member-removed.ts, project-do.ts and contextual-activity-notify.ts
    // before OPS-11.
    expect(buildsExpectedBearer("  const expected = env.SYNC_SECRET_KEY ? `Bearer ${env.SYNC_SECRET_KEY}` : null"))
      .toBe(true)
    expect(buildsExpectedBearer("      const expected = this.env.SYNC_SECRET_KEY"
      + " ? `Bearer ${this.env.SYNC_SECRET_KEY}`")).toBe(true)
    // …and the sender lines it must not flag.
    expect(buildsExpectedBearer("        Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,")).toBe(false)
    expect(buildsExpectedBearer("      headers: { Authorization: `Bearer ${env.SYNC_SECRET_KEY}` },")).toBe(false)
  })

  it("routes every SYNC_SECRET_KEY bearer check through a constant-time helper", () => {
    const offenders: string[] = []
    for (const file of files) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (isComment(line)) return
        if (buildsExpectedBearer(line)) offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
