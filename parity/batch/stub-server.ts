// Reference stub implementing BATCH_ENDPOINT_CONTRACT.md over BatchService.
// Transport-agnostic (no sockets): contract tests drive handle() directly;
// the real endpoint later swaps this for an HTTP transport adapter and MUST
// pass the same contract suite.
import { BatchService, BatchApiError } from "@/lib/batch/pipeline"
import type { BatchDeps } from "@/lib/batch/types"

export interface StubRequest {
  method: "GET" | "POST"
  path: string
  headers?: Record<string, string>
  body?: unknown
}

export interface StubResponse {
  status: number
  body: unknown
}

const ACCOUNT_KEY_RE = /^test_[\w-]+\.[\w-]+$/

export class BatchStubServer {
  readonly service: BatchService

  constructor(deps?: Partial<BatchDeps>) {
    this.service = new BatchService({
      translate: deps?.translate ?? (async ({ text, model }) => ({ translation: `«${text}»`, model: model ?? "stub-default" })),
      retrieveExamples: deps?.retrieveExamples ?? (async () => []),
      now: deps?.now ?? (() => 1_750_000_000_000 + tick++),
    })
  }

  async handle(req: StubRequest): Promise<StubResponse> {
    const headers = Object.fromEntries(
      Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    )
    const accountKeyRaw = headers["x-aquilla-key"]
    const bearer = headers.authorization?.startsWith("Bearer ") ? headers.authorization.slice(7) : undefined
    const accountKey = accountKeyRaw && ACCOUNT_KEY_RE.test(accountKeyRaw) ? accountKeyRaw : undefined

    const err = (status: number, code: string, message: string): StubResponse => ({
      status,
      body: { errors: [{ code, message }] },
    })

    try {
      const create = req.path === "/batch/v1/batches" && req.method === "POST"
      const m = /^\/batch\/v1\/batches\/([^/?]+)(\/results|\/cancel)?(?:\?(.*))?$/.exec(req.path)

      if (create) {
        if (!accountKey) return err(401, "unauthorized", "x-aquilla-key header required")
        const response = this.service.create(req.body, headers["idempotency-key"])
        return { status: 202, body: response }
      }
      if (m) {
        const batchId = m[1]
        const auth = { accountKey, bearer }
        if (!accountKey && !bearer) return err(401, "unauthorized", "credentials required")
        if (m[2] === "/cancel" && req.method === "POST") {
          return { status: 200, body: this.service.cancel(batchId, auth) }
        }
        if (m[2] === "/results" && req.method === "GET") {
          const params = new URLSearchParams(m[3] ?? "")
          const limitRaw = params.get("limit")
          return {
            status: 200,
            body: this.service.results(
              batchId,
              auth,
              params.get("cursor") ?? undefined,
              limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
            ),
          }
        }
        if (!m[2] && req.method === "GET") {
          return { status: 200, body: this.service.status(batchId, auth) }
        }
      }
      return err(404, "not_found", `no route for ${req.method} ${req.path}`)
    } catch (e) {
      if (e instanceof BatchApiError) return err(e.httpStatus, e.code, e.message)
      return err(500, "internal", String(e).slice(0, 200))
    }
  }

  /** Test hook: process the queue (the real endpoint does this in background). */
  drain(): Promise<void> {
    return this.service.drain()
  }
}

let tick = 0
