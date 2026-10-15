import { describe, it, expect, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useRules } from "./useRules"
import type { ProjectRecord, TranslationRule } from "@/lib/parsers/types"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

/**
 * The Rules page reads `project` from useProject, which has no optimistic
 * state of its own, and its refresh() can return the pre-save row while the
 * PATCH is still in flight. Without an overlay in useRules, a toggle either
 * doesn't move or flips back and then on again a moment later, the "thrash"
 * users reported. These tests pin the toggle to the user's choice until the
 * write settles, and roll it back only when the write actually fails.
 */

vi.mock("@/lib/store/project-index", () => ({
  // AD-3 thin client: the project is not in IDB, so patchProject finds nothing.
  patchProject: vi.fn(async () => undefined),
}))

const rule = (id: string, enabled: boolean): TranslationRule =>
  ({ id, name: id, enabled, type: "regex", pattern: "x", severity: "minor", createdAt: "2026-01-01" }) as unknown as TranslationRule

function project(rules: TranslationRule[]): ProjectRecord {
  return {
    id: "p1",
    name: "P",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00.000Z",
    files: [],
    members: [],
    rules,
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe("useRules — optimistic toggles", () => {
  it("shows the toggled value at once and keeps it while a stale server read lands", async () => {
    const write = deferred<{ kind: "ok" }>()
    const patchShared = vi.fn((_p: ProjectWideSettings) => write.promise)
    const stale = project([rule("r1", false)])
    const { result, rerender } = renderHook(({ p }) => useRules(p, () => {}, patchShared), {
      initialProps: { p: stale },
    })

    let pending!: Promise<void>
    act(() => { pending = result.current.updateRule("r1", { enabled: true }) })
    expect(result.current.userRules[0].enabled).toBe(true)

    // A refresh that raced the PATCH comes back with the old row.
    rerender({ p: project([rule("r1", false)]) })
    expect(result.current.userRules[0].enabled).toBe(true)

    await act(async () => { write.resolve({ kind: "ok" }); await pending })
    rerender({ p: project([rule("r1", true)]) })
    expect(result.current.userRules[0].enabled).toBe(true)
  })

  it("does not refresh until the write has landed, so the refresh can't read the old row", async () => {
    const write = deferred<{ kind: "ok" }>()
    const refresh = vi.fn()
    const { result } = renderHook(() => useRules(project([rule("r1", false)]), refresh, () => write.promise))

    let pending!: Promise<void>
    act(() => { pending = result.current.updateRule("r1", { enabled: true }) })
    expect(refresh).not.toHaveBeenCalled()
    await act(async () => { write.resolve({ kind: "ok" }); await pending })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("keeps both of two quick toggles instead of the second overwriting the first", async () => {
    const patchShared = vi.fn(async (_p: ProjectWideSettings) => ({ kind: "ok" as const }))
    const { result } = renderHook(() =>
      useRules(project([rule("r1", false), rule("r2", false)]), () => {}, patchShared),
    )

    await act(async () => {
      await Promise.all([
        result.current.updateRule("r1", { enabled: true }),
        result.current.updateRule("r2", { enabled: true }),
      ])
    })

    const last = patchShared.mock.calls.at(-1)![0]
    expect(last.rules?.map((r) => r.enabled)).toEqual([true, true])
  })

  it("keeps both of two quick built-in check toggles fired before a re-render", async () => {
    const patchShared = vi.fn(async (_p: ProjectWideSettings) => ({ kind: "ok" as const }))
    const { result } = renderHook(() => useRules(project([]), () => {}, patchShared))

    await act(async () => {
      // Same render's callback twice: an automated driver can click two
      // switches before React re-renders, so the closure map is stale.
      const { setBuiltinOverride } = result.current
      await Promise.all([
        setBuiltinOverride("double-space", { enabled: false }),
        setBuiltinOverride("repeated-word", { enabled: false }),
      ])
    })

    const last = patchShared.mock.calls.at(-1)![0]
    expect(last.algorithmicChecks?.["double-space"]).toEqual({ enabled: false })
    expect(last.algorithmicChecks?.["repeated-word"]).toEqual({ enabled: false })
  })

  it("sends two quick toggles as one PATCH carrying both", async () => {
    const patchShared = vi.fn(async (_p: ProjectWideSettings) => ({ kind: "ok" as const }))
    const { result } = renderHook(() =>
      useRules(project([rule("r1", false), rule("r2", false)]), () => {}, patchShared),
    )

    await act(async () => {
      const first = result.current.updateRule("r1", { enabled: true })
      const second = result.current.updateRule("r2", { enabled: true })
      await Promise.all([first, second])
    })

    // One round trip: a reload right after the clicks no longer has a
    // seconds-long window where only the first toggle has been sent.
    expect(patchShared).toHaveBeenCalledTimes(1)
    expect(patchShared.mock.calls[0][0].rules?.map((r) => r.enabled)).toEqual([true, true])
  })

  it("asks the browser to confirm leaving while a write is unsent", async () => {
    const write = deferred<{ kind: "ok" }>()
    const { result } = renderHook(() => useRules(project([rule("r1", false)]), () => {}, () => write.promise))
    const leave = () => {
      const e = new Event("beforeunload", { cancelable: true })
      window.dispatchEvent(e)
      return e.defaultPrevented
    }

    let pending!: Promise<void>
    act(() => { pending = result.current.updateRule("r1", { enabled: true }) })
    expect(leave()).toBe(true)
    await act(async () => { write.resolve({ kind: "ok" }); await pending })
    expect(leave()).toBe(false)
  })

  it("rolls the toggle back when the server rejects the write", async () => {
    const patchShared = vi.fn(async () => ({ kind: "blocked" as const, reason: "role" as const }))
    const { result } = renderHook(() => useRules(project([rule("r1", false)]), () => {}, patchShared))

    await act(async () => { await result.current.updateRule("r1", { enabled: true }) })
    expect(result.current.userRules[0].enabled).toBe(false)
  })
})
