/**
 * The ambient sync loop for one document:
 *
 *   extract → reconcile identities → capture target-side human edits →
 *   plan → translate only what changed → post-edit with accepted corrections →
 *   patch (preconditions + authority) → render native artifact →
 *   three-way merge with any edited target → validate → layout check → publish
 *
 * The function is pure with respect to IO: it takes the folded ledger state and
 * file bytes, and returns new facts, output bytes and blobs for the caller to
 * persist. Running it twice with nothing changed produces no facts and no
 * writes (idempotent sync).
 */
import type { ContentAdapter, LayoutFinding } from "../adapters/adapter.ts"
import { containsTerm, replaceTerm, unitContext } from "../core/context.ts"
import { hashValue, sha256, shortHash } from "../core/hash.ts"
import {
  contentByHash,
  contentHashOf,
  effectiveTranslation,
  fold,
  lastPublish,
  latestProposal,
  seal,
  unitKey,
} from "../core/ledger.ts"
import type { Clock, Envelope, Fact, LedgerState, PublishedUnit, UnitSnapshot } from "../core/ledger.ts"
import { applyPatches } from "../core/patch.ts"
import { planLocale } from "../core/plan.ts"
import type { PlanPolicy, PlanReason, UnitPlan } from "../core/plan.ts"
import { assignIds, initialMapping, reconcile } from "../core/reconcile.ts"
import { mapText, plainOf, validateTagged } from "../core/tagged.ts"
import type { Authority, ContentPatch, ContentUnit, Diagnostic, IdentityMapping, TargetUnitState } from "../core/types.ts"
import { detectEdits, suggestCorrection } from "./feedback.ts"
import type { TranslationJob, Translator } from "./translator.ts"

export interface SyncOptions {
  readonly sourceLocale: string
  readonly locales: readonly string[]
  readonly policy: PlanPolicy
  readonly translator: Translator
  readonly clock: Clock
  readonly actor: string
}

export interface DocSyncInput {
  readonly docId: string
  readonly adapter: ContentAdapter
  readonly source: Uint8Array
  /** Current bytes of each locale's target file (undefined when absent). */
  readonly targets: ReadonlyMap<string, Uint8Array | undefined>
  readonly getBlob: (hash: string) => Uint8Array | undefined
  /** All facts so far. */
  readonly envelopes: readonly Envelope[]
}

export interface LocaleOutput {
  readonly locale: string
  readonly bytes: Uint8Array
  /** Write to the target path. False when nothing changed. */
  readonly write: boolean
  /** The target was edited and could not be merged safely: write beside it instead of over it. */
  readonly besideTarget: boolean
}

export interface ReviewItem {
  readonly logicalId: string
  readonly structuralPath: string
  readonly reason: string
  readonly source: string
  readonly target: string
}

export interface LocaleReport {
  readonly locale: string
  readonly total: number
  readonly reused: number
  readonly translated: number
  readonly byReason: Partial<Record<PlanReason, number>>
  readonly humanEditsCaptured: number
  readonly suggestions: Array<{ id: string; from: string; to: string; otherUnits: number }>
  readonly correctionsApplied: number
  readonly review: ReviewItem[]
  readonly conflicts: string[]
  readonly diagnostics: Diagnostic[]
  readonly layout: LayoutFinding[]
  readonly published: boolean
  readonly besideTarget: boolean
  readonly patch: { applied: number; skipped: number; rejected: number }
}

export interface DocReport {
  readonly docId: string
  readonly format: string
  readonly revision: string
  readonly sourceChanged: boolean
  readonly identity: Record<string, number>
  readonly deleted: number
  readonly diagnostics: Diagnostic[]
  readonly locales: LocaleReport[]
}

export interface DocSyncResult {
  readonly facts: Envelope[]
  readonly outputs: LocaleOutput[]
  readonly blobs: Uint8Array[]
  readonly report: DocReport
}

export const blobKey = (bytes: Uint8Array): string => sha256(bytes)

const snapshot = (u: ContentUnit, status: string, predecessors: readonly string[]): UnitSnapshot => ({
  logicalId: u.logicalId,
  scope: u.scope,
  structuralPath: u.structuralPath,
  ordinal: u.ordinal,
  kind: u.kind,
  contentHash: u.contentHash,
  tagged: u.tagged,
  plain: u.plain,
  status,
  predecessors,
  ...(u.nativeAnchor ? { nativeAnchor: u.nativeAnchor } : {}),
  ...(u.meta ? { meta: u.meta } : {}),
})

const snapshotAsUnit = (s: UnitSnapshot): ContentUnit => ({
  logicalId: s.logicalId,
  scope: s.scope,
  structuralPath: s.structuralPath,
  ordinal: s.ordinal,
  kind: s.kind,
  tagged: s.tagged,
  plain: s.plain,
  contentHash: s.contentHash,
  ...(s.nativeAnchor ? { nativeAnchor: s.nativeAnchor } : {}),
  ...(s.meta ? { meta: s.meta } : {}),
})

export const syncDocument = async (input: DocSyncInput, opts: SyncOptions): Promise<DocSyncResult> => {
  const { docId, adapter } = input
  const facts: Envelope[] = []
  const blobs: Uint8Array[] = []
  let envelopes = [...input.envelopes]
  let state = fold(envelopes)
  const emit = (fact: Fact): Envelope => {
    const env = seal(fact, opts.actor, opts.clock.tick())
    facts.push(env)
    envelopes.push(env)
    return env
  }
  const refresh = (): void => {
    state = fold(envelopes)
  }

  // ── 1. Extract and reconcile ──────────────────────────────────────────────
  const graph = adapter.extract(input.source, docId)
  const prevDoc = state.docs.get(docId)
  const previousUnits = prevDoc?.units ?? []
  const protectedIds = new Set<string>()
  for (const [key, u] of state.units) {
    if (u.human.length > 0 && key.startsWith(`${docId}\u0000`)) protectedIds.add(key.split("\u0000")[1]!)
  }
  let mapping: IdentityMapping
  const sourceChanged = !prevDoc || prevDoc.revision !== graph.revision
  if (!prevDoc) mapping = initialMapping(graph.units, `${docId}|${graph.revision}`)
  else if (!sourceChanged && prevDoc.units.length === graph.units.length) {
    mapping = {
      matches: graph.units.map((_, i) => ({
        index: i,
        logicalId: prevDoc.units[i]!.logicalId,
        status: "unchanged" as const,
        predecessors: [prevDoc.units[i]!.logicalId],
        similarity: 1,
        via: "sequence" as const,
      })),
      deleted: [],
    }
  } else {
    mapping = reconcile(previousUnits.map(snapshotAsUnit), graph.units, {
      salt: `${docId}|${graph.revision}`,
      protectedIds,
      ...(state.assertions.get(docId) ? { assertions: state.assertions.get(docId)! } : {}),
    })
  }
  const units = assignIds(graph.units, mapping)
  const identity: Record<string, number> = {}
  for (const m of mapping.matches) identity[m.status] = (identity[m.status] ?? 0) + 1
  for (const m of mapping.matches) {
    if (m.status !== "ambiguous") continue
    const u = units[m.index]!
    emit({
      type: "conflict.raised",
      id: `amb-${shortHash(`${docId}|${graph.revision}|${u.structuralPath}`).slice(0, 10)}`,
      docId,
      kind: "ambiguous-identity",
      detail: `"${u.plain.slice(0, 80)}" could descend from ${m.predecessors.length} earlier paragraphs (${m.predecessors.join(", ")}). Translated fresh; confirm with \`ambient resolve\`.`,
      logicalId: u.logicalId,
    })
  }

  const locales: LocaleReport[] = []
  const outputs: LocaleOutput[] = []

  for (const locale of opts.locales) {
    const diagnostics: Diagnostic[] = []
    const conflicts: string[] = []
    const review: ReviewItem[] = []
    let humanEditsCaptured = 0
    const suggestions: LocaleReport["suggestions"] = []
    const last = lastPublish(state, docId, locale)
    const target = input.targets.get(locale)
    const targetEdited = target !== undefined && last !== undefined && blobKey(target) !== last.outputHash
    const targetForeign = target !== undefined && last === undefined

    // ── 2. Capture human edits made in the published target ─────────────────
    if (targetEdited) {
      const baseBytes = input.getBlob(last.outputHash)
      if (!baseBytes) {
        diagnostics.push({ code: "BASE_MISSING", severity: "warning", message: `published version of ${locale} is not in the object store; edits cannot be attributed` })
      } else {
        try {
          const baseUnits = adapter.extract(baseBytes, docId).units
          const currentUnits = adapter.extract(target, docId).units
          const fb = detectEdits(last, baseUnits, currentUnits)
          for (const e of fb.edits) {
            emit({ type: "translation.edited", docId, logicalId: e.logicalId, locale, sourceHash: e.sourceHash, content: e.after, basedOn: e.basedOn, via: "target-file" })
            humanEditsCaptured++
            const s = suggestCorrection(locale, e.before, e.after)
            if (s && !state.corrections.has(s.id)) {
              emit({ type: "decision.correction", id: s.id, locale, from: s.from, to: s.to, origin: { docId, logicalId: e.logicalId }, status: "suggested" })
            }
          }
          if (fb.untraced.length || fb.removed.length) {
            const id = `div-${shortHash(`${docId}|${locale}|${blobKey(target)}`).slice(0, 10)}`
            emit({
              type: "conflict.raised",
              id,
              docId,
              locale,
              kind: "target-structure-diverged",
              detail: `${fb.untraced.length} paragraph(s) added and ${fb.removed.length} removed directly in the ${locale} file; they cannot be traced to the source.`,
            })
            conflicts.push(id)
          }
        } catch (e) {
          diagnostics.push({ code: "TARGET_UNREADABLE", severity: "warning", message: `could not read edited ${locale} target: ${(e as Error).message}` })
        }
      }
      refresh()
    }

    // ── 3. Plan ──────────────────────────────────────────────────────────────
    const plans = planLocale({ docId, locale, units, matches: mapping.matches, previousUnits, state, policy: opts.policy })

    // ── 4. Translate only what the plan requires ─────────────────────────────
    const toTranslate = plans.filter((p) => p.action === "translate")
    const neighbours = (i: number): { before?: string; after?: string } => {
      const u = units[i]!
      const prev = units[i - 1]
      const next = units[i + 1]
      return {
        ...(prev && prev.scope === u.scope ? { before: prev.plain } : {}),
        ...(next && next.scope === u.scope ? { after: next.plain } : {}),
      }
    }
    const indexOf = new Map(units.map((u, i) => [u.logicalId, i]))
    const jobs: TranslationJob[] = toTranslate.map((p) => ({
      logicalId: p.unit.logicalId,
      sourceLocale: opts.sourceLocale,
      targetLocale: locale,
      sourceTagged: p.unit.tagged,
      contextRevision: p.context.contextRevision,
      policyRevision: p.context.policyRevision,
      terms: p.context.terms.map((t) => ({ source: t.source, target: t.target, ...(t.note ? { note: t.note } : {}) })),
      rules: p.context.rules.map((r) => r.text),
      prior: p.prior,
      ...neighbours(indexOf.get(p.unit.logicalId)!),
    }))
    const planById = new Map(plans.map((p) => [p.unit.logicalId, p]))
    let translated = 0
    if (jobs.length > 0) {
      let results = await opts.translator.translate(jobs)
      const accept = (rs: typeof results): string[] => {
        const failed: string[] = []
        const got = new Set(rs.map((r) => r.logicalId))
        for (const j of jobs) if (!got.has(j.logicalId)) failed.push(j.logicalId)
        for (const r of rs) {
          const p = planById.get(r.logicalId)!
          const problems = validateTagged(p.unit.tagged, r.tagged, r.logicalId)
          if (problems.length > 0) {
            failed.push(r.logicalId)
            continue
          }
          emit({
            type: "translation.proposed",
            docId,
            logicalId: r.logicalId,
            locale,
            sourceHash: p.unit.contentHash,
            contextRevision: p.context.contextRevision,
            content: r.tagged,
            provenance: r.provenance,
            ...(p.revisesHuman ? { revisesHuman: p.revisesHuman } : {}),
          })
          translated++
        }
        return failed
      }
      let failed = accept(results)
      if (failed.length > 0) {
        // One retry for invalid or missing outputs.
        const retry = jobs.filter((j) => failed.includes(j.logicalId))
        results = await opts.translator.translate(retry)
        failed = accept(results)
        for (const id of failed) {
          diagnostics.push({ code: "TRANSLATION_INVALID", severity: "error", message: `no structurally valid translation after retry; source text left in place`, unitId: id })
        }
      }
      refresh()
    }

    // ── 5. Accepted corrections: deterministic post-edits of agent output ────
    let correctionsApplied = 0
    for (const p of plans) {
      const ctx = unitContext(state, locale, p.unit.plain)
      if (ctx.corrections.length === 0) continue
      const u = state.units.get(unitKey(docId, p.unit.logicalId, locale))
      if (!u) continue
      const eff = effectiveTranslation(state, docId, p.unit.logicalId, locale, p.unit.contentHash, ctx.contextRevision)
      if (!eff || eff.authority !== "agent") continue
      const prop = latestProposal(u, p.unit.contentHash, ctx.contextRevision)!
      const done = new Set(prop.provenance.corrections ?? [])
      let content = prop.content
      const appliedNow: string[] = []
      for (const c of ctx.corrections) {
        if (done.has(c.id) || !containsTerm(plainOf(content), c.from)) continue
        content = mapText(content, (t) => replaceTerm(t, c.from, c.to))
        appliedNow.push(c.id)
      }
      if (appliedNow.length === 0 || content === prop.content) continue
      emit({
        type: "translation.proposed",
        docId,
        logicalId: p.unit.logicalId,
        locale,
        sourceHash: p.unit.contentHash,
        contextRevision: ctx.contextRevision,
        content,
        provenance: { ...prop.provenance, translator: `${prop.provenance.translator}+correction`, corrections: [...done, ...appliedNow] },
        ...(prop.revisesHuman ? { revisesHuman: prop.revisesHuman } : {}),
      })
      correctionsApplied++
    }
    if (correctionsApplied > 0) refresh()

    // ── 6. Patch: previous published state → desired state ───────────────────
    const published = new Map<string, TargetUnitState>()
    for (const pu of last?.units ?? []) {
      published.set(pu.logicalId, {
        content: contentByHash(state, docId, pu.logicalId, locale, pu.contentHash) ?? "",
        contentHash: pu.contentHash,
        authority: pu.authority,
      })
    }
    const desired = new Map<string, { content: string; authority: Authority; plan: UnitPlan }>()
    for (const p of plans) {
      const ctx = unitContext(state, locale, p.unit.plain)
      if (p.action === "hold" && p.effective) {
        desired.set(p.unit.logicalId, { content: p.effective.content, authority: p.effective.authority, plan: p })
        continue
      }
      const eff = effectiveTranslation(state, docId, p.unit.logicalId, locale, p.unit.contentHash, ctx.contextRevision)
      if (eff) desired.set(p.unit.logicalId, { content: eff.content, authority: eff.authority, plan: p })
    }
    const patches: ContentPatch[] = []
    for (const [id, d] of desired) {
      const cur = published.get(id)
      const hash = contentHashOf(d.content)
      if (cur && cur.contentHash === hash && cur.authority === d.authority) continue
      const expected = cur?.contentHash ?? "none"
      patches.push({
        operationId: hashValue([docId, locale, id, expected, hash, d.authority]),
        logicalId: id,
        expectedRevision: expected,
        targetLocale: locale,
        operation: cur ? "replace" : "insert",
        content: d.content,
        authority: d.authority,
        ...(d.plan.revisesHuman || d.plan.reason === "human-source-changed" || d.plan.reason === "ambiguous" ? { revisesHuman: true } : {}),
      })
    }
    for (const id of published.keys()) {
      if (desired.has(id)) continue
      // The unit left the source (or has no valid translation yet). The source owns structure.
      patches.push({
        operationId: hashValue([docId, locale, id, published.get(id)!.contentHash, "delete"]),
        logicalId: id,
        expectedRevision: published.get(id)!.contentHash,
        targetLocale: locale,
        operation: "delete",
        authority: "agent",
        revisesHuman: true,
      })
    }
    const patchResult = applyPatches(published, patches)
    for (const r of patchResult.rejected) {
      diagnostics.push({ code: `PATCH_${r.reason.toUpperCase()}`, severity: "error", message: r.detail, unitId: r.patch.logicalId })
    }

    // ── 7. Render, merge, validate ───────────────────────────────────────────
    const translations = new Map<string, string>()
    const unitById = new Map(units.map((u) => [u.logicalId, u]))
    for (const [id, st] of patchResult.state) {
      const u = unitById.get(id)
      if (u && st.content) translations.set(u.structuralPath, st.content)
    }
    const rendered = adapter.render(input.source, translations, { locale })
    diagnostics.push(...rendered.diagnostics)
    let output = rendered.bytes
    let besideTarget = false
    if (targetForeign) {
      besideTarget = true
      diagnostics.push({ code: "TARGET_NOT_OURS", severity: "warning", message: `a ${locale} file already exists that this workspace never published; wrote the translation beside it instead of overwriting` })
    } else if (targetEdited) {
      const base = input.getBlob(last.outputHash)
      if (base && adapter.merge3) {
        const merged = adapter.merge3(base, target, rendered.bytes)
        output = merged.bytes
        for (const member of merged.conflicts) {
          const id = `mrg-${shortHash(`${docId}|${locale}|${member}|${blobKey(target)}`).slice(0, 10)}`
          emit({ type: "conflict.raised", id, docId, locale, kind: "target-merge", detail: `${member} was changed both in the ${locale} file and by this update; the person's version was kept.` })
          conflicts.push(id)
        }
      } else if (!adapter.merge3) {
        // Text formats: human text edits were captured above and are already in `rendered`.
        // Structural edits we could not trace were flagged; the regenerated file is safe to write
        // only if nothing was untraced.
        if (conflicts.length > 0) besideTarget = true
      } else besideTarget = true
    }
    const validation = adapter.validate(input.source, rendered.bytes)
    diagnostics.push(...validation.diagnostics)
    let layout: LayoutFinding[] = []
    if (adapter.layout) {
      try {
        layout = adapter.layout(input.source, rendered.bytes)
      } catch (e) {
        diagnostics.push({ code: "LAYOUT_UNAVAILABLE", severity: "info", message: (e as Error).message })
      }
    }

    // ── 8. Publish ───────────────────────────────────────────────────────────
    const outputHash = blobKey(output)
    const unchanged = last !== undefined && last.outputHash === outputHash && !targetEdited && target !== undefined
    const write = !unchanged && (target === undefined || blobKey(target) !== outputHash || besideTarget)
    let didPublish = false
    if (!unchanged && !besideTarget) {
      const observed = new Map(adapter.extract(output, docId).units.map((u) => [u.structuralPath, u.contentHash]))
      const pubUnits: PublishedUnit[] = []
      for (const [id, st] of patchResult.state) {
        const u = unitById.get(id)
        if (!u) continue
        pubUnits.push({
          logicalId: id,
          structuralPath: u.structuralPath,
          contentHash: st.contentHash,
          observedHash: observed.get(u.structuralPath) ?? "",
          sourceHash: u.contentHash,
          authority: st.authority,
        })
      }
      const needsNew = !last || last.outputHash !== outputHash || last.sourceRevision !== graph.revision
      if (needsNew || targetEdited) {
        blobs.push(output)
        emit({
          type: "publish.recorded",
          docId,
          locale,
          path: locale,
          outputHash,
          sourceRevision: graph.revision,
          units: pubUnits,
          warnings: diagnostics.filter((d) => d.severity !== "info").length,
        })
        didPublish = true
      }
    } else if (besideTarget) blobs.push(output)
    outputs.push({ locale, bytes: output, write: write || besideTarget, besideTarget })

    // ── 9. Report ────────────────────────────────────────────────────────────
    refresh()
    const byReason: Partial<Record<PlanReason, number>> = {}
    for (const p of plans) byReason[p.reason] = (byReason[p.reason] ?? 0) + 1
    for (const p of plans) {
      if (!p.needsReview) continue
      const d = desired.get(p.unit.logicalId)
      review.push({
        logicalId: p.unit.logicalId,
        structuralPath: p.unit.structuralPath,
        reason:
          p.reason === "human-source-changed"
            ? p.action === "hold"
              ? "source changed under a human translation — human text kept (policy: hold)"
              : "source changed under a human translation — revised from the human text"
            : p.reason === "ambiguous"
              ? "ambiguous identity — translated fresh"
              : p.reason === "split" || p.reason === "merged"
                ? `${p.reason} from human-translated paragraph(s)`
                : p.reason,
        source: p.unit.plain,
        target: d ? plainOf(d.content) : "",
      })
    }
    for (const c of state.corrections.values()) {
      if (c.locale !== locale || c.status !== "suggested") continue
      let other = 0
      for (const p of plans) {
        const d = desired.get(p.unit.logicalId)
        if (d && d.authority === "agent" && containsTerm(plainOf(d.content), c.from)) other++
      }
      suggestions.push({ id: c.id, from: c.from, to: c.to, otherUnits: other })
    }
    for (const c of state.conflicts.values()) if (!c.resolved && c.docId === docId && (c.locale === locale || !c.locale) && !conflicts.includes(c.id)) conflicts.push(c.id)
    locales.push({
      locale,
      total: plans.length,
      reused: plans.filter((p) => p.action === "keep" || p.action === "hold").length,
      translated,
      byReason,
      humanEditsCaptured,
      suggestions,
      correctionsApplied,
      review,
      conflicts,
      diagnostics,
      layout,
      published: didPublish,
      besideTarget,
      patch: { applied: patchResult.applied.length, skipped: patchResult.skipped.length, rejected: patchResult.rejected.length },
    })
  }

  // Record the observation last, so planning above compared against the previous revision.
  if (sourceChanged) {
    emit({
      type: "source.observed",
      docId,
      format: graph.format,
      revision: graph.revision,
      units: units.map((u, i) => snapshot(u, mapping.matches[i]!.status, mapping.matches[i]!.predecessors)),
      deleted: mapping.deleted,
    })
  }
  return {
    facts,
    outputs,
    blobs,
    report: { docId, format: graph.format, revision: graph.revision, sourceChanged, identity, deleted: mapping.deleted.length, diagnostics: graph.diagnostics, locales },
  }
}
