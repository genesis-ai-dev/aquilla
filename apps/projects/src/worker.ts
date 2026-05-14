// Cloudflare Worker entry for apps/projects/.
//
// Serves the Vite-built SPA assets under /projects/* via the Workers Assets
// binding. Workers Routes (aquilla.app/projects/*) dispatches here without
// going through the front-door (per AD-11 / spec §21 routing layer).
//
// We don't run app logic in this Worker; static assets + an SPA-fallback
// rewrite to index.html for any deep-link path under /projects/.
//
// Boot-time hygiene: assertEnvBindings refuses to start a preview Worker
// bound to prod resources (spec §"Environment binding hygiene").

import {
  assertEnvBindings,
  assertNotPreviewInProd,
} from "@aquilla/errors/env-assertion"

// EnvLike from @aquilla/errors expects Record<string, unknown>; declare Env
// as an indexable type so it satisfies that signature while still being
// type-safe at the property level.
interface Env extends Record<string, unknown> {
  ENV: string
  PR?: string
  /** Workers Assets binding — wrangler.toml `[assets] binding = "ASSETS"`. */
  ASSETS: Fetcher
}

const PRODUCTION_HOSTS = new Set<string>(["aquilla.app", "www.aquilla.app"])

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    assertEnvBindings(env, env.ENV)

    const url = new URL(req.url)
    if (PRODUCTION_HOSTS.has(url.hostname)) {
      assertNotPreviewInProd(env, url.hostname)
    }

    // Workers Routes claims everything under /projects/* and forwards it
    // here intact; we don't have to strip the prefix ourselves because
    // the ASSETS binding is configured with directory = "./dist" which
    // already contains the prefix-aware Vite build output.
    return env.ASSETS.fetch(req)
  },
}
