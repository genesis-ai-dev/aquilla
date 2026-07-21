import { getSandbox } from "@cloudflare/sandbox"
import type { Env } from "./types"
import type { ResolveSandbox, SandboxLike } from "./sandbox"

/**
 * Production sandbox resolver — one container Durable Object instance per
 * sessionId. Isolated in its own module (the only place that imports the SDK)
 * so the pure route layer stays unit-testable without a container runtime.
 *
 * `getSandbox` is generic over `Sandbox<any>`; we loosen its signature (rather
 * than introduce an `any`) because our `Env.Sandbox` is `Sandbox<unknown>` and
 * the SDK's Disposable-laden stub type is structurally wider than SandboxLike.
 */
const getSandboxLoose = getSandbox as unknown as (
  ns: Env["Sandbox"],
  id: string,
) => SandboxLike

export const resolveSandbox: ResolveSandbox = (env, sessionId) =>
  getSandboxLoose(env.Sandbox, sessionId)
