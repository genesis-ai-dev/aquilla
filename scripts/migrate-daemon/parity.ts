// Parity gate (Task 12): diffs migrate-all.ts's dry-run event stream
// (`--dump-plan <dir>`) against the daemon's materialized plans, so a swap
// from the old sweep script to the daemon can be verified before it's trusted.
//
//   tsx scripts/migrate-daemon/parity.ts <oldDir> <plansDir> [--only <id>]
//
// <oldDir> holds `<gitlabId>.ndjson` files of `{id, hash}` lines written by
// `migrate-all.ts --dump-plan`. <plansDir> is the daemon's plan root
// (`plans/<gitlabId>/<sha>.ndjson`) — the newest file per project id is used.
// Both sides must be run against a fresh/empty ledger (see the brief) so
// neither stream is delta-filtered against prior state.
//
// Both sides are streamed line-by-line via `readline` rather than read whole
// into memory — daemon plan files for 166k-event projects can exceed 512 MB,
// well past Node's ~512 MiB single-string readFileSync limit.
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import type { PlanLine } from "./plan"

export interface CompareResult {
  missing: number
  extra: number
  changed: number
  order: number
}

/** Slimmed-down `PlanLine`: only what `compareProject` needs to diff and
 *  order-check a plan. Event payloads are dropped so a 166k-event project's
 *  comparison stays memory-bounded. */
export interface ParityLine {
  id: string
  hash: string
  fileId?: string | null
  kind: string
  reconcile?: true
}

function toParityLine(l: PlanLine): ParityLine {
  const out: ParityLine = { id: l.id, hash: l.hash, fileId: l.event.fileId, kind: l.event.kind }
  if (l.reconcile) out.reconcile = true
  return out
}

/** Pure comparison: `old` is the migrate-all dry-run stream (id -> hash),
 *  `plan` is the daemon's materialized plan for the same project, slimmed to
 *  `ParityLine`s (no event payloads retained). */
export function compareProject(old: Map<string, { hash: string }>, plan: ParityLine[]): CompareResult {
  const byId = new Map(plan.map((l) => [l.id, l]))
  let missing = 0
  let changed = 0
  for (const [id, { hash }] of old) {
    const line = byId.get(id)
    if (!line) {
      missing++
      continue
    }
    if (line.hash !== hash) changed++
  }
  let extra = 0
  for (const id of byId.keys()) {
    if (!old.has(id)) extra++
  }

  // Ordering invariant: within a fileId, a line explicitly tagged `reconcile`
  // (a retraction/resurrection/repair from `computeOrphanRetractions`) must
  // land after the last UNTAGGED create for that file. Untagged
  // `*.cell.delete`/`*.cell.reanchor` events come straight from the mapper
  // (`mapFilePairToEvents`), which interleaves creates and deletes identically
  // on migrate-all and the daemon — those carry no ordering constraint and
  // must never be judged here, or an empty-ledger run (no reconciliation
  // events at all) reports a false-positive `order` count.
  let order = 0
  const lastCreateIdx = new Map<string, number>()
  plan.forEach((l, i) => {
    if (l.reconcile) return
    if (l.kind === "source.cell.create" || l.kind === "file.create") {
      const fileId = l.fileId
      if (fileId) lastCreateIdx.set(fileId, i)
    }
  })
  plan.forEach((l, i) => {
    if (!l.reconcile) return
    const fileId = l.fileId
    if (!fileId) return
    const lastCreate = lastCreateIdx.get(fileId)
    if (lastCreate === undefined || i < lastCreate) order++
  })

  return { missing, extra, changed, order }
}

/** Streams `<oldDir>/<id>.ndjson` (`{id, hash}` lines from migrate-all's
 *  `--dump-plan`) line-by-line rather than reading the whole file, so a large
 *  old-script dump never has to sit in memory as one string. */
async function readOldPlan(file: string): Promise<Map<string, { hash: string }>> {
  const out = new Map<string, { hash: string }>()
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  let lineNo = 0
  try {
    for await (const raw of rl) {
      lineNo++
      const trimmed = raw.trim()
      if (!trimmed) continue
      let parsed: { id: string; hash: string }
      try {
        parsed = JSON.parse(trimmed) as { id: string; hash: string }
      } catch (e) {
        throw new Error(`${file}:${lineNo}: ${e instanceof Error ? e.message : String(e)}`)
      }
      out.set(parsed.id, { hash: parsed.hash })
    }
  } finally {
    rl.close()
  }
  return out
}

/** Streams a daemon plan file line-by-line, folding each `PlanLine` into a
 *  slim `ParityLine` (dropping the event payload) so a 512 MB+ plan never
 *  has to be materialized whole. Uses `readline` directly (rather than
 *  `readPlan`'s batched generator) so a parse error can be pinned to the
 *  exact line — `readPlan` only surfaces line boundaries at batch size. */
async function readPlanFile(file: string): Promise<ParityLine[]> {
  const out: ParityLine[] = []
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  let lineNo = 0
  try {
    for await (const raw of rl) {
      lineNo++
      const trimmed = raw.trim()
      if (!trimmed) continue
      let parsed: PlanLine
      try {
        parsed = JSON.parse(trimmed) as PlanLine
      } catch (e) {
        throw new Error(`${file}:${lineNo}: ${e instanceof Error ? e.message : String(e)}`)
      }
      out.push(toParityLine(parsed))
    }
  } finally {
    rl.close()
  }
  return out
}

/** Newest `<sha>.ndjson` under `plansDir/<gitlabId>/`, or undefined if the
 *  project has no daemon plan at all. */
function newestPlanFile(plansDir: string, gitlabId: string): string | undefined {
  const dir = path.join(plansDir, gitlabId)
  if (!fs.existsSync(dir)) return undefined
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson"))
  if (!files.length) return undefined
  let best: { file: string; mtime: number } | undefined
  for (const f of files) {
    const full = path.join(dir, f)
    const mtime = fs.statSync(full).mtimeMs
    if (!best || mtime > best.mtime) best = { file: full, mtime }
  }
  return best?.file
}

export async function main(argv: string[]): Promise<number> {
  const [oldDir, plansDir, ...rest] = argv
  if (!oldDir || !plansDir) {
    console.error("usage: parity.ts <oldDir> <plansDir> [--only <id>]")
    return 1
  }
  const onlyIdx = rest.indexOf("--only")
  const only = onlyIdx >= 0 ? rest[onlyIdx + 1] : undefined

  const ids = fs
    .readdirSync(oldDir)
    .filter((f) => f.endsWith(".ndjson"))
    .map((f) => f.slice(0, -".ndjson".length))
    .filter((id) => !only || id === only)
    .sort()

  const totals: CompareResult = { missing: 0, extra: 0, changed: 0, order: 0 }
  let noPlan = 0
  for (const id of ids) {
    const old = await readOldPlan(path.join(oldDir, `${id}.ndjson`))
    const planFile = newestPlanFile(plansDir, id)
    if (!planFile) {
      console.log(`${id} no-plan`)
      noPlan++
      continue
    }
    const plan = await readPlanFile(planFile)
    const result = compareProject(old, plan)
    console.log(`${id} missing=${result.missing} extra=${result.extra} changed=${result.changed} order=${result.order}`)
    totals.missing += result.missing
    totals.extra += result.extra
    totals.changed += result.changed
    totals.order += result.order
  }
  console.log(
    `TOTAL missing=${totals.missing} extra=${totals.extra} changed=${totals.changed} order=${totals.order} no-plan=${noPlan}`,
  )
  const hasDiff = totals.missing > 0 || totals.extra > 0 || totals.changed > 0 || totals.order > 0 || noPlan > 0
  return hasDiff ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
