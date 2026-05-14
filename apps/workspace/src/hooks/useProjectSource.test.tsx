import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"

const linkMock = vi.fn<
  (projectId: string, sourceProjectId: string, jwt: string) => Promise<{
    projectId: string
    sourceProjectId: string
    previousSourceProjectId: string | null
  }>
>()
const detachMock = vi.fn<
  (projectId: string, jwt: string) => Promise<{
    projectId: string
    previousSourceProjectId: string
    snapshottedCellCount: number
  }>
>()

vi.mock("@/lib/sync/source-linking-read", () => {
  // Defined inside the factory because vi.mock is hoisted to the top of
  // the file — referencing a module-level binding here throws TDZ.
  class FakeSourceLinkingError extends Error {
    status: number
    body: string
    constructor(status: number, body: string) {
      super(body)
      this.status = status
      this.body = body
      this.name = "SourceLinkingError"
    }
  }
  return {
    linkProjectToSource: (...args: unknown[]) =>
      linkMock(...(args as Parameters<typeof linkMock>)),
    detachProjectFromSource: (...args: unknown[]) =>
      detachMock(...(args as Parameters<typeof detachMock>)),
    SourceLinkingError: FakeSourceLinkingError,
  }
})

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "jwt", username: "alice" },
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}))

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: (projectId: string | null) => ({
    settings: projectId === "source-only" ? {} : { targetLanguage: "fr" },
    version: null,
    updatedBy: null,
    updatedAt: null,
    hasFetched: true,
    isOnline: true,
    canEdit: true,
    reasonCannotEdit: null,
    refresh: vi.fn(),
    patch: vi.fn(),
  }),
}))

import { useProjectSource } from "./useProjectSource"
import { SourceLinkingError as FakeSourceLinkingError } from "@/lib/sync/source-linking-read"

beforeEach(() => {
  linkMock.mockReset()
  detachMock.mockReset()
})

describe("useProjectSource", () => {
  it("exposes initial link state from props", () => {
    const { result } = renderHook(() =>
      useProjectSource({
        projectId: "p1",
        initialSourceProjectId: "src-1",
        initialSourceProjectName: "Hebrew OT",
        roleLevel: 700,
      }),
    )
    expect(result.current.sourceProjectId).toBe("src-1")
    expect(result.current.isLinked).toBe(true)
    expect(result.current.sourceProjectName).toBe("Hebrew OT")
    expect(result.current.canEditLink).toBe(true)
  })

  it("flags isSourceOnly=true when targetLanguage is unset in settings", () => {
    const { result } = renderHook(() =>
      useProjectSource({ projectId: "source-only", roleLevel: 700 }),
    )
    expect(result.current.isSourceOnly).toBe(true)
  })

  it("flags isSourceOnly=false when targetLanguage is set", () => {
    const { result } = renderHook(() =>
      useProjectSource({ projectId: "p1", roleLevel: 700 }),
    )
    expect(result.current.isSourceOnly).toBe(false)
  })

  it("link() updates sourceProjectId on success", async () => {
    linkMock.mockResolvedValueOnce({
      projectId: "p1",
      sourceProjectId: "src-new",
      previousSourceProjectId: null,
    })
    const { result } = renderHook(() =>
      useProjectSource({ projectId: "p1", roleLevel: 700 }),
    )
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.link("src-new") })
    expect(ok).toBe(true)
    expect(linkMock).toHaveBeenCalledWith("p1", "src-new", "jwt")
    await waitFor(() => expect(result.current.sourceProjectId).toBe("src-new"))
    expect(result.current.error).toBeNull()
  })

  it("link() surfaces a cycle error in human-friendly form", async () => {
    linkMock.mockRejectedValueOnce(
      new FakeSourceLinkingError(409, JSON.stringify({ error: "linking would create a cycle" })),
    )
    const { result } = renderHook(() =>
      useProjectSource({ projectId: "p1", roleLevel: 700 }),
    )
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.link("downstream") })
    expect(ok).toBe(false)
    await waitFor(() => expect(result.current.error).toMatch(/cycle/i))
  })

  it("link() surfaces 404 as a 'source project unavailable' message", async () => {
    linkMock.mockRejectedValueOnce(new FakeSourceLinkingError(404, "not found"))
    const { result } = renderHook(() =>
      useProjectSource({ projectId: "p1", roleLevel: 700 }),
    )
    await act(async () => { await result.current.link("missing") })
    await waitFor(() => expect(result.current.error).toMatch(/unavailable/i))
  })

  it("link() is a no-op when the role is below project_lead", async () => {
    const { result } = renderHook(() =>
      useProjectSource({ projectId: "p1", roleLevel: 200 }),
    )
    expect(result.current.canEditLink).toBe(false)
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.link("src") })
    expect(ok).toBe(false)
    expect(linkMock).not.toHaveBeenCalled()
  })

  it("detach() clears sourceProjectId and returns snapshot stats", async () => {
    detachMock.mockResolvedValueOnce({
      projectId: "p1",
      previousSourceProjectId: "src-1",
      snapshottedCellCount: 42,
    })
    const { result } = renderHook(() =>
      useProjectSource({
        projectId: "p1",
        initialSourceProjectId: "src-1",
        roleLevel: 700,
      }),
    )
    expect(result.current.isLinked).toBe(true)
    let res: { snapshottedCellCount: number } | null = null
    await act(async () => { res = await result.current.detach() })
    expect(res).not.toBeNull()
    expect((res as unknown as { snapshottedCellCount: number }).snapshottedCellCount).toBe(42)
    await waitFor(() => expect(result.current.sourceProjectId).toBeNull())
    expect(result.current.isLinked).toBe(false)
  })
})
