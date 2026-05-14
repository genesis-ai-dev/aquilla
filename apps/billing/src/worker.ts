import {
  assertEnvBindings,
  assertNotPreviewInProd,
} from "@aquilla/errors/env-assertion"
import { rejectStaleAssetFallback } from "@aquilla/errors/asset-fallback"

interface Env extends Record<string, unknown> {
  ENV: string
  PR?: string
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
    return rejectStaleAssetFallback(req, await env.ASSETS.fetch(req))
  },
}
