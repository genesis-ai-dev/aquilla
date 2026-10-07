import type { RuleWaiver, RuleInfraction, InfractionSpan } from "@/lib/parsers/types"
import { matchHash } from "./match-hash"

// AQU-1740: a waiver dismisses either a whole rule on a cell (`matchHash`
// absent — the shape every waiver had before this ticket, and the shape every
// already-stored row still has) or ONE finding of that rule (`matchHash`
// present). The two coexist on purpose: a rule-wide waiver is still the right
// gesture for "this check does not apply to this verse at all", while the
// per-finding form is what keeps a *second*, later repeated word visible after
// the first one was accepted.

/** The finding identity of a span, or `null` when it has no concrete match
 *  text (absence rules report a cell-level problem with nothing to point at —
 *  those can only ever be waived rule-wide). */
export function spanMatchHash(span: InfractionSpan): string | null {
  const h = matchHash(span.matchedText)
  return h === "" ? null : h
}

/**
 * Key identifying one waiver target on a cell: the bare `ruleId` for a
 * rule-wide waiver, `ruleId` narrowed by the finding hash otherwise. `\u0001`
 * cannot occur in either part, so the two namespaces never collide.
 */
export function waiverKey(ruleId: string, matchHash?: string | null): string {
  return matchHash ? `${ruleId}\u0001${matchHash}` : ruleId
}

/** Every waiver key active on a cell — rule-wide ids and per-finding keys alike. */
export function waivedKeys(waivers: RuleWaiver[] | undefined): Set<string> {
  const keys = new Set<string>()
  if (!waivers) return keys
  for (const w of waivers) keys.add(waiverKey(w.ruleId, w.matchHash))
  return keys
}

/**
 * True when this span is suppressed — either because the whole rule is waived
 * on the cell, or because this exact finding is. Takes a prebuilt key set so
 * the hot render paths (blot decorations, range highlights) build it once.
 */
export function isSpanWaived(
  keys: Set<string>,
  ruleId: string,
  span: InfractionSpan,
): boolean {
  if (keys.has(ruleId)) return true
  const h = spanMatchHash(span)
  return h !== null && keys.has(waiverKey(ruleId, h))
}

/** True when the whole rule is waived on this cell. A per-finding waiver does
 *  NOT satisfy this — that is the point of the ticket. */
export function isWaived(waivers: RuleWaiver[] | undefined, ruleId: string): boolean {
  if (!waivers) return false
  for (const w of waivers) if (w.ruleId === ruleId && !w.matchHash) return true
  return false
}

/** The finding hashes waived for one rule on this cell. */
export function waivedMatchHashes(
  waivers: RuleWaiver[] | undefined,
  ruleId: string,
): Set<string> {
  const out = new Set<string>()
  if (!waivers) return out
  for (const w of waivers) if (w.ruleId === ruleId && w.matchHash) out.add(w.matchHash)
  return out
}

export interface WaiverInput {
  ruleId: string
  /** Omit for a rule-wide waiver; pass `spanMatchHash(span)` to waive one finding. */
  matchHash?: string
  reason?: string
}

export function addWaiver(
  waivers: RuleWaiver[],
  input: WaiverInput,
  waivedBy: string | undefined,
  waivedAt: string = new Date().toISOString(),
): RuleWaiver[] {
  const key = waiverKey(input.ruleId, input.matchHash)
  const filtered = waivers.filter((w) => waiverKey(w.ruleId, w.matchHash) !== key)
  const next: RuleWaiver = { ruleId: input.ruleId, waivedAt }
  if (input.matchHash) next.matchHash = input.matchHash
  if (input.reason) next.reason = input.reason
  if (waivedBy) next.waivedBy = waivedBy
  filtered.push(next)
  return filtered
}

/**
 * Remove exactly the waiver with this key. Omitting `matchHash` removes the
 * rule-wide waiver and leaves per-finding ones standing — un-waiving is always
 * driven from a listed waiver, so the caller always knows which one it means,
 * and a key-exact delete is what the `cell.unwaive` projection does too.
 */
export function removeWaiver(
  waivers: RuleWaiver[],
  ruleId: string,
  matchHash?: string,
): RuleWaiver[] {
  const key = waiverKey(ruleId, matchHash)
  const next = waivers.filter((w) => waiverKey(w.ruleId, w.matchHash) !== key)
  return next.length === waivers.length ? waivers : next
}

/**
 * Split a cell's infractions into the ones still counting against it and the
 * ones that have been accepted.
 *
 * An infraction carries every match of one rule on one cell, so a partly-waived
 * rule splits: the remaining spans come back as an active infraction and the
 * accepted ones as a waived infraction with the same `ruleId`. That is what
 * makes "waive this repeated word" leave a second repeated word visible.
 * `reasonParams` are re-derived for the checks whose message names its spans
 * (see `deriveReasonParams`) so the split halves don't each claim all of them.
 */
export function partitionInfractions(
  infractions: RuleInfraction[],
  waivers: RuleWaiver[] | undefined,
): { active: RuleInfraction[]; waived: RuleInfraction[] } {
  if (!waivers || waivers.length === 0) return { active: infractions, waived: [] }
  const active: RuleInfraction[] = []
  const waived: RuleInfraction[] = []
  for (const inf of infractions) {
    if (isWaived(waivers, inf.ruleId)) {
      waived.push(inf)
      continue
    }
    const hashes = waivedMatchHashes(waivers, inf.ruleId)
    if (hashes.size === 0) {
      active.push(inf)
      continue
    }
    const activeSpans: InfractionSpan[] = []
    const waivedSpans: InfractionSpan[] = []
    for (const span of inf.spans) {
      const h = spanMatchHash(span)
      if (h !== null && hashes.has(h)) waivedSpans.push(span)
      else activeSpans.push(span)
    }
    if (waivedSpans.length === 0) {
      active.push(inf)
      continue
    }
    if (activeSpans.length > 0) active.push(withSpans(inf, activeSpans))
    waived.push(withSpans(inf, waivedSpans))
  }
  return { active, waived }
}

function withSpans(inf: RuleInfraction, spans: InfractionSpan[]): RuleInfraction {
  const reasonParams = deriveReasonParams(inf, spans)
  return reasonParams ? { ...inf, spans, reasonParams } : { ...inf, spans }
}

/**
 * `builtin:placeholder-integrity` names the offending tokens in its message,
 * lifted from the spans (see `placeholderIntegrityParams` in rule-engine.ts).
 * After a split those lists have to shrink with the spans, or a half-waived
 * infraction would keep naming the token the reviewer just accepted.
 *
 * Every other reason's params describe the cell as a whole — the
 * `source-requires-target` instance counts are a property of the mismatch, not
 * of the spans shown — so they are carried through untouched.
 */
function deriveReasonParams(
  inf: RuleInfraction,
  spans: InfractionSpan[],
): Record<string, string> | undefined {
  if (inf.reason !== "builtin:placeholder-integrity") return undefined
  const tokens = spans.map((s) => s.matchedText).filter(Boolean)
  return { tokens: tokens.join(", "), count: String(tokens.length) }
}

/** One waivable finding inside an infraction: the text that matched, its
 *  identity hash, and how many spans in the cell share it. */
export interface InfractionFinding {
  matchHash: string
  matchedText: string
  /** Spans in this cell that normalize to the same finding. Identical matches
   *  are one decision, not several — waiving "the the" accepts both places it
   *  occurs, and a reviewer should not have to click twice for one judgement. */
  spanCount: number
}

/**
 * The distinct findings an infraction reports, in first-appearance order.
 *
 * Empty when no span carries matchable text — an absence rule ("the source
 * requires a rendering that isn't there") has no concrete match to point at, so
 * the only gesture available for it is a cell-wide waiver. Callers render a
 * single rule-level row in that case.
 */
export function distinctFindings(inf: RuleInfraction): InfractionFinding[] {
  const byHash = new Map<string, InfractionFinding>()
  for (const span of inf.spans) {
    const h = spanMatchHash(span)
    if (h === null) continue
    const seen = byHash.get(h)
    if (seen) seen.spanCount += 1
    else byHash.set(h, { matchHash: h, matchedText: span.matchedText, spanCount: 1 })
  }
  return [...byHash.values()]
}
