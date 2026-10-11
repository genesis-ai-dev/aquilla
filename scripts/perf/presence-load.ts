#!/usr/bin/env tsx
/**
 * AQU-1868 — multi-client presence load against the seeded Big Bible project.
 *
 *   pnpm dev
 *   pnpm perf:seed
 *   pnpm perf:presence                     # 50 sockets, 20s
 *   pnpm perf:presence --sockets 100 --duration 60
 *
 * Reports how many sockets the project DO actually held, the frame rate each
 * one had to absorb, and ping/pong round-trip latency. Exits non-zero when
 * fewer sockets stayed open than were asked for — that is the capacity claim
 * the presence-tier work is measured against, so it fails loudly rather than
 * reporting a smaller number in passing.
 *
 * `pnpm perf:measure --presence` runs the same module inside the budgeted
 * report; this CLI is for iterating on the DO without re-running everything.
 */

import { parseArgs } from "node:util"
import { writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { DEFAULT_TARGET, devLogin } from "./lib/client"
import { DEFAULT_HANDLE_PATH, readHandle } from "./lib/fixture-handle"
import { presenceMetrics, runPresenceLoad } from "./lib/presence"
import { round } from "./lib/stats"

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      sockets: { type: "string" },
      duration: { type: "string" },
      "ping-interval": { type: "string" },
      "update-interval": { type: "string" },
      stagger: { type: "string" },
      handle: { type: "string" },
      file: { type: "string" },
      json: { type: "string" },
      "auth-base": { type: "string" },
      "sync-base": { type: "string" },
    },
    allowPositionals: false,
  })
  const num = (raw: string | undefined, fallback: number): number =>
    raw === undefined ? fallback : Number(raw)

  const handle = readHandle(values.handle ?? DEFAULT_HANDLE_PATH)
  const target = {
    authBase: values["auth-base"] ?? handle.target.authBase ?? DEFAULT_TARGET.authBase,
    syncBase: values["sync-base"] ?? handle.target.syncBase ?? DEFAULT_TARGET.syncBase,
  }
  const file = values.file
    ? handle.files.find((candidate) => candidate.id === values.file || candidate.name === values.file)
    : [...handle.files].sort((a, b) => b.cells - a.cells)[0]
  if (!file) throw new Error(`no file ${values.file ?? ""} in the fixture handle`)

  const sockets = Math.max(1, Math.floor(num(values.sockets, 50)))
  const session = await devLogin(target)
  console.log(
    `[perf] presence load — ${sockets} sockets on project ${handle.projectId}, file ${file.name}`,
  )

  const result = await runPresenceLoad({
    target,
    jwt: session.jwt,
    projectId: handle.projectId,
    fileId: file.id,
    username: session.username,
    sockets,
    durationMs: Math.max(1_000, num(values.duration, 20) * 1_000),
    pingIntervalMs: Math.max(100, num(values["ping-interval"], 2_000)),
    updateIntervalMs: Math.max(100, num(values["update-interval"], 3_000)),
    staggerMs: Math.max(0, num(values.stagger, 20)),
    cellIds: file.commitTargets.map((anchor) => anchor.cellId),
    log: (line) => console.log(line),
  })

  console.log("")
  console.log(`  sockets open        ${result.socketsOpen} / ${result.socketsRequested}`)
  console.log(`  closed early        ${result.socketsClosedEarly}`)
  console.log(`  presence.updates    ${result.updatesSent} sent over ${round(result.durationMs / 1000)}s`)
  console.log(`  frames received     ${result.framesReceived} (${round(result.framesPerSecond, 2)}/s total,`
    + ` ${round(result.framesPerSocketPerSecond, 2)}/s per socket)`)
  console.log(
    `  ping round trip     p50 ${round(result.ping.p50Ms)}ms  p95 ${round(result.ping.p95Ms)}ms  max ${round(result.ping.maxMs)}ms`
      + ` (${result.pongsReceived} pongs)`,
  )
  if (Object.keys(result.closeCodes).length > 0) {
    console.log(`  close codes         ${JSON.stringify(result.closeCodes)}`)
  }
  if (result.errors.length > 0) {
    console.log(`  errors              ${result.errors.length} (first: ${result.errors[0]})`)
  }

  if (values.json) {
    const out = path.resolve(values.json)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify({ ...result, metrics: presenceMetrics(result) }, null, 2)}\n`, "utf8")
    console.log(`  written             ${values.json}`)
  }

  if (result.socketsOpen < sockets) {
    console.error(
      `[perf] only ${result.socketsOpen} of ${sockets} sockets stayed open — the DO did not hold the load`,
    )
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error(`[perf] presence load failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
