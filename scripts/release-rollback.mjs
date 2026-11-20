// The rollback watch: what stands behind a release that no person looked
// at. docs/RELEASE-RISK-GATES.md listed "automatic rollback on error-rate
// rise" as an open item from the first day of the hourly line; it became
// the precondition for shipping PRs nobody walked (release-plan.mjs,
// WALK_POLICY), because "fix it forward next hour" is only an answer when
// something notices within minutes that there is something to fix.
//
// Three commands, run by release-deploy.yml around the deploy:
//
//   snapshot <out.json>   BEFORE the deploy. Records, per production Worker,
//                         the one version serving 100% of traffic. That is
//                         what a rollback promotes back.
//   watch <snapshot.json> AFTER the deploy. For WATCH_MINUTES it compares
//                         each Worker's failed-invocation rate since the
//                         deploy with its rate over the hour before, from
//                         Cloudflare's Workers analytics, then probes the
//                         live environment once. Prints one JSON decision.
//   rollback <snapshot.json>
//                         Promotes every recorded version back to 100%, the
//                         same `wrangler versions deploy <id>@100%` the
//                         deploy itself uses. All surfaces together: they
//                         shipped as one release and are only known to work
//                         with each other as they were.
//
// `watch` rolls back by itself only while AUTO_ROLLBACK is `on`. Otherwise
// it is in observe mode: it prints the decision it would have acted on and
// the workflow posts it. That is how this ships (docs/SELF-DRIVING-ROUTINES.md:
// record before you enforce): the thresholds below are a first guess, and a
// rollback is a production change.
//
// What the signal is, and is not. `errors` in workersInvocationsAdaptive
// counts invocations that failed (an uncaught exception, a resource limit).
// A handler that catches its error and answers 500 is a successful
// invocation and is not counted. So this catches a release that throws, not
// one that answers wrong; the live probe at the end catches the routes the
// deploy's own checks cover. Neither sees a subtle wrong answer. A schema
// change is not rolled back: only additive migrations apply themselves
// (gate-migration.ts), and the previous code runs on those by construction.
//
// Environment: CLOUDFLARE_API_TOKEN (Workers deploy, and Account Analytics
// read for `watch`), CLOUDFLARE_ACCOUNT_ID, AUTO_ROLLBACK, WATCH_MINUTES
// (default 10), DEPLOYED_AT (ISO; default: when `watch` starts).
import { execFile } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

export const SURFACES = ["web", "sync", "identity"]
export const DEFAULT_WATCH_MINUTES = 10
/** Below this many invocations since the deploy, a rate is noise, not a signal. */
export const MIN_REQUESTS = 200
/** A release is never rolled back under this failed-invocation rate, whatever the baseline. */
export const RATE_FLOOR = 0.05
/** …and only when the rate is this many times the hour before the deploy. */
export const RATE_FACTOR = 3

const rate = (sample) => (sample && sample.requests > 0 ? sample.errors / sample.requests : 0)

/**
 * One Worker's verdict from its failed-invocation counts before and after the
 * deploy. `no-signal` is not a pass: it means analytics could not say.
 */
export function workerVerdict({ before, after }) {
  if (!after) return { verdict: "no-signal", why: "analytics returned nothing for the time since the deploy" }
  if (after.requests < MIN_REQUESTS) return { verdict: "quiet", why: `${after.requests} invocations since the deploy; fewer than ${MIN_REQUESTS} decides nothing` }
  const threshold = Math.max(RATE_FLOOR, RATE_FACTOR * rate(before))
  const now = rate(after)
  const percent = (value) => `${(value * 100).toFixed(1)}%`
  const detail = `${after.errors} of ${after.requests} invocations failed (${percent(now)}); the hour before: ${percent(rate(before))}; limit ${percent(threshold)}`
  return now >= threshold ? { verdict: "bad", why: detail } : { verdict: "ok", why: detail }
}

/**
 * The release's decision from every Worker's verdict and the live probe.
 * One bad Worker, or a failed probe, rolls the release back. With no bad
 * signal, a Worker analytics could not see leaves the release in place and
 * says so: a blind watch must never read as a clean one.
 */
export function decideRollback({ workers, probe }) {
  const bad = workers.filter((worker) => worker.verdict === "bad")
  if (bad.length) return { action: "rollback", reason: bad.map((worker) => `${worker.worker}: ${worker.why}`).join("; ") }
  if (probe && !probe.ok) return { action: "rollback", reason: `live check failed after the watch: ${probe.why}` }
  const blind = workers.filter((worker) => worker.verdict === "no-signal")
  if (blind.length) return { action: "no-signal", reason: blind.map((worker) => `${worker.worker}: ${worker.why}`).join("; ") }
  return { action: "none", reason: workers.map((worker) => `${worker.worker}: ${worker.why}`).join("; ") }
}

/** The version a `wrangler deployments status --json` document says serves all traffic, or null. */
export function activeVersion(deployment) {
  const traffic = deployment?.versions
  if (!Array.isArray(traffic) || traffic.length !== 1 || traffic[0]?.percentage !== 100) return null
  return typeof traffic[0].version_id === "string" ? traffic[0].version_id : null
}

/** What `rollback` has to promote: every surface whose recorded version is not the one serving now. */
export function rollbackPlan(snapshot, current) {
  return snapshot.surfaces
    .filter((entry) => entry.versionId && current[entry.surface] !== entry.versionId)
    .map(({ surface, worker, directory, versionId }) => ({ surface, worker, directory, versionId }))
}

const run = promisify(execFile)

async function wrangler(args, cwd) {
  const { stdout } = await run("pnpm", ["exec", "wrangler", ...args], { cwd, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

// The Worker names come from this file's own manifest; the directories are
// resolved against the working directory. release-deploy.yml runs this copy
// (dev's, from the workflow's commit) inside the release branch's checkout,
// which is where wrangler and that release's wrangler.toml are.
async function surfaces() {
  const { REPO_ROOT, deploymentExpectation } = await import("./cloudflare-deployment-manifest.mjs")
  return SURFACES.map((surface) => {
    const { worker, directory } = deploymentExpectation(surface, "production")
    return { surface, worker, directory: path.resolve(process.cwd(), path.relative(REPO_ROOT, directory)) }
  })
}

async function servingVersion({ worker, directory }) {
  return activeVersion(JSON.parse(await wrangler(["deployments", "status", `--name=${worker}`, "--json"], directory)))
}

const ANALYTICS_QUERY = `query ($account: string!, $script: string!, $since: Time!, $until: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }) {
      sum { requests errors }
    }
  } }
}`

/** { requests, errors } for one Worker over a window, or null when analytics would not answer. */
async function invocations(worker, since, until) {
  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: ANALYTICS_QUERY, variables: { account: process.env.CLOUDFLARE_ACCOUNT_ID, script: worker, since, until } }),
    })
    const body = await response.json()
    if (!response.ok || body.errors?.length) {
      console.error(`[rollback] analytics for ${worker}: HTTP ${response.status} ${JSON.stringify(body.errors ?? "").slice(0, 300)}`)
      return null
    }
    const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive
    if (!Array.isArray(rows)) return null
    // No row is a window with no invocations, which is an answer.
    return { requests: rows[0]?.sum?.requests ?? 0, errors: rows[0]?.sum?.errors ?? 0 }
  } catch (error) {
    console.error(`[rollback] analytics for ${worker}: ${error.message}`)
    return null
  }
}

async function liveProbe() {
  try {
    const { verifyLiveEnvironment } = await import("./verify-live-environment.mjs")
    await verifyLiveEnvironment("production", { log: () => {} })
    return { ok: true }
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) }
  }
}

async function promote(plan, message) {
  for (const { worker, directory, versionId } of plan) {
    console.error(`[rollback] ${worker} → ${versionId}`)
    await wrangler(["versions", "deploy", `${versionId}@100%`, "--env=production", "--message", message, "--yes"], directory)
  }
}

async function watch(snapshot) {
  const minutes = Number(process.env.WATCH_MINUTES) || DEFAULT_WATCH_MINUTES
  const deployedAt = new Date(process.env.DEPLOYED_AT || Date.now())
  const hourBefore = new Date(deployedAt.getTime() - 3_600_000).toISOString()
  const until = deployedAt.getTime() + minutes * 60_000
  const baseline = new Map()
  for (const { worker } of snapshot.surfaces) baseline.set(worker, await invocations(worker, hourBefore, deployedAt.toISOString()))

  // Read every minute so a release that throws on most requests is rolled
  // back in the first minutes, not at the end of the watch.
  let workers = []
  for (;;) {
    workers = []
    for (const { worker } of snapshot.surfaces) {
      const after = await invocations(worker, deployedAt.toISOString(), new Date().toISOString())
      workers.push({ worker, ...workerVerdict({ before: baseline.get(worker), after }) })
    }
    if (workers.some((entry) => entry.verdict === "bad") || Date.now() >= until) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, Math.max(1_000, until - Date.now()))))
  }
  const probe = workers.some((entry) => entry.verdict === "bad") ? undefined : await liveProbe()
  return { ...decideRollback({ workers, probe }), workers, watchedMinutes: Math.round((Date.now() - deployedAt.getTime()) / 60_000) }
}

async function main() {
  const [command, file] = process.argv.slice(2)
  if (command === "snapshot" && file) {
    const entries = []
    for (const entry of await surfaces()) entries.push({ ...entry, versionId: await servingVersion(entry).catch(() => null) })
    writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), surfaces: entries }, null, 2))
    console.log(JSON.stringify(entries.map(({ worker, versionId }) => ({ worker, versionId }))))
    return
  }
  if ((command === "watch" || command === "rollback") && file) {
    const snapshot = JSON.parse(readFileSync(file, "utf8"))
    const decision = command === "watch" ? await watch(snapshot) : { action: "rollback", reason: "asked for by hand" }
    const acting = command === "rollback" || process.env.AUTO_ROLLBACK === "on"
    let rolledBack = []
    if (decision.action === "rollback" && acting) {
      const current = {}
      for (const entry of snapshot.surfaces) current[entry.surface] = await servingVersion(entry).catch(() => null)
      const plan = rollbackPlan(snapshot, current)
      await promote(plan, `rollback: ${decision.reason}`.slice(0, 100))
      rolledBack = plan.map(({ worker, versionId }) => ({ worker, versionId }))
    }
    console.log(JSON.stringify({ ...decision, mode: acting ? "act" : "observe", rolledBack }))
    return
  }
  console.error("usage: release-rollback.mjs snapshot <out.json> | watch <snapshot.json> | rollback <snapshot.json>")
  process.exit(2)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
