import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { events, schema } from "@/lib/offline/schema"
import { readProjectSnapshot } from "@/lib/offline/project-snapshot"
import type { CloudProjectSummary, ResolveProjectResult } from "./cloud-projects"
import type { ProjectSettingsResponse } from "./project-settings"

const h = vi.hoisted(() => ({
  tauri: true,
  result: null as ResolveProjectResult | null,
  store: null as Store<typeof import("@/lib/offline/schema").schema> | null,
  storeError: null as Error | null,
}))

vi.mock("@/lib/offline/is-tauri", () => ({ isTauriRuntime: () => h.tauri }))
vi.mock("./cloud-projects", () => ({ resolveCloudProjectResult: vi.fn(async () => h.result) }))
vi.mock("@/lib/offline/store", () => ({
  getOfflineStore: vi.fn(async () => {
    if (h.storeError) throw h.storeError
    return h.store
  }),
}))

const { readOfflineProjectSettings, rememberProjectSettingsOffline, resolveProjectForRead } = await import("./project-resolve")

const project = (name = "Genesis") =>
  ({ id: "proj1", name, gitlabProjectId: null, orgId: 1, role: { level: 300, name: "translator", source: "org" } }) as CloudProjectSummary

let seq = 0

beforeEach(async () => {
  h.tauri = true
  h.storeError = null
  h.store = await createStorePromise({ schema, storeId: `resolve-${++seq}`, adapter: makeInMemoryAdapter() })
  h.store.commit(events.projectSynced({ id: "proj1", name: "Genesis", orgId: "1", settings: null, syncedAt: new Date() }))
  h.store.commit(events.offlineProjectStatusSet({ projectId: "proj1", status: "ready", syncedAt: null, queueDepth: 0 }))
})

describe("resolveProjectForRead", () => {
  it("records the server's answer, then serves it when the server is unreachable", async () => {
    h.result = { ok: true, project: project() }
    expect(await resolveProjectForRead("proj1", "jwt")).toEqual(h.result)
    await vi.waitFor(() => expect(readProjectSnapshot(h.store!, "proj1")).not.toBeNull())

    h.result = { ok: false, reason: "unreachable" }
    expect(await resolveProjectForRead("proj1", "jwt")).toEqual({ ok: true, project: project(), fromOfflineCopy: true })
  })

  it("passes through an unreachable server when nothing is stored", async () => {
    h.result = { ok: false, reason: "unreachable" }
    expect(await resolveProjectForRead("proj1", "jwt")).toEqual(h.result)
  })

  it.each(["forbidden", "unauthenticated", "not-found"] as const)(
    "never hides a %s answer behind the offline copy",
    async (reason) => {
      h.result = { ok: true, project: project() }
      await resolveProjectForRead("proj1", "jwt")
      await vi.waitFor(() => expect(readProjectSnapshot(h.store!, "proj1")).not.toBeNull())

      h.result = { ok: false, reason }
      expect(await resolveProjectForRead("proj1", "jwt")).toEqual(h.result)
    },
  )

  it("behaves as before when the offline store can't be opened", async () => {
    h.storeError = new Error("newer generation")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    h.result = { ok: false, reason: "unreachable" }
    expect(await resolveProjectForRead("proj1", "jwt")).toEqual(h.result)
  })

  it("never touches the offline store in the browser", async () => {
    h.tauri = false
    h.result = { ok: false, reason: "unreachable" }
    expect(await resolveProjectForRead("proj1", "jwt")).toEqual(h.result)
    const { getOfflineStore } = await import("@/lib/offline/store")
    expect(getOfflineStore).not.toHaveBeenCalled()
  })
})

describe("offline project settings", () => {
  const settings = { version: 3, updatedAt: "", updatedBy: null, settings: {}, lanes: [] } as unknown as ProjectSettingsResponse

  it("hands back what was remembered", async () => {
    rememberProjectSettingsOffline("proj1", settings)
    await vi.waitFor(async () => expect(await readOfflineProjectSettings("proj1")).toEqual(settings))
  })

  it("is a no-op in the browser", async () => {
    h.tauri = false
    rememberProjectSettingsOffline("proj1", settings)
    expect(await readOfflineProjectSettings("proj1")).toBeNull()
  })
})
