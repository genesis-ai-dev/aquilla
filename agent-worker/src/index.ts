import { createApp } from "./app"
import { resolveSandbox } from "./resolve-sandbox"
import type { Env } from "./types"
import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox"

// The container-backed Durable Object class. Internet access defaults ON in
// Cloudflare Containers, so re-exporting the SDK class directly would let
// untrusted import code exfiltrate uploaded content. Keep the class name that
// wrangler.toml binds, but make the documented default-deny policy real.
export class Sandbox extends CloudflareSandbox<Env> {
  override enableInternet = false
}

const app = createApp({ resolveSandbox })

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
}
