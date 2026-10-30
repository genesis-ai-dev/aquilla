// Which production outcomes a change could cause, read off the files it
// touches. This is the one place the hourly release line decides "this PR
// needs a person": the planner (release-plan.mjs) keeps a PR off the
// automatic line when it touches a holding area, and the labeler workflow
// (risk-label.yml) puts the same areas on the PR as `risk:<area>` labels so
// reviewers see it at once. The forbidden outcomes behind the holding areas
// and the file map are written up in docs/RELEASE-RISK-GATES.md; change
// the two together.
//
// Deterministic by design: a path either matches or it does not. Nothing
// here reads the diff's content.

// Areas that keep a PR off the automatic hourly line until a person signs it
// off with the `release:approved` label. Each one maps to a forbidden
// outcome (RELEASE-RISK-GATES.md):
//   events       bad events in the append-only log; lost or corrupted edits
//   offline-sync offline sync dropping changes
//   auth         one organization seeing another's data; broken permissions
//   migration    a schema change (needs the hand-applied Neon migration)
//   infra        the deploy machinery itself
export const HOLDING_AREAS = new Set(["events", "offline-sync", "auth", "migration", "infra"])

// Noted on the release notes and the PR labels so a person can see them,
// but not holding on their own:
//   export   published output (USFM/IDML/DOCX/…) — covered by roundtrip
//            suites; the 2026-10-30 meeting did not put it on the list
//   sync     the rest of sync-worker (audio, comments, search, …)

// The order is the order areas print in. A file can land in several.
const AREA_PATTERNS = [
  ["migration", /^db\/postgres\/(migrations\/|schema\.sql$)/],
  [
    "infra",
    /(^|\/)wrangler\.toml$|^config\/cloudflare-deployments\.json$|^\.github\/workflows\/|^scripts\/(cloudflare-|verify-|resolve-deployment|tag-release|tag-metadata|record-github-deployment|assert-workers-build-env|ci-build|release-plan|release-cut|release-risk|release-deploy|release-verify)/,
  ],
  // The event log's write path: kinds, validation, head compare-and-swap,
  // projection, replay, and every importer that mints events. Read routes
  // under events/ ride along; splitting them out would mean naming each
  // one, and a read-route change that starts writing would slip through.
  [
    "events",
    /^sync-worker\/src\/(events\/|project-do(-types)?\.ts$|checking\/policy\.ts$)|^src\/lib\/sync\/(events-emit|chain|target-commit-parent|source-commit-chain|bulk-events|bulk-import|create-targets|settle-own-event|lane-write-rejections)\.ts$|^src\/lib\/import\.ts$|^db\/postgres\/schema\.sql$/,
  ],
  // The client's write buffer and the two paths that drain it.
  [
    "offline-sync",
    /^src\/lib\/sync\/(outbox|outbox-[a-z-]+|ws-reconciler|backoff|flush-applied|live-apply|confirmed-target-heads|cqrs-bridge)\.ts$|^src\/hooks\/useOutboxFlusher\.ts$/,
  ],
  // Every chokepoint a request passes through before it reads or writes
  // project data: session and token verification, membership and role
  // resolution, scopes, PAT credentials, admin secrets, and the shared
  // resolvers both workers use.
  [
    "auth",
    /^auth-worker\/src\/(index\.ts$|middleware\/|services\/(project-permissions|org-permissions|lane-grants|elevation-gate|sync-token-mint|access-payload|invite-scopes|team-roles|user-search-access)\.ts$|routes\/(auth|sync-token|project-members|member-scopes|invites|admin|admin-billing|credentials|access|access-links|access-audit|org-access|changeset-approvals|mcp-oauth|users|me)\.ts$)|^sync-worker\/src\/(auth\.ts$|admin\.ts$|index\.ts$|events\/(authorize|role-policy|membership|tool-provenance|lane-read-wall|export-floor)\.ts$|external\/(read-auth|token-bridge|org-read-routes|authority|identity-bridge|mcp-oauth-metadata)\.ts$|lib\/(service-auth|admin-auth|admin-secret)\.ts$)|^db\/shared\/(project-roles|access-grants|api-credentials|lane-visibility|lane-grants|workspace-access|visibility-floors)\.ts$|^db\/shim\//,
  ],
  [
    "export",
    /^src\/lib\/export\/|^packages\/idml-roundtrip\/|^src\/lib\/parsers\/usfm-lossless\/|^sync-worker\/src\/events\/(export-route|export-bundle-route|plaintext-export|usfm-export-plan)\.ts$/,
  ],
  ["sync", /^(sync-worker\/src\/|src\/lib\/sync\/)/],
]

export const AREAS = AREA_PATTERNS.map(([area]) => area)

// Test files never ship, so they never hold; the pattern above would
// otherwise hold a PR that only adds a sync-worker test.
const TEST_FILE = /\.test\.[jt]sx?$|^e2e\/|^sync-worker\/src\/__tests__\//

// The gates' own machinery: the harness, its corpus, its golden and the
// tooling around them. A PR that edits these can make its own gate pass,
// so they are infra (holding, no gate) and are checked BEFORE the test-file
// skip, since most of the harness lives under __tests__.
// "Executes" is the whole chain: the harness, every shared test helper it
// runs through (the PGlite seed is one), the sync-worker test config and
// dependency set, and the corpus tooling.
const GATE_MACHINERY = /^sync-worker\/replay-corpus\/|^sync-worker\/src\/__tests__\/(replay-corpus\.test\.ts$|helpers\/)|^sync-worker\/(vitest\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|package\.json|pnpm-lock\.yaml)$|^scripts\/replay-corpus/

export function classifyFiles(files) {
  const areas = new Set()
  for (const file of files) {
    if (GATE_MACHINERY.test(file)) {
      areas.add("infra")
      continue
    }
    if (TEST_FILE.test(file)) continue
    for (const [area, pattern] of AREA_PATTERNS) if (pattern.test(file)) areas.add(area)
  }
  const sorted = AREAS.filter((area) => areas.has(area))
  return { areas: sorted, pathHolds: sorted.some((area) => HOLDING_AREAS.has(area)) }
}

// A gate is a required check on the PR's head sha that proves the area's
// forbidden outcome did not happen for that change. Green, the area stops
// holding and the PR rides the hourly line like any other; this is how a
// high-risk area becomes low-risk by test rather than by a person. The
// check's name is what release-plan-walk.mjs reads off the check-runs API.
//   events → replay-gate (risk-label.yml): the corpus of real projects replays
//            to the committed golden projection (sync-worker/replay-corpus).
//            The job also fails when golden.json changes in the PR, so an
//            intentional projection change still goes to a person.
export const AREA_GATES = { events: "replay-gate" }

// The areas of `areas` that still hold once the gates in `passedGates` (area
// names) are taken off the list.
export function holdingAreas(areas, passedGates = []) {
  return areas.filter((area) => HOLDING_AREAS.has(area) && !passedGates.includes(area))
}

export const RISK_LABEL_PREFIX = "risk:"
export const APPROVED_LABEL = "release:approved"

export function riskLabelsFor(areas) {
  return areas.map((area) => `${RISK_LABEL_PREFIX}${area}`)
}
