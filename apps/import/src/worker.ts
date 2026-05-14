// Cloudflare Worker entrypoint for apps/import/ (AD-11; spec §21-monorepo.md).
//
// Behavior:
//   - Boot-time `assertEnvBindings()` guard so a preview deploy can never
//     silently bind to prod resources (spec §"Environment binding hygiene").
//   - Everything else delegates to the Workers Assets binding, which serves
//     the Vite-built SPA from dist/. SPA fallback is configured at the
//     wrangler.toml level (not_found_handling = "single-page-application").
//
// Phase 3d ships the placeholder UI only; the real import logic lands after
// Phase 2c-β.

import { assertEnvBindings } from "@aquilla/errors/env-assertion"

interface Env extends Record<string, unknown> {
  ENV: string
  PR?: string
  ASSETS: { fetch: (req: Request) => Promise<Response> }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Workers don't have a real "boot" hook, so we re-run this cheaply per
    // request. Microseconds of overhead vs. the catastrophic cost of a
    // mis-bound preview Worker — easy trade.
    assertEnvBindings(env, env.ENV)

    return env.ASSETS.fetch(req)
  },
}
