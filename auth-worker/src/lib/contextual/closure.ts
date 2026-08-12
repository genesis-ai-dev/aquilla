// closure — the scene_closure loop (graph nodes `construe` ⇄ `expand_window`,
// plus `register` at loop exit).
//
// The analyzer "looks backwards and forwards recursively until it
// understands": construe the window → if not closed, widen the window per the
// open questions → re-construe. Three stops, all enforced here in code:
//   1. dry round — the construal reached a fixpoint (deep-equal, ignoring
//      evidenceCellIds ordering);
//   2. max_iterations (6);
//   3. loop unit budget (40 units), inside the span's RunBudget.
// TWO DISTINCT EXITS (the loop's one deadly failure mode is conflating them):
//   - closed (model-closed / fixpoint / window-exhausted) is a SUCCESS — the
//     surviving openQuestions are GENUINE ambiguity and become the register;
//   - budget/iteration exhaustion is INCOMPLETE — surfaced for a human, never
//     silently closed.

import type { CellPair } from "../agent/tools/select-cells"
import {
  chargeBudget,
  CLOSURE_LOOP_MAX_UNITS,
  CLOSURE_MAX_ITERATIONS,
  TIER_WEIGHTS,
  type AmbiguityEntry,
  type ClosureExit,
  type Construal,
  type LlmCall,
  type RunBudget,
  type SpanSeed,
  type Window,
} from "./types"

// ── Context the loop grows into ─────────────────────────────────────────────

export interface NeighborBrief {
  id: string
  l1Summary: string
  /** Which side of the span the brief covers. */
  side: "before" | "after"
}

export interface LayerAboveBlock {
  /** Stable identifier recorded on Window.layerAboveRefs. */
  ref: string
  text: string
}

export interface ClosureContext {
  /** The whole file's pairs in display order (window growth walks these). */
  orderedPairs: CellPair[]
  /** Adjacent APPROVED scene briefs — compressed, memoized context. */
  neighborBriefs: NeighborBrief[]
  /** One layer up: file intro / project brief. */
  layerAbove: LayerAboveBlock[]
}

export interface ConstrueSceneDeps {
  seed: SpanSeed
  window?: Window
  llm: LlmCall
  budget: RunBudget
  context: ClosureContext
  priorConstrual?: Construal
  steeringDirections?: string[]
}

export interface ClosureResult {
  construal: Construal
  register: AmbiguityEntry[]
  closed: boolean
  incomplete: boolean
  rounds: number
  exit: ClosureExit
  window: Window
}

// ── Window growth policy (pure code, graph node `expand_window`) ────────────

const FORWARD_STEP = 4
const BACKWARD_STEP = 4

export function initialWindow(seed: SpanSeed, context: ClosureContext): Window {
  const ids = context.orderedPairs.map((p) => p.cellId)
  const start = ids.indexOf(seed.startCellId)
  const end = ids.indexOf(seed.endCellId)
  const cellIds =
    start !== -1 && end !== -1 && end >= start
      ? ids.slice(start, end + 1)
      : [seed.startCellId, seed.endCellId].filter((v, i, a) => a.indexOf(v) === i)
  return { spanId: seed.id, cellIds, precedingBriefIds: [], layerAboveRefs: [] }
}

/**
 * Widen the window one increment. Expansion order per the design: backward
 * first via adjacent approved scene briefs (compressed context), then raw
 * cells (forward, plus backward when no brief covers that side), then one
 * layer up. Returns the window UNCHANGED when nothing is left to add — the
 * caller reads that as "context exhausted".
 */
export function expandWindow(current: Window, _construal: Construal, context: ClosureContext): Window {
  const consumed = new Set(current.precedingBriefIds)
  const nextBrief = context.neighborBriefs.find((b) => !consumed.has(b.id))
  if (nextBrief) {
    return { ...current, precedingBriefIds: [...current.precedingBriefIds, nextBrief.id] }
  }

  const ids = context.orderedPairs.map((p) => p.cellId)
  const inWindow = new Set(current.cellIds)
  const first = ids.indexOf(current.cellIds[0] ?? "")
  const last = ids.indexOf(current.cellIds[current.cellIds.length - 1] ?? "")
  const before: string[] = []
  const after: string[] = []
  if (last !== -1) {
    for (let i = last + 1; i < ids.length && after.length < FORWARD_STEP; i++) {
      if (!inWindow.has(ids[i])) after.push(ids[i])
    }
  }
  const briefCoversBackward = context.neighborBriefs.some((b) => b.side === "before")
  if (!briefCoversBackward && first > 0) {
    for (let i = first - 1; i >= 0 && before.length < BACKWARD_STEP; i--) {
      if (!inWindow.has(ids[i])) before.unshift(ids[i])
    }
  }
  if (before.length > 0 || after.length > 0) {
    return { ...current, cellIds: [...before, ...current.cellIds, ...after] }
  }

  const layerRefs = context.layerAbove.map((l) => l.ref).filter((r) => !current.layerAboveRefs.includes(r))
  if (layerRefs.length > 0) {
    return { ...current, layerAboveRefs: [...current.layerAboveRefs, ...layerRefs] }
  }

  return current
}

// ── Prompt + tolerant parse ─────────────────────────────────────────────────

function windowBlock(window: Window, context: ClosureContext): string {
  const byId = new Map(context.orderedPairs.map((p) => [p.cellId, p]))
  const cells = window.cellIds
    .map((id) => {
      const p = byId.get(id)
      return p ? `[${id}]${p.canonicalRef ? ` (${p.canonicalRef})` : ""} ${p.source}` : `[${id}] (missing)`
    })
    .join("\n")
  const briefs = window.precedingBriefIds
    .map((id) => context.neighborBriefs.find((b) => b.id === id))
    .filter((b): b is NeighborBrief => b !== undefined)
    .map((b) => `Adjacent scene (${b.side}): ${b.l1Summary}`)
    .join("\n")
  const layers = window.layerAboveRefs
    .map((ref) => context.layerAbove.find((l) => l.ref === ref))
    .filter((l): l is LayerAboveBlock => l !== undefined)
    .map((l) => `Layer above (${l.ref}): ${l.text}`)
    .join("\n")
  return [briefs, layers, `Cells:\n${cells}`].filter(Boolean).join("\n\n")
}

function construeSystemPrompt(steeringDirections?: string[]): string {
  const steering =
    steeringDirections && steeringDirections.length > 0
      ? `\nActive directions from the human team (honour them):\n${steeringDirections.map((d) => `- ${d}`).join("\n")}\n`
      : ""
  // [[ctx:construe]] is a routing marker for the scripted e2e mock
  // (scripts/mock-openrouter.ts) — it keys canned replies off the node, not
  // off fragile prompt copy. Harmless to a real model.
  return `[[ctx:construe]] You are a discourse analyst. Construe the SITUATION the given span of cells enacts: who is involved, the social relationship (tenor), and the sequence of speech-act moves.

Set "closed": true ONLY if reading further context would NOT change your construal (a fixpoint test, not a confidence guess). If context you cannot see could still change it, set "closed": false and list what you need in "openQuestions". Questions that no amount of context could settle are GENUINE ambiguity — keep them in "openQuestions" and still set "closed": true.

Never invent participants the cells do not evidence.
${steering}
Output STRICT JSON only, no prose, no code fences:
{"situation":"…","participants":["…"],"tenor":"…","moves":["…"],"closed":true,"openQuestions":["…"],"evidenceCellIds":["…"]}`
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

/** Tolerant extraction of the construal object (parseDraftReply's approach:
 *  slice the outermost braces, validate field-by-field, never throw). */
export function parseConstrualReply(content: string, spanId: string): Construal | null {
  const start = content.indexOf("{")
  const end = content.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    const raw = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>
    if (typeof raw !== "object" || raw === null) return null
    return {
      spanId,
      situation: typeof raw.situation === "string" ? raw.situation : "",
      participants: asStringArray(raw.participants),
      tenor: typeof raw.tenor === "string" ? raw.tenor : "",
      moves: asStringArray(raw.moves),
      closed: raw.closed === true,
      openQuestions: asStringArray(raw.openQuestions),
      evidenceCellIds: asStringArray(raw.evidenceCellIds),
    }
  } catch {
    return null
  }
}

/** Fixpoint test: compare stable claims, not prose-order accidents.
 *  Unordered fields are sorted; whitespace is collapsed. A model that
 *  paraphrases the same situation with shuffled participants still converges. */
export function construalsEqual(a: Construal, b: Construal): boolean {
  const text = (value: string) => value.trim().replace(/\s+/g, " ")
  const sorted = (xs: string[]) => [...xs].map(text).filter(Boolean).sort()
  return (
    text(a.situation) === text(b.situation) &&
    text(a.tenor) === text(b.tenor) &&
    a.closed === b.closed &&
    JSON.stringify(sorted(a.participants)) === JSON.stringify(sorted(b.participants)) &&
    JSON.stringify(sorted(a.moves)) === JSON.stringify(sorted(b.moves)) &&
    JSON.stringify(sorted(a.openQuestions)) === JSON.stringify(sorted(b.openQuestions)) &&
    JSON.stringify(sorted(a.evidenceCellIds)) === JSON.stringify(sorted(b.evidenceCellIds))
  )
}

export function registerFromConstrual(construal: Construal): AmbiguityEntry[] {
  return construal.openQuestions.map((question, i) => ({
    id: `${construal.spanId}:amb:${i + 1}`,
    question,
  }))
}

// ── The loop ────────────────────────────────────────────────────────────────

export async function construeScene(deps: ConstrueSceneDeps): Promise<ClosureResult> {
  const { seed, llm, budget, context } = deps
  let window = deps.window ?? initialWindow(seed, context)
  let prior = deps.priorConstrual
  let loopUnits = 0
  let rounds = 0

  const exitWith = (construal: Construal, exit: ClosureExit): ClosureResult => {
    const closed = exit === "model-closed" || exit === "fixpoint" || exit === "window-exhausted"
    return {
      construal,
      register: closed ? registerFromConstrual(construal) : [],
      closed,
      incomplete: !closed,
      rounds,
      exit,
      window,
    }
  }

  // A prior construal (re-construe path) counts as round 0's baseline.
  let last: Construal | undefined = prior
  let parsedRounds = 0

  for (;;) {
    if (rounds >= CLOSURE_MAX_ITERATIONS) {
      const exit = parsedRounds === 0 ? "unparseable" : "max-iterations"
      return exitWith(last ?? emptyConstrual(seed.id), exit)
    }
    if (loopUnits + TIER_WEIGHTS.mid > CLOSURE_LOOP_MAX_UNITS) {
      return exitWith(last ?? emptyConstrual(seed.id), "budget")
    }
    const charge = chargeBudget(budget, "mid")
    if (!charge.ok) {
      return exitWith(last ?? emptyConstrual(seed.id), "budget")
    }
    loopUnits += TIER_WEIGHTS.mid
    rounds += 1

    const priorBlock = prior
      ? `\nYour prior construal (revise only where the added context demands):\n${JSON.stringify({
          situation: prior.situation,
          participants: prior.participants,
          tenor: prior.tenor,
          moves: prior.moves,
          openQuestions: prior.openQuestions,
        })}\n`
      : ""
    const reply = await llm({
      system: construeSystemPrompt(deps.steeringDirections),
      user: `${windowBlock(window, context)}${priorBlock}`,
      tier: "mid",
      maxTokens: 1024,
      temperature: 0,
      label: "construe",
    })
    const construal = parseConstrualReply(reply, seed.id)
    if (!construal) {
      // Unparseable round: retry consumes the next iteration's budget; a run
      // of failures exhausts max_iterations as `unparseable` rather than
      // pretending the scene churned semantically.
      continue
    }
    parsedRounds += 1

    if (construal.closed) return exitWith(construal, "model-closed")
    if (last && construalsEqual(construal, last)) {
      // Dry round — the last expansion changed nothing: the fixpoint. Open
      // questions that survived a fixpoint are genuine ambiguity.
      return exitWith(construal, "fixpoint")
    }

    const grown = expandWindow(window, construal, context)
    if (
      grown.cellIds.length === window.cellIds.length &&
      grown.precedingBriefIds.length === window.precedingBriefIds.length &&
      grown.layerAboveRefs.length === window.layerAboveRefs.length
    ) {
      // Nothing left to read — re-construing the same window is a guaranteed
      // dry round; treat as closed (open questions are genuinely open).
      return exitWith(construal, "window-exhausted")
    }
    window = grown
    prior = construal
    last = construal
  }
}

function emptyConstrual(spanId: string): Construal {
  return {
    spanId,
    situation: "",
    participants: [],
    tenor: "",
    moves: [],
    closed: false,
    openQuestions: [],
    evidenceCellIds: [],
  }
}
