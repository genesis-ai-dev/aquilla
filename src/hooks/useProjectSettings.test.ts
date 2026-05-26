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
