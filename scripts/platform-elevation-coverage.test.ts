// Platform-admin elevation coverage drift guard (OPSEC review 2026-10-12, OPS-44).
//
// WHY THIS EXISTS. `resolveProjectRole` gives every platform operator level 700
// on every project in every org, and a sync token minted on that path carries
// `src: "platform"` — the claim the sync-worker treats as its one blanket
// exemption from the live membership re-check and the lane read wall. So one
// mint on admin authority yields cross-tenant read AND write on draft content
// (D2) and the membership graph (D3), reaching further than anything the admin
// console's own step-up gate protects.
//
// AQU-1322 established the rule that fixes this — "admin power applies only
// while elevated" — but applied it to eleven grant-management writes and not to
// the two paths that hand out that capability: the sync-token mint and the
// merge-sibling fold. OPS-44 closed both. This test keeps them closed, and
// keeps the blast radius of a platform-source token visible:
//
//   * every module that signs a sync token with a role-derived `src` is listed
//     in MINTERS with the gate that covers it, and that gate is still present;
//   * every caller of mintSyncTokenForUser has made an explicit decision about
//     `platformElevated`, so a new caller cannot default into the admin path;
//   * the sync-worker sites that exempt `src: "platform"` match EXEMPTIONS, so
//     a new exemption widens the radius visibly rather than silently.
//
// AQU-2003 NARROWED the sync-token mint (Ryder + Matthew, 2026-10-16): the
// browser route now mints an UN-elevated, platform-only caller a Viewer (100)
// token that keeps `src: "platform"`, so a platform admin can open another
// tenant's project read-only. User-content writes are refused by the
// sync-worker's role floors plus the explicit platform-view rule in
// events/authorize.ts (the link-sync trigger is the one exception, and writes
// only server-authored mirror data). Elevation re-mints at the full level. The server-side agent harness does not
// opt in and still fails closed. MINT_CALLERS below records which is which.
//
// This is a coverage ledger over source text, not a runtime assertion. The
// behavioural tests are auth-worker/src/__tests__/admin-membership-elevation.test.ts
// ("sync-token mint (OPS-44)") and .../merge-sibling.test.ts ("admin power
// needs elevation (OPS-44)").

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

const REPO = path.resolve(import.meta.dirname, "..")

/** Strip block and line comments so a doc comment naming a pattern is not a hit. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue
      out.push(...walk(full))
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full)
    }
  }
  return out
}

const rel = (p: string) => path.relative(REPO, p).replace(/\\/g, "/")
const read = (p: string) => readFileSync(path.join(REPO, p), "utf8")

/**
 * Modules that sign a sync token whose `src` claim comes from a resolved role —
 * i.e. that can emit `src: "platform"` — mapped to the gate that covers them.
 * services/source-linking.ts signs a token too but sets NO `src`, so it carries
 * no exemption and is correctly absent.
 */
const MINTERS: Record<string, { gate: string; assert: (src: string) => void }> = {
  "auth-worker/src/services/sync-token-mint.ts": {
    gate: "refuses a platform-only grant path unless opts.platformElevated, or signs Viewer only (AQU-2003)",
    assert: (src) => {
      expect(src).toContain('resolved.source === "platform"')
      expect(src).toContain("platformElevated")
      expect(src).toContain("elevation_required")
      // AQU-2003: the only un-elevated platform token is Viewer (100), and it
      // is opt-in. A change that signs a higher level here breaks this pin.
      expect(src).toContain("platformViewWithoutElevation")
      expect(src).toMatch(/level:\s*100,\s*name:\s*roleNameFor\(100\)/)
    },
  },
  "auth-worker/src/services/merge-sibling.ts": {
    gate: "routes/merge-sibling.ts strips un-elevated admin power on BOTH sides",
    assert: () => {
      const route = stripComments(read("auth-worker/src/routes/merge-sibling.ts"))
      // Once for the host project, once for the donor.
      expect(route.match(/roleWithoutUnelevatedAdmin\(/g) ?? []).toHaveLength(2)
    },
  },
}

/** Callers of the mint core, and the decision each has made about admin power. */
const MINT_CALLERS: Record<string, "gated" | "closed"> = {
  // Passes the request's live elevation through, so an elevated operator keeps
  // the cross-tenant path and an un-elevated one is demoted to their genuine
  // role. AQU-2003: with no genuine role, it gets a Viewer-only platform token
  // (opts.platformViewWithoutElevation), never the 700 one.
  "auth-worker/src/routes/sync-token.ts": "gated",
  // A server-side agent harness has no session to elevate, so it never asserts
  // elevation, never opts into the Viewer view (it can write), and the
  // platform path simply fails closed.
  "auth-worker/src/lib/agent/command-tools.ts": "closed",
}

/** sync-worker checks that treat `src: "platform"` as exempt. This is the reach. */
const EXEMPTIONS: Record<string, number> = {
  // 2 exemptions + 1 AQU-2003 restriction (refusePlatformView: a platform
  // token below Contributor writes nothing). The count is the grep, not the reach.
  "sync-worker/src/events/authorize.ts": 3,
  "sync-worker/src/events/route.ts": 1,
  "sync-worker/src/events/merge-sibling-route.ts": 1,
  "sync-worker/src/events/plan-route.ts": 1,
  "sync-worker/src/events/lane-read-wall.ts": 1,
}

describe("platform-source sync tokens are minted only behind elevation", () => {
  const authSrc = walk(path.join(REPO, "auth-worker/src"))

  it("every module that can emit src: \"platform\" is a declared minter", () => {
    const found = authSrc
      .filter((f) => {
        const src = stripComments(readFileSync(f, "utf8"))
        return (
          src.includes("sign(") &&
          /aud:\s*["']sync["']/.test(src) &&
          /^\s*src:/m.test(src)
        )
      })
      .map(rel)
      .sort()
    expect(found).toEqual(Object.keys(MINTERS).sort())
  })

  it.each(Object.entries(MINTERS))("%s is still gated (%s)", (file, { assert }) => {
    assert(stripComments(read(file)))
  })

  it("every caller of the mint core has decided about platformElevated", () => {
    const callers = authSrc
      .filter((f) => rel(f) !== "auth-worker/src/services/sync-token-mint.ts")
      .filter((f) => stripComments(readFileSync(f, "utf8")).includes("mintSyncTokenForUser("))
      .map(rel)
      .sort()
    expect(callers).toEqual(Object.keys(MINT_CALLERS).sort())
  })

  it.each(Object.entries(MINT_CALLERS))("%s honours its declared decision: %s", (file, decision) => {
    const src = stripComments(read(file))
    if (decision === "gated") {
      expect(src).toContain("platformElevated")
      expect(src).toContain("hasActiveElevation")
      // AQU-2003: the route is the ONE caller that opts into the Viewer view.
      expect(src).toContain("platformViewWithoutElevation: true")
    } else {
      // Must NOT quietly start asserting elevation it cannot observe.
      expect(src).not.toContain("platformElevated")
      // ... nor hand a write-capable harness a platform token of any level.
      expect(src).not.toContain("platformViewWithoutElevation")
    }
  })
})

/**
 * The paths OPS-44 closed beyond the sync-token mint: each hands out, or
 * discloses, something that OUTLIVES or ESCAPES the session, so a later
 * elevation check cannot reach it. Each must still de-escalate un-elevated
 * admin authority before deciding.
 */
const DE_ESCALATED: Record<string, readonly string[]> = {
  // A PAT outlives the session that minted it: an un-elevated admin could
  // otherwise hold a permanent cross-tenant credential, pii/act included.
  "auth-worker/src/routes/credentials.ts": [
    "roleWithoutUnelevatedAdmin",
    "orgLevelWithoutUnelevatedAdmin",
  ],
  // The unredacted branch returns the org's live vendor API keys (D7).
  "auth-worker/src/routes/org-settings.ts": ["hasActiveElevation", "getOrgMemberRole"],
  // Irreversible cross-tenant fold, both sides.
  "auth-worker/src/routes/merge-sibling.ts": ["roleWithoutUnelevatedAdmin"],
  // OPS-47: approving mints a changeset_confirmations row that the AGENT's
  // credential consumes later (sync-worker external/commit-gates.ts), so the
  // write lands on a principal no elevation check can reach — and it is the
  // ONE human gate in front of it. Rejecting and assigning write to another
  // tenant's staged plan directly. The read stays open, per AQU-2003.
  "auth-worker/src/routes/changeset-approvals.ts": ["roleWithoutUnelevatedAdmin"],
}

describe("admin authority is de-escalated on the paths that escape the session", () => {
  it.each(Object.entries(DE_ESCALATED))("%s still de-escalates", (file, symbols) => {
    const src = stripComments(read(file))
    for (const symbol of symbols) expect(src).toContain(symbol)
  })

  it("the changeset approval surface narrows its three WRITES and not its read (OPS-47)", () => {
    const src = stripComments(read("auth-worker/src/routes/changeset-approvals.ts"))
    // approve / reject pass narrowAdmin=true through the shared authority check;
    // the approval read passes false.
    expect(src).toContain('authorityDenied(c, user, cs, "approve", true)')
    expect(src).toContain('authorityDenied(c, user, cs, "reject", true)')
    expect(src).toContain('authorityDenied(c, user, cs, "view", false)')
    // assign resolves its own floor (the org's assignment policy), so it
    // narrows at its own call site rather than through authorityDenied.
    expect(src.match(/roleWithoutUnelevatedAdmin\(/g) ?? []).toHaveLength(2)
  })

  it("the de-escalation helpers only ever NARROW, never widen", () => {
    const gate = stripComments(read("auth-worker/src/services/elevation-gate.ts"))
    // Both helpers must return the de-escalated answer on the un-elevated
    // branch; an early `return callerRole` after the elevation check would
    // silently restore admin power.
    expect(gate).toContain("resolveGenuineProjectRole(c.env, user, projectId)")
    expect(gate).toContain("getOrgMemberRole(c.env, orgId, user.id)")
  })
})

describe("the reach of a platform-source token stays measured", () => {
  it("authorize() keeps the explicit read-only rule for the platform view token (AQU-2003)", () => {
    const src = stripComments(read("sync-worker/src/events/authorize.ts"))
    // Once for the project-scoped branch, once for the file-scoped branch.
    expect(src.match(/refusePlatformView\(tokenClaims\)/g) ?? []).toHaveLength(2)
    expect(src).toMatch(/claims\.src === 'platform' && claims\.role < ROLE\.CONTRIBUTOR/)
  })

  it("the sync-worker's platform exemptions match the ledger", () => {
    const counts: Record<string, number> = {}
    for (const f of walk(path.join(REPO, "sync-worker/src"))) {
      const hits = stripComments(readFileSync(f, "utf8")).match(
        /(===|!==)\s*['"]platform['"]/g,
      )
      if (hits) counts[rel(f)] = hits.length
    }
    expect(counts).toEqual(EXEMPTIONS)
  })
})
