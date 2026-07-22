import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types"
import type { Sandbox } from "@cloudflare/sandbox"

/**
 * Worker bindings. `Sandbox` is the container-backed Durable Object namespace
 * declared in wrangler.toml (class `Sandbox`, re-exported from index.ts).
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
}
