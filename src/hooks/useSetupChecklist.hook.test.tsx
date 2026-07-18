import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { IDBFactory } from "fake-indexeddb"
import { useSetupChecklist } from "./useSetupChecklist"
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
