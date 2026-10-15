import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import {
  laneCheckOverrides,
  lanePunctuation,
  withLaneOverride,
} from "@/lib/lqa/lane-builtin-checks"
import { bibleChecksEnabled } from "@/lib/bible-data/check-context"
import { rulesForLane } from "@/lib/rules/rule-engine"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import { compileConceptsToRules } from "@/lib/terminology/compile"
import { conceptsForLaneTag } from "@/lib/terminology/rendering-lane"
import type { Concept } from "@/lib/terminology/types"

/**
 * Optional callback that syncs the given partial settings slice to Postgres.
 * Pass `useProjectSettings(...).patch` from the caller.
 */
type PatchSharedFn = (partial: ProjectWideSettings) => Promise<unknown>

/** The settings keys this hook writes, held locally until the server read catches up. */
type RuleSettingsOverlay = Partial<Pick<ProjectRecord, "rules" | "algorithmicChecks" | "algorithmicChecksByLane" | "rulePenalties">>

/** A patchShared result that says the write did not land (blocked, conflict, error). */
function writeFailed(outcome: unknown): boolean {
  if (!outcome || typeof outcome !== "object" || !("kind" in outcome)) return false
  return (outcome as { kind: unknown }).kind !== "ok"
}

const EMPTY_RULES: TranslationRule[] = []

/** Rule-setting writes this close together go to the server as one PATCH. */
const WRITE_BATCH_MS = 250

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
  /**
   * AQU-609: the active target-language lane (`''` = default lane). When
   * provided, the merged `rules` array excludes lane-scoped rules belonging to
   * OTHER lanes, so every evaluation consumer downstream is lane-correct.
   * Management surfaces omit it and see the full list (`userRules` is never
   * filtered either way).
   */
  lane?: string,
  /**
   * This project's OWN concepts, read from the sync-worker projection via
   * `useConcepts` (AQU-1006 follow-up).
   *
   * These used to come from `project.terminology` — a key in the
   * project_settings JSON blob. That key is GONE: every add rewrote the whole
   * array from the writer's stale snapshot, so concurrent adds silently
   * destroyed each other. Do not reintroduce a read of `project.terminology`
   * here; it no longer exists on the record.
   *
   * HAZARD, and the reason this is documented rather than defaulted quietly:
   * omitting it compiles to ZERO terminology rules, which presents as every
   * term check silently vanishing from the editor — indistinguishable, to a
   * user, from the outage this whole change set exists to fix. Every caller
   * that renders or evaluates terminology must pass it.
   */
  localConcepts?: Concept[],
) {
  // AQU-1104: a fresh `[]` per render gave `rules` a new identity on every
  // workspace render for projects without rules, which re-ran every consumer
  // memo (useHealth's checkRules pass, ~700 times in one scroll session).
  // Optimistic overlay. `project` comes from useProject, which has no
  // optimistic state, and a refresh() racing the PATCH returns the pre-save
  // row — the toggle then didn't move, or flipped back and on again. The
  // overlay holds what this hook wrote until the write settles AND a newer
  // `project` arrives; a failed write drops it so the UI shows server truth.
  const [overlay, setOverlay] = useState<RuleSettingsOverlay>({})
  const inFlightRef = useRef(0)
  // The `project` seen when the last write settled; the overlay clears once
  // the prop moves past it. `undefined` = a write is still in flight.
  const [settledAt, setSettledAt] = useState<ProjectRecord | null | undefined>(undefined)
  if (settledAt !== undefined && project !== settledAt) {
    setSettledAt(undefined)
    setOverlay({})
  }
  // Checks maps as last written, for clicks that land before a re-render;
  // null once no write is in flight (the rendered maps are current again).
  const pendingChecksRef = useRef<ProjectRecord["algorithmicChecks"] | null>(null)
  const pendingLaneChecksRef = useRef<ProjectRecord["algorithmicChecksByLane"] | null>(null)
  const projectRef = useRef(project)
  useEffect(() => { projectRef.current = project }, [project])

  const userRules = overlay.rules ?? project?.rules ?? EMPTY_RULES
  // AQU-1906: the lane's own overrides lie over the project-wide ones. With no
  // lane (a management surface) this IS the project-wide map, by identity —
  // memoized for the same reason `userRules` is above: a fresh object per
  // render re-runs every consumer memo. Writes build from the two STORED maps
  // (`projectChecks`, `laneChecks`), never from this resolved one.
  const projectChecks = overlay.algorithmicChecks ?? project?.algorithmicChecks
  const laneChecks = overlay.algorithmicChecksByLane ?? project?.algorithmicChecksByLane
  const algorithmicChecks = useMemo(
    () => laneCheckOverrides({ algorithmicChecks: projectChecks, algorithmicChecksByLane: laneChecks }, lane),
    [projectChecks, laneChecks, lane],
  )
  const penalties: RulePenalties = overlay.rulePenalties ?? project?.rulePenalties ?? { major: 15, minor: 5 }
  // The two stored maps, overlay included, for a surface that resolves a lane
  // of its own: the Rules page views one lane while its useRules has none.
  // Resolving from `project` instead would show a toggle only once the refresh
  // lands — the flip-back PR #1438 removed.
  const checkOverrides = useMemo(
    () => ({ algorithmicChecks: projectChecks, algorithmicChecksByLane: laneChecks }),
    [projectChecks, laneChecks],
  )
  const terminology = localConcepts

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

  // AQU-1688: the Bible data checks are rules only while the project's Bible
  // data checks enrichment is on (which also needs Bible data itself on).
  const bibleChecks = bibleChecksEnabled(project)
  // AQU-1906: the punctuation checks judge the target by the ACTIVE lane's own
  // marks. Resolved here, once per lane, and stamped onto the two checks'
  // descriptors, so every consumer of this rule set — editor underline, Issues
  // tab, health ribbon, Check file — agrees. A management surface (no lane)
  // keeps the source-relative sets; the Rules page resolves the lane it is
  // viewing itself, through `withBuiltinOverrides`.
  const projectLanes = project?.lanes
  const projectTargetLanguage = project?.targetLanguage
  const projectLanguageProfile = project?.languageProfile
  const punctuation = useMemo(
    () =>
      lane === undefined
        ? null
        : lanePunctuation(
            {
              lanes: projectLanes,
              targetLanguage: projectTargetLanguage ?? "",
              languageProfile: projectLanguageProfile,
            },
            lane,
          ).conventions,
    [projectLanes, projectTargetLanguage, projectLanguageProfile, lane],
  )
  const builtinRules = useMemo(
    () => resolveBuiltinRules(algorithmicChecks, { bibleChecks, punctuation }),
    [algorithmicChecks, bibleChecks, punctuation],
  )

  // Subscribed (org-managed) concepts union local terminology, subscribed
  // first (higher precedence), then compiled together so they share the
  // identical derive-on-read path. Subscribed concepts are already in
  // subscription-priority order from useSubscribedConcepts.
  //
  // The CONSUMING project's affix inventory (project.termMatching) governs
  // every compiled concept, subscribed org termbases included — matching runs
  // against THIS project's source text, so the morphology that matters is the
  // one of the language being worked on here, not the termbase's owner org.
  // A lane (including '') sees only that lane's renderings. Management
  // surfaces omit `lane` and keep every rendering. No `''` lane row yet
  // leaves the lists alone — conceptsForLaneTag's rule.
  const laneConcepts = useMemo(() => {
    if (lane === undefined) return null
    const lanes = project?.lanes ?? []
    return {
      subscribed: conceptsForLaneTag(subscribedConcepts ?? [], lane, lanes),
      local: terminology ? conceptsForLaneTag(terminology, lane, lanes) : undefined,
    }
  }, [lane, subscribedConcepts, terminology, project?.lanes])

  const terminologyRules = useMemo(
    () =>
      compileConceptsToRules(
        laneConcepts
          ? [...laneConcepts.subscribed, ...(laneConcepts.local ?? [])]
          : [...(subscribedConcepts ?? []), ...(terminology ?? [])],
        project?.termMatching,
      ),
    [laneConcepts, subscribedConcepts, terminology, project?.termMatching],
  )

  // Order: builtins → org rules → project rules → terminology
  // (subscribed + local). Project rules can shadow org rules (same id wins in
  // evaluation order). With a `lane`, lane-scoped rules for other lanes are
  // dropped from the evaluation list (AQU-609).
  const rules = useMemo(() => {
    const merged = [...builtinRules, ...(orgRules ?? []), ...userRules, ...terminologyRules]
    return lane === undefined ? merged : rulesForLane(merged, lane)
  }, [builtinRules, orgRules, userRules, terminologyRules, lane])

  // Apply locally, wait for the server write, then refresh — refreshing
  // before the PATCH lands is what read the stale row back.
  //
  // Writes within WRITE_BATCH_MS share one PATCH. Each save is a serialized
  // probe GET + PATCH, so a second toggle sent on its own reached the server
  // ~4 s after the click and a reload in that window lost it (QA, PR #1438).
  // Every key here carries its whole value, so merging partials by key is safe.
  const batchRef = useRef<{ partial: RuleSettingsOverlay; calls: number; done: Promise<void> } | null>(null)
  const sendBatch = useCallback(async (partial: RuleSettingsOverlay, calls: number) => {
    let failed: boolean
    try {
      failed = writeFailed(await patchShared?.(partial))
    } catch {
      failed = true
    } finally {
      inFlightRef.current -= calls
      if (inFlightRef.current === 0) {
        pendingChecksRef.current = null
        pendingLaneChecksRef.current = null
      }
    }
    if (failed) {
      if (partial.rules) latestRulesRef.current = projectRef.current?.rules ?? EMPTY_RULES
      setOverlay({})
    } else if (inFlightRef.current === 0) {
      setSettledAt(projectRef.current)
    }
    refresh()
  }, [patchShared, refresh])

  const writeShared = useCallback((partial: RuleSettingsOverlay): Promise<void> => {
    inFlightRef.current++
    setSettledAt(undefined)
    setOverlay((prev) => ({ ...prev, ...partial }))
    const open = batchRef.current
    if (open) {
      Object.assign(open.partial, partial)
      open.calls++
      return open.done
    }
    const batch = { partial: { ...partial }, calls: 1, done: Promise.resolve() }
    batch.done = new Promise<void>((resolve) => setTimeout(resolve, WRITE_BATCH_MS)).then(() => {
      batchRef.current = null
      return sendBatch(batch.partial, batch.calls)
    })
    batchRef.current = batch
    return batch.done
  }, [sendBatch])

  // A reload or tab close before the PATCH answers drops the change, and the
  // sync indicator (outbox-based) still reads "synced". Ask the browser to
  // confirm leaving while a settings write is unsent.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (inFlightRef.current > 0) e.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [])

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
    // AQU-455: await the shared-settings write (Postgres project_settings PATCH).
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
    await writeShared({ rules: cumulative })
  }, [project, writeShared])

  const updateRule = useCallback(async (ruleId: string, updates: Partial<TranslationRule>) => {
    if (!project) return
    // Built-in rules update via setBuiltinOverride; reject here.
    if (ruleId.startsWith("builtin:")) return
    // AQU-455 again: build from latestRulesRef, not the `project.rules`
    // closure, or two quick toggles send arrays that each drop the other.
    const next = latestRulesRef.current.map((r) => r.id === ruleId ? { ...r, ...updates } : r)
    latestRulesRef.current = next
    void patchProject(project.id, (p) => ({
      ...p,
      rules: (p.rules || []).map((r) => r.id === ruleId ? { ...r, ...updates } : r),
    }))
    await writeShared({ rules: next })
  }, [project, writeShared])

  const deleteRule = useCallback(async (ruleId: string) => {
    if (!project) return
    if (ruleId.startsWith("builtin:")) return
    const next = latestRulesRef.current.filter((r) => r.id !== ruleId)
    latestRulesRef.current = next
    void patchProject(project.id, (p) => ({
      ...p,
      rules: (p.rules || []).filter((r) => r.id !== ruleId),
    }))
    await writeShared({ rules: next })
  }, [project, writeShared])

  const updatePenalties = useCallback(async (newPenalties: RulePenalties) => {
    if (!project) return
    void patchProject(project.id, (p) => ({ ...p, rulePenalties: newPenalties }))
    await writeShared({ rulePenalties: newPenalties })
  }, [project, writeShared])

  /**
   * AQU-1906: `overrideLane` switches ONE lane's copy of the check instead of
   * the project-wide one (`''` is the default lane). Omit it and this writes
   * `algorithmicChecks`, exactly as before — which is what a single-lane
   * project keeps doing.
   */
  const setBuiltinOverride = useCallback(async (
    checkId: BuiltinCheckId,
    override: AlgorithmicCheckOverride,
    overrideLane?: string,
  ) => {
    if (!project) return
    if (overrideLane !== undefined) {
      void patchProject(project.id, (p) => ({
        ...p,
        algorithmicChecksByLane: withLaneOverride(p.algorithmicChecksByLane, overrideLane, checkId, override),
      }))
      // Same rule as the project-wide path below: the key replaces wholesale,
      // so send the full per-lane map, built from the last-written one so two
      // quick toggles in a lane both survive.
      const next = withLaneOverride(pendingLaneChecksRef.current ?? laneChecks, overrideLane, checkId, override)
      pendingLaneChecksRef.current = next
      await writeShared({ algorithmicChecksByLane: next })
      return
    }
    void patchProject(project.id, (p) => ({
      ...p,
      algorithmicChecks: { ...(p.algorithmicChecks ?? {}), [checkId]: override },
    }))
    // Sync to Postgres like `rules`/`rulePenalties`: under AD-3 the read path is the
    // server projection, so an IDB-only write here is invisible to useProject.
    // Top-level settings keys replace wholesale — send the full merged map,
    // built from the last-written map so a second click before a re-render
    // keeps the first (QA on PR #1438 lost one of two quick toggles). The
    // STORED project-wide map, not the lane-resolved `algorithmicChecks`: a
    // lane's overrides must never be baked into the key every lane shares.
    const next = { ...(pendingChecksRef.current ?? projectChecks ?? {}), [checkId]: override }
    pendingChecksRef.current = next
    await writeShared({ algorithmicChecks: next })
  }, [project, projectChecks, laneChecks, writeShared])

  return {
    rules,
    userRules,
    builtinRules,
    checkOverrides,
    penalties,
    addRule,
    updateRule,
    deleteRule,
    updatePenalties,
    setBuiltinOverride,
  }
}
