import { describe, it, expect, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useRules } from "./useRules"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

/**
 * FRO-455: "Suggest from edits" (and rule-import) dialogs commit N accepted
 * suggestions by calling `onAdd` (= `addRule`) once per suggestion in a
 * sequential loop:
 *
 *   for (const i of accepted) { await onAdd(...) }
 *
 * Root cause: `addRule` fired its shared-settings (D1 `project_settings`)
 * write with `void patchShared?.(...)` — fire-and-forget. The loop's `await`
 * only waited for the fast local IDB write, not the network PATCH. That let
 * N PATCH requests for N accepted rules be in flight concurrently; if they
 * resolved out of order (or interleaved with the `refresh()` GET each call
 * also fires), the last PATCH response to land won and silently discarded
 * any rule added by a PATCH that was still in flight when a later one
 * landed. Net effect: only the LAST accepted rule survived a reload.
 *
 * Fix: `addRule` now `await`s `patchShared` before returning, so the
 * caller's sequential loop genuinely serializes one full round trip (IDB +
 * D1 write) per accepted rule before starting the next.
 */

let store: Record<string, ProjectRecord> = {}

vi.mock("@/lib/store/project-index", () => ({
  patchProject: vi.fn(
    async (id: string, updater: (p: ProjectRecord) => ProjectRecord) => {
      const latest = store[id]
      if (!latest) return undefined
      const next = updater(latest)
      store[id] = next
      return next
    },
  ),
}))

function baseProject(): ProjectRecord {
  return {
    id: "p1",
    name: "P",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00.000Z",
    files: [],
    members: [],
    rules: [],
  }
}

const noop = () => {}

function acceptedRule(name: string) {
  return {
    name,
    description: "d",
    severity: "major" as const,
    source: "llm" as const,
    scope: "project" as const,
    check: { type: "source-target-match" as const, pattern: name },
    enabled: true,
  }
}

describe("useRules — addRule under sequential multi-accept commit (FRO-455)", () => {
  it("happy path: patchShared is called once per accepted rule with the full cumulative array (does not by itself distinguish void vs await patchShared — see the out-of-order-server test below for the actual regression)", async () => {
    store = { p1: baseProject() }
    const patchShared = vi.fn(async (_partial: ProjectWideSettings) => ({ kind: "ok" as const }))

    const { result } = renderHook(() => useRules(store.p1, noop, patchShared))

    const accepted = [acceptedRule("Rule A"), acceptedRule("Rule B"), acceptedRule("Rule C")]

    // Mirrors RuleSuggestFromEditsDialog.handleCommit / RuleImportDialog.handleCommit:
    // sequential awaited calls to onAdd (= addRule) for each accepted suggestion.
    await act(async () => {
      for (const rule of accepted) {
        await result.current.addRule(rule)
      }
    })

    // All three must survive in IDB (project-index store) ...
    expect(store.p1.rules?.map((r) => r.name).sort()).toEqual(["Rule A", "Rule B", "Rule C"])

    // ... AND all three must have been pushed to the server via patchShared
    // (the shared-settings sync path) so they survive a reload, not just
    // the local IDB mirror.
    expect(patchShared).toHaveBeenCalledTimes(3)
    const lastCall = patchShared.mock.calls[patchShared.mock.calls.length - 1][0]
    expect(lastCall.rules?.map((r) => r.name).sort()).toEqual(["Rule A", "Rule B", "Rule C"])
  })

  it("OUTCOME REGRESSION: server ends up with ALL N rules even when patchShared responses land out of order (not just the mechanism, the actual observable outcome)", async () => {
    // FRO-455's real failure mode: each addRule() call's `patchShared` payload
    // already carries the correct full cumulative `rules` array at *dispatch*
    // time (it reads the just-updated IDB snapshot via `patchProject`'s
    // return value) — so a mock that resolves synchronously/in-order can
    // never show the bug: the last dispatched call always has the full
    // array, regardless of whether the previous call was awaited or
    // fire-and-forgotten. The actual production hazard is that with `void
    // patchShared?.(...)`, addRule's *caller loop* does not wait for the
    // network write to land before moving on (and, in the real dialogs,
    // before calling refresh()/closing). If patchShared's server-side
    // responses can land OUT OF ORDER relative to dispatch order (slow
    // earlier request, fast later one racing ahead, or vice versa) and the
    // server applies whichever response landed *last* (last-write-wins on
    // the whole `rules` blob — exactly what a naive PATCH handler /
    // `writeServer(outcome.value)` does), then whichever call the caller
    // failed to wait for can have its write silently overwritten by a
    // differently-ordered write for another rule.
    //
    // Model this directly: a `patchShared` mock backed by a shared "server"
    // object, where the promise for the Nth call resolves *later* than the
    // (N+1)th call's promise (decreasing/reversed resolve order — the first
    // dispatched call is the slowest, so it lands last and "wins" with a
    // stale, non-cumulative payload) unless the caller actually awaits each
    // call before dispatching the next.
    //
    // - Under the OLD `void patchShared?.(...)` code: addRule resolves as
    //   soon as the local IDB write finishes, so the loop dispatches all 3
    //   patchShared calls back-to-back without waiting for any of them. The
    //   slow-resolving call for Rule A (dispatched first, carrying only
    //   `[Rule A]` as the cumulative array observed at ITS dispatch time)
    //   lands LAST and clobbers the server's `rules` field, discarding Rule B
    //   and Rule C's server-side writes. Server ends up with `[Rule A]`, not
    //   all three -- test must FAIL here.
    // - Under the FIX (`await patchShared?.(...)`): addRule does not resolve
    //   until its own patchShared call has landed, so the loop cannot
    //   dispatch call N+1 until call N's server write is durably applied.
    //   Calls are therefore serialized in dispatch order and each carries the
    //   full cumulative array by the time it lands. Server ends up with all
    //   three -- test must PASS here.
    store = { p1: baseProject() }

    const server: { rules: ProjectWideSettings["rules"] } = { rules: [] }
    let dispatchCount = 0
    const patchShared = vi.fn((partial: ProjectWideSettings) => {
      const dispatchIndex = dispatchCount++
      // Reversed delay: the call dispatched FIRST (index 0) waits longest,
      // so later-dispatched calls land at the server first. Only a caller
      // that genuinely serializes dispatch (awaits each call before firing
      // the next) avoids ever having two calls in flight concurrently, which
      // is the only way to guarantee correct final server state here.
      const delayMs = (3 - dispatchIndex) * 20
      return new Promise<{ kind: "ok" }>((resolve) => {
        setTimeout(() => {
          server.rules = partial.rules
          resolve({ kind: "ok" })
        }, delayMs)
      })
    })

    const { result } = renderHook(() => useRules(store.p1, noop, patchShared))

    const accepted = [acceptedRule("Rule A"), acceptedRule("Rule B"), acceptedRule("Rule C")]

    await act(async () => {
      for (const rule of accepted) {
        await result.current.addRule(rule)
      }
      // Let any straggling out-of-order writes (dispatched but not awaited
      // by the loop under the old fire-and-forget code) finish landing.
      await new Promise((r) => setTimeout(r, 100))
    })

    expect(patchShared).toHaveBeenCalledTimes(3)
    expect(server.rules?.map((r) => r.name).sort()).toEqual(["Rule A", "Rule B", "Rule C"])
  })

  it("REGRESSION: addRule's returned promise does not resolve until patchShared's write lands", async () => {
    // This is the precise mechanism behind FRO-455: RuleSuggestFromEditsDialog /
    // RuleImportDialog commit accepted suggestions via
    // `for (const i of accepted) { await onAdd(...) }`. That loop's safety
    // depends entirely on `onAdd` (== addRule) not resolving until its
    // server write (patchShared) has actually landed — otherwise the loop
    // races ahead to the next rule while a still-in-flight PATCH for a
    // previous rule can be overtaken/clobbered by a later one.
    //
    // Use a manually-controlled (never-resolving-until-we-say-so) patchShared
    // so we can observe addRule's promise state at the exact moment
    // patchShared is still pending. A microtask-hop-based check is not
    // enough here: `act(async () => ...)` flushes pending microtasks after
    // the callback runs, which would make even a fire-and-forget
    // (`void patchShared?.(...)`) write LOOK resolved by the time we inspect
    // it afterward, masking the bug. Racing addRule's promise against the
    // still-pending patchShared promise via Promise.race is what actually
    // distinguishes "awaited" from "fire-and-forget".
    store = { p1: baseProject() }

    let releasePatchShared!: () => void
    const patchSharedGate = new Promise<void>((resolve) => { releasePatchShared = resolve })
    const patchShared = vi.fn(async (_partial: ProjectWideSettings) => {
      await patchSharedGate
      return { kind: "ok" as const }
    })

    const { result } = renderHook(() => useRules(store.p1, noop, patchShared))

    let addRuleSettled = false
    let raceWinner: "addRule" | "timeout" = "timeout"

    await act(async () => {
      const addRulePromise = result.current.addRule(acceptedRule("Rule A")).then(() => {
        addRuleSettled = true
      })
      // While patchShared is still gated (unresolved), race addRule against
      // a timeout. If addRule awaits patchShared internally, addRule cannot
      // win this race (patchShared is deliberately held open) — the race
      // must resolve via the timeout branch, and addRuleSettled must still
      // be false at that point.
      await Promise.race([
        addRulePromise.then(() => { raceWinner = "addRule" }),
        new Promise((r) => setTimeout(r, 10)),
      ])
    })

    expect(raceWinner).toBe("timeout")
    expect(addRuleSettled).toBe(false)

    // Now release the gate and confirm addRule completes and the write landed.
    await act(async () => {
      releasePatchShared()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(addRuleSettled).toBe(true)
    expect(patchShared).toHaveBeenCalledTimes(1)
  })
})
