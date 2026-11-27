import { useEffect, useLayoutEffect, useMemo, useState } from "react"
import {
  candidateConcepts,
  conceptMatcherReady,
  conceptsAwaitingCompile,
  findConceptMatches,
  prepareConceptMatcher,
} from "@/lib/terminology/match"
import type { Concept, TermMatchingSettings } from "@/lib/terminology/types"
import { readAtVersion } from "./useActiveCellStore"
import { scheduleSlice } from "./useProjectInfractions"

/** One highlighted span of source text and the concepts that matched exactly it. */
export interface SourceTermMatch {
  start: number
  end: number
  concepts: Concept[]
}

/**
 * How many glossary-term patterns the source highlights of one render pass may
 * compile for the first time before the rest are compiled in the background
 * (AQU-2655).
 *
 * Matching a term is cheap once its pattern is compiled; compiling one is not —
 * a term with mark folding and affixes costs V8 several milliseconds at 1x CPU.
 * A first screen that mentions 200 terms the session has not seen held the main
 * thread for about 1.4 s before any row painted. The budget counts compiles,
 * not milliseconds, so it is the same on every machine; a screen that stays
 * under it (every edit, scrolling over terms already seen, a file that mentions
 * a dozen terms) highlights synchronously exactly as before.
 *
 * The budget is spent in render and given back when a row that spent it
 * commits, so one render pass — however many scheduler slices React splits it
 * into — compiles at most this many.
 */
const SYNC_PATTERN_BUDGET = 16

/** Milliseconds of background compiling per idle slice. */
const BACKGROUND_SLICE_MS = 8

let spentThisPass = 0

function trySpend(count: number): boolean {
  if (spentThisPass + count > SYNC_PATTERN_BUDGET) return false
  spentThisPass += count
  return true
}

interface Waiter {
  concepts: readonly Concept[]
  termMatching: TermMatchingSettings | undefined
  next: number
  done: () => void
}

/** Rows waiting for their patterns, in the order they asked: the top of the screen first. */
const waiters: Waiter[] = []
let cancelSlice: (() => void) | null = null

function runSlice(): void {
  cancelSlice = null
  // An idle slice runs between render passes. A pass that spent the budget
  // and was then thrown away never committed to give it back; do it here.
  spentThisPass = 0
  const deadline = performance.now() + BACKGROUND_SLICE_MS
  while (waiters.length > 0) {
    const waiter = waiters[0]
    while (
      waiter.next < waiter.concepts.length &&
      conceptMatcherReady(waiter.concepts[waiter.next], waiter.termMatching)
    ) {
      waiter.next++
    }
    if (waiter.next >= waiter.concepts.length) {
      waiters.shift()
      waiter.done()
      continue
    }
    prepareConceptMatcher(waiter.concepts[waiter.next], waiter.termMatching)
    waiter.next++
    if (performance.now() >= deadline) break
  }
  if (waiters.length > 0) cancelSlice = scheduleSlice(runSlice)
}

/** Compile `concepts` in idle slices, then call `done`. Returns a cancel. */
function compileInBackground(
  concepts: readonly Concept[],
  termMatching: TermMatchingSettings | undefined,
  done: () => void,
): () => void {
  const waiter: Waiter = { concepts, termMatching, next: 0, done }
  waiters.push(waiter)
  cancelSlice ??= scheduleSlice(runSlice)
  return () => {
    const at = waiters.indexOf(waiter)
    if (at >= 0) waiters.splice(at, 1)
    if (waiters.length === 0 && cancelSlice) {
      cancelSlice()
      cancelSlice = null
    }
  }
}

function matchSpans(
  text: string,
  candidates: readonly Concept[],
  termMatching: TermMatchingSettings | undefined,
): SourceTermMatch[] {
  const found: Array<{ start: number; end: number; concept: Concept }> = []
  for (const concept of candidates) {
    for (const m of findConceptMatches(text, concept, termMatching)) {
      found.push({ start: m.start, end: m.end, concept })
    }
  }
  // Longest-first at each offset, then drop anything overlapping an already
  // taken span — a highlight may not start inside another one.
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: SourceTermMatch[] = []
  let taken = -1
  for (const m of found) {
    const last = kept[kept.length - 1]
    if (last && last.start === m.start && last.end === m.end) {
      last.concepts.push(m.concept)
      continue
    }
    if (m.start < taken) continue
    kept.push({ start: m.start, end: m.end, concepts: [m.concept] })
    taken = m.end
  }
  return kept
}

interface MatchState {
  /** `null` while patterns this text needs are still being compiled. */
  matches: SourceTermMatch[] | null
  /** What the background must compile before `matches` can be computed. */
  awaiting: readonly Concept[]
  /** Compiles this render spent from the pass's budget. */
  spent: number
}

const NO_CONCEPTS: readonly Concept[] = []

/**
 * The glossary terms in a row's source text, as non-overlapping spans
 * (AQU-1272 semantics: the CONCEPT is matched — wildcards, mark folding, the
 * project's affixes, forms and exclusions). Only concepts that can occur in
 * the text are run (AQU-2654).
 *
 * Returns `null` while the patterns the text needs are compiled in idle slices
 * (see `SYNC_PATTERN_BUDGET`); the row re-renders with its spans when they are
 * ready. Nothing is dropped: every row that asked is answered, top of the
 * screen first.
 */
export function useSourceTermMatches(
  text: string,
  activeConcepts: readonly Concept[],
  termMatching: TermMatchingSettings | undefined,
): SourceTermMatch[] | null {
  // Bumped when the background has compiled what this row was waiting for.
  const [compiledVersion, setCompiledVersion] = useState(0)

  const state = useMemo<MatchState>(
    () =>
      readAtVersion(compiledVersion, () => {
        const candidates = candidateConcepts(text, activeConcepts, termMatching)
        const cold = candidates.length === 0 ? NO_CONCEPTS : conceptsAwaitingCompile(text, candidates, termMatching)
        if (cold.length > 0 && !trySpend(cold.length)) return { matches: null, awaiting: cold, spent: 0 }
        return { matches: matchSpans(text, candidates, termMatching), awaiting: NO_CONCEPTS, spent: cold.length }
      }),
    [text, activeConcepts, termMatching, compiledVersion],
  )

  // The pass that spent the budget has committed: the next one starts fresh.
  useLayoutEffect(() => {
    if (state.spent > 0) spentThisPass = 0
  }, [state])

  useEffect(() => {
    if (state.matches !== null) return
    return compileInBackground(state.awaiting, termMatching, () => setCompiledVersion((v) => v + 1))
  }, [state, termMatching])

  return state.matches
}
