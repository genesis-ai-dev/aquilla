import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { useProjectSettings, type PatchOutcome } from "./useProjectSettings"
import * as restClient from "@/lib/sync/project-settings"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "ryder" } }),
}))

vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(async () => ({
    id: "p1", name: "P", sourceLanguage: "en", targetLanguage: "swh",
    files: [], members: [], createdAt: "",
    syncRole: { level: 700, name: "owner", source: "creator", fetchedAt: "" },
  })),
  patchProject: vi.fn(async (id: string, fn: (p: any) => any) => fn({ id })),
}))

beforeEach(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
})

afterEach(() => vi.restoreAllMocks())

describe("useProjectSettings — StrictMode race (BUG-TERM-1)", () => {
  it("applies server settings (incl. rules/sourceLanguage) after StrictMode mount→cleanup→remount", async () => {
    // Simulate React StrictMode's double-invoke: effect runs, cleanup fires
    // (which previously set aliveRef.current=false), then effect runs again.
    // On the OLD code the second mount's fetch resolved AFTER the cleanup had
    // set aliveRef.current=false, so refresh() hit `if (!aliveRef.current) return null`
    // and silently dropped the data — server stayed null, hasFetched stayed false
    // forever — causing ALL synced settings (rules, sourceLanguage, terminology
    // concepts, etc.) to never appear in the UI.

    // Use a deferred fetch so we control exactly when resolution happens
    // relative to simulated cleanup.
    let resolveServerFetch!: (v: any) => void
    vi.spyOn(restClient, "fetchProjectSettings").mockImplementation(
      () => new Promise((res) => { resolveServerFetch = res }),
    )

    const { unmount } = renderHook(() => useProjectSettings("p1", 700))

    // Simulate StrictMode: unmount immediately (cleanup fires, setting
    // aliveRef.current=false on the old code) then remount in a new renderHook.
    unmount()
    const { result: result2 } = renderHook(() => useProjectSettings("p1", 700))

    // Now resolve the fetch on the NEW (surviving) mount — on the old code this
    // would be swallowed because aliveRef.current===false from the first cleanup;
    // on the fixed code the surviving mount resets aliveRef.current=true at the
    // start of its effect, so the fetch lands correctly.
    act(() => {
      resolveServerFetch({
        version: 17,
        updatedAt: "2026-05-01T00:00:00Z",
        updatedBy: { id: 1, username: "alex" },
        settings: {
          sourceLanguage: "fr",
          rules: [
            {
              id: "r1",
              name: "Terminology: God→Dieu",
              description: "Ensure 'God' is translated as 'Dieu'",
              severity: "major",
              source: "user",
              scope: "project",
              check: { type: "source-requires-target", sourcePattern: "God", targetPattern: "Dieu" },
              enabled: true,
              createdAt: "2026-05-01T00:00:00Z",
            },
          ],
        },
      })
    })

    // The surviving mount MUST apply the server data.
    // On the old code: hasFetched===false, server===null — this assertion fails.
    await waitFor(() => expect(result2.current.hasFetched).toBe(true))
    expect(result2.current.version).toBe(17)
    // sourceLanguage from server must override the IDB "en" value
    expect(result2.current.settings.sourceLanguage).toBe("fr")
    // rules (terminology concepts) must be present — this would be [] / undefined on old code
    expect(result2.current.settings.rules).toHaveLength(1)
    expect(result2.current.settings.rules![0].name).toBe("Terminology: God→Dieu")
  })
})

describe("useProjectSettings — read path", () => {
  it("surfaces local IDB values immediately, then merges server values", async () => {
    // Use a deferred fetch so we can observe the local "en" state before the
    // server "fr" overwrites it. The hook sequences: IDB read → React render
    // → server fetch, so this deferred promise gives waitFor a polling window.
    let resolveServerFetch!: (v: any) => void
    vi.spyOn(restClient, "fetchProjectSettings").mockImplementation(
      () =>
        new Promise((res) => {
          resolveServerFetch = res
        }),
    )
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(result.current.settings.sourceLanguage).toBe("en"))
    act(() => {
      resolveServerFetch({
        version: 3,
        updatedAt: "2026-04-29T10:00:00Z",
        updatedBy: { id: 1, username: "alex" },
        settings: { sourceLanguage: "fr", systemPrompt: "Be concise." },
      })
    })
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

  it("does not crash when local IDB read fails", async () => {
    const idbMod = await import("@/lib/store/project-index")
    vi.mocked(idbMod.getProject).mockRejectedValueOnce(new Error("idb unavailable"))
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue({
      version: 1, updatedAt: "x", updatedBy: { id: 1, username: "ryder" },
      settings: { sourceLanguage: "en" },
    })
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    // Should still surface server values even without local cache.
    await waitFor(() => expect(result.current.settings.sourceLanguage).toBe("en"))
  })
})

describe("useProjectSettings — write path", () => {
  it("returns blocked-offline when offline, but still applies the edit locally", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
    const idbMod = await import("@/lib/store/project-index")
    vi.mocked(idbMod.patchProject).mockClear()
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue(null)
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    // Wait for mount-time local-IDB read to settle before patching, otherwise
    // the mount setLocal races our optimistic setLocal inside patch.
    await waitFor(() => expect(result.current.settings.sourceLanguage).toBe("en"))
    let got!: PatchOutcome
    await act(async () => {
      got = await result.current.patch({ sourceLanguage: "fr" })
    })
    expect(got.kind).toBe("blocked")
    if (got.kind === "blocked") expect(got.reason).toBe("offline")
    // Local state + IDB still receive the edit — the server gate only blocks
    // the server roundtrip, not the local apply.
    expect(result.current.settings.sourceLanguage).toBe("fr")
    expect(idbMod.patchProject).toHaveBeenCalled()
  })

  it("returns blocked-role for sub-PROJECT_LEAD callers, but still applies the edit locally", async () => {
    const idbMod = await import("@/lib/store/project-index")
    vi.mocked(idbMod.patchProject).mockClear()
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue(null)
    const { result } = renderHook(() => useProjectSettings("p1", 400))
    await waitFor(() => expect(result.current.settings.sourceLanguage).toBe("en"))
    let got!: PatchOutcome
    await act(async () => {
      got = await result.current.patch({ sourceLanguage: "fr" })
    })
    expect(got.kind).toBe("blocked")
    if (got.kind === "blocked") expect(got.reason).toBe("role")
    expect(result.current.settings.sourceLanguage).toBe("fr")
    expect(idbMod.patchProject).toHaveBeenCalled()
  })

  it("unsynced project (roleLevel === null) writes locally with no server call", async () => {
    const idbMod = await import("@/lib/store/project-index")
    vi.mocked(idbMod.patchProject).mockClear()
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue(null)
    const patchSpy = vi.spyOn(restClient, "patchProjectSettings")
    const { result } = renderHook(() => useProjectSettings("p1", null))
    await waitFor(() => expect(result.current.settings.sourceLanguage).toBe("en"))
    let got!: PatchOutcome
    await act(async () => {
      got = await result.current.patch({ sourceLanguage: "fr" })
    })
    // Same return shape as "role-blocked" — caller can flash on local-only too.
    expect(got.kind).toBe("blocked")
    if (got.kind === "blocked") expect(got.reason).toBe("role")
    expect(result.current.settings.sourceLanguage).toBe("fr")
    expect(idbMod.patchProject).toHaveBeenCalled()
    expect(patchSpy).not.toHaveBeenCalled()
  })

  it("optimistic write + server confirm", async () => {
    vi.spyOn(restClient, "fetchProjectSettings").mockResolvedValue({
      version: 1, updatedAt: "x", updatedBy: { id: 1, username: "ryder" },
      settings: { sourceLanguage: "en", targetLanguage: "swh" },
    })
    const patchSpy = vi.spyOn(restClient, "patchProjectSettings").mockResolvedValue({
      kind: "ok",
      value: {
        version: 2, updatedAt: "y", updatedBy: { id: 1, username: "ryder" },
        settings: { sourceLanguage: "fr", targetLanguage: "swh" },
      },
    })
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(result.current.version).toBe(1))
    let res!: any
    await act(async () => {
      res = await result.current.patch({ sourceLanguage: "fr" })
    })
    expect(res.kind).toBe("ok")
    expect(patchSpy).toHaveBeenCalledWith(
      "test-jwt",
      "p1",
      { sourceLanguage: "fr", targetLanguage: "swh" },
      1,
    )
    expect(result.current.settings.sourceLanguage).toBe("fr")
    expect(result.current.version).toBe(2)
  })

  it("snaps to server on conflict (including local state + IDB)", async () => {
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
    const idbMod = await import("@/lib/store/project-index")
    vi.mocked(idbMod.patchProject).mockClear()
    const { result } = renderHook(() => useProjectSettings("p1", 700))
    await waitFor(() => expect(result.current.version).toBe(1))
    let res!: PatchOutcome
    await act(async () => {
      res = await result.current.patch({ sourceLanguage: "fr" })
    })
    expect(res.kind).toBe("conflict")
    if (res.kind === "conflict") expect(res.latest.updatedBy?.username).toBe("alex")
    expect(result.current.settings.sourceLanguage).toBe("de")
    expect(result.current.version).toBe(2)
    // Two IDB writes expected: the optimistic local apply with "fr", then the
    // conflict snap-back with "de" (whichever order; the final state is what
    // matters and is observable via the next render).
    expect(idbMod.patchProject).toHaveBeenCalled()
    const calls = vi.mocked(idbMod.patchProject).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })
})

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
