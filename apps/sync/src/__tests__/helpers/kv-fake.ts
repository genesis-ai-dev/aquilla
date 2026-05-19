// Minimal in-memory KVNamespace fake for unit tests.
//
// Recognizes the `get(key, "json")` and `put(key, value, { expirationTtl })`
// shapes the branching-search cache uses. TTL is recorded but not actually
// expired — tests advance state by clearing the store between cases or by
// asserting on the call log.

export interface InMemoryKV extends KVNamespace {
  _store(): Map<string, string>
  _puts(): Array<{ key: string; value: string; ttl?: number }>
  _gets(): Array<{ key: string }>
}

export function makeInMemoryKV(seed?: Record<string, unknown>): InMemoryKV {
  const store = new Map<string, string>()
  if (seed) {
    for (const [k, v] of Object.entries(seed)) {
      store.set(k, typeof v === "string" ? v : JSON.stringify(v))
    }
  }
  const puts: Array<{ key: string; value: string; ttl?: number }> = []
  const gets: Array<{ key: string }> = []

  const kv = {
    async get(key: string, type?: "text" | "json" | "arrayBuffer" | "stream") {
      gets.push({ key })
      const raw = store.get(key)
      if (raw === undefined) return null
      if (type === "json") {
        try {
          return JSON.parse(raw)
        } catch {
          return null
        }
      }
      return raw
    },
    async put(
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options?: { expirationTtl?: number },
    ) {
      const str = typeof value === "string" ? value : "[non-string]"
      store.set(key, str)
      puts.push({ key, value: str, ttl: options?.expirationTtl })
    },
    async delete(key: string) {
      store.delete(key)
    },
    async list() {
      return {
        keys: Array.from(store.keys()).map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      }
    },
    async getWithMetadata() {
      return { value: null, metadata: null, cacheStatus: null }
    },
    _store: () => store,
    _puts: () => puts,
    _gets: () => gets,
  } as unknown as InMemoryKV

  return kv
}
