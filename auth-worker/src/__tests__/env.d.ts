import type { D1Migration } from "cloudflare:test"
import type { Env as WorkerEnv } from "../types"

// `cloudflare:test` (cloudflare-test.d.ts) types its `env` as
// `Cloudflare.Env`, as @cloudflare/vitest-pool-workers did. Per
// @cloudflare/workers-types, a project extends the test/runtime env by
// re-declaring `Cloudflare.Env`; TypeScript merges all declarations. This
// preserves the original intent: tests see our worker bindings plus the
// migrations the harness seeds.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
