/**
 * Identity reconciliation (spec §4.2).
 *
 * Given the previous revision's units (with logical ids) and the current
 * revision's units (without), decide which current unit descends from which
 * previous unit. Content hashes alone are not enough — editing a paragraph
 * changes its hash but not its identity — so matching runs in passes from most
 * to least certain, and anything that cannot be decided is reported as
 * `ambiguous` instead of guessed:
 *
 *   1. native anchors (format-provided ids) and explicit human assertions
 *   2. exact-hash longest common subsequence inside each scope  → unchanged
 *   3. exact hash elsewhere                                     → moved
 *   4. monotonic fuzzy alignment inside each gap between anchors → modified
 *   5. splits (1 → n adjacent) and merges (n adjacent → 1)
 *   6. global fuzzy pass for edited-and-moved units              → moved
 *   7. leftovers                                                 → inserted / deleted
 *
 * The function is pure and deterministic: identical inputs always produce the
 * identical mapping, including the ids minted for inserted units.
 */
import { shortHash } from "./hash.ts"
import { containment, similarity } from "./similarity.ts"
import type { ContentUnit, IdentityMapping, IdentityMatch, IdentityStatus } from "./types.ts"

export interface ReconcileOptions {
  /** Minimum similarity for a fuzzy (modified) match inside a gap. */
  readonly fuzzyThreshold?: number
  /** Minimum similarity for a fuzzy match outside the unit's own gap (edited and moved). */
  readonly movedFuzzyThreshold?: number
  /** If the two best candidates are within this margin, the match is ambiguous. */
  readonly ambiguityMargin?: number
  /** Human-asserted identities: current structuralPath → previous logical id. */
  readonly assertions?: ReadonlyMap<string, string>
  /**
   * Previous ids that carry instance-specific decisions (human edits, approvals).
   * Duplicate-text matches involving such ids are escalated as ambiguous rather
   * than resolved by position, because a wrong guess would move a human decision.
   */
  readonly protectedIds?: ReadonlySet<string>
  /** Salt for minted ids (normally docId + revision). */
  readonly salt?: string
}

interface Slot {
  logicalId?: string
  status?: IdentityStatus
  predecessors?: string[]
  similarity?: number
  via?: IdentityMatch["via"]
}

const lcsPairs = (a: readonly string[], b: readonly string[]): Array<[number, number]> => {
  const n = a.length
  const m = b.length
  // Trim common prefix/suffix first: the common case (few edits) becomes O(n).
  let pre = 0
  while (pre < n && pre < m && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++
  const pairs: Array<[number, number]> = []
  for (let i = 0; i < pre; i++) pairs.push([i, i])
  const a2 = a.slice(pre, n - suf)
  const b2 = b.slice(pre, m - suf)
  if (a2.length > 0 && b2.length > 0) {
    const w = b2.length + 1
    const dp = new Uint32Array((a2.length + 1) * w)
    for (let i = a2.length - 1; i >= 0; i--) {
      for (let j = b2.length - 1; j >= 0; j--) {
        dp[i * w + j] =
          a2[i] === b2[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < a2.length && j < b2.length) {
      if (a2[i] === b2[j]) {
        pairs.push([pre + i, pre + j])
        i++
        j++
      } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++
      else j++
    }
  }
  for (let k = suf; k > 0; k--) pairs.push([n - k, m - k])
  return pairs
}

const groupByScope = (units: readonly ContentUnit[]): Map<string, number[]> => {
  const out = new Map<string, number[]>()
  units.forEach((u, i) => {
    const list = out.get(u.scope)
    if (list) list.push(i)
    else out.set(u.scope, [i])
  })
  return out
}

export const reconcile = (
  previous: readonly ContentUnit[],
  current: readonly ContentUnit[],
  options: ReconcileOptions = {},
): IdentityMapping => {
  const fuzzy = options.fuzzyThreshold ?? 0.65
  const movedFuzzy = options.movedFuzzyThreshold ?? 0.72
  const margin = options.ambiguityMargin ?? 0.06
  const protectedIds = options.protectedIds ?? new Set<string>()
  const salt = options.salt ?? ""

  const slots: Slot[] = current.map(() => ({}))
  const prevUsed = new Set<number>()
  const prevIndexById = new Map(previous.map((u, i) => [u.logicalId, i]))
  const claim = (pi: number, ci: number, s: Omit<Slot, "logicalId" | "predecessors">): void => {
    const p = previous[pi]!
    prevUsed.add(pi)
    slots[ci] = { ...s, logicalId: p.logicalId, predecessors: [p.logicalId] }
  }
  const status = (pi: number, ci: number): IdentityStatus =>
    previous[pi]!.contentHash === current[ci]!.contentHash ? "unchanged" : "modified"

  // ── Pass 1: assertions and native anchors ────────────────────────────────
  if (options.assertions) {
    current.forEach((u, ci) => {
      const id = options.assertions!.get(u.structuralPath)
      const pi = id === undefined ? undefined : prevIndexById.get(id)
      if (pi !== undefined && !prevUsed.has(pi)) {
        claim(pi, ci, { status: status(pi, ci), similarity: similarity(previous[pi]!.plain, u.plain), via: "asserted" })
      }
    })
  }
  const anchorCount = (units: readonly ContentUnit[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const u of units) if (u.nativeAnchor) m.set(u.nativeAnchor, (m.get(u.nativeAnchor) ?? 0) + 1)
    return m
  }
  const prevAnchors = anchorCount(previous)
  const currAnchors = anchorCount(current)
  const prevByAnchor = new Map<string, number>()
  previous.forEach((u, i) => {
    if (u.nativeAnchor && prevAnchors.get(u.nativeAnchor) === 1) prevByAnchor.set(u.nativeAnchor, i)
  })
  current.forEach((u, ci) => {
    if (slots[ci]!.logicalId || !u.nativeAnchor || currAnchors.get(u.nativeAnchor) !== 1) return
    const pi = prevByAnchor.get(u.nativeAnchor)
    if (pi === undefined || prevUsed.has(pi)) return
    const st = status(pi, ci)
    claim(pi, ci, {
      status: st === "unchanged" && previous[pi]!.scope !== u.scope ? "moved" : st,
      similarity: st === "unchanged" ? 1 : similarity(previous[pi]!.plain, u.plain),
      via: "native-anchor",
    })
  })

  // ── Pass 2: exact-hash LCS within each scope ─────────────────────────────
  // Duplicate texts whose multiplicity changed and that carry human decisions
  // are "contested": positional pairing would be a guess, so they skip the
  // sequence pass and are escalated in pass 3.
  const countBy = (list: readonly ContentUnit[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const u of list) m.set(u.contentHash, (m.get(u.contentHash) ?? 0) + 1)
    return m
  }
  const prevCounts = countBy(previous)
  const currCounts = countBy(current)
  const contested = new Set<string>()
  previous.forEach((u, i) => {
    if (prevUsed.has(i)) return
    const pc = prevCounts.get(u.contentHash) ?? 0
    const cc = currCounts.get(u.contentHash) ?? 0
    if ((pc > 1 || cc > 1) && pc !== cc && protectedIds.has(u.logicalId)) contested.add(u.contentHash)
  })
  const prevScopes = groupByScope(previous)
  const currScopes = groupByScope(current)
  for (const [scope, cIdx] of currScopes) {
    const pIdx = (prevScopes.get(scope) ?? []).filter((i) => !prevUsed.has(i) && !contested.has(previous[i]!.contentHash))
    const cFree = cIdx.filter((i) => !slots[i]!.logicalId && !contested.has(current[i]!.contentHash))
    const pairs = lcsPairs(
      pIdx.map((i) => previous[i]!.contentHash),
      cFree.map((i) => current[i]!.contentHash),
    )
    for (const [a, b] of pairs) claim(pIdx[a]!, cFree[b]!, { status: "unchanged", similarity: 1, via: "sequence" })
  }

  // ── Pass 3: exact hash elsewhere (moved) ─────────────────────────────────
  const freePrevByHash = new Map<string, number[]>()
  previous.forEach((u, i) => {
    if (prevUsed.has(i)) return
    const list = freePrevByHash.get(u.contentHash)
    if (list) list.push(i)
    else freePrevByHash.set(u.contentHash, [i])
  })
  const freeCurrByHash = new Map<string, number[]>()
  current.forEach((u, i) => {
    if (slots[i]!.logicalId) return
    const list = freeCurrByHash.get(u.contentHash)
    if (list) list.push(i)
    else freeCurrByHash.set(u.contentHash, [i])
  })
  for (const [hash, cList] of freeCurrByHash) {
    const pList = freePrevByHash.get(hash)
    if (!pList || pList.length === 0) continue
    const contested = pList.length > 1 || cList.length > 1
    const touchesProtected = pList.some((pi) => protectedIds.has(previous[pi]!.logicalId))
    if (contested && touchesProtected) {
      // Duplicate text where at least one instance carries a human decision:
      // position is not proof of identity. Escalate every current instance.
      for (const ci of cList) {
        slots[ci] = {
          logicalId: mintId(salt, current[ci]!),
          status: "ambiguous",
          predecessors: pList.map((pi) => previous[pi]!.logicalId),
          similarity: 1,
          via: "exact-elsewhere",
        }
      }
      // Reserve the candidates so no weaker pass hands them to another unit.
      for (const pi of pList) prevUsed.add(pi)
      continue
    }
    // Pair in document order; deterministic.
    const k = Math.min(pList.length, cList.length)
    for (let t = 0; t < k; t++) {
      const pi = pList[t]!
      const ci = cList[t]!
      claim(pi, ci, { status: "moved", similarity: 1, via: "exact-elsewhere" })
    }
  }

  // ── Pass 4: fuzzy monotonic alignment inside gaps ────────────────────────
  // Gaps are the stretches between already-matched units of the same scope.
  for (const [scope, cIdx] of currScopes) {
    const pIdxAll = prevScopes.get(scope) ?? []
    // Build gaps: walk current units in order; anchors are matched units whose predecessor is in this scope.
    const anchors: Array<[number, number]> = [] // [prevPos, currPos] positions within scope lists
    const prevPos = new Map(pIdxAll.map((pi, k) => [pi, k]))
    cIdx.forEach((ci, k) => {
      const id = slots[ci]!.logicalId
      if (!id || slots[ci]!.status === "ambiguous") return
      const pi = prevIndexById.get(id)
      const pp = pi === undefined ? undefined : prevPos.get(pi)
      if (pp !== undefined) anchors.push([pp, k])
    })
    // Keep a monotonic chain of anchors (moves can break monotonicity).
    const chain: Array<[number, number]> = []
    for (const a of anchors) if (chain.length === 0 || a[0] > chain.at(-1)![0]) chain.push(a)
    const bounds: Array<[number, number, number, number]> = []
    let lp = -1
    let lc = -1
    for (const [pp, cp] of [...chain, [pIdxAll.length, cIdx.length] as [number, number]]) {
      bounds.push([lp + 1, pp, lc + 1, cp])
      lp = pp
      lc = cp
    }
    for (const [p0, p1, c0, c1] of bounds) {
      const gp = pIdxAll.slice(p0, p1).filter((pi) => !prevUsed.has(pi))
      const gc = cIdx.slice(c0, c1).filter((ci) => !slots[ci]!.logicalId)
      if (gp.length === 0 || gc.length === 0) continue
      alignGap(gp, gc)
    }
  }

  function alignGap(gpAll: number[], gcAll: number[]): void {
    // Splits and merges first: a 1→n or n→1 explanation that fits clearly
    // better than any 1→1 pairing must not be pre-empted by the fuzzy pass.
    detectSplitsAndMerges(gpAll, gcAll)
    const gp = gpAll.filter((pi) => !prevUsed.has(pi))
    const gc = gcAll.filter((ci) => !slots[ci]!.logicalId)
    if (gp.length === 0 || gc.length === 0) return
    const sim: number[][] = gp.map((pi) => gc.map((ci) => similarity(previous[pi]!.plain, current[ci]!.plain)))
    // Needleman–Wunsch style DP maximising total (sim - threshold) over a monotonic matching.
    const n = gp.length
    const m = gc.length
    const score: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        const s = sim[i]![j]!
        const take = s >= fuzzy ? s - fuzzy + score[i + 1]![j + 1]! : -Infinity
        score[i]![j] = Math.max(take, score[i + 1]![j]!, score[i]![j + 1]!)
      }
    }
    let i = 0
    let j = 0
    const pairs: Array<[number, number]> = []
    while (i < n && j < m) {
      const s = sim[i]![j]!
      if (s >= fuzzy && score[i]![j] === s - fuzzy + score[i + 1]![j + 1]!) {
        pairs.push([i, j])
        i++
        j++
      } else if (score[i + 1]![j]! >= score[i]![j + 1]!) i++
      else j++
    }
    for (const [a, b] of pairs) {
      // Ambiguity: another unmatched candidate in the gap is nearly as good, in either direction.
      const best = sim[a]![b]!
      const rivalsForCurr = gp.filter((_, k) => k !== a && sim[k]![b]! >= fuzzy && best - sim[k]![b]! < margin)
      const rivalsForPrev = gc.filter((_, k) => k !== b && sim[a]![k]! >= fuzzy && best - sim[a]![k]! < margin)
      const ci = gc[b]!
      const pi = gp[a]!
      if (rivalsForCurr.length > 0 || rivalsForPrev.length > 0) {
        const cands = [pi, ...gp.filter((_, k) => k !== a && sim[k]![b]! >= fuzzy && best - sim[k]![b]! < margin)]
        slots[ci] = {
          logicalId: mintId(salt, current[ci]!),
          status: "ambiguous",
          predecessors: cands.map((x) => previous[x]!.logicalId),
          similarity: best,
          via: "fuzzy",
        }
        continue
      }
      // Mutual best: if this previous paragraph matches some *other* unmatched
      // current paragraph clearly better (it was edited and moved), do not let
      // a weaker local candidate take it; pass 6 will pair it globally.
      const elsewhere = current.reduce(
        (m, c, k) => (k === ci || slots[k]!.logicalId || gc.includes(k) ? m : Math.max(m, similarity(previous[pi]!.plain, c.plain))),
        0,
      )
      if (elsewhere > best + margin) continue
      // A fuzzy pairing is also doubtful when the current text is (nearly) a
      // verbatim fragment of some *other* unmatched paragraph — e.g. half of a
      // paragraph that was split and partly moved. Escalate rather than guess.
      const own = containment(current[ci]!.plain, previous[pi]!.plain)
      const fragmentOf = previous.findIndex(
        (p, k) => k !== pi && !prevUsed.has(k) && containment(current[ci]!.plain, p.plain) >= 0.9 && containment(current[ci]!.plain, p.plain) > own + 0.1,
      )
      if (fragmentOf >= 0) {
        slots[ci] = {
          logicalId: mintId(salt, current[ci]!),
          status: "ambiguous",
          predecessors: [pi, fragmentOf].map((x) => previous[x]!.logicalId),
          similarity: best,
          via: "fuzzy",
        }
        continue
      }
      claim(pi, ci, { status: "modified", similarity: best, via: "fuzzy" })
    }
  }

  function bestFreeCurrent(pi: number, except: number): number {
    let m = 0
    current.forEach((c, k) => {
      if (k !== except && !slots[k]!.logicalId) m = Math.max(m, similarity(previous[pi]!.plain, c.plain))
    })
    return m
  }
  function bestFreePrevious(ci: number, except: number): number {
    let m = 0
    previous.forEach((p, k) => {
      if (k !== except && !prevUsed.has(k)) m = Math.max(m, similarity(p.plain, current[ci]!.plain))
    })
    return m
  }

  function detectSplitsAndMerges(leftP: number[], leftC: number[]): void {
    const joinPlain = (idx: number[], units: readonly ContentUnit[]): string => idx.map((i) => units[i]!.plain).join(" ")
    // For every candidate we pick the *best-scoring* contiguous run (ties →
    // shorter), so an unrelated neighbour is never swallowed into a split or
    // merge just because it shares vocabulary: adding it lowers the score.
    // Split: one previous unit ≈ concatenation of ≥2 adjacent current units.
    for (const pi of leftP) {
      if (prevUsed.has(pi)) continue
      let best: { run: number[]; sim: number } | undefined
      for (let s = 0; s < leftC.length; s++) {
        for (let e = s + 2; e <= Math.min(leftC.length, s + 6); e++) {
          const run = leftC.slice(s, e)
          if (run.some((ci) => slots[ci]!.logicalId)) break
          if (!run.every((ci) => containment(current[ci]!.plain, previous[pi]!.plain) >= 0.85)) continue
          const sim = similarity(previous[pi]!.plain, joinPlain(run, current))
          const bestSingle = Math.max(...run.map((ci) => similarity(previous[pi]!.plain, current[ci]!.plain)))
          if (sim < 0.75 || sim < bestSingle + 0.1) continue
          if (run.some((ci) => bestFreePrevious(ci, pi) >= sim)) continue
          if (!best || sim > best.sim + 1e-9) best = { run, sim }
        }
      }
      if (!best) continue
      prevUsed.add(pi)
      const pid = previous[pi]!.logicalId
      for (const ci of best.run) {
        slots[ci] = { logicalId: mintId(salt, current[ci]!), status: "split", predecessors: [pid], similarity: best.sim, via: "split" }
      }
    }
    // Merge: one current unit ≈ concatenation of ≥2 adjacent previous units.
    const stillP = leftP.filter((pi) => !prevUsed.has(pi))
    for (const ci of leftC) {
      if (slots[ci]!.logicalId) continue
      let best: { run: number[]; sim: number } | undefined
      for (let s = 0; s < stillP.length; s++) {
        for (let e = s + 2; e <= Math.min(stillP.length, s + 6); e++) {
          const full = stillP.slice(s, e)
          if (full.some((pi) => prevUsed.has(pi))) break
          // Also consider the run with interior units left out: paragraphs
          // deleted between merged ones must not be swept into the merge.
          const interior = full.slice(1, -1)
          const variants: number[][] = []
          for (let mask = 0; mask < 1 << interior.length; mask++) {
            variants.push([full[0]!, ...interior.filter((_, k) => !(mask & (1 << k))), full.at(-1)!])
          }
          for (const run of variants) {
            if (!run.every((pi) => containment(previous[pi]!.plain, current[ci]!.plain) >= 0.85)) continue
            const sim = similarity(joinPlain(run, previous), current[ci]!.plain)
            const bestSingle = Math.max(...run.map((pi) => similarity(previous[pi]!.plain, current[ci]!.plain)))
            if (sim < 0.75 || sim < bestSingle + 0.1) continue
            // Do not swallow a paragraph that has its own, better 1→1 match elsewhere.
            if (run.some((pi) => bestFreeCurrent(pi, ci) >= sim)) continue
            if (!best || sim > best.sim + 1e-9 || (Math.abs(sim - best.sim) <= 1e-9 && run.length < best.run.length)) best = { run, sim }
          }
        }
      }
      if (!best) continue
      for (const pi of best.run) prevUsed.add(pi)
      slots[ci] = {
        logicalId: mintId(salt, current[ci]!),
        status: "merged",
        predecessors: best.run.map((pi) => previous[pi]!.logicalId),
        similarity: best.sim,
        via: "merge",
      }
    }
  }

  // ── Pass 6: global fuzzy for edited-and-moved units ──────────────────────
  const restP = previous.map((_, i) => i).filter((i) => !prevUsed.has(i))
  for (const ci of current.map((_, i) => i).filter((i) => !slots[i]!.logicalId)) {
    let best = -1
    let bestSim = 0
    let second = 0
    for (const pi of restP) {
      if (prevUsed.has(pi)) continue
      const s = similarity(previous[pi]!.plain, current[ci]!.plain)
      if (s > bestSim) {
        second = bestSim
        bestSim = s
        best = pi
      } else if (s > second) second = s
    }
    if (best < 0 || bestSim < movedFuzzy) continue
    if (bestSim - second < margin && second >= movedFuzzy) {
      slots[ci] = {
        logicalId: mintId(salt, current[ci]!),
        status: "ambiguous",
        predecessors: restP
          .filter((pi) => !prevUsed.has(pi) && similarity(previous[pi]!.plain, current[ci]!.plain) >= second)
          .map((pi) => previous[pi]!.logicalId),
        similarity: bestSim,
        via: "fuzzy",
      }
      continue
    }
    claim(best, ci, { status: "moved", similarity: bestSim, via: "fuzzy" })
  }

  // ── Pass 7: leftovers ────────────────────────────────────────────────────
  const matches: IdentityMatch[] = slots.map((s, ci) =>
    s.logicalId
      ? {
          index: ci,
          logicalId: s.logicalId,
          status: s.status!,
          predecessors: s.predecessors ?? [],
          similarity: s.similarity ?? 0,
          via: s.via ?? "none",
        }
      : { index: ci, logicalId: mintId(salt, current[ci]!), status: "inserted", predecessors: [], similarity: 0, via: "none" },
  )
  // Guarantee unique ids even for identical inserted units in the same scope.
  const seen = new Map<string, number>()
  const unique = matches.map((m) => {
    const n = seen.get(m.logicalId) ?? 0
    seen.set(m.logicalId, n + 1)
    return n === 0 ? m : { ...m, logicalId: `${m.logicalId}.${n}` }
  })
  const descended = new Set(unique.flatMap((m) => (m.status === "ambiguous" ? [] : m.predecessors)))
  // Previous units that are only *candidates* of an ambiguous match are not deleted yet: a human must decide.
  const pendingAmbiguous = new Set(unique.flatMap((m) => (m.status === "ambiguous" ? m.predecessors : [])))
  const deleted = previous
    .map((u) => u.logicalId)
    .filter((id) => !descended.has(id) && !pendingAmbiguous.has(id))
  return { matches: unique, deleted }
}

const mintId = (salt: string, u: ContentUnit): string =>
  `u${shortHash(`${salt}|${u.scope}|${u.ordinal}|${u.contentHash}`).slice(0, 12)}`

/** Initial identities for a first observation (no previous revision). */
export const initialMapping = (current: readonly ContentUnit[], salt: string): IdentityMapping =>
  reconcile([], current, { salt })

/** Apply a mapping to the current units, returning units with logical ids set. */
export const assignIds = (current: readonly ContentUnit[], mapping: IdentityMapping): ContentUnit[] =>
  current.map((u, i) => ({ ...u, logicalId: mapping.matches[i]!.logicalId }))
