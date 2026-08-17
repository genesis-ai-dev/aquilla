export const FAST_AFFECTED_SPEC_LIMIT = 8
const MAX_LOCAL_PREVIEW_SHARDS = 2

export interface AffectedRunMode {
  viteMode: "dev" | "preview"
  shards: number
}

/** Small changed-file suites optimize for startup latency. Larger selections
 * need static output and isolated shards so Vite transforms cannot dominate or
 * restart during a long run. */
export function affectedRunMode(specCount: number): AffectedRunMode {
  if (specCount <= FAST_AFFECTED_SPEC_LIMIT) return { viteMode: "dev", shards: 1 }
  return {
    viteMode: "preview",
    // Each shard owns a Vite build, Chromium, identity workerd, sync workerd,
    // and mock services. Three sustained stacks can make macOS terminate a
    // browser and workerd without a crash record, cascading into ECONNREFUSED
    // fixture failures. Two retains parallelism without exceeding that local
    // resource envelope. The release gate can still opt into e2e-shard
    // directly on a larger CI runner.
    shards: Math.min(MAX_LOCAL_PREVIEW_SHARDS, Math.max(2, Math.ceil(specCount / 40))),
  }
}

export function shouldWriteTestEnvFile(sharded: boolean, viteMode: "dev" | "preview"): boolean {
  // Dev mode receives VITE_* through process.env. Writing the watched env file
  // after Vite starts causes a restart race with Playwright's first page.goto.
  return !sharded && viteMode === "preview"
}
