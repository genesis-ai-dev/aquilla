// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest"
import { DaemonDb } from "../db"
import { CONTENT_LOGIC_VERSION } from "../stages/materialize"
import { pollInbox, reconcile, registerProject, type DetectDeps, type PlacementIndex } from "../stages/detect"
import { INBOX_PAGE, type GitLabClient, type GitLabProjectLite, type SyncClient } from "../http"

const proj = (over: Partial<GitLabProjectLite> = {}): GitLabProjectLite => ({
  id: 7, name: "demo", namespace: "org/team", path_with_namespace: "org/team/demo",
  last_activity_at: "2026-01-01T00:00:00Z", http_url_to_repo: "https://gitlab.example/org/team/demo.git",
  default_branch: "main", ...over,
})

const mappedPlacement: PlacementIndex = { resolve: () => ({ orgId: 1, ownerUserId: 9, teamId: 2 }) }
const unmappedPlacement: PlacementIndex = { resolve: () => undefined }

function makeDeps(over: Partial<DetectDeps> = {}): DetectDeps {
  return {
    db: new DaemonDb(":memory:"),
    sync: { inbox: async () => ({ items: [], last: undefined }), orgTeamMaps: async () => ({ orgMap: new Map(), teamMap: new Map() }) },
    gitlab: {} as GitLabClient,
    creds: { gitlabToken: "t", gitlabUrl: "https://gitlab.example", accessToken: "t" },
    placement: mappedPlacement,
    log: () => {},
    probe: async () => true,
    ...over,
  }
}

describe("registerProject", () => {
  let db: DaemonDb
  beforeEach(() => { db = new DaemonDb(":memory:") })

  it("not-codex: probe fails, no upsert", async () => {
    const deps = makeDeps({ db, probe: async () => false })
    const r = await registerProject(deps, proj(), "sha1")
    expect(r).toBe("not-codex")
    expect(db.getProject(7)).toBeUndefined()
  })

  it("unmapped namespace records status unmapped and enqueues nothing", async () => {
    const deps = makeDeps({ db, placement: unmappedPlacement })
    const r = await registerProject(deps, proj(), "sha1")
    expect(r).toBe("unmapped")
    expect(db.getProject(7)?.status).toBe("unmapped")
    expect(db.listJobs().length).toBe(0)
  })

  it("mapped + new sha enqueues a content job", async () => {
    const deps = makeDeps({ db })
    const r = await registerProject(deps, proj(), "sha1")
    expect(r).toBe("enqueued")
    const p = db.getProject(7)
    expect(p?.status).toBe("ok")
    expect(p?.org_id).toBe(1)
    expect(p?.team_id).toBe(2)
    expect(p?.owner_user_id).toBe(9)
    const jobs = db.listJobs()
    expect(jobs).toHaveLength(2)
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ project_id: 7, kind: "content", sha: "sha1" }),
      expect.objectContaining({ project_id: 7, kind: "audio", sha: "sha1" }),
    ]))
  })

  it("unchanged sha (matches applied_sha + current content logic) enqueues nothing", async () => {
    const deps = makeDeps({ db })
    await registerProject(deps, proj(), "sha1")
    db.setProjectFields(7, { applied_sha: "sha1", audio_applied_sha: "sha1", content_logic: CONTENT_LOGIC_VERSION })
    const r = await registerProject(deps, proj(), "sha1")
    expect(r).toBe("unchanged")
    expect(db.listJobs()).toHaveLength(2) // the original content + audio jobs only
  })

  it("null sha fetches the head via gitlab.headSha", async () => {
    const gitlab = { headSha: async () => "resolved-sha" } as unknown as GitLabClient
    const deps = makeDeps({ db, gitlab })
    const r = await registerProject(deps, proj(), null)
    expect(r).toBe("enqueued")
    expect(db.listJobs().map((job) => job.sha)).toEqual(["resolved-sha", "resolved-sha"])
  })

  it("throws when headSha resolves to null (fail loud, never treat as unchanged)", async () => {
    const gitlab = { headSha: async () => null } as unknown as GitLabClient
    const deps = makeDeps({ db, gitlab })
    await expect(registerProject(deps, proj(), null)).rejects.toThrow(/no head sha/)
  })
})

describe("pollInbox", () => {
  it("enqueues jobs from inbox items and advances the cursor", async () => {
    const db = new DaemonDb(":memory:")
    const gitlab = { project: async (id: number) => proj({ id }) } as unknown as GitLabClient
    const sync: Pick<SyncClient, "inbox" | "orgTeamMaps"> = {
      inbox: async (after) => {
        expect(after).toBeUndefined()
        return { items: [{ key: "k1", gitlabId: 7, sha: "sha1", ts: 1 }], last: "cursor-1" }
      },
      orgTeamMaps: async () => ({ orgMap: new Map(), teamMap: new Map() }),
    }
    const deps = makeDeps({ db, gitlab, sync })
    const n = await pollInbox(deps)
    expect(n).toBe(1)
    expect(db.kvGet("inbox_cursor")).toBe("cursor-1")
    expect(db.listJobs()).toHaveLength(2)
  })

  it("follows pages until one comes back short", async () => {
    const db = new DaemonDb(":memory:")
    const gitlab = { project: async (id: number) => proj({ id }) } as unknown as GitLabClient
    const cursors: Array<string | undefined> = []
    const sync: Pick<SyncClient, "inbox" | "orgTeamMaps"> = {
      inbox: async (after) => {
        cursors.push(after)
        if (after === undefined) {
          // A full page means "there may be more" — the poll must ask again.
          const items = Array.from({ length: INBOX_PAGE }, (_, i) => ({ key: `k${i}`, gitlabId: 100 + i, sha: "s", ts: i }))
          return { items, last: "cursor-1" }
        }
        return { items: [{ key: "z", gitlabId: 9, sha: "s2", ts: 999 }], last: "cursor-2" }
      },
      orgTeamMaps: async () => ({ orgMap: new Map(), teamMap: new Map() }),
    }
    const n = await pollInbox(makeDeps({ db, gitlab, sync }))
    expect(cursors).toEqual([undefined, "cursor-1"])
    expect(n).toBe(INBOX_PAGE + 1)
    expect(db.kvGet("inbox_cursor")).toBe("cursor-2")
  })

  it("collapses duplicate gitlabIds in one batch to the last (latest-sha) item", async () => {
    const db = new DaemonDb(":memory:")
    const gitlab = { project: async (id: number) => proj({ id }) } as unknown as GitLabClient
    const sync: Pick<SyncClient, "inbox" | "orgTeamMaps"> = {
      inbox: async () => ({
        items: [
          { key: "k1", gitlabId: 7, sha: "sha-old", ts: 1 },
          { key: "k2", gitlabId: 7, sha: "sha-new", ts: 2 },
        ],
        last: "cursor-2",
      }),
      orgTeamMaps: async () => ({ orgMap: new Map(), teamMap: new Map() }),
    }
    const deps = makeDeps({ db, gitlab, sync })
    const n = await pollInbox(deps)
    expect(n).toBe(1)
    const jobs = db.listJobs()
    expect(jobs).toHaveLength(2)
    expect(jobs.every((job) => job.sha === "sha-new")).toBe(true)
    expect(jobs.map((job) => job.kind).sort()).toEqual(["audio", "content"])
  })

  it("skips inbox items whose project is gone from GitLab", async () => {
    const db = new DaemonDb(":memory:")
    const gitlab = { project: async () => null } as unknown as GitLabClient
    const sync: Pick<SyncClient, "inbox" | "orgTeamMaps"> = {
      inbox: async () => ({ items: [{ key: "k1", gitlabId: 7, sha: "sha1", ts: 1 }], last: "cursor-1" }),
      orgTeamMaps: async () => ({ orgMap: new Map(), teamMap: new Map() }),
    }
    const deps = makeDeps({ db, gitlab, sync })
    const n = await pollInbox(deps)
    expect(n).toBe(0)
    expect(db.listJobs().length).toBe(0)
  })
})

describe("reconcile", () => {
  it("iterates until the hwm and updates it to the newest last_activity_at", async () => {
    const db = new DaemonDb(":memory:")
    const seen: Array<string | undefined> = []
    const gitlab = {
      async *listProjectsByActivity(sinceIso: string | undefined) {
        seen.push(sinceIso)
        yield proj({ id: 7, last_activity_at: "2026-02-01T00:00:00Z" })
        yield proj({ id: 8, last_activity_at: "2026-01-15T00:00:00Z" })
      },
      headSha: async (id: number) => `sha-${id}`,
    } as unknown as GitLabClient
    const deps = makeDeps({ db, gitlab })
    const n = await reconcile(deps)
    expect(n).toBe(2)
    expect(seen).toEqual([undefined])
    expect(db.kvGet("reconcile_hwm")).toBe("2026-02-01T00:00:00Z")
  })

  it("passes the stored hwm into listProjectsByActivity on the next run", async () => {
    const db = new DaemonDb(":memory:")
    db.kvSet("reconcile_hwm", "2026-01-01T00:00:00Z")
    let receivedSince: string | undefined
    const gitlab = {
      async *listProjectsByActivity(sinceIso: string | undefined) {
        receivedSince = sinceIso
        yield proj({ id: 7, last_activity_at: "2026-03-01T00:00:00Z" })
      },
      headSha: async () => "sha-7",
    } as unknown as GitLabClient
    const deps = makeDeps({ db, gitlab })
    await reconcile(deps)
    expect(receivedSince).toBe("2026-01-01T00:00:00Z")
    expect(db.kvGet("reconcile_hwm")).toBe("2026-03-01T00:00:00Z")
  })

  it("does not abort the sweep on a single project's registerProject failure, but does not enqueue it", async () => {
    const db = new DaemonDb(":memory:")
    const gitlab = {
      async *listProjectsByActivity() {
        yield proj({ id: 7, last_activity_at: "2026-02-01T00:00:00Z" })
        yield proj({ id: 8, last_activity_at: "2026-02-02T00:00:00Z" })
      },
      headSha: async (id: number) => (id === 7 ? null : "sha-8"),
    } as unknown as GitLabClient
    const messages: string[] = []
    const deps = makeDeps({ db, gitlab, log: (m) => messages.push(m) })
    const n = await reconcile(deps)
    expect(n).toBe(1)
    expect(db.getProject(8)).toBeDefined()
    expect(db.kvGet("reconcile_hwm")).toBe("2026-02-02T00:00:00Z")
    expect(messages.some((m) => m.includes("7"))).toBe(true)
  })

  it("aborts and does not move the hwm when listing itself throws", async () => {
    const db = new DaemonDb(":memory:")
    const gitlab = {
      // eslint-disable-next-line require-yield
      async *listProjectsByActivity() {
        throw new Error("gitlab down")
      },
    } as unknown as GitLabClient
    const deps = makeDeps({ db, gitlab })
    await expect(reconcile(deps)).rejects.toThrow("gitlab down")
    expect(db.kvGet("reconcile_hwm")).toBeUndefined()
  })
})
