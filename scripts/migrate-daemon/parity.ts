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
import fs from "node:fs"
import path from "node:path"
import type { PlanLine } from "./plan"

export interface CompareResult {
  missing: number
  extra: number
  changed: number
  order: number
}

/** Pure comparison: `old` is the migrate-all dry-run stream (id -> hash),
 *  `plan` is the daemon's materialized plan for the same project. */
export function compareProject(old: Map<string, { hash: string }>, plan: PlanLine[]): CompareResult {
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
    if (l.event.kind === "source.cell.create" || l.event.kind === "file.create") {
      const fileId = l.event.fileId
      if (fileId) lastCreateIdx.set(fileId, i)
    }
  })
  plan.forEach((l, i) => {
    if (!l.reconcile) return
    const fileId = l.event.fileId
    if (!fileId) return
    const lastCreate = lastCreateIdx.get(fileId)
    if (lastCreate === undefined || i < lastCreate) order++
  })

  return { missing, extra, changed, order }
}

function readOldPlan(file: string): Map<string, { hash: string }> {
  const out = new Map<string, { hash: string }>()
  const text = fs.readFileSync(file, "utf8")
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const { id, hash } = JSON.parse(trimmed) as { id: string; hash: string }
    out.set(id, { hash })
  }
  return out
}

function readPlanFile(file: string): PlanLine[] {
  const out: PlanLine[] = []
  const text = fs.readFileSync(file, "utf8")
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    out.push(JSON.parse(trimmed) as PlanLine)
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

export function main(argv: string[]): number {
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
    const old = readOldPlan(path.join(oldDir, `${id}.ndjson`))
    const planFile = newestPlanFile(plansDir, id)
    if (!planFile) {
      console.log(`${id} no-plan`)
      noPlan++
      continue
    }
    const plan = readPlanFile(planFile)
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
  process.exit(main(process.argv.slice(2)))
}
