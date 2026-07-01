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

  it("REAL-WORLD REGRESSION (AD-3 thin client): server ends up with ALL N rules even when patchProject never finds an IDB record and the caller's `project` closure is stale across the loop", async () => {
    // This is the test the prior swarm-fixed FRO-455 pass was missing, and
    // the reason unit tests went green while live-UI QA against the real dev
    // stack still showed only the last accepted rule surviving.
    //
    // The `happy path` and `OUTCOME REGRESSION` tests above both use a
    // `patchProject` mock that ALWAYS returns a truthy, correctly-cumulative
    // record (`store[id]` exists and is updated in place). That can never
    // reproduce the actual production bug, because on the real dev stack
    // (confirmed live: Editor -> Rules -> Suggest from edits -> accept 3
    // suggestions with 2 pre-existing rules -> only the last accepted rule
    // + pre-existing survived a reload), the project is loaded via the AD-3
    // thin-client path (useProject.ts): the ProjectRecord comes from the
    // server and is NEVER written to IndexedDB as a whole record. So
    // `patchProject(project.id, ...)` in addRule calls `getProject(id)`,
    // finds NOTHING in IDB, and returns `undefined` -- every single call, not
    // just occasionally.
    //
    // Additionally, the real callers (RuleSuggestFromEditsDialog /
    // RuleImportDialog) hold ONE `onAdd` (= addRule) closure for the whole
    // `for (const i of accepted) { await onAdd(...) }` loop -- the same
    // closure captured when the dialog's props were last set, which closes
    // over the `project` value from THAT render. `refresh()` is a full async
    // server re-fetch (useProject's refresh, not a fast IDB read) and cannot
    // resolve, flow through React, and produce a new `addRule` closure before
    // the loop's next iteration starts. So `project.rules` inside every
    // iteration of the loop is the SAME pre-loop snapshot.
    //
    // Model both facts here: `patchProject` always resolves `undefined`
    // (no IDB record for this project id), and the hook is driven with a
    // single stable `project` object for the entire loop (mirroring the
    // stale closure), exactly like the real caller. If addRule's fallback
    // ever again reads `project.rules` (the stale prop) instead of a
    // self-maintained running total, this test fails exactly like the real
    // bug: the server ends up with only the pre-existing rules + the last
    // accepted one instead of all N.
    store = {} // no IDB record for any project id -- patchProject always returns undefined

    const preexisting = [
      { id: "pre-1", name: "Pre-existing A", description: "", severity: "major" as const, source: "user" as const, scope: "project" as const, check: { type: "source-target-match" as const, pattern: "x" }, enabled: true, createdAt: "2026-01-01T00:00:00.000Z" },
    ]
    const project: ProjectRecord = { ...baseProject(), rules: preexisting }

    const server: { rules: ProjectWideSettings["rules"] } = { rules: preexisting }
    const patchShared = vi.fn(async (partial: ProjectWideSettings) => {
      // Server semantics per project-settings.ts: PATCH replaces top-level
      // keys (like `rules`) wholesale -- it does not element-wise merge.
      if (partial.rules != null) server.rules = partial.rules
      return { kind: "ok" as const }
    })

    const { result } = renderHook(() => useRules(project, noop, patchShared))

    const accepted = [acceptedRule("Rule A"), acceptedRule("Rule B"), acceptedRule("Rule C")]

    // Exactly mirrors RuleSuggestFromEditsDialog.handleCommit: one held
    // `addRule` reference, sequential awaited calls, `project` never changes.
    await act(async () => {
      for (const rule of accepted) {
        await result.current.addRule(rule)
      }
    })

    expect(patchShared).toHaveBeenCalledTimes(3)
    expect(server.rules?.map((r) => r.name).sort()).toEqual(
      ["Pre-existing A", "Rule A", "Rule B", "Rule C"].sort(),
    )
  })
})
