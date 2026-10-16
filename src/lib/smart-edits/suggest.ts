// Smart edits — tier 0: algorithmic suggestions from the project's edit memory.
//
// Pure and synchronous. The caller (auth-worker route or the replay eval) does
// the I/O in two phases around it:
//
//   1. findCandidates(cells, observations)   — which phrases in these cells have
//      been edited elsewhere in the project, and to what;
//   2. caller counts KEEPS for each (old phrase, source anchors): human-settled
//      cells that still contain the phrase — the counter-evidence that stops a
//      one-off edit lighting up every occurrence;
//   3. scoreCandidates(...) — confidence + tier per replacement.
//
// Context decides everything. An observation supports a suggestion strongly
// only when its neighbouring words match (2-token or 1-token context) or the
// source text shares the observation group's anchor tokens — the source words
// present every time that edit was made. That is what keeps "Lord → Yahweh"
// to cells whose source has the divine name rather than every "Lord".

import { isPunct, phraseKey, tokenize } from "./tokens"
import { MAX_OLD_TOKENS } from "./extract"

export interface Observation {
  id: string
  cellKey: string
  afterId: string
  ts: number
  beforeOrigin: "human" | "ai" | "machine"
  bulkKey: string | null
  old: string
  oldNorm: string
  new: string
  newNorm: string
  left: string[]
  right: string[]
  /** Unique normalized source tokens of the cell when the edit was made. */
  sourceNorms: string[]
  /** Clipped texts — evidence a person or Jev can read. */
  sourceText: string
  beforeText: string
  afterText: string
}

export interface CellInput {
  id: string
  source: string
  target: string
}

export type MatchLevel = "context2" | "context1" | "anchor" | "phrase"

export interface Replacement {
  new: string
  newNorm: string
  /** Source tokens present in every observation of this edit (≥2 obs only). */
  anchors: string[]
  support: { strong: number; weak: number }
  examples: Observation[]
  /** Observations backing this replacement, for survival checks. */
  observationIds: string[]
}

export interface Candidate {
  cellId: string
  start: number
  end: number
  /** Text as it appears in the cell now. */
  old: string
  oldNorm: string
  replacements: Replacement[]
}

const MAX_EXAMPLES = 3
const MAX_ANCHORS = 3

function sameTail(a: readonly string[], b: readonly string[], n: number): boolean {
  if (a.length < n || b.length < n) return a.length === b.length && a.every((x, i) => x === b[i])
  for (let i = 1; i <= n; i++) if (a[a.length - i] !== b[b.length - i]) return false
  return true
}

function sameHead(a: readonly string[], b: readonly string[], n: number): boolean {
  if (a.length < n || b.length < n) return a.length === b.length && a.every((x, i) => x === b[i])
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false
  return true
}

/** Source tokens shared by every observation of one (old → new) edit. Longest
 *  first as a cheap rarity proxy: short tokens are mostly function words. */
export function anchorsOf(obs: readonly Observation[]): string[] {
  if (obs.length < 2) return []
  let shared = new Set(obs[0].sourceNorms.filter((t) => !isPunct(t)))
  for (const o of obs.slice(1)) {
    const s = new Set(o.sourceNorms)
    shared = new Set([...shared].filter((t) => s.has(t)))
    if (shared.size === 0) return []
  }
  return [...shared].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, MAX_ANCHORS)
}

function matchLevel(o: Observation, left: string[], right: string[], anchors: string[], source: Set<string>): MatchLevel {
  if (sameTail(o.left, left, 2) && sameHead(o.right, right, 2)) return "context2"
  if (sameTail(o.left, left, 1) && sameHead(o.right, right, 1)) return "context1"
  if (anchors.length > 0 && anchors.every((t) => source.has(t))) return "anchor"
  return "phrase"
}

/** Distinct-cell count, with every cell touched by one bulk replace counted once. */
function distinctSupport(obs: readonly Observation[]): number {
  const keys = new Set(obs.map((o) => o.bulkKey ?? o.cellKey))
  return keys.size
}

export function findCandidates(cells: readonly CellInput[], observations: readonly Observation[]): Candidate[] {
  const byOld = new Map<string, Observation[]>()
  for (const o of observations) {
    if (!o.oldNorm) continue // pure insertions are recorded but not suggested (v1)
    const list = byOld.get(o.oldNorm)
    if (list) list.push(o)
    else byOld.set(o.oldNorm, [o])
  }
  // Anchors per (old → new) group, computed once.
  const anchorCache = new Map<string, string[]>()
  const groupAnchors = (oldNorm: string, newNorm: string, group: Observation[]): string[] => {
    const key = `${oldNorm}\u0000${newNorm}`
    let a = anchorCache.get(key)
    if (!a) {
      a = anchorsOf(group)
      anchorCache.set(key, a)
    }
    return a
  }

  const out: Candidate[] = []
  for (const cell of cells) {
    const toks = tokenize(cell.target)
    const norms = toks.map((t) => t.norm)
    const source = new Set(tokenize(cell.source).map((t) => t.norm))
    for (let i = 0; i < toks.length; i++) {
      for (let len = 1; len <= MAX_OLD_TOKENS && i + len <= toks.length; len++) {
        const key = phraseKey(norms.slice(i, i + len))
        const obs = byOld.get(key)
        if (!obs) continue
        const left = norms.slice(Math.max(0, i - 2), i)
        const right = norms.slice(i + len, i + len + 2)
        const byNew = new Map<string, Observation[]>()
        for (const o of obs) {
          if (o.cellKey === cell.id) continue // never learn a cell's own edit back onto it
          const g = byNew.get(o.newNorm)
          if (g) g.push(o)
          else byNew.set(o.newNorm, [o])
        }
        const replacements: Replacement[] = []
        for (const [newNorm, group] of byNew) {
          if (newNorm === key) continue
          const anchors = groupAnchors(key, newNorm, group)
          const strong: Observation[] = []
          const weak: Observation[] = []
          for (const o of group) {
            const level = matchLevel(o, left, right, anchors, source)
            ;(level === "phrase" ? weak : strong).push(o)
          }
          const ranked = [...strong, ...weak].sort((x, y) => y.ts - x.ts)
          replacements.push({
            new: mostCommonSurface(group),
            newNorm,
            anchors,
            support: { strong: distinctSupport(strong), weak: distinctSupport(weak) },
            examples: ranked.slice(0, MAX_EXAMPLES),
            observationIds: group.map((o) => o.id),
          })
        }
        if (replacements.length === 0) continue
        out.push({
          cellId: cell.id,
          start: toks[i].start,
          end: toks[i + len - 1].end,
          old: cell.target.slice(toks[i].start, toks[i + len - 1].end),
          oldNorm: key,
          replacements,
        })
      }
    }
  }
  return out
}

function mostCommonSurface(group: readonly Observation[]): string {
  const counts = new Map<string, number>()
  for (const o of group) counts.set(o.new, (counts.get(o.new) ?? 0) + 1)
  let best = group[0].new
  let n = 0
  for (const [s, c] of counts) if (c > n) [best, n] = [s, c]
  return best
}

/** Carry the occurrence's capitalisation onto the replacement's first letter. */
export function matchCase(occurrence: string, replacement: string): string {
  const o = occurrence.charAt(0)
  const r = replacement.charAt(0)
  if (!o || !r) return replacement
  const oUpper = o !== o.toLowerCase() && o === o.toUpperCase()
  const rLower = r !== r.toUpperCase() && r === r.toLowerCase()
  return oUpper && rLower ? r.toUpperCase() + replacement.slice(1) : replacement
}

// ── scoring ──────────────────────────────────────────────────────────────────

export type Tier = "show" | "verify" | "drop"

export interface Thresholds {
  /** Minimum strong support (distinct cells) to show without verification. */
  showMinStrong: number
  showMinConfidence: number
  verifyMinConfidence: number
  /** Weight of a context-free, anchor-free observation relative to a strong one. */
  weakWeight: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  showMinStrong: 2,
  showMinConfidence: 0.5,
  verifyMinConfidence: 0.15,
  weakWeight: 0.25,
}

export interface ScoreInputs {
  /** keepKey(oldNorm, anchors) → human-settled cells that still contain the phrase. */
  keeps: ReadonlyMap<string, number>
  /** Observation ids whose edit no longer survives in its cell (reverted). */
  reverted: ReadonlySet<string>
  /** dismissKey(oldNorm, newNorm) → dismissals. */
  dismissals: ReadonlyMap<string, number>
}

export function keepKey(oldNorm: string, anchors: readonly string[]): string {
  return `${oldNorm}\u0000${[...anchors].sort().join(" ")}`
}

export function dismissKey(oldNorm: string, newNorm: string): string {
  return `${oldNorm}\u0000${newNorm}`
}

export interface ScoredSuggestion {
  cellId: string
  start: number
  end: number
  old: string
  oldNorm: string
  new: string
  newNorm: string
  confidence: number
  tier: Tier
  support: { strong: number; weak: number; keeps: number; reverted: number; conflicts: number; dismissed: number }
  examples: Observation[]
  /** Runners-up for the same span — what Jev chooses between. */
  alternatives: { new: string; newNorm: string; confidence: number }[]
}

export function scoreCandidates(
  candidates: readonly Candidate[],
  inputs: ScoreInputs,
  t: Thresholds = DEFAULT_THRESHOLDS,
): ScoredSuggestion[] {
  const out: ScoredSuggestion[] = []
  for (const c of candidates) {
    const scored = c.replacements.map((r) => {
      const revertedCount = r.observationIds.filter((id) => inputs.reverted.has(id)).length
      // Reverted observations stop counting as support and count against it.
      const liveShare = r.observationIds.length === 0 ? 1 : 1 - revertedCount / r.observationIds.length
      const strong = r.support.strong * liveShare
      const weak = r.support.weak * liveShare
      return { r, strong, weak, revertedCount }
    })
    const totalStrong = scored.reduce((s, x) => s + x.strong, 0)
    const ranked = scored
      .map((x) => {
        const keeps = inputs.keeps.get(keepKey(c.oldNorm, x.r.anchors)) ?? 0
        const dismissed = inputs.dismissals.get(dismissKey(c.oldNorm, x.r.newNorm)) ?? 0
        const conflicts = totalStrong - x.strong
        const eff = x.strong + t.weakWeight * x.weak
        const confidence = eff / (eff + keeps + conflicts + x.revertedCount + 2 * dismissed + 1)
        return { ...x, keeps, dismissed, conflicts, confidence }
      })
      .sort((a, b) => b.confidence - a.confidence)
    const best = ranked[0]
    const tier: Tier =
      best.strong >= t.showMinStrong && best.confidence >= t.showMinConfidence
        ? "show"
        : best.confidence >= t.verifyMinConfidence
          ? "verify"
          : "drop"
    out.push({
      cellId: c.cellId,
      start: c.start,
      end: c.end,
      old: c.old,
      oldNorm: c.oldNorm,
      new: matchCase(c.old, best.r.new),
      newNorm: best.r.newNorm,
      confidence: best.confidence,
      tier,
      support: {
        strong: best.r.support.strong,
        weak: best.r.support.weak,
        keeps: best.keeps,
        reverted: best.revertedCount,
        conflicts: best.conflicts,
        dismissed: best.dismissed,
      },
      examples: best.r.examples,
      alternatives: ranked.slice(1, 4).map((x) => ({ new: matchCase(c.old, x.r.new), newNorm: x.r.newNorm, confidence: x.confidence })),
    })
  }
  return out
}

/**
 * At most `perCell` non-overlapping suggestions per cell, best first. Dense
 * underlining is the main way suggestion UIs fail (Gmail, Grammarly), so the
 * cap lives in the shared lib, not in one caller.
 */
export function selectForDisplay(suggestions: readonly ScoredSuggestion[], perCell = 2): ScoredSuggestion[] {
  const byCell = new Map<string, ScoredSuggestion[]>()
  for (const s of suggestions) {
    if (s.tier === "drop") continue
    const list = byCell.get(s.cellId)
    if (list) list.push(s)
    else byCell.set(s.cellId, [s])
  }
  const out: ScoredSuggestion[] = []
  for (const list of byCell.values()) {
    list.sort((a, b) => (a.tier === b.tier ? b.confidence - a.confidence : a.tier === "show" ? -1 : 1))
    const kept: ScoredSuggestion[] = []
    for (const s of list) {
      if (kept.length >= perCell) break
      if (kept.some((k) => s.start < k.end && k.start < s.end)) continue
      kept.push(s)
    }
    out.push(...kept)
  }
  return out
}
