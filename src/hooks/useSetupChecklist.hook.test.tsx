import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { IDBFactory } from "fake-indexeddb"
import { useSetupChecklist, isSetupInProgress } from "./useSetupChecklist"
import { createProject, getProject, _resetDbForTesting } from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"

// useSetupChecklist reaches useAccounts (via useFrontierSession), which needs
// a QueryClientProvider since AQU-212 — same as the app root in main.tsx.
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
)

function mkProject(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    name: "Test",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    ...overrides,
  } as ProjectRecord
}

beforeEach(async () => {
  await _resetDbForTesting()
  ;(globalThis as any).indexedDB = new IDBFactory()
})

describe("useSetupChecklist — dismiss persistence", () => {
  it("stays dismissed after a stale project re-prop", async () => {
    const initial = mkProject("p1")
    await createProject(initial)
    const { result, rerender } = renderHook(
      ({ project }) => useSetupChecklist(project),
      { initialProps: { project: initial }, wrapper }
    )
    await act(async () => { await result.current.dismiss() })
    expect(result.current.dismissed).toBe(true)

    // Simulate a stale-spread clobber: parent re-renders with a project
    // record that lacks setupChecklistDismissed.
    const stale = mkProject("p1", { setupChecklistDismissed: false })
    rerender({ project: stale })
    expect(result.current.dismissed).toBe(true)
  })

  it("resets when project id changes", async () => {
    const a = mkProject("p1")
    const b = mkProject("p2")
    await createProject(a)
    await createProject(b)
    const { result, rerender } = renderHook(
      ({ project }) => useSetupChecklist(project),
      { initialProps: { project: a }, wrapper }
    )
    await act(async () => { await result.current.dismiss() })
    expect(result.current.dismissed).toBe(true)

    rerender({ project: b })
    await waitFor(() => {
      expect(result.current.dismissed).toBe(false)
    })
  })

  it("persists to IDB", async () => {
    const initial = mkProject("p1")
    await createProject(initial)
    const { result } = renderHook(() => useSetupChecklist(initial), { wrapper })
    await act(async () => { await result.current.dismiss() })
    const stored = await getProject("p1")
    expect(stored?.setupChecklistDismissed).toBe(true)
  })

  it("sets dismissed true immediately after dismiss call", async () => {
    const initial = mkProject("p1")
    await createProject(initial)
    const { result } = renderHook(() => useSetupChecklist(initial), { wrapper })
    expect(result.current.dismissed).toBe(false)
    await act(async () => { await result.current.dismiss() })
    expect(result.current.dismissed).toBe(true)
  })
})

describe("useSetupChecklist — AQU-694 mid-setup persistence", () => {
  beforeEach(() => {
    localStorage.removeItem("codex.setupInProgress.p1")
  })

  // wasInProgress is deliberately a mount-time snapshot of localStorage (it is
  // only consumed once per load by the workspace's restore effect), so these
  // assert the persisted flag via the exported helper rather than expecting the
  // returned value to update live within one render.

  it("wasInProgress reflects a pre-existing flag on mount (the restore path)", async () => {
    const initial = mkProject("p1")
    await createProject(initial)
    // A prior session was mid-setup: the flag is already persisted before mount.
    localStorage.setItem("codex.setupInProgress.p1", "1")
    const { result } = renderHook(() => useSetupChecklist(initial), { wrapper })
    expect(result.current.wasInProgress).toBe(true)
  })

  it("wasInProgress is false on mount for a project never opened (no auto-open)", async () => {
    const initial = mkProject("p1")
    await createProject(initial)
    const { result } = renderHook(() => useSetupChecklist(initial), { wrapper })
    expect(result.current.wasInProgress).toBe(false)
  })

  it("markInProgress persists the flag for this project", async () => {
    const initial = mkProject("p1")
    await createProject(initial)
    const { result } = renderHook(() => useSetupChecklist(initial), { wrapper })
    act(() => { result.current.markInProgress() })
    expect(isSetupInProgress("p1")).toBe(true)
  })

  it("dismiss clears the persisted flag so restore stops (dismissal wins)", async () => {
    const initial = mkProject("p1")
    await createProject(initial)
    const { result } = renderHook(() => useSetupChecklist(initial), { wrapper })
    act(() => { result.current.markInProgress() })
    expect(isSetupInProgress("p1")).toBe(true)
    await act(async () => { await result.current.dismiss() })
    expect(isSetupInProgress("p1")).toBe(false)
    // dismiss() also re-renders (setDismissed), so the snapshot now reads false too.
    expect(result.current.wasInProgress).toBe(false)
  })

  it("clearInProgress removes the persisted flag (e.g. all steps complete)", async () => {
    const initial = mkProject("p1")
    await createProject(initial)
    const { result } = renderHook(() => useSetupChecklist(initial), { wrapper })
    act(() => { result.current.markInProgress() })
    expect(isSetupInProgress("p1")).toBe(true)
    act(() => { result.current.clearInProgress() })
    expect(isSetupInProgress("p1")).toBe(false)
  })
})
