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
  storeHangs: false,
  storeGate: null as Promise<void> | null,
}))

vi.mock("@/lib/offline/is-tauri", () => ({ isTauriRuntime: () => h.tauri }))
vi.mock("./cloud-projects", () => ({ resolveCloudProjectResult: vi.fn(async () => h.result) }))
vi.mock("@/lib/offline/store", () => ({
  getOfflineStore: vi.fn(async () => {
    if (h.storeError) throw h.storeError
    if (h.storeHangs) return new Promise(() => {})
    if (h.storeGate) await h.storeGate
    return h.store
  }),
}))

const { OFFLINE_STORE_WAIT_MS, readOfflineProjectSettings, rememberProjectSettingsOffline, resolveProjectForRead, whenOfflineStoreOpen } =
  await import("./project-resolve")

/** Unsigned JWT-shaped token for `sub` — only its subject is ever read. */
function tokenFor(sub: string): string {
  const encode = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "")
  return `${encode({ alg: "HS256" })}.${encode({ sub })}.sig`
}

const jwt = tokenFor("anna")

const project = (name = "Genesis") =>
  ({ id: "proj1", name, gitlabProjectId: null, orgId: 1, role: { level: 300, name: "translator", source: "org" } }) as CloudProjectSummary

let seq = 0

beforeEach(async () => {
  h.tauri = true
  h.storeError = null
  h.storeHangs = false
  h.storeGate = null
  h.store = await createStorePromise({ schema, storeId: `resolve-${++seq}`, adapter: makeInMemoryAdapter() })
  h.store.commit(events.projectSynced({ id: "proj1", name: "Genesis", orgId: "1", settings: null, syncedAt: new Date() }))
  h.store.commit(events.offlineProjectStatusSet({ projectId: "proj1", status: "ready", syncedAt: null, queueDepth: 0 }))
})

describe("resolveProjectForRead", () => {
  it("records the server's answer, then serves it when the server is unreachable", async () => {
    h.result = { ok: true, project: project() }
    expect(await resolveProjectForRead("proj1", jwt)).toEqual(h.result)
    await vi.waitFor(() => expect(readProjectSnapshot(h.store!, "proj1", "anna")).not.toBeNull())

    h.result = { ok: false, reason: "unreachable" }
    expect(await resolveProjectForRead("proj1", jwt)).toEqual({ ok: true, project: project(), fromOfflineCopy: true })
  })

  it("never serves one account's copy to another account on the device", async () => {
    h.result = { ok: true, project: project() }
    await resolveProjectForRead("proj1", tokenFor("owner"))
    await vi.waitFor(() => expect(readProjectSnapshot(h.store!, "proj1", "owner")).not.toBeNull())

    h.result = { ok: false, reason: "unreachable" }
    expect(await resolveProjectForRead("proj1", tokenFor("translator"))).toEqual(h.result)
  })

  it("stops waiting for an offline store that never opens", async () => {
    vi.useFakeTimers()
    try {
      h.storeHangs = true
      vi.spyOn(console, "warn").mockImplementation(() => {})
      h.result = { ok: false, reason: "unreachable" }
      const pending = resolveProjectForRead("proj1", jwt)
      await vi.advanceTimersByTimeAsync(OFFLINE_STORE_WAIT_MS)
      expect(await pending).toEqual({ ...h.result, offlineCopyPending: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it("finds the offline copy on a retry once a slow store has opened", async () => {
    h.result = { ok: true, project: project() }
    await resolveProjectForRead("proj1", jwt)
    await vi.waitFor(() => expect(readProjectSnapshot(h.store!, "proj1", "anna")).not.toBeNull())

    let open!: () => void
    h.storeGate = new Promise((resolve) => { open = resolve })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    h.result = { ok: false, reason: "unreachable" }
    vi.useFakeTimers()
    try {
      const pending = resolveProjectForRead("proj1", jwt)
      await vi.advanceTimersByTimeAsync(OFFLINE_STORE_WAIT_MS)
      expect(await pending).toEqual({ ...h.result, offlineCopyPending: true })
    } finally {
      vi.useRealTimers()
    }

    open()
    expect(await whenOfflineStoreOpen()).toBe(true)
    h.storeGate = null
    expect(await resolveProjectForRead("proj1", jwt)).toEqual({ ok: true, project: project(), fromOfflineCopy: true })
  })

  it("reports no offline store to wait for in the browser", async () => {
    h.tauri = false
    expect(await whenOfflineStoreOpen()).toBe(false)
  })

  it("passes through an unreachable server when nothing is stored", async () => {
    h.result = { ok: false, reason: "unreachable" }
    expect(await resolveProjectForRead("proj1", jwt)).toEqual(h.result)
  })

  it.each(["forbidden", "unauthenticated", "not-found"] as const)(
    "never hides a %s answer behind the offline copy",
    async (reason) => {
      h.result = { ok: true, project: project() }
      await resolveProjectForRead("proj1", jwt)
      await vi.waitFor(() => expect(readProjectSnapshot(h.store!, "proj1", "anna")).not.toBeNull())

      h.result = { ok: false, reason }
      expect(await resolveProjectForRead("proj1", jwt)).toEqual(h.result)
    },
  )

  it("behaves as before when the offline store can't be opened", async () => {
    h.storeError = new Error("newer generation")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    h.result = { ok: false, reason: "unreachable" }
    expect(await resolveProjectForRead("proj1", jwt)).toEqual(h.result)
  })

  it("never touches the offline store in the browser", async () => {
    h.tauri = false
    h.result = { ok: false, reason: "unreachable" }
    expect(await resolveProjectForRead("proj1", jwt)).toEqual(h.result)
    const { getOfflineStore } = await import("@/lib/offline/store")
    expect(getOfflineStore).not.toHaveBeenCalled()
  })
})

describe("offline project settings", () => {
  const settings = { version: 3, updatedAt: "", updatedBy: null, settings: {}, lanes: [] } as unknown as ProjectSettingsResponse

  it("hands back what was remembered", async () => {
    rememberProjectSettingsOffline("proj1", jwt, settings)
    await vi.waitFor(async () => expect(await readOfflineProjectSettings("proj1", jwt)).toEqual(settings))
  })

  it("is not handed to another account on the device", async () => {
    rememberProjectSettingsOffline("proj1", jwt, settings)
    await vi.waitFor(async () => expect(await readOfflineProjectSettings("proj1", jwt)).toEqual(settings))
    expect(await readOfflineProjectSettings("proj1", tokenFor("ben"))).toBeNull()
  })

  it("is a no-op in the browser", async () => {
    h.tauri = false
    rememberProjectSettingsOffline("proj1", jwt, settings)
    expect(await readOfflineProjectSettings("proj1", jwt)).toBeNull()
  })
})
