/**
 * Durable facts and decisions (spec §3 "minimal durable state").
 *
 * The ledger is an append-only set of sealed facts. State is a pure fold over
 * that set. Because the fold first de-duplicates by `opId` and then orders by
 * (hybrid logical clock, opId), any two replicas holding the same set of facts —
 * received in any order, with any duplicates — derive identical state. That is
 * the CRDT-style convergence guarantee; semantic conflicts (two humans editing
 * the same translation concurrently) are *detected* by the fold and surfaced,
 * never silently resolved.
 */
import { sha256, stableStringify } from "./hash.ts"
import type { Authority } from "./types.ts"

// ── Facts ───────────────────────────────────────────────────────────────────

export interface UnitSnapshot {
  readonly logicalId: string
  readonly scope: string
  readonly structuralPath: string
  readonly ordinal: number
  readonly kind: string
  readonly contentHash: string
  readonly tagged: string
  readonly plain: string
  readonly status: string
  readonly predecessors: readonly string[]
  readonly nativeAnchor?: string
  readonly meta?: Readonly<Record<string, string | number>>
}

export interface Provenance {
  readonly translator: string
  readonly model?: string
  readonly promptHash?: string
  readonly durationMs?: number
  /** Correction decisions applied as deterministic post-edits, in order. */
  readonly corrections?: readonly string[]
}

export type Fact =
  | {
      readonly type: "source.observed"
      readonly docId: string
      readonly format: string
      readonly revision: string
      readonly units: readonly UnitSnapshot[]
      readonly deleted: readonly string[]
    }
  | {
      readonly type: "translation.proposed"
      readonly docId: string
      readonly logicalId: string
      readonly locale: string
      readonly sourceHash: string
      readonly contextRevision: string
      readonly content: string
      readonly provenance: Provenance
      /** Set when this proposal revises an earlier human translation after a source change. */
      readonly revisesHuman?: string
    }
  | {
      readonly type: "translation.edited"
      readonly docId: string
      readonly logicalId: string
      readonly locale: string
      readonly sourceHash: string
      readonly content: string
      /** contentHash of the translation the editor was looking at — causal parent. */
      readonly basedOn: string
      readonly via: "target-file" | "cli" | "ui" | "agent-tool"
    }
  | {
      readonly type: "translation.approved"
      readonly docId: string
      readonly logicalId: string
      readonly locale: string
      readonly sourceHash: string
      readonly content: string
      readonly basedOn: string
    }
  | {
      readonly type: "decision.term"
      readonly id: string
      readonly locale: string
      readonly source: string
      readonly target: string
      readonly note?: string
      readonly status: "active" | "retired"
    }
  | {
      readonly type: "decision.rule"
      readonly id: string
      readonly locale: string
      readonly text: string
      readonly retroactive: boolean
      readonly status: "active" | "retired"
    }
  | {
      readonly type: "decision.correction"
      readonly id: string
      readonly locale: string
      readonly from: string
      readonly to: string
      readonly origin?: { readonly docId: string; readonly logicalId: string }
      readonly status: "suggested" | "accepted" | "rejected"
    }
  | {
      readonly type: "identity.asserted"
      readonly docId: string
      readonly structuralPath: string
      readonly logicalId: string
    }
  | {
      readonly type: "publish.recorded"
      readonly docId: string
      readonly locale: string
      readonly path: string
      readonly outputHash: string
      readonly sourceRevision: string
      readonly units: readonly PublishedUnit[]
      readonly warnings: number
      readonly rollbackOf?: string
    }
  | {
      readonly type: "conflict.raised"
      readonly id: string
      readonly docId: string
      readonly kind: string
      readonly detail: string
      readonly logicalId?: string
      readonly locale?: string
    }
  | { readonly type: "conflict.resolved"; readonly id: string; readonly resolution: string }

export interface PublishedUnit {
  readonly logicalId: string
  readonly structuralPath: string
  /** Hash of the translation we intended to publish (ledger content). */
  readonly contentHash: string
  /** Hash of the unit as re-extracted from the published file (what a later edit is compared against). */
  readonly observedHash: string
  readonly sourceHash: string
  readonly authority: Authority
}

export interface Envelope {
  readonly opId: string
  readonly hlc: string
  readonly actor: string
  readonly fact: Fact
}

// ── Hybrid logical clock ────────────────────────────────────────────────────

/** HLC strings sort lexicographically in causal-then-wallclock order. */
export class Clock {
  private wall = 0
  private counter = 0
  constructor(
    private readonly node: string,
    private readonly now: () => number = Date.now,
  ) {}
  tick(): string {
    const t = this.now()
    if (t > this.wall) {
      this.wall = t
      this.counter = 0
    } else this.counter++
    return formatHlc(this.wall, this.counter, this.node)
  }
  /** Advance past a remote timestamp so later local events sort after it. */
  observe(hlc: string): void {
    const [w, c] = parseHlc(hlc)
    if (w > this.wall || (w === this.wall && c > this.counter)) {
      this.wall = w
      this.counter = c
    }
  }
}

export const formatHlc = (wall: number, counter: number, node: string): string =>
  `${String(wall).padStart(15, "0")}.${String(counter).padStart(6, "0")}.${node}`

const parseHlc = (hlc: string): [number, number] => {
  const [w, c] = hlc.split(".")
  return [Number(w), Number(c)]
}

export const seal = (fact: Fact, actor: string, hlc: string): Envelope => ({
  opId: sha256(stableStringify({ actor, fact, hlc })).slice(0, 32),
  hlc,
  actor,
  fact,
})

export const compareEnvelopes = (a: Envelope, b: Envelope): number =>
  a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0

/** Union of fact sets, de-duplicated and canonically ordered. */
export const canonical = (envelopes: Iterable<Envelope>): Envelope[] => {
  const byId = new Map<string, Envelope>()
  for (const e of envelopes) if (!byId.has(e.opId)) byId.set(e.opId, e)
  return [...byId.values()].sort(compareEnvelopes)
}

// ── State ───────────────────────────────────────────────────────────────────

export interface DocState {
  readonly docId: string
  readonly format: string
  readonly revision: string
  readonly units: readonly UnitSnapshot[]
  readonly revisions: readonly { readonly revision: string; readonly hlc: string; readonly opId: string }[]
  /** logicalId → predecessor ids across all observations (lineage). */
  readonly lineage: ReadonlyMap<string, readonly string[]>
  readonly deleted: ReadonlySet<string>
}

export interface Proposal {
  readonly opId: string
  readonly hlc: string
  readonly sourceHash: string
  readonly contextRevision: string
  readonly content: string
  readonly contentHash: string
  readonly provenance: Provenance
  readonly revisesHuman?: string
}

export interface HumanVersion {
  readonly opId: string
  readonly hlc: string
  readonly actor: string
  readonly sourceHash: string
  readonly content: string
  readonly contentHash: string
  readonly basedOn: string
  readonly approved: boolean
  readonly via: string
}

export interface UnitLocaleState {
  readonly proposals: Proposal[]
  readonly human: HumanVersion[]
}

export interface Term {
  readonly id: string
  readonly locale: string
  readonly source: string
  readonly target: string
  readonly note?: string
  readonly status: "active" | "retired"
  readonly hlc: string
}
export interface Rule {
  readonly id: string
  readonly locale: string
  readonly text: string
  readonly retroactive: boolean
  readonly status: "active" | "retired"
  readonly hlc: string
}
export interface Correction {
  readonly id: string
  readonly locale: string
  readonly from: string
  readonly to: string
  readonly origin?: { readonly docId: string; readonly logicalId: string }
  readonly status: "suggested" | "accepted" | "rejected"
  readonly hlc: string
}

export interface PublishRecord {
  readonly opId: string
  readonly hlc: string
  readonly actor: string
  readonly docId: string
  readonly locale: string
  readonly path: string
  readonly outputHash: string
  readonly sourceRevision: string
  readonly units: readonly PublishedUnit[]
  readonly warnings: number
  readonly rollbackOf?: string
}

export interface Conflict {
  readonly id: string
  readonly docId: string
  readonly kind: string
  readonly detail: string
  readonly logicalId?: string
  readonly locale?: string
  readonly hlc: string
  readonly resolved?: string
}

export interface LedgerState {
  readonly docs: Map<string, DocState>
  readonly units: Map<string, UnitLocaleState>
  readonly terms: Map<string, Term>
  readonly rules: Map<string, Rule>
  readonly corrections: Map<string, Correction>
  readonly publishes: Map<string, PublishRecord[]>
  readonly conflicts: Map<string, Conflict>
  readonly assertions: Map<string, Map<string, string>>
  /** Facts folded (after de-duplication). */
  readonly size: number
}

export const unitKey = (docId: string, logicalId: string, locale: string): string => `${docId}\u0000${logicalId}\u0000${locale}`
export const publishKey = (docId: string, locale: string): string => `${docId}\u0000${locale}`

export const contentHashOf = (content: string): string => sha256(content).slice(0, 16)

export const emptyState = (): LedgerState => ({
  docs: new Map(),
  units: new Map(),
  terms: new Map(),
  rules: new Map(),
  corrections: new Map(),
  publishes: new Map(),
  conflicts: new Map(),
  assertions: new Map(),
  size: 0,
})

const unitState = (s: LedgerState, key: string): UnitLocaleState => {
  let u = s.units.get(key)
  if (!u) {
    u = { proposals: [], human: [] }
    s.units.set(key, u)
  }
  return u
}

/** Pure fold. Input order and duplicates do not matter. */
export const fold = (envelopes: Iterable<Envelope>): LedgerState => {
  const ordered = canonical(envelopes)
  const s = emptyState()
  for (const e of ordered) apply(s, e)
  return { ...s, size: ordered.length }
}

const apply = (s: LedgerState, e: Envelope): void => {
  const f = e.fact
  switch (f.type) {
    case "source.observed": {
      const prev = s.docs.get(f.docId)
      const lineage = new Map(prev?.lineage ?? [])
      for (const u of f.units) if (u.predecessors.length > 0 && u.predecessors[0] !== u.logicalId) lineage.set(u.logicalId, u.predecessors)
      const deleted = new Set(prev?.deleted ?? [])
      for (const d of f.deleted) deleted.add(d)
      for (const u of f.units) deleted.delete(u.logicalId)
      s.docs.set(f.docId, {
        docId: f.docId,
        format: f.format,
        revision: f.revision,
        units: f.units,
        revisions: [...(prev?.revisions ?? []), { revision: f.revision, hlc: e.hlc, opId: e.opId }],
        lineage,
        deleted,
      })
      return
    }
    case "translation.proposed": {
      const u = unitState(s, unitKey(f.docId, f.logicalId, f.locale))
      u.proposals.push({
        opId: e.opId,
        hlc: e.hlc,
        sourceHash: f.sourceHash,
        contextRevision: f.contextRevision,
        content: f.content,
        contentHash: contentHashOf(f.content),
        provenance: f.provenance,
        ...(f.revisesHuman ? { revisesHuman: f.revisesHuman } : {}),
      })
      return
    }
    case "translation.edited":
    case "translation.approved": {
      const u = unitState(s, unitKey(f.docId, f.logicalId, f.locale))
      u.human.push({
        opId: e.opId,
        hlc: e.hlc,
        actor: e.actor,
        sourceHash: f.sourceHash,
        content: f.content,
        contentHash: contentHashOf(f.content),
        basedOn: f.basedOn,
        approved: f.type === "translation.approved",
        via: f.type === "translation.edited" ? f.via : "approval",
      })
      return
    }
    case "decision.term":
      s.terms.set(f.id, { id: f.id, locale: f.locale, source: f.source, target: f.target, status: f.status, hlc: e.hlc, ...(f.note ? { note: f.note } : {}) })
      return
    case "decision.rule":
      s.rules.set(f.id, { id: f.id, locale: f.locale, text: f.text, retroactive: f.retroactive, status: f.status, hlc: e.hlc })
      return
    case "decision.correction":
      s.corrections.set(f.id, { id: f.id, locale: f.locale, from: f.from, to: f.to, status: f.status, hlc: e.hlc, ...(f.origin ? { origin: f.origin } : {}) })
      return
    case "identity.asserted": {
      let m = s.assertions.get(f.docId)
      if (!m) {
        m = new Map()
        s.assertions.set(f.docId, m)
      }
      m.set(f.structuralPath, f.logicalId)
      return
    }
    case "publish.recorded": {
      const key = publishKey(f.docId, f.locale)
      const list = s.publishes.get(key) ?? []
      list.push({
        opId: e.opId,
        hlc: e.hlc,
        actor: e.actor,
        docId: f.docId,
        locale: f.locale,
        path: f.path,
        outputHash: f.outputHash,
        sourceRevision: f.sourceRevision,
        units: f.units,
        warnings: f.warnings,
        ...(f.rollbackOf ? { rollbackOf: f.rollbackOf } : {}),
      })
      s.publishes.set(key, list)
      return
    }
    case "conflict.raised":
      if (!s.conflicts.has(f.id)) {
        s.conflicts.set(f.id, {
          id: f.id,
          docId: f.docId,
          kind: f.kind,
          detail: f.detail,
          hlc: e.hlc,
          ...(f.logicalId ? { logicalId: f.logicalId } : {}),
          ...(f.locale ? { locale: f.locale } : {}),
        })
      }
      return
    case "conflict.resolved": {
      const c = s.conflicts.get(f.id)
      if (c) s.conflicts.set(f.id, { ...c, resolved: f.resolution })
      return
    }
  }
}

// ── Queries ─────────────────────────────────────────────────────────────────

export interface Effective {
  readonly content: string
  readonly contentHash: string
  readonly authority: Authority
  readonly origin: "human" | "approved" | "proposal"
  readonly opId: string
}

/**
 * The translation that should be published for a unit, given the current
 * source hash and context revision. Human authority always beats agent output
 * for the same source; agent output is only reused if it was produced under
 * the same source *and* the same context revision.
 */
export const effectiveTranslation = (
  s: LedgerState,
  docId: string,
  logicalId: string,
  locale: string,
  sourceHash: string,
  contextRevision: string,
): Effective | undefined => {
  const u = s.units.get(unitKey(docId, logicalId, locale))
  if (!u) return undefined
  const human = latestHuman(u)
  if (human && human.sourceHash === sourceHash) {
    return {
      content: human.content,
      contentHash: human.contentHash,
      authority: human.approved ? "approved" : "human",
      origin: human.approved ? "approved" : "human",
      opId: human.opId,
    }
  }
  const proposal = latestProposal(u, sourceHash, contextRevision)
  if (proposal) return { content: proposal.content, contentHash: proposal.contentHash, authority: "agent", origin: "proposal", opId: proposal.opId }
  return undefined
}

export const latestHuman = (u: UnitLocaleState): HumanVersion | undefined => u.human.at(-1)

export const latestProposal = (u: UnitLocaleState, sourceHash: string, contextRevision?: string): Proposal | undefined => {
  for (let i = u.proposals.length - 1; i >= 0; i--) {
    const p = u.proposals[i]!
    if (p.sourceHash === sourceHash && (contextRevision === undefined || p.contextRevision === contextRevision)) return p
  }
  return undefined
}

export interface HumanConflict {
  readonly docId: string
  readonly logicalId: string
  readonly locale: string
  readonly basedOn: string
  readonly versions: readonly HumanVersion[]
}

/**
 * Concurrent human edits: two or more edits of the same unit that were based
 * on the same parent content but disagree. The fold picks a deterministic
 * winner (latest HLC) so replicas converge, but the disagreement is reported
 * so a person decides — CRDT convergence is not semantic agreement.
 */
export const humanConflicts = (s: LedgerState): HumanConflict[] => {
  const out: HumanConflict[] = []
  for (const [key, u] of s.units) {
    const [docId, logicalId, locale] = key.split("\u0000") as [string, string, string]
    const byParent = new Map<string, HumanVersion[]>()
    for (const h of u.human) {
      if (h.approved) continue
      const list = byParent.get(h.basedOn) ?? []
      list.push(h)
      byParent.set(h.basedOn, list)
    }
    for (const [basedOn, versions] of byParent) {
      const distinct = new Set(versions.map((v) => v.contentHash))
      if (distinct.size < 2) continue
      // A later edit that builds on one of the siblings resolves the fork.
      const tips = new Set(versions.map((v) => v.contentHash))
      const resolved = u.human.some((h) => tips.has(h.basedOn) && compareHlc(h.hlc, versions.at(-1)!.hlc) > 0)
      if (!resolved) out.push({ docId, logicalId, locale, basedOn, versions })
    }
  }
  return out
}

const compareHlc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Find translation content recorded in the ledger by its hash (for rebuilding published state). */
export const contentByHash = (s: LedgerState, docId: string, logicalId: string, locale: string, hash: string): string | undefined => {
  const u = s.units.get(unitKey(docId, logicalId, locale))
  if (!u) return undefined
  for (const h of u.human) if (h.contentHash === hash) return h.content
  for (const p of u.proposals) if (p.contentHash === hash) return p.content
  return undefined
}

export const lastPublish = (s: LedgerState, docId: string, locale: string): PublishRecord | undefined =>
  s.publishes.get(publishKey(docId, locale))?.at(-1)

export const openConflicts = (s: LedgerState, docId?: string): Conflict[] =>
  [...s.conflicts.values()].filter((c) => !c.resolved && (docId === undefined || c.docId === docId))

export const activeTerms = (s: LedgerState, locale: string): Term[] =>
  [...s.terms.values()].filter((t) => t.status === "active" && (t.locale === locale || t.locale === "*"))

export const activeRules = (s: LedgerState, locale: string): Rule[] =>
  [...s.rules.values()].filter((r) => r.status === "active" && (r.locale === locale || r.locale === "*"))

export const acceptedCorrections = (s: LedgerState, locale: string): Correction[] =>
  [...s.corrections.values()].filter((c) => c.status === "accepted" && c.locale === locale)
