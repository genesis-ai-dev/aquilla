// AQU-1848 — an in-memory `PoolGate` for route tests.
//
// `createApp` takes the gate as a dependency precisely so the admission caps
// can be exercised without a Durable Object host (the same reason
// `resolveSandbox` is injected). This drives the REAL `PoolLedger`, so these
// tests check the actual policy rather than a re-implementation of it.

import { PoolLedger, type AdmitRequest, type AdmitResult, type PoolGate, type PoolLimits } from "../src/pool"

export interface FakePool extends PoolGate {
  ledger: PoolLedger
  /** Admissions seen, for asserting that a route gated at all. */
  admits: AdmitRequest[]
  releases: string[]
  /** Test-controlled clock, so lease expiry is deterministic. */
  now: number
}

export function makeFakePool(limits?: Partial<PoolLimits>): FakePool {
  const ledger = new PoolLedger({
    maxTotal: limits?.maxTotal ?? 20,
    maxPerTenant: limits?.maxPerTenant ?? 3,
    leaseTtlMs: limits?.leaseTtlMs ?? 330_000,
  })
  const pool: FakePool = {
    ledger,
    admits: [],
    releases: [],
    now: 1_000,
    async admit(_env: unknown, req: AdmitRequest): Promise<AdmitResult> {
      pool.admits.push(req)
      return ledger.admit(req, pool.now)
    },
    async release(_env: unknown, sessionId: string): Promise<void> {
      pool.releases.push(sessionId)
      ledger.release(sessionId)
    },
  }
  return pool
}

/** A gate that always admits — for tests whose subject is not the pool. */
export function alwaysAdmit(): PoolGate {
  return {
    async admit(): Promise<AdmitResult> {
      return { granted: true, renewed: false, activeTotal: 1, activeForTenant: 1 }
    },
    async release(): Promise<void> {},
  }
}

/** Never sleep in tests — the wait loop is driven by the ledger, not the clock. */
export const noSleep = async (): Promise<void> => {}
