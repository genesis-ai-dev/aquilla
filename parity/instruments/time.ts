/**
 * I3 — Time accounting. Prints elapsed / remaining wall clock for the parity run.
 * Usage: pnpm parity:time
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const meta = JSON.parse(readFileSync(join(here, '..', 'run-meta.json'), 'utf8')) as {
  runId: string
  startedAtUtc: string
  wallClockBudgetHours: number
  hardStopUtc: string
  phase0DeadlineUtc: string
  stopOpeningNewRowsAtUtc: string
  matrixFrozen: boolean
}

const now = Date.now()
const start = Date.parse(meta.startedAtUtc)
const hardStop = Date.parse(meta.hardStopUtc)
const stabilize = Date.parse(meta.stopOpeningNewRowsAtUtc)

const fmt = (ms: number): string => {
  const sign = ms < 0 ? '-' : ''
  const abs = Math.abs(ms)
  const h = Math.floor(abs / 3_600_000)
  const m = Math.floor((abs % 3_600_000) / 60_000)
  return `${sign}${h}h${String(m).padStart(2, '0')}m`
}

console.log(`run: ${meta.runId}`)
console.log(`now (utc):        ${new Date(now).toISOString()}`)
console.log(`started:          ${meta.startedAtUtc}`)
console.log(`elapsed:          ${fmt(now - start)}`)
console.log(`remaining:        ${fmt(hardStop - now)}  (hard stop ${meta.hardStopUtc})`)
console.log(`stabilize-only in: ${fmt(stabilize - now)}  (hour 8 rule)`)
console.log(`matrix frozen:    ${meta.matrixFrozen}`)
if (now > hardStop) console.log('!! WALL CLOCK BUDGET EXCEEDED — stop and write the gap report.')
else if (now > stabilize) console.log('!! Past hour 8 — no new rows; stabilize + deliverables only.')
