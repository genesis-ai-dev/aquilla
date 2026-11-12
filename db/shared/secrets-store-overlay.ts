// Cloudflare Secrets Store overlay for the API Workers.
//
// A per-Worker secret (`wrangler secret put`) is baked into a Worker version:
// changing one promotes a new, untagged version, which the environment guards
// reject (docs/DEPLOYMENT-ENVIRONMENTS.md, "Rotating a secret"). An account
// Secrets Store secret is read at runtime instead, so its value can change
// without a new Worker version.
//
// Convention: a Secrets Store binding named `SS_<NAME>` supplies `<NAME>`.
// `withStoreSecrets(env)` returns a copy of `env` where each such `<NAME>` is
// the store's value, so the existing `env.<NAME>` reads stay synchronous and
// unchanged. The per-Worker secret of the same name stays the fallback: when
// the binding is absent, or the store call fails (Secrets Store is in beta),
// `env.<NAME>` keeps whatever the Worker version carries.
//
// Values are cached per isolate for CACHE_TTL_MS, so a change in the store is
// live within about a minute and hot paths do not pay a round trip each time.

export const STORE_BINDING_PREFIX = "SS_"
export const CACHE_TTL_MS = 60_000

interface StoreSecret {
  get(): Promise<string>
}

interface CachedValue {
  value: string
  expires: number
}

const cache = new Map<string, CachedValue>()

function isStoreSecret(value: unknown): value is StoreSecret {
  return typeof value === "object" && value !== null
    && typeof (value as { get?: unknown }).get === "function"
}

async function readStoreSecret(name: string, binding: StoreSecret, now: number): Promise<string | undefined> {
  const cached = cache.get(name)
  if (cached && cached.expires > now) return cached.value
  try {
    const value = await binding.get()
    if (typeof value === "string" && value) {
      cache.set(name, { value, expires: now + CACHE_TTL_MS })
      return value
    }
    console.warn(`[secrets-store] ${STORE_BINDING_PREFIX}${name} returned an empty value; using the Worker secret`)
  } catch (error) {
    console.warn(`[secrets-store] ${STORE_BINDING_PREFIX}${name} read failed; using ${cached ? "the last value" : "the Worker secret"}`, error)
  }
  // A failed refresh keeps serving the last good value rather than flipping
  // back to a possibly older Worker secret mid-rotation.
  return cached?.value
}

/**
 * Resolve every `SS_<NAME>` Secrets Store binding onto `<NAME>`. Returns `env`
 * itself (no copy) when there are none, so Workers without bindings pay
 * nothing. Never throws: a store failure falls back as described above.
 */
export async function withStoreSecrets<E extends object>(env: E, now = Date.now()): Promise<E> {
  const record = env as Record<string, unknown>
  const keys = Object.keys(record).filter(key =>
    key.startsWith(STORE_BINDING_PREFIX) && key.length > STORE_BINDING_PREFIX.length && isStoreSecret(record[key]))
  if (keys.length === 0) return env
  const resolved: Record<string, unknown> = { ...record }
  await Promise.all(keys.map(async key => {
    const name = key.slice(STORE_BINDING_PREFIX.length)
    const value = await readStoreSecret(name, record[key] as StoreSecret, now)
    if (value !== undefined) resolved[name] = value
  }))
  return resolved as E
}

/** Test hook: forget cached store values. */
export function __resetStoreSecretCacheForTests(): void {
  cache.clear()
}
