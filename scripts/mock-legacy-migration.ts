// Deterministic frontier-db-v2 + GitLab REST mock for the AQU-713 smoke
// journey. The real auth worker, Postgres transaction, session issuance, and
// permission APIs all run unchanged; only the two external dependencies are
// replaced.
//
// Run: npx tsx scripts/mock-legacy-migration.ts [port]

import http from "node:http"
import { hashPasswordWerkzeugScrypt } from "../auth-worker/src/utils/password"

const PORT = Number(process.argv[2]) || 9460
const USERNAME = "legacy-e2e"
const EMAIL = "legacy-e2e@example.test"
const D1_TOKEN = "e2e-d1-read"
const GITLAB_TOKEN = "e2e-gitlab-admin"

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
  })
  response.end(JSON.stringify(body))
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
}

const passwordHash = await hashPasswordWerkzeugScrypt("legacy-password")

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`)

  if (url.pathname === "/healthz") {
    return sendJson(response, 200, { ok: true })
  }

  if (
    request.method === "POST" &&
    url.pathname === "/client/v4/accounts/e2e/d1/database/frontier-db-v2/query"
  ) {
    if (request.headers.authorization !== `Bearer ${D1_TOKEN}`) {
      return sendJson(response, 401, { success: false })
    }
    const body = await readJson(request)
    const sql = String(body.sql ?? "")
    const params = Array.isArray(body.params) ? body.params : []
    if (sql.toLowerCase().includes("gitlab_token")) {
      return sendJson(response, 400, { success: false })
    }
    const identifier = String(params[0] ?? "").trim().toLowerCase()
    const matches = identifier === USERNAME || identifier === EMAIL
    return sendJson(response, 200, {
      success: true,
      result: [{
        success: true,
        results: matches
          ? [{
              id: 700,
              username: USERNAME,
              email: EMAIL,
              password_hash: passwordHash,
              gitlab_user_id: 77,
              created_at: "2026-07-01T12:00:00.000Z",
              updated_at: "2026-07-02T12:00:00.000Z",
            }]
          : [],
      }],
    })
  }

  if (url.pathname.startsWith("/api/v4/")) {
    if (request.headers.authorization !== `Bearer ${GITLAB_TOKEN}`) {
      return sendJson(response, 401, { message: "unauthorized" })
    }
    const pagination = { "X-Next-Page": "" }
    if (
      url.pathname === "/api/v4/groups" &&
      url.searchParams.get("top_level_only") === "true"
    ) {
      return sendJson(response, 200, [
        { id: 10, name: "Legacy Org", full_path: "legacy-org", parent_id: null },
      ], pagination)
    }
    if (url.pathname === "/api/v4/groups/10/descendant_groups") {
      return sendJson(response, 200, [
        {
          id: 11,
          name: "Legacy Team",
          full_path: "legacy-org/legacy-team",
          parent_id: 10,
        },
      ], pagination)
    }
    if (url.pathname === "/api/v4/users/77/memberships") {
      return sendJson(response, 200, [
        { source_type: "Namespace", source_id: 10, access_level: 20 },
        { source_type: "Project", source_id: 91, access_level: 30 },
      ], pagination)
    }
  }

  return sendJson(response, 404, { error: "not found" })
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-legacy-migration] listening on http://127.0.0.1:${PORT}`)
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
