// A stand-in for the identity worker's preference routes, for client tests
// (AQU-2264). It keeps one person's `users.preferences` record in memory and
// answers the four calls the client makes, with the same rules as the worker:
//
//   GET   /api/v2/auth/me              → { preferences }
//   PATCH /api/v2/auth/me              → { preferences } REPLACES the record
//   GET   /api/v2/auth/me/preferences  → { preferences }
//   PATCH /api/v2/auth/me/preferences  → { set, setIfAbsent } MERGED in
//
// `beforeWrite` runs when a write arrives, before it is applied: that is where
// a test makes "another device" write in between a caller's read and its write.

export interface FakePreferencesServer {
  /** The stored record, as the worker holds it. */
  record: Record<string, unknown>
  /** Every request, in order: method + path + parsed body. */
  calls: { method: string; path: string; body: unknown }[]
  /** Answer every request with this status instead (null = normal). */
  failWith: number | null
  /** Called when a PATCH arrives, before it is applied. */
  beforeWrite: (() => void) | null
  fetch: typeof fetch
}

export function createFakePreferencesServer(initial: Record<string, unknown> = {}): FakePreferencesServer {
  const server: FakePreferencesServer = {
    record: { ...initial },
    calls: [],
    failWith: null,
    beforeWrite: null,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://x")
      const method = (init?.method ?? "GET").toUpperCase()
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      server.calls.push({ method, path: url.pathname, body })
      if (server.failWith != null) return json({ error: "refused" }, server.failWith)
      if (method === "PATCH") server.beforeWrite?.()
      if (url.pathname.endsWith("/api/v2/auth/me/preferences")) {
        if (method === "GET") {
          return json({ preferences: { ...server.record } })
        }
        if (method === "PATCH") {
          const { set = {}, setIfAbsent = {} } = (body ?? {}) as {
            set?: Record<string, unknown>
            setIfAbsent?: Record<string, unknown>
          }
          server.record = { ...setIfAbsent, ...server.record, ...set }
          return json({ preferences: { ...server.record } })
        }
      }
      if (url.pathname.endsWith("/api/v2/auth/me")) {
        if (method === "GET") {
          return json({ preferences: { ...server.record } })
        }
        if (method === "PATCH") {
          const next = (body as { preferences?: Record<string, unknown> } | undefined)?.preferences
          if (next) server.record = { ...next }
          return json({ preferences: { ...server.record } })
        }
      }
      return json({ error: "not found" }, 404)
    }) as typeof fetch,
  }
  return server
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}
