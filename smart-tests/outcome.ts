import type { ProjectedCellRow } from "../e2e/helpers/seed-project"

export interface EditContract {
  cellId: string
  expected: string
  baseline: ProjectedCellRow[]
}

export interface Outcome {
  verdict: "passed" | "product_failure" | "inconclusive"
  checks: Record<string, boolean>
  reason: string
}

/** Pure independent oracle. An agent's DONE verdict is deliberately absent. */
export function verifyEdit(
  contract: EditContract,
  rows: ProjectedCellRow[],
  freshVisible: string | null,
  inputObserved: boolean,
): Outcome {
  const target = rows.filter((row) => row.side === "target" && row.cellId === contract.cellId)
  const protectedRows = (values: ProjectedCellRow[]) => values
    .filter((row) => !(row.side === "target" && row.cellId === contract.cellId))
    .map((row) => JSON.stringify([row.cellId, row.side, row.value, row.eventId]))
    .sort()
  const before = protectedRows(contract.baseline)
  const after = protectedRows(rows)
  const checks = {
    durableTarget: target.length === 1 && target[0].value === contract.expected,
    freshSession: freshVisible === contract.expected,
    unrelatedUnchanged: JSON.stringify(before) === JSON.stringify(after),
    inputObserved,
  }
  const passed = Object.values(checks).every(Boolean)
  return {
    verdict: passed ? "passed" : inputObserved ? "product_failure" : "inconclusive",
    checks,
    reason: passed ? "The intended edit survives in storage and a fresh browser session."
      : inputObserved ? "The UI accepted the intended input, but the outcome contract failed."
        : "The agent did not establish the intended edit; this is not a verified product failure.",
  }
}

/** Reset is only allowed on the explicitly owned local E2E database. */
export function assertOwnedStack(env: NodeJS.ProcessEnv): void {
  const database = new URL(env.E2E_DATABASE_URL ?? "http://missing")
  if (!["localhost", "127.0.0.1"].includes(database.hostname)
    || !/^\/aquilla_e2e(?:_s\d+)?$/.test(database.pathname)) {
    throw new Error("Smart tests require the isolated scripts/e2e-up.ts database")
  }
  for (const name of ["E2E_BASE_URL", "VITE_FRONTIER_BASE"]) {
    const url = new URL(env[name] ?? "http://missing")
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error(`${name} must point at the owned local E2E stack`)
    }
  }
  const sync = new URL(`http://${env.VITE_SYNC_WORKER_HOST ?? "missing"}`)
  if (sync.hostname !== "127.0.0.1") throw new Error("Sync must use the owned local E2E stack")
}
