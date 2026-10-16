import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types"
import type { Sandbox } from "@cloudflare/sandbox"
import type { SandboxPool } from "./pool-do"

/**
 * Worker bindings. `Sandbox` is the container-backed Durable Object namespace
 * declared in wrangler.toml (the egress-disabled `Sandbox` subclass exported
 * from index.ts).
 * `SNAPSHOTS` is the R2 bucket (`aquilla-snapshots`) that the sync-worker also
 * binds — the source of agent artifacts pulled into the container.
 */
export interface Env {
  /** Shared bearer secret required on every route except /health. */
  AGENT_SANDBOX_KEY: string
  /** Container-backed Durable Object namespace (one instance per sessionId). */
  Sandbox: DurableObjectNamespace<Sandbox>
  /** R2 bucket holding agent artifacts / media blobs (aquilla-snapshots). */
  SNAPSHOTS: R2Bucket
  /** PostHog *project* token (phc_…, public). When set, slow/error logs are
   *  shipped to PostHog Logs (see posthog-logs.ts). Unset locally/in tests. */
  POSTHOG_KEY?: string
  /** PostHog ingest host; defaults to https://eu.i.posthog.com (AQU-854). */
  POSTHOG_HOST?: string
  /** AQU-1848: admission ledger for the account-wide container pool. */
  SANDBOX_POOL: DurableObjectNamespace<SandboxPool>
  /** AQU-1848: global cap on in-flight containers. Default `DEFAULT_LIMITS`. */
  SANDBOX_MAX_TOTAL?: string
  /** AQU-1848: per-tenant cap, so one org cannot drain the pool. */
  SANDBOX_MAX_PER_TENANT?: string
  /** AQU-1848: how long a lease survives without renewal, in ms. */
  SANDBOX_LEASE_TTL_MS?: string
  /** AQU-1848: how long a caller waits on a FULL pool before giving up, in ms. */
  SANDBOX_POOL_WAIT_MS?: string
}

/**
 * The slice of `Env` the pool plumbing needs. Declared separately so
 * `pool-do.ts` and `pool-gate.ts` do not depend on the R2/sandbox bindings they
 * never touch.
 */
export type PoolEnv = Pick<
  Env,
  "SANDBOX_POOL" | "SANDBOX_MAX_TOTAL" | "SANDBOX_MAX_PER_TENANT" | "SANDBOX_LEASE_TTL_MS"
>
