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
  // OPS-49: the ONE authorization decision made by all three progress-sync
  // routers (monday / airtable / langquest). Their MAINTAINER floors do not
  // guard a row — they guard WHERE a project's progress leaves Aquilla and ON
  // WHOSE credential. A link written here outlives the session and the
  // five-minute cron keeps pushing project names, languages, completion
  // figures and the `translators` username list to the configured third party,
  // so an un-elevated admin could open a standing egress channel on any
  // tenant. The member-level status read (minRole == null) is NOT narrowed,
  // per AQU-2003.
  "auth-worker/src/routes/_integration-helpers.ts": [
    "roleWithoutUnelevatedAdmin",
    "orgLevelWithoutUnelevatedAdmin",
  ],
}

/** The routers whose only authorization decision is that shared guard pair. */
const INTEGRATION_ROUTERS = [
  "auth-worker/src/routes/monday.ts",
  "auth-worker/src/routes/airtable.ts",
  "auth-worker/src/routes/langquest.ts",
]

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

  it("the integration guards narrow an asserted floor and leave the status read open (OPS-49)", () => {
    const src = stripComments(read("auth-worker/src/routes/_integration-helpers.ts"))
    // Both guards answer the member-level read BEFORE de-escalating, so
    // AQU-2003's cross-tenant read-only posture is unchanged...
    expect(src.match(/if \(minRole == null\) return/g) ?? []).toHaveLength(2)
    // ... and narrow on every path that asserts one.
    expect(src).toContain("orgLevelWithoutUnelevatedAdmin(c, orgId, user, effective)")
    expect(src).toContain("roleWithoutUnelevatedAdmin(c, user, projectId, role)")
  })

  it("the integration routers make no authorization decision of their own (OPS-49)", () => {
    // If a route in one of these files resolved a role directly it would skip
    // the gate above, so the guard pair would stop being the whole story.
    for (const file of INTEGRATION_ROUTERS) {
      const src = stripComments(read(file))
      for (const resolver of [
        "resolveProjectRole",
        "getEffectiveOrgRole",
        "getOrgMemberRole",
      ]) {
        expect(`${file}: ${resolver}`).toBe(
          `${file}: ${src.includes(resolver) ? `UNGATED ${resolver}` : resolver}`,
        )
      }
    }
  })

  it("the de-escalation helpers only ever NARROW, never widen", () => {
    const gate = stripComments(read("auth-worker/src/services/elevation-gate.ts"))
    // Both helpers must return the de-escalated answer on the un-elevated
    // branch; an early `return callerRole` after the elevation check would
    // silently restore admin power.
    // OPS-51 threads `opts` through so a caller that resolved with the archive
    // rule off (source-linking's router) does not de-escalate an operator who
    // genuinely owns a TRASHED project down to no access. Still the genuine
    // lookup on the un-elevated branch, which is what this pins.
    expect(gate).toContain("resolveGenuineProjectRole(c.env, user, projectId, opts)")
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

// ──────────────────────────────────────────────────────────────────────────
// OPS-52 (closes OPS-50 §1): the elevation census, as an assertion.
//
// OPS-45 measured how many auth-worker route modules make an elevation
// decision and how many make none; OPS-48 separated their writes from their
// reads and ranked what to decide next; OPS-50 found that the census method
// could not see a decision once AQU-804 moved it into a shared guard, and
// named the fix — "the census belongs in the drift guard, not in a document …
// making it an assertion that fails when a new undecided module appears is
// the follow-up, and it is the only thing that stops this ledger decaying
// between passes."
//
// This is that assertion. Every route module that reaches a role a platform
// operator can win must appear in LEDGER with one of three states:
//
//   "decides"    — makes the elevation decision itself. The assertion checks a
//                  decision symbol is still present, so a refactor that drops
//                  it fails here rather than in the next hand-run pass.
//   "delegates"  — its authorization is a helper that decides (OPS-49's guard
//                  pair). The assertion checks it resolves NO role of its own,
//                  so a new route in it cannot sidestep the guard.
//   "undecided"  — reaches platform-winnable power and makes no elevation
//                  decision. NOT a clean bill: it is the open queue, carried
//                  here so it is counted rather than re-derived. OPS-48's
//                  ranked writes are annotated.
//
// A module that is in none of the three fails the first assertion. That is the
// whole point: the next route to reach a platform-winnable role cannot default
// into the undecided set silently.
//
// What this does NOT claim: that an "undecided" module is safe, or that a
// "decides" module decided correctly. It is a coverage ledger over source
// text. The behavioural tests are the per-finding suites
// (admin-membership-elevation, merge-sibling, changeset-approval-elevation,
// integration-guard-elevation, source-linking-elevation).
// ──────────────────────────────────────────────────────────────────────────

/** Resolvers that can hand back a role a platform operator wins (level 700). */
const PLATFORM_WINNABLE_RESOLVERS = [
  "resolveProjectRole",
  "resolveProjectRoleIncludingArchived",
  "resolveProjectRoles",
  "resolveOrgWriteRole",
  "getEffectiveOrgRole",
  "isPlatformAdmin",
] as const

/** Symbols that constitute making an elevation decision. */
const DECISION_SYMBOLS = [
  "roleWithoutUnelevatedAdmin",
  "orgLevelWithoutUnelevatedAdmin",
  "projectElevationDenial",
  "hasActiveElevation",
  "requireAdminElevation",
] as const

type LedgerState = "decides" | "delegates" | "undecided"

/**
 * One recorded state per route module. Paths are relative to
 * auth-worker/src/routes. Keep the comments: they are the decision, and the
 * next pass reads them before re-deciding anything.
 */
const LEDGER: Record<string, LedgerState> = {
  // ── decides (14) ───────────────────────────────────────────────────────
  "_integration-helpers.ts": "decides", // OPS-49, for all three routers below
  "access-links.ts": "decides",
  "agent-connect.ts": "decides",
  "changeset-approvals.ts": "decides", // OPS-47
  "credentials.ts": "decides", // OPS-44 (a PAT outlives the session)
  "invites.ts": "decides",
  "merge-sibling.ts": "decides", // OPS-44 (irreversible fold)
  "org-settings.ts": "decides", // D7 (the org's live vendor keys)
  "orgs.ts": "decides",
  "project-members.ts": "decides", // AQU-1322's original eleven
  "projects.ts": "decides", // AQU-1322
  "source-linking.ts": "decides", // OPS-51 (the hard delete, and the link)
  "sync-token.ts": "decides", // OPS-44 (the mint)
  "termbase-subscriptions.ts": "decides", // OPS-53 (the org's consent flag, and the standing Q19 grant)

  // ── delegates to _integration-helpers' guard pair (3) ──────────────────
  "airtable.ts": "delegates",
  "langquest.ts": "delegates",
  "monday.ts": "delegates",

  // ── undecided (33) — the open queue, not a clean bill ──────────────────
  // OPS-48's ranked remainder, with its write counts. source-linking.ts was
  // the head of this list and is now decided (OPS-51), and
  // termbase-subscriptions.ts was the next head and is now decided (OPS-53);
  // these seven are what OPS-48 left, in its order.
  "member-scopes.ts": "undecided", // OPS-48: 2 writes — and its `scopes` array is uncapped (cf. OPS-54)
  "knowledge.ts": "undecided", // OPS-48: 2 writes
  "team-handoffs.ts": "undecided", // OPS-48: 1 write
  "project-settings.ts": "undecided", // OPS-48: 1 write
  "ai-smart-edits.ts": "undecided", // OPS-48: 1 write
  "ai-interventions.ts": "undecided", // OPS-48: 1 write
  "agent-artifacts.ts": "undecided", // OPS-48: 1 write
  // The rest: reads, AI proxies and helpers OPS-48 did not rank as writes.
  // Unread by this series as elevation surfaces — which is the state this
  // ledger exists to keep visible, not a judgment that they are fine.
  "_contextual-helpers.ts": "undecided",
  "access-audit.ts": "undecided",
  "agent-memory.ts": "undecided",
  "agent-sessions.ts": "undecided",
  "agent.ts": "undecided",
  "ai-harmonize.ts": "undecided",
  "ai-passage-tags.ts": "undecided",
  "ai-seams.ts": "undecided",
  "ai-transcript-cleanup.ts": "undecided",
  "aquifer.ts": "undecided",
  "billing-workspace.ts": "undecided",
  "billing.ts": "undecided",
  "chat.ts": "undecided",
  "edit-history.ts": "undecided",
  "feedback.ts": "undecided",
  "import-classify.ts": "undecided",
  "import-recording-names.ts": "undecided", // #1763 (AQU-2302): resolves project + org roles, decides nothing
  "import-sandbox.ts": "undecided",
  "scene-briefs.ts": "undecided",
  "style-rules.ts": "undecided",
  "tools-build.ts": "undecided",
  "tools-web.ts": "undecided",
  "tools.ts": "undecided",
  "transcription.ts": "undecided",
  "usage.ts": "undecided",
  "users.ts": "undecided",
}

describe("the platform-elevation census is an assertion, not a document (OPS-52)", () => {
  const ROUTES = path.join(REPO, "auth-worker/src/routes")
  const routeRel = (p: string) => path.relative(ROUTES, p).replace(/\\/g, "/")
  const sources = new Map(
    walk(ROUTES).map((f) => [routeRel(f), stripComments(readFileSync(f, "utf8"))]),
  )

  /**
   * Reaches platform-winnable power: resolves such a role, delegates to a
   * shared guard that does, or makes an elevation decision about one.
   *
   * The third arm matters — routes/sync-token.ts resolves nothing itself (the
   * mint core does) and would otherwise fall out of the ledger entirely while
   * being the very path OPS-44 closed.
   */
  const reaches = (src: string): boolean =>
    PLATFORM_WINNABLE_RESOLVERS.some((r) => new RegExp(`\\b${r}\\s*\\(`).test(src)) ||
    /\b(orgGuard|projectGuard)\s*\(/.test(src) ||
    DECISION_SYMBOLS.some((d) => new RegExp(`\\b${d}\\s*\\(`).test(src))

  it("every route module that reaches platform-winnable power has a recorded state", () => {
    const found = [...sources]
      .filter(([, src]) => reaches(src))
      .map(([name]) => name)
      .sort()
    // Fails in BOTH directions on purpose: a new module that reaches a
    // platform-winnable role must be added with a state, and a module that
    // stops reaching one must be removed rather than left as a stale row.
    expect(found).toEqual(Object.keys(LEDGER).sort())
  })

  it("every module recorded as deciding still makes a decision", () => {
    for (const [name, state] of Object.entries(LEDGER)) {
      if (state !== "decides") continue
      const src = sources.get(name)
      expect(src, `${name} is in the ledger but not on disk`).toBeDefined()
      const decisions = DECISION_SYMBOLS.filter((d) =>
        new RegExp(`\\b${d}\\s*\\(`).test(src as string),
      )
      expect(`${name}: ${decisions.join(",") || "NO DECISION"}`).toBe(
        `${name}: ${decisions.join(",")}`,
      )
      expect(decisions.length, `${name} records "decides" but makes no decision`).toBeGreaterThan(0)
    }
  })

  it("every module recorded as delegating resolves no role of its own", () => {
    // Same rule as the OPS-49 pin above, applied from the ledger so a fourth
    // delegating router inherits it without a new test.
    for (const [name, state] of Object.entries(LEDGER)) {
      if (state !== "delegates") continue
      const src = sources.get(name) as string
      const own = PLATFORM_WINNABLE_RESOLVERS.filter((r) =>
        new RegExp(`\\b${r}\\s*\\(`).test(src),
      )
      expect(`${name}: ${own.length ? `UNGATED ${own.join(",")}` : "delegates"}`).toBe(
        `${name}: delegates`,
      )
    }
  })

  it("every module recorded as undecided still makes no decision", () => {
    // The other direction: a module that quietly STARTS deciding should be
    // promoted in the ledger, so the count below stays true and the next pass
    // does not spend its budget re-deciding something already closed.
    for (const [name, state] of Object.entries(LEDGER)) {
      if (state !== "undecided") continue
      const src = sources.get(name) as string
      const decisions = DECISION_SYMBOLS.filter((d) =>
        new RegExp(`\\b${d}\\s*\\(`).test(src),
      )
      expect(`${name}: ${decisions.length ? `NOW DECIDES (${decisions.join(",")})` : "undecided"}`).toBe(
        `${name}: undecided`,
      )
    }
  })

  it("the count is what the review series last reported", () => {
    const tally = (s: LedgerState) => Object.values(LEDGER).filter((v) => v === s).length
    // 10-26 re-measured 13 of 48 covered (deciding, or delegating to a guard
    // that decides) by exactly this method. OPS-51 adds source-linking.ts and
    // the denominator is 49: 16 of 49.
    // 11-05: #1763 adds import-recording-names.ts (undecided); 16 of 50.
    // 11-09: OPS-53 promotes termbase-subscriptions.ts; 17 of 50.
    expect({ decides: tally("decides"), delegates: tally("delegates"), undecided: tally("undecided") })
      .toEqual({ decides: 14, delegates: 3, undecided: 33 })
    expect(tally("decides") + tally("delegates") + tally("undecided")).toBe(
      Object.keys(LEDGER).length,
    )
  })
})
