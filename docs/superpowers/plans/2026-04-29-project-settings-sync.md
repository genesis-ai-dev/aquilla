# Project Settings Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace local-IDB-only project-wide settings (languages, system prompt, rules, health, validation counts) with server-authoritative D1 storage exposed by REST endpoints, with role-gated edits (PROJECT_LEAD+ / 500+), online-only writes, ETag-based conflict handling, and one-shot migration from existing IDB data on first PROJECT_LEAD+ open.

**Architecture:**
- Server (frontier-server, separate repo at `~/frontierrnd/frontier-server/cloudflare`): a 1:1 `project_settings` D1 table holds a JSON `settings` blob plus a monotonic `version` counter. Two endpoints: `GET /api/v2/projects/:id/settings` and `PATCH .../settings`. PATCH gates writes on `role.level >= 500`, requires `ifMatchVersion`, and merges top-level keys.
- Client (codex-web-app): a `useProjectSettings(projectId)` hook surfaces cached IDB values immediately, fetches and merges from the server, and routes optimistic writes through PATCH with online + role gating. `useProject` overlays synced fields onto the `ProjectRecord` shape so existing consumers (workspace header, settings page, rule engine, completion service) read from one type. Conflict (409) snaps to server with a toast naming the other user.
- Migration: when GET returns `version: 0` and local IDB has values, a PROJECT_LEAD+ device PATCHes them up exactly once. Sub-role users see local values until a maintainer-level user opens the project.

**Tech Stack:**
- Server: Hono on Cloudflare Workers, D1, existing `resolveProjectRole` from `src/services/project-permissions.ts`.
- Client: React, IndexedDB via `idb`, vitest, existing patterns from `useProject` / `cloud-projects.ts` / `members.ts`.
- Tests: vitest with mocked `fetch` for the REST client, `@testing-library/react` (already used by the repo) for the hook.

---

## Phase A — Server (frontier-server)

> All server tasks happen in the **`~/frontierrnd/frontier-server/cloudflare`** repo. Switch directories before starting these tasks. Commits go in that repo's history.

### Task 1: D1 migration 0017 — `project_settings` table

**Files:**
- Create: `migrations/0017_project_settings.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0017_project_settings.sql
-- Project-wide settings synced across collaborators. JSON blob keeps schema
-- migrations cheap as new keys land; old clients ignore unknown keys.

CREATE TABLE project_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  -- JSON object with optional keys: sourceLanguage, targetLanguage,
  -- systemPrompt, rules, rulePenalties, healthSettings, validationCount,
  -- validationCountAudio. Empty object is valid.
  settings TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  -- Monotonic counter — incremented atomically on PATCH. Clients send
  -- ifMatchVersion = previous value; mismatch returns 409.
  version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_project_settings_updated_at ON project_settings(updated_at);
```

- [ ] **Step 2: Apply locally and verify**

```bash
wrangler d1 execute frontier-db-v2 --local --file=migrations/0017_project_settings.sql
wrangler d1 execute frontier-db-v2 --local --command="SELECT name FROM sqlite_master WHERE type='table' AND name='project_settings'"
```

Expected: one row with `name = project_settings`.

- [ ] **Step 3: Commit**

```bash
git add migrations/0017_project_settings.sql
git commit -m "feat(d1): add project_settings table (0017)"
```

---

### Task 2: GET `/api/v2/projects/:id/settings` handler

**Files:**
- Create: `src/routes/project-settings.ts`
- Modify: the main router (e.g. `src/index.ts` or wherever `/api/v2/projects/:id/...` routes are registered today — match the existing pattern used by `/api/v2/projects/:id/members`).
- Test: `test/routes/project-settings.test.ts` (or alongside other route tests)

- [ ] **Step 1: Write the failing test**

```ts
// test/routes/project-settings.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import { setupTestEnv, makeAuthedRequest, createTestProject, createTestUser } from "../helpers" // match repo's existing test helpers

describe("GET /api/v2/projects/:id/settings", () => {
  it("returns version 0 + empty settings when no row exists", async () => {
    const env = await setupTestEnv()
    const owner = await createTestUser(env, { role: 700 })
    const project = await createTestProject(env, { ownerId: owner.id })
    const res = await makeAuthedRequest(env, owner, "GET", `/api/v2/projects/${project.id}/settings`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ version: 0, settings: {} })
    expect(body.updatedBy).toBeNull()
  })

  it("returns the stored row when one exists", async () => {
    const env = await setupTestEnv()
    const owner = await createTestUser(env, { role: 700 })
    const project = await createTestProject(env, { ownerId: owner.id })
    await env.DB.prepare(
      `INSERT INTO project_settings(project_id, settings, version, updated_by) VALUES (?, ?, 3, ?)`
    ).bind(project.id, JSON.stringify({ sourceLanguage: "en" }), owner.id).run()
    const res = await makeAuthedRequest(env, owner, "GET", `/api/v2/projects/${project.id}/settings`)
    const body = await res.json()
    expect(body.version).toBe(3)
    expect(body.settings.sourceLanguage).toBe("en")
    expect(body.updatedBy.username).toBe(owner.username)
  })

  it("returns 403 when caller has no role on the project", async () => {
    const env = await setupTestEnv()
    const owner = await createTestUser(env)
    const stranger = await createTestUser(env)
    const project = await createTestProject(env, { ownerId: owner.id })
    const res = await makeAuthedRequest(env, stranger, "GET", `/api/v2/projects/${project.id}/settings`)
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm test -- project-settings
```

Expected: FAIL with route not registered or 404.

- [ ] **Step 3: Implement the GET handler**

Open `src/routes/project-settings.ts` and add:

```ts
import { Hono } from "hono"
import type { Env } from "../types" // match repo's env type
import { resolveProjectRole } from "../services/project-permissions"
import { requireUser } from "../middleware/auth" // match repo's auth helper

interface SettingsRow {
  project_id: string
  settings: string
  updated_at: string
  updated_by: number | null
  version: number
}

interface SettingsRowExpanded extends SettingsRow {
  updatedBy: { id: number; username: string } | null
}

async function loadSettings(env: Env, projectId: string): Promise<SettingsRowExpanded> {
  const row = await env.DB.prepare(
    `SELECT s.project_id, s.settings, s.updated_at, s.updated_by, s.version,
            u.username AS updated_by_username
     FROM project_settings s
     LEFT JOIN users u ON u.id = s.updated_by
     WHERE s.project_id = ?`
  ).bind(projectId).first<SettingsRow & { updated_by_username: string | null }>()

  if (!row) {
    return {
      project_id: projectId,
      settings: "{}",
      updated_at: new Date().toISOString(),
      updated_by: null,
      version: 0,
      updatedBy: null,
    }
  }

  return {
    ...row,
    updatedBy: row.updated_by != null && row.updated_by_username
      ? { id: row.updated_by, username: row.updated_by_username }
      : null,
  }
}

export const projectSettingsRoutes = new Hono<{ Bindings: Env }>()

projectSettingsRoutes.get("/:id/settings", async (c) => {
  const user = await requireUser(c)
  if (!user) return c.json({ error: "unauthenticated" }, 401)

  const projectId = c.req.param("id")
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "forbidden" }, 403)

  const row = await loadSettings(c.env, projectId)
  return c.json({
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updatedBy,
    settings: JSON.parse(row.settings),
  })
})
```

- [ ] **Step 4: Wire the route into the main router**

Find where `/api/v2/projects/:id/members` (or another `/projects/:id/*` route) is registered. Add alongside it:

```ts
import { projectSettingsRoutes } from "./routes/project-settings"
// ...
app.route("/api/v2/projects", projectSettingsRoutes)
```

(If the existing pattern mounts each route file under `/api/v2/projects` and the file's routes use `:id/...` paths, this matches.)

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test -- project-settings
```

Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/project-settings.ts src/index.ts test/routes/project-settings.test.ts
git commit -m "feat(api): GET /api/v2/projects/:id/settings"
```

---

### Task 3: PATCH `/api/v2/projects/:id/settings` with role gate + ETag

**Files:**
- Modify: `src/routes/project-settings.ts`
- Modify: `test/routes/project-settings.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/project-settings.test.ts`:

```ts
describe("PATCH /api/v2/projects/:id/settings", () => {
  it("creates a row on first write and returns version 1", async () => {
    const env = await setupTestEnv()
    const owner = await createTestUser(env, { role: 700 })
    const project = await createTestProject(env, { ownerId: owner.id })
    const res = await makeAuthedRequest(env, owner, "PATCH", `/api/v2/projects/${project.id}/settings`, {
      settings: { sourceLanguage: "en", targetLanguage: "swh" },
      ifMatchVersion: 0,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toBe(1)
    expect(body.settings).toEqual({ sourceLanguage: "en", targetLanguage: "swh" })
    expect(body.updatedBy.username).toBe(owner.username)
  })

  it("merges top-level keys without losing existing ones", async () => {
    const env = await setupTestEnv()
    const owner = await createTestUser(env, { role: 700 })
    const project = await createTestProject(env, { ownerId: owner.id })
    // First write: languages
    await makeAuthedRequest(env, owner, "PATCH", `/api/v2/projects/${project.id}/settings`, {
      settings: { sourceLanguage: "en", targetLanguage: "swh" },
      ifMatchVersion: 0,
    })
    // Second write: just systemPrompt
    const res = await makeAuthedRequest(env, owner, "PATCH", `/api/v2/projects/${project.id}/settings`, {
      settings: { systemPrompt: "Translate idiomatically." },
      ifMatchVersion: 1,
    })
    const body = await res.json()
    expect(body.version).toBe(2)
    expect(body.settings).toEqual({
      sourceLanguage: "en",
      targetLanguage: "swh",
      systemPrompt: "Translate idiomatically.",
    })
  })

  it("returns 409 with current state when ifMatchVersion is stale", async () => {
    const env = await setupTestEnv()
    const owner = await createTestUser(env, { role: 700 })
    const project = await createTestProject(env, { ownerId: owner.id })
    await makeAuthedRequest(env, owner, "PATCH", `/api/v2/projects/${project.id}/settings`, {
      settings: { sourceLanguage: "en" },
      ifMatchVersion: 0,
    })
    const res = await makeAuthedRequest(env, owner, "PATCH", `/api/v2/projects/${project.id}/settings`, {
      settings: { sourceLanguage: "fr" },
      ifMatchVersion: 0, // stale; current is 1
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.latest.version).toBe(1)
    expect(body.latest.settings.sourceLanguage).toBe("en")
  })

  it("returns 403 with required + current role for sub-PROJECT_LEAD callers", async () => {
    const env = await setupTestEnv()
    const owner = await createTestUser(env, { role: 700 })
    const contributor = await createTestUser(env)
    const project = await createTestProject(env, { ownerId: owner.id })
    await env.DB.prepare(
      `INSERT INTO project_members(project_id, user_id, role_level, granted_by) VALUES (?, ?, 400, ?)`
    ).bind(project.id, contributor.id, owner.id).run()
    const res = await makeAuthedRequest(env, contributor, "PATCH", `/api/v2/projects/${project.id}/settings`, {
      settings: { sourceLanguage: "en" },
      ifMatchVersion: 0,
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.required).toBe(500)
    expect(body.role).toBe(400)
  })

  it("rejects ifMatchVersion != 0 against a non-existent row", async () => {
    const env = await setupTestEnv()
    const owner = await createTestUser(env, { role: 700 })
    const project = await createTestProject(env, { ownerId: owner.id })
    const res = await makeAuthedRequest(env, owner, "PATCH", `/api/v2/projects/${project.id}/settings`, {
      settings: { sourceLanguage: "en" },
      ifMatchVersion: 5, // no row exists; only 0 is valid
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.latest.version).toBe(0)
  })

  it("PROJECT_LEAD (500) can write", async () => {
    const env = await setupTestEnv()
    const owner = await createTestUser(env, { role: 700 })
    const lead = await createTestUser(env)
    const project = await createTestProject(env, { ownerId: owner.id })
    await env.DB.prepare(
      `INSERT INTO project_members(project_id, user_id, role_level, granted_by) VALUES (?, ?, 500, ?)`
    ).bind(project.id, lead.id, owner.id).run()
    const res = await makeAuthedRequest(env, lead, "PATCH", `/api/v2/projects/${project.id}/settings`, {
      settings: { systemPrompt: "Be concise." },
      ifMatchVersion: 0,
    })
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npm test -- project-settings
```

Expected: 6 new tests fail (PATCH route not implemented).

- [ ] **Step 3: Implement the PATCH handler**

Append to `src/routes/project-settings.ts`:

```ts
const EDIT_ROLE_FLOOR = 500 // PROJECT_LEAD+

interface PatchBody {
  settings?: Record<string, unknown>
  ifMatchVersion?: number
}

projectSettingsRoutes.patch("/:id/settings", async (c) => {
  const user = await requireUser(c)
  if (!user) return c.json({ error: "unauthenticated" }, 401)

  const projectId = c.req.param("id")
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "forbidden" }, 403)
  if (role.level < EDIT_ROLE_FLOOR) {
    return c.json({ error: "forbidden", required: EDIT_ROLE_FLOOR, role: role.level }, 403)
  }

  const body = await c.req.json<PatchBody>().catch(() => null)
  if (!body || typeof body.settings !== "object" || body.settings === null) {
    return c.json({ error: "settings must be a JSON object" }, 400)
  }
  if (typeof body.ifMatchVersion !== "number") {
    return c.json({ error: "ifMatchVersion (number) is required" }, 400)
  }

  // Read current state.
  const existing = await c.env.DB.prepare(
    `SELECT version, settings FROM project_settings WHERE project_id = ?`
  ).bind(projectId).first<{ version: number; settings: string }>()

  const currentVersion = existing?.version ?? 0
  if (currentVersion !== body.ifMatchVersion) {
    const latest = await loadSettings(c.env, projectId)
    return c.json({
      error: "version mismatch",
      latest: {
        version: latest.version,
        updatedAt: latest.updated_at,
        updatedBy: latest.updatedBy,
        settings: JSON.parse(latest.settings),
      },
    }, 409)
  }

  const merged = JSON.stringify({
    ...JSON.parse(existing?.settings ?? "{}"),
    ...body.settings,
  })

  if (existing) {
    // Atomic UPDATE re-checks version, defending against a race between the
    // SELECT above and this UPDATE.
    const updated = await c.env.DB.prepare(
      `UPDATE project_settings
       SET settings = ?, version = version + 1, updated_by = ?, updated_at = datetime('now')
       WHERE project_id = ? AND version = ?
       RETURNING version`
    ).bind(merged, user.id, projectId, body.ifMatchVersion).first<{ version: number }>()
    if (!updated) {
      const latest = await loadSettings(c.env, projectId)
      return c.json({
        error: "version mismatch",
        latest: {
          version: latest.version,
          updatedAt: latest.updated_at,
          updatedBy: latest.updatedBy,
          settings: JSON.parse(latest.settings),
        },
      }, 409)
    }
  } else {
    // INSERT fails (UNIQUE) if another writer beat us — treat that as 409.
    try {
      await c.env.DB.prepare(
        `INSERT INTO project_settings (project_id, settings, version, updated_by, updated_at)
         VALUES (?, ?, 1, ?, datetime('now'))`
      ).bind(projectId, merged, user.id).run()
    } catch {
      const latest = await loadSettings(c.env, projectId)
      return c.json({
        error: "version mismatch",
        latest: {
          version: latest.version,
          updatedAt: latest.updated_at,
          updatedBy: latest.updatedBy,
          settings: JSON.parse(latest.settings),
        },
      }, 409)
    }
  }

  const fresh = await loadSettings(c.env, projectId)
  return c.json({
    version: fresh.version,
    updatedAt: fresh.updated_at,
    updatedBy: fresh.updatedBy,
    settings: JSON.parse(fresh.settings),
  })
})
```

The two-path implementation (UPDATE for existing rows, INSERT for first writes) keeps the version-check explicit and the SQL readable. The version check happens in two places — the early SELECT for fast-path 409, and the UPDATE's `WHERE version = ?` clause for the read-then-write race — so concurrent writers cannot both win.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- project-settings
```

Expected: all 9 tests pass (3 GET + 6 PATCH).

- [ ] **Step 5: Commit**

```bash
git add src/routes/project-settings.ts test/routes/project-settings.test.ts
git commit -m "feat(api): PATCH /api/v2/projects/:id/settings with role gate + ETag"
```

---

### Task 4: Cross-check role downgrade after stale JWT

**Files:**
- Modify: `test/routes/project-settings.test.ts`

The spec requires server-side role re-check at request time, not from a JWT claim. `resolveProjectRole` already does this. Add one more test confirming the behavior so it can't regress.

- [ ] **Step 1: Write the failing test**

```ts
it("re-checks role at request time even with a still-valid JWT", async () => {
  const env = await setupTestEnv()
  const owner = await createTestUser(env, { role: 700 })
  const lead = await createTestUser(env)
  const project = await createTestProject(env, { ownerId: owner.id })
  await env.DB.prepare(
    `INSERT INTO project_members(project_id, user_id, role_level, granted_by) VALUES (?, ?, 500, ?)`
  ).bind(project.id, lead.id, owner.id).run()
  // First write succeeds.
  const ok = await makeAuthedRequest(env, lead, "PATCH", `/api/v2/projects/${project.id}/settings`, {
    settings: { sourceLanguage: "en" }, ifMatchVersion: 0,
  })
  expect(ok.status).toBe(200)
  // Demote lead to contributor (400) directly in DB. JWT still says lead.
  await env.DB.prepare(
    `UPDATE project_members SET role_level = 400 WHERE project_id = ? AND user_id = ?`
  ).bind(project.id, lead.id).run()
  // Second write must be rejected.
  const denied = await makeAuthedRequest(env, lead, "PATCH", `/api/v2/projects/${project.id}/settings`, {
    settings: { sourceLanguage: "fr" }, ifMatchVersion: 1,
  })
  expect(denied.status).toBe(403)
})
```

- [ ] **Step 2: Run the test**

```bash
npm test -- project-settings
```

Expected: passes (existing implementation already re-resolves role per request).

- [ ] **Step 3: Commit**

```bash
git add test/routes/project-settings.test.ts
git commit -m "test(api): pin per-request role re-check on settings PATCH"
```

---

> **End of frontier-server work. Switch back to `~/prototypes/codex-web-app` for the rest.**

---

## Phase B — Client REST + hook (codex-web-app)

### Task 5: REST library — `project-settings.ts`

**Files:**
- Create: `src/lib/sync/project-settings.ts`
- Test: `src/lib/sync/project-settings.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/sync/project-settings.test.ts
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  fetchProjectSettings,
  patchProjectSettings,
  PROJECT_SETTINGS_VERSION_INITIAL,
} from "./project-settings"

const API = "https://api.example.com"

afterEach(() => vi.restoreAllMocks())

describe("fetchProjectSettings", () => {
  it("returns parsed settings on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({
        version: 4,
        updatedAt: "2026-04-29T10:00:00Z",
        updatedBy: { id: 7, username: "ryder" },
        settings: { sourceLanguage: "en" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ))
    const got = await fetchProjectSettings("jwt", "p1", API)
    expect(got).toEqual({
      version: 4,
      updatedAt: "2026-04-29T10:00:00Z",
      updatedBy: { id: 7, username: "ryder" },
      settings: { sourceLanguage: "en" },
    })
  })

  it("returns null on 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }))
    expect(await fetchProjectSettings("jwt", "p1", API)).toBeNull()
  })

  it("returns null on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    expect(await fetchProjectSettings("jwt", "p1", API)).toBeNull()
  })
})

describe("patchProjectSettings", () => {
  it("returns the new state on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({
        version: 5,
        updatedAt: "2026-04-29T10:01:00Z",
        updatedBy: { id: 7, username: "ryder" },
        settings: { sourceLanguage: "en", systemPrompt: "x" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ))
    const got = await patchProjectSettings("jwt", "p1", { systemPrompt: "x" }, 4, API)
    expect(got.kind).toBe("ok")
    if (got.kind === "ok") expect(got.value.version).toBe(5)
  })

  it("returns conflict + latest on 409", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({
        error: "version mismatch",
        latest: {
          version: 7,
          updatedAt: "2026-04-29T10:02:00Z",
          updatedBy: { id: 12, username: "alex" },
          settings: { sourceLanguage: "fr" },
        },
      }),
      { status: 409, headers: { "content-type": "application/json" } }
    ))
    const got = await patchProjectSettings("jwt", "p1", { sourceLanguage: "en" }, 4, API)
    expect(got.kind).toBe("conflict")
    if (got.kind === "conflict") {
      expect(got.latest.version).toBe(7)
      expect(got.latest.updatedBy?.username).toBe("alex")
    }
  })

  it("returns forbidden + required level on 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ error: "forbidden", required: 500, role: 400 }),
      { status: 403, headers: { "content-type": "application/json" } }
    ))
    const got = await patchProjectSettings("jwt", "p1", { sourceLanguage: "en" }, 0, API)
    expect(got.kind).toBe("forbidden")
    if (got.kind === "forbidden") {
      expect(got.required).toBe(500)
      expect(got.role).toBe(400)
    }
  })
})

it("PROJECT_SETTINGS_VERSION_INITIAL is 0", () => {
  expect(PROJECT_SETTINGS_VERSION_INITIAL).toBe(0)
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/lib/sync/project-settings.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement the REST library**

```ts
// src/lib/sync/project-settings.ts
import { FRONTIER_API_URL } from "./sync-token"
import type {
  TranslationRule,
  RulePenalties,
  HealthSettings,
} from "@/lib/parsers/types"

/** Initial server version for projects with no settings row. */
export const PROJECT_SETTINGS_VERSION_INITIAL = 0

/**
 * The synced subset of project-wide fields. Mirrors the server's settings
 * JSON. Top-level keys only — deep merge is not performed; replacing
 * `rules` replaces the whole array.
 *
 * Device-local fields (apiKey, endpoint, audio strategy, experimental flags,
 * TTS, dismissed-banner state) are deliberately absent.
 */
export interface ProjectWideSettings {
  sourceLanguage?: string
  targetLanguage?: string
  systemPrompt?: string
  rules?: TranslationRule[]
  rulePenalties?: RulePenalties
  healthSettings?: HealthSettings
  validationCount?: number
  validationCountAudio?: number
}

export interface ProjectSettingsResponse {
  version: number
  updatedAt: string
  updatedBy: { id: number; username: string } | null
  settings: ProjectWideSettings
}

export type PatchResult =
  | { kind: "ok"; value: ProjectSettingsResponse }
  | { kind: "conflict"; latest: ProjectSettingsResponse }
  | { kind: "forbidden"; required: number; role: number }
  | { kind: "error"; status: number; message: string }

function authHeaders(jwt: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  }
}

/**
 * GET /api/v2/projects/:id/settings.
 *
 * Returns null on 403/404 (caller has no access or project doesn't exist
 * server-side) and on any network error — callers fall back to local IDB.
 * Real server failures (5xx that aren't network errors) also return null;
 * we do not surface them as exceptions because the consumer's UI is
 * already tolerant of "offline / unknown".
 */
export async function fetchProjectSettings(
  jwt: string,
  projectId: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<ProjectSettingsResponse | null> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
      { headers: authHeaders(jwt) },
    )
    if (!res.ok) return null
    return (await res.json()) as ProjectSettingsResponse
  } catch {
    return null
  }
}

/**
 * PATCH /api/v2/projects/:id/settings. The server merges top-level keys.
 * Caller must include `ifMatchVersion`; mismatched version returns
 * `{kind: "conflict", latest}`. Sub-PROJECT_LEAD callers get
 * `{kind: "forbidden", required, role}`.
 */
export async function patchProjectSettings(
  jwt: string,
  projectId: string,
  settings: ProjectWideSettings,
  ifMatchVersion: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<PatchResult> {
  let res: Response
  try {
    res = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
      {
        method: "PATCH",
        headers: authHeaders(jwt),
        body: JSON.stringify({ settings, ifMatchVersion }),
      },
    )
  } catch (e) {
    return { kind: "error", status: 0, message: e instanceof Error ? e.message : String(e) }
  }

  if (res.ok) {
    const value = (await res.json()) as ProjectSettingsResponse
    return { kind: "ok", value }
  }
  if (res.status === 409) {
    const body = (await res.json()) as { latest: ProjectSettingsResponse }
    return { kind: "conflict", latest: body.latest }
  }
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { required?: number; role?: number }
    return { kind: "forbidden", required: body.required ?? 500, role: body.role ?? 0 }
  }
  const text = await res.text().catch(() => "")
  return { kind: "error", status: res.status, message: text }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npx vitest run src/lib/sync/project-settings.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/project-settings.ts src/lib/sync/project-settings.test.ts
git commit -m "feat(sync): add project-settings REST client"
```

---

### Task 6: `useProjectSettings` hook — read path + online detection

**Files:**
- Create: `src/hooks/useProjectSettings.ts`
- Test: `src/hooks/useProjectSettings.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/hooks/useProjectSettings.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { useProjectSettings } from "./useProjectSettings"
import * as restClient from "@/lib/sync/project-settings"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "ryder" } }),
}))

vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(async () => ({
    id: "p1", name: "P", sourceLanguage: "en", targetLanguage: "swh",
    files: [], members: [], createdAt: "", syncRole: { level: 700, name: "owner", source: "creator", fetchedAt: "" },
  })),
  patchProject: vi.fn(async (id: string, fn: (p: any) => any) => fn({ id })),
}))

beforeEach(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
})

afterEach(() => vi.restoreAllMocks())

describe("useProjectSettings — read path", () => {
  it("surfaces local IDB values immediately, then merges server values", async () => {
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue({
      version: 3,
      updatedAt: "2026-04-29T10:00:00Z",
      updatedBy: { id: 1, username: "alex" },
      settings: { sourceLanguage: "fr", systemPrompt: "Be concise." },
    })
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    // Local first.
    await waitFor(() => expect(result.current.settings.sourceLanguage).toBe("en"))
    // Then server wins.
    await waitFor(() => expect(result.current.settings.sourceLanguage).toBe("fr"))
    expect(result.current.settings.systemPrompt).toBe("Be concise.")
    expect(result.current.version).toBe(3)
  })

  it("treats version 0 + empty server settings as no-server-row (keeps local)", async () => {
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue({
      version: 0,
      updatedAt: "2026-04-29T10:00:00Z",
      updatedBy: null,
      settings: {},
    })
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(result.current.version).toBe(0))
    expect(result.current.settings.sourceLanguage).toBe("en") // from local IDB
  })

  it("canEdit is false when offline even at OWNER role", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue(null)
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(result.current.canEdit).toBe(false))
    expect(result.current.reasonCannotEdit).toBe("offline")
  })

  it("canEdit is false at CONTRIBUTOR (400)", async () => {
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue(null)
    const { result } = renderHook(() => useProjectSettings("p1", 400))
    await waitFor(() => expect(result.current.canEdit).toBe(false))
    expect(result.current.reasonCannotEdit).toBe("role")
  })

  it("canEdit is true at PROJECT_LEAD (500) while online", async () => {
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue(null)
    const { result } = renderHook(() => useProjectSettings("p1", 500))
    await waitFor(() => expect(result.current.canEdit).toBe(true))
    expect(result.current.reasonCannotEdit).toBeNull()
  })

  it("re-fetches when navigator transitions offline -> online", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
    const fetchSpy = vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue(null)
    renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(0))
    act(() => {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
      window.dispatchEvent(new Event("online"))
    })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run src/hooks/useProjectSettings.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement the hook (read path only)**

```ts
// src/hooks/useProjectSettings.ts
import { useCallback, useEffect, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getProject, patchProject } from "@/lib/store/project-index"
import {
  fetchProjectSettings,
  PROJECT_SETTINGS_VERSION_INITIAL,
  type ProjectWideSettings,
  type ProjectSettingsResponse,
} from "@/lib/sync/project-settings"

const EDIT_ROLE_FLOOR = 500 // PROJECT_LEAD+

export type CannotEditReason = "offline" | "role" | null

export interface UseProjectSettings {
  /** Merged view: server values overlay local IDB values for keys the
   *  server has set. Always defined (may be empty). */
  settings: ProjectWideSettings
  /** Server version of the settings row. null = never fetched yet. */
  version: number | null
  /** "When was this last edited and by whom" — null if no server row yet. */
  updatedBy: { id: number; username: string } | null
  updatedAt: string | null
  /** True after the first GET resolves (success OR network failure). */
  hasFetched: boolean
  isOnline: boolean
  canEdit: boolean
  reasonCannotEdit: CannotEditReason
  /** Force a re-GET. */
  refresh: () => Promise<void>
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [])
  return online
}

/** Pull synced subset out of a ProjectRecord for local-cache merge. */
function localSettingsFrom(record: Awaited<ReturnType<typeof getProject>>): ProjectWideSettings {
  if (!record) return {}
  const out: ProjectWideSettings = {}
  if (record.sourceLanguage) out.sourceLanguage = record.sourceLanguage
  if (record.targetLanguage) out.targetLanguage = record.targetLanguage
  if (record.completionSettings?.systemPrompt) out.systemPrompt = record.completionSettings.systemPrompt
  if (record.rules) out.rules = record.rules
  if (record.rulePenalties) out.rulePenalties = record.rulePenalties
  if (record.healthSettings) out.healthSettings = record.healthSettings
  if (record.validationCount != null) out.validationCount = record.validationCount
  if (record.validationCountAudio != null) out.validationCountAudio = record.validationCountAudio
  return out
}

/**
 * Project-wide settings: read from local IDB cache, refreshed from
 * frontier-server, with online + role gating for writes (writes added in
 * the next task). Pass the caller's role level for this project — usually
 * sourced from `useProject`'s `project.syncRole.level`.
 */
export function useProjectSettings(
  projectId: string | null,
  roleLevel: number | null,
): UseProjectSettings {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const isOnline = useOnline()

  const [server, setServer] = useState<ProjectSettingsResponse | null>(null)
  const [local, setLocal] = useState<ProjectWideSettings>({})
  const [hasFetched, setHasFetched] = useState(false)
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  // Hydrate local cache once the projectId is known.
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    void getProject(projectId).then((rec) => {
      if (!cancelled && aliveRef.current) setLocal(localSettingsFrom(rec))
    })
    return () => { cancelled = true }
  }, [projectId])

  const refresh = useCallback(async () => {
    if (!projectId || !jwt) return
    if (!isOnline) return
    const got = await fetchProjectSettings(jwt, projectId)
    if (!aliveRef.current) return
    setServer(got)
    setHasFetched(true)
    // Persist non-empty server settings into IDB so a later offline open
    // doesn't lose what we just learned.
    if (got && got.version > 0 && projectId) {
      await patchProject(projectId, (existing) => ({
        ...existing,
        ...(got.settings.sourceLanguage != null
          ? { sourceLanguage: got.settings.sourceLanguage } : {}),
        ...(got.settings.targetLanguage != null
          ? { targetLanguage: got.settings.targetLanguage } : {}),
        ...(got.settings.systemPrompt != null
          ? { completionSettings: { ...(existing.completionSettings ?? {}), systemPrompt: got.settings.systemPrompt } as any }
          : {}),
        ...(got.settings.rules != null ? { rules: got.settings.rules } : {}),
        ...(got.settings.rulePenalties != null ? { rulePenalties: got.settings.rulePenalties } : {}),
        ...(got.settings.healthSettings != null ? { healthSettings: got.settings.healthSettings } : {}),
        ...(got.settings.validationCount != null ? { validationCount: got.settings.validationCount } : {}),
        ...(got.settings.validationCountAudio != null ? { validationCountAudio: got.settings.validationCountAudio } : {}),
      }))
    }
  }, [projectId, jwt, isOnline])

  useEffect(() => { void refresh() }, [refresh])

  // Re-fetch when transitioning offline -> online.
  useEffect(() => {
    if (isOnline && projectId && jwt) void refresh()
  }, [isOnline, projectId, jwt, refresh])

  // Server values overlay local for keys the server has set.
  const settings: ProjectWideSettings = server && server.version > 0
    ? { ...local, ...server.settings }
    : local

  const canEdit = isOnline && roleLevel != null && roleLevel >= EDIT_ROLE_FLOOR
  const reasonCannotEdit: CannotEditReason = canEdit
    ? null
    : !isOnline
      ? "offline"
      : "role"

  return {
    settings,
    version: server ? server.version : null,
    updatedBy: server?.updatedBy ?? null,
    updatedAt: server?.updatedAt ?? null,
    hasFetched,
    isOnline,
    canEdit,
    reasonCannotEdit,
    refresh,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/hooks/useProjectSettings.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useProjectSettings.ts src/hooks/useProjectSettings.test.ts
git commit -m "feat(hooks): useProjectSettings read path + online detection"
```

---

### Task 7: `useProjectSettings` hook — write path with conflict handling

**Files:**
- Modify: `src/hooks/useProjectSettings.ts`
- Modify: `src/hooks/useProjectSettings.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/hooks/useProjectSettings.test.ts`:

```ts
describe("useProjectSettings — write path", () => {
  it("returns blocked-offline when offline", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    const got = await result.current.patch({ sourceLanguage: "fr" })
    expect(got.kind).toBe("blocked")
    if (got.kind === "blocked") expect(got.reason).toBe("offline")
  })

  it("returns blocked-role for sub-PROJECT_LEAD callers", async () => {
    const { result } = renderHook(() => useProjectSettings("p1", 400))
    const got = await result.current.patch({ sourceLanguage: "fr" })
    expect(got.kind).toBe("blocked")
    if (got.kind === "blocked") expect(got.reason).toBe("role")
  })

  it("optimistic write + server confirm", async () => {
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue({
      version: 1, updatedAt: "x", updatedBy: { id: 1, username: "ryder" },
      settings: { sourceLanguage: "en" },
    })
    const patchSpy = vi.spyOn(restClient, "patchProjectSettings").mockResolvedValue({
      kind: "ok",
      value: {
        version: 2, updatedAt: "y", updatedBy: { id: 1, username: "ryder" },
        settings: { sourceLanguage: "fr" },
      },
    })
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(result.current.version).toBe(1))
    let res!: any
    await act(async () => {
      res = await result.current.patch({ sourceLanguage: "fr" })
    })
    expect(res.kind).toBe("ok")
    expect(patchSpy).toHaveBeenCalledWith("test-jwt", "p1", { sourceLanguage: "fr" }, 1)
    expect(result.current.settings.sourceLanguage).toBe("fr")
    expect(result.current.version).toBe(2)
  })

  it("snaps to server on conflict", async () => {
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue({
      version: 1, updatedAt: "x", updatedBy: { id: 1, username: "ryder" },
      settings: { sourceLanguage: "en" },
    })
    vi.spyOn(restClient, "patchProjectSettings").mockResolvedValue({
      kind: "conflict",
      latest: {
        version: 2, updatedAt: "y", updatedBy: { id: 9, username: "alex" },
        settings: { sourceLanguage: "de" },
      },
    })
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(result.current.version).toBe(1))
    let res!: any
    await act(async () => {
      res = await result.current.patch({ sourceLanguage: "fr" })
    })
    expect(res.kind).toBe("conflict")
    if (res.kind === "conflict") expect(res.latest.updatedBy?.username).toBe("alex")
    expect(result.current.settings.sourceLanguage).toBe("de") // snapped to server
    expect(result.current.version).toBe(2)
  })
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run src/hooks/useProjectSettings.test.ts
```

Expected: 4 new tests fail (no `patch` method).

- [ ] **Step 3: Extend the hook with the write path**

In `src/hooks/useProjectSettings.ts`, add to the imports:

```ts
import { patchProjectSettings, type PatchResult } from "@/lib/sync/project-settings"
```

Extend the `UseProjectSettings` interface:

```ts
export type PatchOutcome =
  | { kind: "ok" }
  | { kind: "conflict"; latest: ProjectSettingsResponse }
  | { kind: "blocked"; reason: "offline" | "role" }
  | { kind: "error"; message: string }

export interface UseProjectSettings {
  // ...existing fields...
  patch: (partial: ProjectWideSettings) => Promise<PatchOutcome>
}
```

Inside the hook body, before the `return`, add:

```ts
const patch = useCallback(async (partial: ProjectWideSettings): Promise<PatchOutcome> => {
  if (!projectId || !jwt) return { kind: "error", message: "no session or project" }
  if (!isOnline) return { kind: "blocked", reason: "offline" }
  if (roleLevel == null || roleLevel < EDIT_ROLE_FLOOR) return { kind: "blocked", reason: "role" }

  const baseVersion = server?.version ?? PROJECT_SETTINGS_VERSION_INITIAL

  // Optimistic local update so the UI feels instant.
  const optimistic: ProjectSettingsResponse = {
    version: baseVersion,
    updatedAt: server?.updatedAt ?? new Date().toISOString(),
    updatedBy: server?.updatedBy ?? null,
    settings: { ...(server?.settings ?? {}), ...partial },
  }
  setServer(optimistic)

  const result: PatchResult = await patchProjectSettings(jwt, projectId, partial, baseVersion)
  if (!aliveRef.current) return { kind: "ok" }

  if (result.kind === "ok") {
    setServer(result.value)
    return { kind: "ok" }
  }
  if (result.kind === "conflict") {
    // Snap to server's current state. The toast caller surfaces the username.
    setServer(result.latest)
    return { kind: "conflict", latest: result.latest }
  }
  // Any other outcome: revert optimistic update by re-fetching.
  await refresh()
  if (result.kind === "forbidden") {
    return { kind: "blocked", reason: "role" }
  }
  return { kind: "error", message: result.message }
}, [projectId, jwt, isOnline, roleLevel, server, refresh])
```

And include `patch` in the returned object.

- [ ] **Step 4: Run tests to verify pass**

```bash
npx vitest run src/hooks/useProjectSettings.test.ts
```

Expected: all 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useProjectSettings.ts src/hooks/useProjectSettings.test.ts
git commit -m "feat(hooks): useProjectSettings write path with optimistic + conflict snap"
```

---

## Phase C — Wire into existing UI

### Task 8: Merge synced settings into `useProject`'s `ProjectRecord`

**Files:**
- Modify: `src/hooks/useProject.ts`

The goal: existing consumers of `project.sourceLanguage`, `project.completionSettings.systemPrompt`, `project.rules`, etc. continue to work without per-callsite changes. We overlay synced fields onto the IDB record.

- [ ] **Step 1: Open the file**

Read [src/hooks/useProject.ts](src/hooks/useProject.ts) to refresh on its current shape.

- [ ] **Step 2: Add merge helper inside the hook**

Add this helper above the `useProject` function:

```ts
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

/** Overlay synced settings onto an IDB ProjectRecord. Server wins for keys
 *  it has set; local fields outside the synced subset are untouched. */
function overlaySettings(record: ProjectRecord, settings: ProjectWideSettings): ProjectRecord {
  const next: ProjectRecord = { ...record }
  if (settings.sourceLanguage != null) next.sourceLanguage = settings.sourceLanguage
  if (settings.targetLanguage != null) next.targetLanguage = settings.targetLanguage
  if (settings.systemPrompt != null) {
    next.completionSettings = {
      ...(record.completionSettings ?? {} as any),
      systemPrompt: settings.systemPrompt,
    }
  }
  if (settings.rules != null) next.rules = settings.rules
  if (settings.rulePenalties != null) next.rulePenalties = settings.rulePenalties
  if (settings.healthSettings != null) next.healthSettings = settings.healthSettings
  if (settings.validationCount != null) next.validationCount = settings.validationCount
  if (settings.validationCountAudio != null) next.validationCountAudio = settings.validationCountAudio
  return next
}
```

- [ ] **Step 3: Wire `useProjectSettings` into `useProject`**

Inside `useProject`, after deriving `project` and `status`, call `useProjectSettings` and overlay:

```ts
const roleLevel = project?.syncRole?.level ?? null
const { settings: syncedSettings } = useProjectSettings(projectId, roleLevel)

const overlaid = project ? overlaySettings(project, syncedSettings) : null

return { project: overlaid, status, loading: status === "loading", refresh }
```

- [ ] **Step 4: Verify the existing useProject tests still pass (if any)**

```bash
npx vitest run src/hooks/useProject
```

Expected: existing tests pass; if there are no tests, skip.

- [ ] **Step 5: Smoke-test in the dev server**

Start the dev server, open a project, verify languages/system prompt render from the overlay (will be empty until Task 12 migration runs in production data, but the merge code path should not crash).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useProject.ts
git commit -m "feat(hooks): overlay synced settings onto useProject ProjectRecord"
```

---

### Task 9: ProjectSettings — disable shared fields when `!canEdit`

**Files:**
- Modify: `src/components/ProjectSettings.tsx`

- [ ] **Step 1: Add a helper hook adapter at the top of the component**

After the existing `const { project, loading, refresh } = useProject(id!)`:

```ts
const { canEdit: canEditShared, reasonCannotEdit, version, updatedBy, updatedAt, patch: patchShared } =
  useProjectSettings(id ?? null, project?.syncRole?.level ?? null)
```

Import:

```ts
import { useProjectSettings } from "@/hooks/useProjectSettings"
```

- [ ] **Step 2: Compute the disabled tooltip text**

Add near the top of the component body:

```ts
const sharedDisabledTooltip =
  reasonCannotEdit === "offline" ? "Reconnect to edit shared settings."
  : reasonCannotEdit === "role" ? "Project Lead or higher can edit shared settings."
  : null
```

- [ ] **Step 3: Mark every shared input as conditionally disabled**

For each of the following fields, set `disabled={!canEditShared}` on the `<Input>` / `<Textarea>` / etc. and wrap them in a tooltip showing `sharedDisabledTooltip` when present:
- Source Language input (id `sl`)
- Target Language input (id `tl`)
- System prompt textarea (the `setSystemPrompt` field)
- Rules-related controls (if present in this file — otherwise leave for the rules drawer)
- Health/validation count fields

Pattern:

```tsx
<Tooltip content={sharedDisabledTooltip ?? undefined}>
  <Input
    id="sl"
    value={sourceLanguage}
    onChange={(e) => setSourceLanguage(e.target.value)}
    onBlur={() => savePartialShared({ sourceLanguage })}
    disabled={!canEditShared}
  />
</Tooltip>
```

The `Tooltip` wrapper renders no chrome when `content` is undefined — keep behavior unchanged for editable users.

- [ ] **Step 4: Replace `saveField` for shared fields with `patchShared`**

Add a helper at the top of the component:

```ts
const savePartialShared = useCallback(async (partial: Parameters<typeof patchShared>[0]) => {
  const out = await patchShared(partial)
  if (out.kind === "ok") {
    flash()
  } else if (out.kind === "blocked") {
    // Field shouldn't have been editable. No-op; UI already prevents this.
  } else if (out.kind === "conflict") {
    // Conflict toast is handled in the next task. For now, no-op (settings
    // already snapped to server inside the hook, fields will re-render).
  }
}, [patchShared, flash])
```

Replace each shared-field `onBlur={() => saveField({ sourceLanguage })}` with `onBlur={() => savePartialShared({ sourceLanguage })}`. Device-local fields (apiKey, endpoint, model, audio strategy, experimental flags) keep their existing `saveField` path.

For the systemPrompt field specifically, since `saveField` previously wrote to `completionSettings.systemPrompt` via deep-merge, route this one through `savePartialShared({ systemPrompt: ... })`.

- [ ] **Step 5: Add API key hint text**

Below the API key `<Input>`:

```tsx
<p className="text-xs text-muted-foreground">
  Stays on this device — not shared with collaborators.
</p>
```

- [ ] **Step 6: Smoke-test**

Open a project as OWNER (canEdit=true): all fields editable. Disconnect Wi-Fi (or DevTools → Network → Offline), confirm shared fields go disabled with the tooltip; device-local fields stay editable. Reconnect, confirm fields re-enable.

- [ ] **Step 7: Commit**

```bash
git add src/components/ProjectSettings.tsx
git commit -m "feat(settings): disable shared fields when offline or below PROJECT_LEAD"
```

---

### Task 10: ProjectSettings — conflict toast + "last edited by" line

**Files:**
- Modify: `src/components/ProjectSettings.tsx`

- [ ] **Step 1: Add conflict toast state**

Near the existing toast/flash state in the component:

```ts
const [conflictBy, setConflictBy] = useState<string | null>(null)
useEffect(() => {
  if (!conflictBy) return
  const t = setTimeout(() => setConflictBy(null), 4000)
  return () => clearTimeout(t)
}, [conflictBy])
```

- [ ] **Step 2: Surface conflict from `savePartialShared`**

Update the `savePartialShared` from Task 9:

```ts
const savePartialShared = useCallback(async (partial: Parameters<typeof patchShared>[0]) => {
  const out = await patchShared(partial)
  if (out.kind === "ok") {
    flash()
  } else if (out.kind === "conflict") {
    setConflictBy(out.latest.updatedBy?.username ?? "another collaborator")
  }
  // blocked / error: no-op
}, [patchShared, flash])
```

- [ ] **Step 3: Render the conflict toast**

Near the bottom of the component (next to any existing toast):

```tsx
{conflictBy && (
  <div className="fixed bottom-4 right-4 z-[70] rounded border bg-amber-50 px-3 py-2 text-sm text-amber-900 shadow-md">
    Synced settings update from <span className="font-medium">{conflictBy}</span>.
  </div>
)}
```

- [ ] **Step 4: Add "last edited by" line under the shared sections**

Just below the Languages section header (and similarly under any other shared-section header):

```tsx
{updatedBy && updatedAt && (
  <p className="text-xs text-muted-foreground">
    Last edited by {updatedBy.username} ·{" "}
    {new Date(updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
  </p>
)}
```

- [ ] **Step 5: Commit**

```bash
git add src/components/ProjectSettings.tsx
git commit -m "feat(settings): conflict toast + last-edited line for shared fields"
```

---

### Task 11: ProjectCard — "Awaiting setup by &lt;maintainer&gt;" copy

**Files:**
- Modify: `src/components/ProjectCard.tsx`

- [ ] **Step 1: Determine when to show the new copy**

A project shows "Awaiting setup by <maintainer>" instead of "Languages not set" when:
- It has server-side existence (`hasServerSideExistence(project)`)
- Both languages are blank
- We have a maintainer username to name (use the project owner's username; for git-imported projects, fall back to creator)

For now, source the username from `project.syncRole?.source === "creator"` ? session.username : (a maintainer's username via `useProjectMembers`'s top-role member if available).

Simplest and good-enough heuristic: use the first member with role 600+ (MAINTAINER+) from the existing `useProjectMembers` result. If none, fall back to "the project lead".

- [ ] **Step 2: Patch the empty-state branch**

Replace the existing:

```tsx
{project.sourceLanguage || project.targetLanguage ? (
  <p className="text-sm text-muted-foreground">
    {project.sourceLanguage || "?"} → {project.targetLanguage || "?"}
  </p>
) : (
  <p className="text-sm text-muted-foreground italic">
    Languages not set
  </p>
)}
```

with:

```tsx
{project.sourceLanguage || project.targetLanguage ? (
  <p className="text-sm text-muted-foreground">
    {project.sourceLanguage || "?"} → {project.targetLanguage || "?"}
  </p>
) : hasServerSideExistence(project) ? (
  <p className="text-sm text-muted-foreground italic">
    Awaiting setup{maintainerLabel ? ` by ${maintainerLabel}` : ""}
  </p>
) : (
  <p className="text-sm text-muted-foreground italic">
    Languages not set
  </p>
)}
```

- [ ] **Step 3: Compute `maintainerLabel`**

Above the `return`:

```ts
const maintainerLabel = members.find((m) => m.role.level >= 600)?.username ?? null
```

(`members` is already in scope from the existing `useProjectMembers(fetchKey)` call.)

- [ ] **Step 4: Smoke-test**

Find a server-side project that has no languages set, confirm the card reads "Awaiting setup by <username>" using the maintainer's username. Local-only project with no languages: still reads "Languages not set". Project with languages: shows them.

- [ ] **Step 5: Commit**

```bash
git add src/components/ProjectCard.tsx
git commit -m "feat(dashboard): name the maintainer in awaiting-setup empty state"
```

---

### Task 12: One-shot migration on first PROJECT_LEAD+ open

**Files:**
- Modify: `src/hooks/useProjectSettings.ts`
- Modify: `src/hooks/useProjectSettings.test.ts`

The migration runs exactly when:
- We've fetched and the server returned `version: 0` and `settings: {}`.
- The local IDB `ProjectRecord` has at least one synced field set.
- The current user has role >= 500 (`canEdit` is true).

It fires a single PATCH with all locally-known synced fields. On 409 (someone else just migrated), the hook's existing conflict-snap logic runs.

- [ ] **Step 1: Write the failing test**

Add to `src/hooks/useProjectSettings.test.ts`:

```ts
describe("useProjectSettings — migration", () => {
  it("PATCHes local IDB values when server returns version 0 + canEdit=true", async () => {
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue({
      version: 0, updatedAt: "x", updatedBy: null, settings: {},
    })
    const patchSpy = vi.spyOn(restClient, "patchProjectSettings").mockResolvedValue({
      kind: "ok",
      value: {
        version: 1, updatedAt: "y", updatedBy: { id: 1, username: "ryder" },
        settings: { sourceLanguage: "en", targetLanguage: "swh" },
      },
    })
    renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith(
        "test-jwt", "p1",
        expect.objectContaining({ sourceLanguage: "en", targetLanguage: "swh" }),
        0
      )
    })
  })

  it("does NOT migrate when sub-PROJECT_LEAD", async () => {
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue({
      version: 0, updatedAt: "x", updatedBy: null, settings: {},
    })
    const patchSpy = vi.spyOn(restClient, "patchProjectSettings")
    renderHook(() => useProjectSettings("p1", 400))
    // Wait long enough that an erroneous migration would have fired.
    await new Promise((r) => setTimeout(r, 50))
    expect(patchSpy).not.toHaveBeenCalled()
  })

  it("does NOT migrate when local IDB is empty", async () => {
    const idbMod = await import("@/lib/store/project-index")
    vi.mocked(idbMod.getProject).mockResolvedValueOnce({
      id: "p1", name: "P", sourceLanguage: "", targetLanguage: "",
      files: [], members: [], createdAt: "",
      syncRole: { level: 700, name: "owner", source: "creator", fetchedAt: "" },
    } as any)
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue({
      version: 0, updatedAt: "x", updatedBy: null, settings: {},
    })
    const patchSpy = vi.spyOn(restClient, "patchProjectSettings")
    renderHook(() => useProjectSettings("p1", 700))
    await new Promise((r) => setTimeout(r, 50))
    expect(patchSpy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run src/hooks/useProjectSettings.test.ts
```

Expected: 3 new tests fail (no migration logic).

- [ ] **Step 3: Add the migration effect to the hook**

Inside `useProjectSettings`, after the `useEffect(() => { void refresh() }, [refresh])` line, add:

```ts
const migrationFiredRef = useRef(false)
useEffect(() => {
  if (migrationFiredRef.current) return
  if (!hasFetched) return
  if (!server || server.version !== 0) return
  if (!canEdit) return
  if (Object.keys(local).length === 0) return
  migrationFiredRef.current = true
  void (async () => {
    const out = await patchProjectSettings(jwt!, projectId!, local, 0)
    if (!aliveRef.current) return
    if (out.kind === "ok") setServer(out.value)
    else if (out.kind === "conflict") setServer(out.latest)
    // forbidden / error: silently leave server at version 0; user retains
    // local-cached display. Migration will be reattempted next mount.
  })()
}, [hasFetched, server, canEdit, local, jwt, projectId])
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npx vitest run src/hooks/useProjectSettings.test.ts
```

Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useProjectSettings.ts src/hooks/useProjectSettings.test.ts
git commit -m "feat(hooks): one-shot settings migration from local IDB on first PL+ open"
```

---

### Task 13: PostHog instrumentation for the success metric

**Files:**
- Modify: `src/hooks/useProjectSettings.ts`

We need three events: `project settings hydrated` (with `withinMs`), `project settings migrated` (with `fieldsCount`, `conflictsCount`), and `project settings sync conflict` (on 409).

- [ ] **Step 1: Add hydration timing**

Near the top of the hook:

```ts
import posthog from "@/lib/posthog"
```

Inside the hook body, capture mount time:

```ts
const mountAtRef = useRef(performance.now())
```

In the `refresh` callback, after `setHasFetched(true)`, capture:

```ts
if (got && got.version > 0) {
  posthog.capture("project settings hydrated", {
    project_id: projectId,
    within_ms: Math.round(performance.now() - mountAtRef.current),
    has_server_row: true,
  })
} else if (got) {
  posthog.capture("project settings hydrated", {
    project_id: projectId,
    within_ms: Math.round(performance.now() - mountAtRef.current),
    has_server_row: false,
  })
}
```

- [ ] **Step 2: Add migration event**

In the migration effect (Task 12), inside the `out.kind === "ok"` branch:

```ts
posthog.capture("project settings migrated", {
  project_id: projectId,
  fields_count: Object.keys(local).length,
})
```

In the `out.kind === "conflict"` branch:

```ts
posthog.capture("project settings migration conflict", {
  project_id: projectId,
  fields_count: Object.keys(local).length,
})
```

- [ ] **Step 3: Add conflict event in the patch path**

In the `patch` callback, the `result.kind === "conflict"` branch:

```ts
posthog.capture("project settings sync conflict", {
  project_id: projectId,
  conflicting_user: result.latest.updatedBy?.username ?? null,
})
```

- [ ] **Step 4: Smoke-test**

In the dev console with PostHog enabled, open a project, confirm a `project settings hydrated` event fires within ~2s. Edit and save a shared field, confirm no event other than the natural one. Trigger a conflict (manually via two devices) and confirm `project settings sync conflict` fires.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useProjectSettings.ts
git commit -m "feat(analytics): track settings hydration, migration, and conflicts"
```

---

## Self-Review Checklist (run after implementation, before opening PR)

- [ ] All 13 tasks committed in order, no reordered or missing tasks
- [ ] Server tests pass: `cd ~/frontierrnd/frontier-server/cloudflare && npm test -- project-settings`
- [ ] Client tests pass: `npx vitest run src/lib/sync/project-settings src/hooks/useProjectSettings`
- [ ] `npx tsc --noEmit` passes
- [ ] Manual: open a project on Device A as OWNER, set source language, refresh on Device B (different browser profile), confirm language appears
- [ ] Manual: as CONTRIBUTOR (400) on Device B, confirm fields are disabled with "Project Lead or higher can edit" tooltip
- [ ] Manual: go offline mid-session, confirm shared fields disable with "Reconnect to edit"; reconnect, confirm they re-enable
- [ ] Manual: trigger a conflict by editing the same field on two devices within seconds; confirm "Synced settings update from <user>" toast appears
- [ ] Manual: a project with no server settings row but populated local IDB, opened by a PROJECT_LEAD+, migrates within ~1s of mount

---

## Notes

- **No service-worker / cross-tab sync of settings.** A second tab on the same browser sees stale data until it refreshes; same as today for IDB. Acceptable.
- **`completionSettings.endpoint`, `completionSettings.apiKey`, `completionSettings.model`, `completionSettings.maxTokens`, `completionSettings.temperature`, `completionSettings.llmHealthPenalty` all stay device-local.** Only `systemPrompt` syncs. The split is enforced in `localSettingsFrom` (Task 6) and `overlaySettings` (Task 8).
- **Org-level settings inheritance** is out of scope. If org-default system prompts are needed later, server-side merge order (org default → project override → empty) lands without client changes — the GET response shape already covers it.
- **Server-managed apiKey + LLM proxy** is a separate spec. The frontier-server already proxies LLM requests; org-level centralization can route through that proxy without involving this `project_settings` table.
