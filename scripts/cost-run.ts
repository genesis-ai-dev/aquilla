// cost-run — drive a project-wide autopilot run to completion against the
// local dev stack, for the cost-meter experiment.  DEV TOOLING.
//
//   npx tsx scripts/cost-run.ts <projectId> [--resume-only] [--poll 15]
//
// Why this exists: selfTickLoop stops after MAX_WAVES_PER_LOOP and PARKS the
// run. In production a 5-minute cron sweep adopts parked runs, but Miniflare
// does not fire scheduled Workers ("Miniflare 3 does not currently trigger
// scheduled Workers automatically"), so on the dev stack a parked run simply
// sits there. This polls and re-kicks it until the run settles.

const IDENTITY = process.env.DEV_IDENTITY_URL ?? "http://127.0.0.1:8788"

const argv = process.argv.slice(2)
const projectId = argv.find((a) => !a.startsWith("--"))
if (!projectId) {
  console.error("usage: npx tsx scripts/cost-run.ts <projectId> [--resume-only] [--poll <seconds>]")
  process.exit(1)
}
const RESUME_ONLY = argv.includes("--resume-only")
const POLL_S = Number(argv[argv.indexOf("--poll") + 1]) || 15

const SETTLED = new Set(["done", "failed", "terminated"])
/** Statuses a re-kick can move forward. 'pausing' is a human's pause landing —
 *  never fight it; the driver exits and leaves the run to the operator. */
const RESUMABLE = new Set(["paused", "parked"])
/** A 'running' run whose heartbeat is older than this has lost its driver.
 *  `updated_at` doubles as the heartbeat and is touched per wave, so this must
 *  exceed the slowest realistic wave or the driver will interrupt live work. */
const STRANDED_AFTER_MS = 4 * 60 * 1000

interface RunSnapshot {
  runId: string
  status: string
  done: number
  total: number
  failed: number
  unitsSpent: number
  callsSpent: number
  lastError: string | null
  /** Doubles as the driver heartbeat — see STRANDED_AFTER_MS. */
  updatedAt: string
}

async function login(): Promise<string> {
  const res = await fetch(`${IDENTITY}/__dev__/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
  if (!res.ok) throw new Error(`dev login failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { access_token: string }).access_token
}

async function api(token: string, path: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${IDENTITY}/api/v2/projects/${projectId}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** Newest non-settled run, or the newest run overall. */
async function activeRuns(token: string): Promise<RunSnapshot[]> {
  const res = await api(token, `/contextual/overview`)
  if (!res.ok) throw new Error(`overview failed: ${res.status} ${await res.text()}`)
  const overview = (await res.json()) as { files?: { fileId: string }[] }
  const out: RunSnapshot[] = []
  for (const f of overview.files ?? []) {
    const r = await api(token, `/contextual/runs?fileId=${encodeURIComponent(f.fileId)}`)
    if (!r.ok) continue
    const snap = (await r.json()) as { run?: RunSnapshot | null }
    if (snap.run) out.push(snap.run)
  }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const token = await login()

  if (!RESUME_ONLY) {
    const res = await api(token, `/contextual/runs`, "POST", { scope: "project" })
    const text = await res.text()
    if (!res.ok) {
      // 409-ish: an active run already exists. That is not an error for this
      // driver — fall through and drive whatever is already going.
      console.log(`start returned ${res.status}: ${text.slice(0, 200)}`)
      console.log("continuing with any run already in flight…")
    } else {
      console.log(`started: ${text.slice(0, 300)}`)
    }
  }

  let lastLine = ""
  let idleTicks = 0
  for (;;) {
    await sleep(POLL_S * 1000)
    let runs: RunSnapshot[]
    try {
      runs = await activeRuns(token)
    } catch (err) {
      console.log(`poll error (continuing): ${String(err).slice(0, 160)}`)
      continue
    }
    if (runs.length === 0) {
      if (++idleTicks > 4) { console.log("no runs visible — exiting"); return }
      continue
    }
    idleTicks = 0

    // A run whose span cursor is exhausted PARKS rather than reaching 'done'.
    // Resuming it just parks it again, so status alone is not a stop condition —
    // without this the driver re-kicks a finished run forever.
    const live = runs.filter(
      (r) => !SETTLED.has(r.status) && !(r.total > 0 && r.done + r.failed >= r.total),
    )
    const exhausted = runs.filter(
      (r) => !SETTLED.has(r.status) && r.total > 0 && r.done + r.failed >= r.total,
    )
    for (const r of exhausted) {
      console.log(`  ${r.runId.slice(0, 8)} exhausted: ${r.done} done, ${r.failed} failed of ${r.total} — not re-kicking`)
    }
    for (const r of runs) {
      const line =
        `${r.status.padEnd(11)} ${r.done}/${r.total} spans` +
        `${r.failed ? ` (${r.failed} failed)` : ""} ` +
        `units=${r.unitsSpent} calls=${r.callsSpent}` +
        (r.lastError ? `  err=${r.lastError.slice(0, 90)}` : "")
      if (line !== lastLine) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`); lastLine = line }
    }

    for (const r of live) {
      if (RESUMABLE.has(r.status)) {
        const res = await api(token, `/contextual/runs/${r.runId}/resume`, "POST")
        console.log(`  re-kicked ${r.runId.slice(0, 8)} (was ${r.status}) -> ${res.status}`)
        continue
      }
      // Stranded: 'running' but the driver died (a worker hot-reload kills the
      // in-flight selfTickLoop). Production's 5-minute cron sweep adopts these;
      // Miniflare never fires scheduled Workers, so nothing rescues it here and
      // the run sits at 'running' forever. Detect via a stale heartbeat.
      if (r.status === "running") {
        const quietMs = Date.now() - new Date(r.updatedAt).getTime()
        if (quietMs > STRANDED_AFTER_MS) {
          console.log(
            `  ${r.runId.slice(0, 8)} stranded (no heartbeat for ${Math.round(quietMs / 1000)}s) — pausing to make it resumable`,
          )
          await api(token, `/contextual/runs/${r.runId}/pause`, "POST")
          const res = await api(token, `/contextual/runs/${r.runId}/resume`, "POST")
          console.log(`  re-kicked ${r.runId.slice(0, 8)} -> ${res.status}`)
        }
      }
    }

    if (live.length === 0) {
      console.log("all runs settled.")
      for (const r of runs) console.log(`  ${r.runId.slice(0, 8)} ${r.status} ${r.done}/${r.total} failed=${r.failed}`)
      return
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
