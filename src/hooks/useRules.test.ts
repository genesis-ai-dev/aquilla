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
  it("persists ALL rules when addRule is awaited N times in a row, not just the last", async () => {
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
