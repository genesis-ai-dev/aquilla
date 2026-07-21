import { createApp } from "./app"
import { resolveSandbox } from "./resolve-sandbox"
import type { Env } from "./types"

// The container-backed Durable Object class. wrangler.toml declares a
// `containers[]` entry with `class_name = "Sandbox"` pointing at ./Dockerfile,
// and a durable_objects binding named `Sandbox` for the same class. The SDK
// requires this exact re-export.
export { Sandbox } from "@cloudflare/sandbox"

const app = createApp({ resolveSandbox })

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
}
