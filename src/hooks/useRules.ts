import { useCallback, useMemo, useRef } from "react"
import { v4 as uuid } from "uuid"
import type {
  ProjectRecord,
  TranslationRule,
  RulePenalties,
  AlgorithmicCheckOverride,
  BuiltinCheckId,
} from "@/lib/parsers/types"
import { patchProject } from "@/lib/store/project-index"
import { resolveBuiltinRules } from "@/lib/lqa/builtin-resolver"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import { compileConceptsToRules } from "@/lib/terminology/compile"
import type { Concept } from "@/lib/terminology/types"

/**
 * Optional callback that syncs the given partial settings slice to D1.
 * Pass `useProjectSettings(...).patch` from the caller.
 */
type PatchSharedFn = (partial: ProjectWideSettings) => Promise<unknown>

export function useRules(
  project: ProjectRecord | null,
  refresh: () => void,
  patchShared?: PatchSharedFn,
  orgRules?: TranslationRule[],
  /**
   * Active concepts from this project's termbase subscriptions, already
   * flattened in subscription-priority order (see useSubscribedConcepts).
   * These are org-MANAGED, DETERMINISTIC terms: they are compiled through the
   * exact same compileConceptsToRules path as local terminology, so the
   * deterministic/probabilistic contract is identical for subscribed and local
   * concepts. Subscribed concepts take precedence over local terminology and
   * so are unioned ahead of it.
   */
  subscribedConcepts?: Concept[],
) {
  const userRules = project?.rules || []
  const algorithmicChecks = project?.algorithmicChecks
  const penalties: RulePenalties = project?.rulePenalties || { major: 15, minor: 5 }
  const terminology = project?.terminology

  // AQU-455: track the latest known-cumulative rules array ourselves rather
  // than trusting `patchProject`'s return value or the `project` prop as the
  // source of truth for "what rules exist right now".
  //
  // Root cause (confirmed live against the real dev stack, not just a mock):
  // under the AD-3 thin-client architecture (see useProject.ts), a project
  // loaded via the server-authoritative path is NEVER written to IDB as a
  // whole record — only isolated fields (e.g. completionSettings) get
  // mirrored back. So `patchProject(project.id, ...)` in `addRule` calls
  // `getProject(id)` against IDB, finds nothing (`latest` is undefined), and
  // returns `undefined` *every single time*, not just on a rare race. The old
  // code's `updated?.rules ?? [...(project.rules || []), newRule]` fallback
  // therefore ALWAYS runs, and it always reads `project.rules` from the
  // closure captured when the dialog's `onAdd` prop was last set — which
  // never changes across a `for (const i of accepted) { await onAdd(...) }`
  // loop, because `refresh()` (a full server re-fetch) cannot resolve and
  // flow through a new render before the loop's next iteration starts. Every
  // call in the loop ends up computing `[...originalPreexistingRules, newRule]`
  // and the server (which replaces `rules` wholesale per-PATCH) keeps getting
  // overwritten with a 2-element array, not the accumulating one.
  //
  // Fix: keep a ref seeded from the current `rules` prop, and have each
  // addRule call both read from AND write to that ref synchronously. This
  // makes N sequential awaited addRule calls (same closure, no re-render
  // required in between) genuinely accumulate, regardless of whether IDB has
  // a record for this project.
  //
  // The ref is intentionally NOT resynced to `userRules` on every render —
  // only addRule/updateRule/deleteRule write to it (see below), plus a
  // length/identity-based catch-up on mount and when the project id changes.
  // Resyncing unconditionally on every render would reintroduce the bug: a
  // render that happens between two loop iterations (with `project.rules`
  // still reflecting the pre-loop server snapshot, since refresh() is an
  // async server GET that can't land mid-loop) would stomp the ref back to
  // stale data right before the next addRule call reads it.
  const latestRulesRef = useRef<TranslationRule[]>(userRules)
  const seededProjectIdRef = useRef<string | null>(project?.id ?? null)
  if (project && project.id !== seededProjectIdRef.current) {
    // Genuinely a different (or newly-loaded) project — reseed from its rules.
    seededProjectIdRef.current = project.id
    latestRulesRef.current = userRules
  } else if (!project) {
    seededProjectIdRef.current = null
  } else if (userRules.length > latestRulesRef.current.length) {
    // The prop caught up with (or overtook) our tracked state — e.g. a
    // completed refresh(), a different tab's edit, or another CRUD path.
    // Adopt the longer list rather than risk staying stuck on stale data.
    latestRulesRef.current = userRules
  }

  const builtinRules = useMemo(
    () => resolveBuiltinRules(algorithmicChecks),
    [algorithmicChecks],
  )

  // Subscribed (org-managed) concepts union local terminology, subscribed
  // first (higher precedence), then compiled together so they share the
  // identical derive-on-read path. Subscribed concepts are already in
  // subscription-priority order from useSubscribedConcepts.
  const terminologyRules = useMemo(
    () =>
      compileConceptsToRules([
        ...(subscribedConcepts ?? []),
        ...(terminology ?? []),
      ]),
    [subscribedConcepts, terminology],
  )

  // Order: builtins → org rules → project rules → terminology
  // (subscribed + local). Project rules can shadow org rules (same id wins in
  // evaluation order).
  const rules = useMemo(
    () => [...builtinRules, ...(orgRules ?? []), ...userRules, ...terminologyRules],
    [builtinRules, orgRules, userRules, terminologyRules],
  )

  const addRule = useCallback(async (rule: Omit<TranslationRule, "id" | "createdAt">) => {
    if (!project) return
    const newRule: TranslationRule = { ...rule, id: uuid(), createdAt: new Date().toISOString() }
    // AQU-455: compute the cumulative array from `latestRulesRef`, NOT from
    // `patchProject`'s return value or the `project` prop. Confirmed live
    // against the real dev stack: for AD-3 thin-client projects (the normal
    // case — see useProject.ts), the project record is never written to IDB
    // as a whole, so `patchProject` always finds nothing and returns
    // `undefined`. Falling back to `project.rules` was the actual bug — that
    // closure is captured once by the caller (RuleSuggestFromEditsDialog /
    // RuleImportDialog's `for (const i of accepted) { await onAdd(...) }`
    // loop) and never updates mid-loop, because `refresh()` is an async
    // server GET that cannot resolve and flow through a React re-render
    // before the loop's next iteration starts. Every call in the loop was
    // therefore computing `[...originalPreexistingRules, newRule]`, and since
    // the server replaces `rules` wholesale per-PATCH, only the last call's
    // 2-element array survived.
    //
    // `latestRulesRef` is written here synchronously (before any await),
    // so call N+1 in the same loop sees call N's addition even though no
    // render has happened in between.
    const cumulative = [...latestRulesRef.current, newRule]
    latestRulesRef.current = cumulative
    // Best-effort IDB mirror; irrelevant to correctness above (patchShared
    // carries the authoritative array either way) but keeps any legacy
    // IDB-backed project record in sync for offline/local-only projects.
    void patchProject(project.id, (p) => ({ ...p, rules: [...(p.rules || []), newRule] }))
    // AQU-455: await the shared-settings write (D1 project_settings PATCH).
    // patchShared's write is queued (useProjectSettings.patch →
    // runSerialized), so back-to-back calls don't clobber each other
    // server-side *once they're properly ordered* — but when this call was
    // fire-and-forget (`void patchShared?.(...)`), addRule returned (and the
    // loop advanced to the next accepted rule) before the PATCH actually
    // landed. Multiple in-flight PATCH/refresh round trips could then resolve
    // out of order, and the last one to land wins — silently dropping all but
    // the final accepted rule. Awaiting here makes each loop iteration a true
    // synchronous-from-the-caller's-perspective step: the server write for
    // rule N is durably queued and committed before rule N+1 starts.
    await patchShared?.({ rules: cumulative })
    refresh()
  }, [project, refresh, patchShared])

  const updateRule = useCallback(async (ruleId: string, updates: Partial<TranslationRule>) => {
    if (!project) return
    // Built-in rules update via setBuiltinOverride; reject here.
    if (ruleId.startsWith("builtin:")) return
    const updated = await patchProject(project.id, (p) => ({
      ...p,
      rules: (p.rules || []).map((r) => r.id === ruleId ? { ...r, ...updates } : r),
    }))
    void patchShared?.({ rules: updated?.rules ?? (project.rules || []).map((r) => r.id === ruleId ? { ...r, ...updates } : r) })
    refresh()
  }, [project, refresh, patchShared])

  const deleteRule = useCallback(async (ruleId: string) => {
    if (!project) return
    if (ruleId.startsWith("builtin:")) return
    const updated = await patchProject(project.id, (p) => ({
      ...p,
      rules: (p.rules || []).filter((r) => r.id !== ruleId),
    }))
    void patchShared?.({ rules: updated?.rules ?? (project.rules || []).filter((r) => r.id !== ruleId) })
    refresh()
  }, [project, refresh, patchShared])

  const updatePenalties = useCallback(async (newPenalties: RulePenalties) => {
    if (!project) return
    await patchProject(project.id, (p) => ({ ...p, rulePenalties: newPenalties }))
    void patchShared?.({ rulePenalties: newPenalties })
    refresh()
  }, [project, refresh, patchShared])

  const setBuiltinOverride = useCallback(async (
    checkId: BuiltinCheckId,
    override: AlgorithmicCheckOverride,
  ) => {
    if (!project) return
    const updated = await patchProject(project.id, (p) => ({
      ...p,
      algorithmicChecks: { ...(p.algorithmicChecks ?? {}), [checkId]: override },
    }))
    // Sync to D1 like `rules`/`rulePenalties`: under AD-3 the read path is the
    // server projection, so an IDB-only write here is invisible to useProject.
    // Top-level settings keys replace wholesale — send the full merged map.
    void patchShared?.({
      algorithmicChecks: updated?.algorithmicChecks ?? {
        ...(project.algorithmicChecks ?? {}),
        [checkId]: override,
      },
    })
    refresh()
  }, [project, refresh, patchShared])

  return {
    rules,
    userRules,
    builtinRules,
    penalties,
    addRule,
    updateRule,
    deleteRule,
    updatePenalties,
    setBuiltinOverride,
  }
}
