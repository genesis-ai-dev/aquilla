/**
 * I4 — Spend accounting. Prints per-cycle and cumulative token estimates and
 * external paid-resource status. Run before any paid batch.
 * Usage: pnpm parity:spend
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ledger = JSON.parse(readFileSync(join(here, '..', 'spend-ledger.json'), 'utf8')) as {
  externalPaidResourcesApproved: string[]
  entries: { cycle: number; label: string; estTokensThisCycle: number; notes?: string }[]
}

let cumulative = 0
for (const e of ledger.entries) {
  cumulative += e.estTokensThisCycle
  console.log(
    `cycle ${String(e.cycle).padStart(2)}  ${e.label.padEnd(28)} ~${(e.estTokensThisCycle / 1000).toFixed(0)}k tok  (cum ~${(cumulative / 1000).toFixed(0)}k)`,
  )
}
const last = ledger.entries[ledger.entries.length - 1]
console.log(`\ncumulative: ~${(cumulative / 1000).toFixed(0)}k tokens over ${ledger.entries.length} cycle(s)`)
if (last) console.log(`projected next cycle (last-cycle basis): ~${(last.estTokensThisCycle / 1000).toFixed(0)}k tokens`)
console.log(`external paid resources approved: ${ledger.externalPaidResourcesApproved.length === 0 ? 'NONE (none may be used without human approval)' : ledger.externalPaidResourcesApproved.join(', ')}`)

// Stall detector input: flag grinding (rising spend, flat metric is judged in the iteration log).
if (ledger.entries.length >= 3) {
  const [a, b, c] = ledger.entries.slice(-3)
  if (c.estTokensThisCycle > a.estTokensThisCycle * 1.5 && c.estTokensThisCycle > b.estTokensThisCycle * 1.5) {
    console.log('!! spend rising sharply across last 3 cycles — check parity delta before continuing (grinding?)')
  }
}
