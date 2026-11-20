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
// off with the `release:approved` label, or until the area's gate (AREA_GATES
// below) is green on the PR's head. Each one maps to a forbidden outcome
// (RELEASE-RISK-GATES.md):
//   events          bad events in the append-only log; lost or corrupted edits
//   offline-sync    offline sync dropping changes
//   auth            one organization seeing another's data; broken permissions
//   migration       a schema change production's code has not met yet
//   infra           the deploy machinery itself, and the gates' own machinery
//   release-tooling the scripts that decide what ships and when (planner, cut,
//                   deploy check); split out of infra on 2026-11-19 because
//                   they can be proven by a dry run and infra cannot
//   deps            a worker's dependency set; split out of infra on
//                   2026-11-19 (28 of the 122 infra touches since 2026-11-01
//                   were a worker's package.json or lockfile, most of them a
//                   version bump)
export const HOLDING_AREAS = new Set(["events", "offline-sync", "auth", "migration", "infra", "release-tooling", "deps"])

// Noted on the release notes and the PR labels so a person can see them,
// but not holding on their own:
//   export   published output (USFM/IDML/DOCX/…) — covered by roundtrip
//            suites; the 2026-10-30 meeting did not put it on the list
//   sync     the rest of sync-worker (audio, comments, search, …)
//   ci       a workflow that is neither on the web release line nor a gate
//            (OFF_LINE_WORKFLOW). GitHub runs these from dev the moment they
//            merge, so keeping one out of a release slice protected nothing:
//            the hold only delayed the unrelated files in the same PR.

// Workflows that neither deploy the web app, decide a release, nor run a
// gate or a required check. Listed by name, so a new workflow holds as infra
// until someone decides it belongs here.
const OFF_LINE_WORKFLOW =
  /^\.github\/workflows\/(tauri-[a-z-]+|desktop-release-[a-z-]+|dependency-audit|audio-delta-sync|dev-neon-refresh|adversarial-jev|notify-help-bot|e2e-hetzner)\.yml$/
const WORKFLOW = /^\.github\/workflows\//

// The order is the order areas print in. A file can land in several.
const AREA_PATTERNS = [
  ["migration", /^db\/postgres\/(migrations\/|schema\.sql$)/],
  [
    "infra",
    /(^|\/)wrangler\.toml$|^config\/cloudflare-deployments\.json$|^scripts\/(cloudflare-|verify-|resolve-deployment|tag-release|tag-metadata|record-github-deployment|assert-workers-build-env|ci-build|release-risk)/,
  ],
  // What ships and when: the planner, the cut, the deploy check, the stall
  // and hold reports. release-risk* stays infra above: it is the file map
  // itself, and no dry run of today's queue proves a path was not dropped.
  ["release-tooling", /^scripts\/release-(?!risk)/],
  ["deps", /^(sync-worker|auth-worker)\/(package\.json|pnpm-lock\.yaml)$/],
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
  // Filled in by classifyFiles (a workflow is infra or ci, never both); the
  // pattern here never matches and only gives the area its place in AREAS.
  ["ci", /^$/],
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
// runs through (the PGlite seed is one), the sync-worker test config, and
// the corpus tooling. A worker's package.json and lockfile used to be here
// too; they are the `deps` area now, whose gate checks exactly what made
// them machinery (the test engine's own versions, and nothing but version
// fields changing).
//
// The auth matrix (auth-worker + sync-worker permission-matrix/) runs through
// the same sync-worker chain plus auth-worker's own: its PGlite env, the
// shared access fixture, the setup file, and the vitest/tsconfig set.
// db/shared/test-lane-fill.ts is the lane trigger both harness databases
// install.
//
// The offline gate is one directory (src/lib/sync/offline-gate/), and the
// scripted gates (migration, deps, plan diff) are scripts/gate-*.
const GATE_MACHINERY =
  /^sync-worker\/replay-corpus\/|^sync-worker\/src\/__tests__\/(replay-corpus\.test\.ts$|permission-matrix\.test\.ts$|helpers\/)|^sync-worker\/(vitest\.config\.[cm]?[jt]s|tsconfig[^/]*\.json)$|^scripts\/replay-corpus|^(auth-worker|sync-worker)\/permission-matrix\/|^auth-worker\/src\/__tests__\/(permission-matrix\.test\.ts$|setup-migrations\.ts$|helpers\/)|^auth-worker\/(vitest\.config\.[cm]?[jt]s|tsconfig[^/]*\.json)$|^db\/shared\/test-lane-fill\.ts$|^src\/lib\/sync\/offline-gate\/|^scripts\/gate-/

export function classifyFiles(files) {
  const areas = new Set()
  for (const file of files) {
    if (GATE_MACHINERY.test(file)) {
      areas.add("infra")
      continue
    }
    if (TEST_FILE.test(file)) continue
    if (WORKFLOW.test(file)) {
      areas.add(OFF_LINE_WORKFLOW.test(file) ? "ci" : "infra")
      continue
    }
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
//   auth   → auth-matrix (risk-label.yml): every (principal × guarded route)
//            request through both workers' handlers answers the status the
//            committed goldens pin (auth-worker/ and sync-worker/
//            permission-matrix/golden.json). The job also fails when either
//            golden changes in the PR, so an intentional permission change
//            still goes to a person.
//   offline-sync → offline-gate (risk-label.yml): the real outbox and both of
//            its drains run a table of scripted faults against a fake server;
//            every enqueued event must end accepted, still queued, or held by
//            a documented rule, and the per-scenario outcome must equal
//            src/lib/sync/offline-gate/golden.json.
//   migration → migration-gate (risk-label.yml, scripts/gate-migration.ts):
//            every statement the PR's migrations add is one production's
//            current code cannot notice (additive only), the migrations
//            turn the base schema into the committed schema.sql, and the
//            BASE commit's replay corpus and permission matrix still answer
//            their goldens on the new schema. Counts only while the
//            AUTO_MIGRATE repository variable is `on` (GATE_SWITCHES): a
//            green gate ships the PR, so the deploy has to be allowed to
//            apply the migration itself.
//   release-tooling → plan-diff (risk-label.yml, scripts/gate-plan-diff.mjs):
//            the base commit's own tests pass against the PR's scripts, and
//            the PR's planner and deploy check answer today's queue exactly
//            as the base's do. A change that moves either goes to a person.
//   deps   → deps-gate (risk-label.yml, scripts/gate-deps.mjs): only version
//            fields changed, the test engine's own packages did not, and
//            both goldens above still hold on the new set.
export const AREA_GATES = {
  events: "replay-gate",
  auth: "auth-matrix",
  "offline-sync": "offline-gate",
  migration: "migration-gate",
  "release-tooling": "plan-diff",
  deps: "deps-gate",
}

// A gate that only counts while a repository variable is `on`: the kill
// switch for a gate whose green result makes the line do something new.
// The planner reads the variable from its environment (release-cut.yml).
export const GATE_SWITCHES = { migration: "AUTO_MIGRATE" }

/** Whether a green run of `area`'s gate may lift the hold, given the environment. */
export function gateEnabled(area, env = process.env) {
  const variable = GATE_SWITCHES[area]
  return variable === undefined || env[variable] === "on"
}

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
