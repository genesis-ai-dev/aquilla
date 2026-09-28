import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types"
import type { Sandbox } from "@cloudflare/sandbox"

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
}
