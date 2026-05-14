// Boot-time env-binding assertions (AD-11; spec §"Environment binding hygiene").
//
// "The nightmare to prevent: a preview deploy silently binds to prod D1
//  because env-var resolution fell through to defaults."
//
// The mitigation has three layers; this module owns layer 2 (the
// boot-time assertion every Worker runs at startup):
//
//   1. Strict per-env wrangler configs ([env.preview], [env.prod]).
//   2. Worker refuses to start unless binding NAMES match the ENV secret.
//   3. Naming discipline visible to human eyes in `wrangler` output.
//
// Naming convention enforced here:
//   ENV=prod    ⇒ every binding name starts with `aquilla-prod-`
//   ENV=preview ⇒ every binding name starts with `aquilla-pr-`
//                 OR is exactly `aquilla-dev` (the shared dev DB — spec
//                 §"Preview databases" Tier 2)
//
// `assertNotPreviewInProd` is the second, narrower guard: even if all
// binding names check out, refuse to serve a preview-ENV Worker on the
// production hostname.

/**
 * The shape of an env binding we can extract a "name" from. D1 and KV
 * bindings expose `name`; other resources (R2 buckets, queues, DOs) name
 * themselves via their binding key on the env object rather than a
 * `.name` property, so callers can either pass them in directly (we
 * accept anything with a string `name`) or pre-normalize.
 */
export interface NamedBinding {
  name: string
}

/**
 * The minimal `env` shape we operate on. Every Worker that calls
 * `assertEnvBindings` should pass its own `env`; we duck-type for any
 * value that exposes a `.name` string, and skip everything else.
 */
export type EnvLike = Record<string, unknown>

/**
 * Returns true iff `name` is consistent with `expectedEnv`'s naming
 * convention. Exported for unit tests and for callers that want to
 * pre-validate a specific binding without throwing.
 */
export function isBindingNameValid(
  name: string,
  expectedEnv: string,
): boolean {
  if (expectedEnv === "prod") {
    return name.startsWith("aquilla-prod-")
  }
  if (expectedEnv === "preview") {
    if (name === "aquilla-dev") return true
    return name.startsWith("aquilla-pr-") || name.startsWith("aquilla-dev-")
  }
  // Unknown env values fail closed.
  return false
}

/**
 * Walks `env` and validates every binding name we can find against the
 * convention for `expectedEnv`. Throws on the first mismatch — Worker
 * refuses to start (or, in a per-request setup, refuses to serve the
 * request).
 *
 * `expectedEnv` is normally just `env.ENV`; we accept it as a separate
 * argument so the caller's intent is explicit at the call-site and tests
 * can pass a value without mutating env.
 */
export function assertEnvBindings(env: EnvLike, expectedEnv: string): void {
  if (expectedEnv !== "prod" && expectedEnv !== "preview") {
    throw new Error(
      `[env-assertion] Unknown ENV "${expectedEnv}". Expected "prod" or "preview". ` +
        `Worker refuses to start.`,
    )
  }

  for (const [key, value] of Object.entries(env)) {
    if (value == null || typeof value !== "object") continue
    const candidate = (value as { name?: unknown }).name
    if (typeof candidate !== "string") continue
    if (!isBindingNameValid(candidate, expectedEnv)) {
      throw new Error(
        `[env-assertion] Binding "${key}" has name "${candidate}", which is not valid ` +
          `for ENV=${expectedEnv}. ` +
          (expectedEnv === "prod"
            ? `Prod bindings must start with "aquilla-prod-".`
            : `Preview bindings must start with "aquilla-pr-" or be "aquilla-dev"/"aquilla-dev-*".`) +
          ` Worker refuses to start.`,
      )
    }
  }
}

/**
 * Refuses to boot if `ENV=preview` and the request hostname matches a
 * production domain. Fail-closed prevents a misconfigured preview Worker
 * from running on the prod hostname.
 *
 * The list of "production" hostnames is caller-supplied so this helper
 * works for any Worker; the front-door passes `aquilla.app`.
 */
export function assertNotPreviewInProd(
  env: EnvLike,
  hostname: string,
  productionHosts: ReadonlySet<string> = new Set(["aquilla.app", "www.aquilla.app"]),
): void {
  const envValue = (env as { ENV?: unknown }).ENV
  if (typeof envValue !== "string") {
    throw new Error(
      `[env-assertion] env.ENV is not a string (got ${typeof envValue}). ` +
        `Worker refuses to start.`,
    )
  }
  if (envValue === "preview" && productionHosts.has(hostname)) {
    throw new Error(
      `[env-assertion] ENV=preview but request hostname is the production domain ` +
        `"${hostname}". Worker refuses to start.`,
    )
  }
}
