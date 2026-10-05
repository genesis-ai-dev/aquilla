import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CREDENTIAL_PARAM_NAMES,
  CREDENTIAL_PATH_SHAPES,
  REDACTED_SEGMENT,
  redactLogPath,
} from "./log-path-redaction"

// [Pen test] Auth & session mgmt (2026-10-05, OPS-42). Both workers copy
// `url.pathname` into PostHog Logs (every 4xx/5xx) and into Cloudflare Workers
// Logs (every request over 5s, success included). Seven routes carry a live
// bearer credential as a path segment, so those two sinks were credential
// sinks. The first block pins the redaction; the second is the drift guard —
// a new `:token`-style route cannot reach a log line uncovered.

const ROOT = join(__dirname, "..")
const TOKEN = "Zt7Jq2bX9yLm4Rn8Ks3Wd6Pv1Hc5Tg0Ub2Ae4Yi7Qo"

describe("redactLogPath — the credential-bearing routes (OPS-42)", () => {
  const cases: [string, string][] = [
    [`/api/v2/invites/${TOKEN}/preview`, `/api/v2/invites/${REDACTED_SEGMENT}/preview`],
    [`/api/v2/invites/${TOKEN}/accept`, `/api/v2/invites/${REDACTED_SEGMENT}/accept`],
    [`/api/v2/access-links/${TOKEN}/redeem`, `/api/v2/access-links/${REDACTED_SEGMENT}/redeem`],
    [`/api/v2/access-links/${TOKEN}/revoke`, `/api/v2/access-links/${REDACTED_SEGMENT}/revoke`],
    [`/api/v2/orgs/invite-preview/${TOKEN}`, `/api/v2/orgs/invite-preview/${REDACTED_SEGMENT}`],
    [`/api/v2/projects/invite-preview/${TOKEN}`, `/api/v2/projects/invite-preview/${REDACTED_SEGMENT}`],
    [`/api/v2/orgs/41/invites/${TOKEN}`, `/api/v2/orgs/41/invites/${REDACTED_SEGMENT}`],
    [
      `/api/v2/projects/d290f1ee-6c54-4b01-90e6-d701748f0851/invites/${TOKEN}`,
      `/api/v2/projects/d290f1ee-6c54-4b01-90e6-d701748f0851/invites/${REDACTED_SEGMENT}`,
    ],
  ]

  it.each(cases)("redacts %s", (input, expected) => {
    expect(redactLogPath(input)).toBe(expected)
    expect(redactLogPath(input)).not.toContain(TOKEN)
  })

  it("keeps the non-secret segments, so the log still names the route", () => {
    expect(redactLogPath(`/api/v2/orgs/41/invites/${TOKEN}`)).toContain("/orgs/41/invites/")
  })

  it("covers the /identity and /sync mount prefixes too", () => {
    // The prefix is stripped before routing, so a logged path normally arrives
    // bare — but a future log site upstream of the strip must not leak.
    for (const prefix of ["/identity", "/sync"]) {
      expect(redactLogPath(`${prefix}/api/v2/invites/${TOKEN}/accept`)).not.toContain(TOKEN)
    }
  })

  it("tolerates the /api/v1 alias shape (authRoutes is mounted under both)", () => {
    // No invite route lives under /api/v1 today; the shapes accept v1 so a
    // re-mount cannot quietly re-open this.
    expect(redactLogPath(`/api/v1/invites/${TOKEN}/accept`)).not.toContain(TOKEN)
  })

  it("leaves ordinary paths byte-identical", () => {
    for (const path of [
      "/api/v2/invites/mine",
      "/api/v2/orgs/41/invites",
      "/api/v2/orgs/41/project-invites",
      "/api/v2/projects/d290f1ee-6c54-4b01-90e6-d701748f0851/cells",
      "/api/v1/ai/agent/run",
      "/healthz",
      "/",
    ]) {
      expect(redactLogPath(path)).toBe(path)
    }
  })

  it("never widens a shape into a neighbouring route", () => {
    // `/invites/:token/preview` must not swallow a deeper path that happens to
    // share its prefix — redaction is per-shape, anchored at both ends.
    expect(redactLogPath(`/api/v2/invites/${TOKEN}/preview/extra`)).toContain(TOKEN)
  })
})

// ---------------------------------------------------------------------------
// Drift guard: every route whose declared path carries a credential parameter
// must be redacted. Resolves each router's mount prefix from index.ts rather
// than hard-coding it, so a re-mount is caught as well as a new route.
// ---------------------------------------------------------------------------

interface MountedRoute {
  readonly file: string
  readonly fullPath: string
  readonly params: string[]
}

function collectMountedRoutes(): MountedRoute[] {
  const index = readFileSync(join(ROOT, "auth-worker/src/index.ts"), "utf8")

  // `import invitesRoutes from "./routes/invites"` → identifier → file
  const importedFrom = new Map<string, string>()
  for (const m of index.matchAll(/^import\s+(\w+)\s+from\s+"(\.\/routes\/[\w-]+)"/gm)) {
    importedFrom.set(m[1], `auth-worker/src/${m[2].slice(2)}.ts`)
  }

  // `app.route("/api/v2/invites", invitesRoutes)` — a router may be mounted
  // more than once (v1 + v2 aliases), so every mount is kept.
  const mounts: [string, string][] = []
  for (const m of index.matchAll(/app\.route\(\s*"([^"]*)"\s*,\s*(\w+)\s*\)/g)) {
    const file = importedFrom.get(m[2])
    if (file) mounts.push([m[1], file])
  }
  expect(mounts.length).toBeGreaterThan(20)

  const routes: MountedRoute[] = []
  const sourceOf = new Map<string, string>()
  for (const [prefix, file] of mounts) {
    if (!sourceOf.has(file)) sourceOf.set(file, readFileSync(join(ROOT, file), "utf8"))
    const source = sourceOf.get(file) as string
    for (const r of source.matchAll(/\.\s*(?:get|post|put|patch|delete|all)\(\s*"([^"]+)"/g)) {
      const declared = r[1]
      const params = [...declared.matchAll(/:(\w+)/g)].map((p) => p[1])
      if (!params.length) continue
      const tail = declared === "/" ? "" : declared
      routes.push({ file, fullPath: `${prefix}${tail}`, params })
    }
  }
  return routes
}

describe("drift guard: no credential-bearing route path escapes redaction", () => {
  const routes = collectMountedRoutes()

  it("found the routes it is supposed to be guarding", () => {
    expect(routes.length).toBeGreaterThan(50)
    const credentialed = routes.filter((r) =>
      r.params.some((p) => CREDENTIAL_PARAM_NAMES.includes(p)),
    )
    // The eight in OPS-42. A new one makes this fail loudly rather than
    // silently joining the uncovered set.
    expect(credentialed.map((r) => r.fullPath).sort()).toEqual([
      "/api/v2/access-links/:token/redeem",
      "/api/v2/access-links/:token/revoke",
      "/api/v2/invites/:token/accept",
      "/api/v2/invites/:token/preview",
      "/api/v2/orgs/:orgId/invites/:token",
      "/api/v2/orgs/invite-preview/:token",
      "/api/v2/projects/:projectId/invites/:token",
      "/api/v2/projects/invite-preview/:token",
    ])
  })

  it("redacts the credential parameter of every such route", () => {
    for (const route of routes) {
      const credentialParams = route.params.filter((p) => CREDENTIAL_PARAM_NAMES.includes(p))
      if (!credentialParams.length) continue
      const concrete = route.params.reduce(
        (path, param) =>
          path.replace(`:${param}`, CREDENTIAL_PARAM_NAMES.includes(param) ? TOKEN : "41"),
        route.fullPath,
      )
      const redacted = redactLogPath(concrete)
      expect(redacted, `${route.fullPath} (${route.file}) is not covered by CREDENTIAL_PATH_SHAPES`)
        .not.toContain(TOKEN)
    }
  })

  it("every declared shape is reachable by some real route", () => {
    const concrete = routes.map((route) =>
      route.params.reduce(
        (path, param) =>
          path.replace(`:${param}`, CREDENTIAL_PARAM_NAMES.includes(param) ? TOKEN : "41"),
        route.fullPath,
      ),
    )
    for (const shape of CREDENTIAL_PATH_SHAPES) {
      expect(
        concrete.some((path) => shape.pattern.test(path)),
        `shape "${shape.name}" matches no route — stale entry`,
      ).toBe(true)
    }
  })
})

describe("the log sinks read only the pathname (OPS-42)", () => {
  // `routes/monday.ts` reads an OAuth `?code=` from the query string. Nothing
  // redacts a query string, so nothing may log one — including the two
  // `[slow-request]` / unhandled-error sites, which build their own message.
  const sinks = [
    "auth-worker/src/posthog-logs.ts",
    "sync-worker/src/posthog-logs.ts",
    "auth-worker/src/index.ts",
    "sync-worker/src/index.ts",
  ]

  it.each(sinks)("%s never logs url.search / c.req.url", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8")
    const logging = source
      .split("\n")
      .filter((line) => /shipLog\(|console\.(warn|error|log)\(|"http\.path"/.test(line))
      .join("\n")
    expect(logging).not.toMatch(/url\.search|url\.href|searchParams/)
  })

  it.each(sinks)("%s routes every logged path through redactLogPath", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8")
    const values = [...source.matchAll(/"http\.path":\s*([^,\n]+)/g)].map((m) => m[1].trim())
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) {
      // Either the call itself, or a local the same file binds to the call.
      const redacted =
        value.includes("redactLogPath") ||
        new RegExp(`const ${value.replace(/[^\w]/g, "")} = redactLogPath\\(`).test(source)
      expect(redacted, `${file}: "http.path" (${value}) is not redacted`).toBe(true)
    }
  })
})
