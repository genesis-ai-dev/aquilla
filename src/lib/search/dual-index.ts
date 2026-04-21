import { tokenizeText } from "./tokenizer"

export interface CellInput {
  id: string
  original: string
  translated: string
  fileId: string
}

export interface IndexedPair {
  cellId: string
  fileId: string
  source: string
  target: string
  sourceTokens: Set<string>
  targetTokens: Set<string>
}

export interface ScoredPair {
  cellId: string
  fileId: string
  source: string
  target: string
  score: number
  matchedTokens: string[]
  coverageWeight: number
}

export type IndexSide = "source" | "target"

export class DualIndex {
  private pairs = new Map<string, IndexedPair>()
  private sourceInverted = new Map<string, Set<string>>()
  private targetInverted = new Map<string, Set<string>>()
  private sourceDocFreq = new Map<string, number>()
  private targetDocFreq = new Map<string, number>()

  buildFromProject(cells: CellInput[]): void {
    this.pairs.clear()
    this.sourceInverted.clear()
    this.targetInverted.clear()
    this.sourceDocFreq.clear()
    this.targetDocFreq.clear()
    for (const c of cells) this.addPair(c)
  }

  addPair(cell: CellInput): void {
    if (!cell.original || !cell.original.trim()) return
    if (!cell.translated || !cell.translated.trim()) return
    if (this.pairs.has(cell.id)) this.removePair(cell.id)

    const sourceTokens = new Set(tokenizeText(cell.original))
    const targetTokens = new Set(tokenizeText(cell.translated))
    const pair: IndexedPair = {
      cellId: cell.id, fileId: cell.fileId,
      source: cell.original, target: cell.translated,
      sourceTokens, targetTokens,
    }
    this.pairs.set(cell.id, pair)
    for (const t of sourceTokens) this.addInverted(this.sourceInverted, this.sourceDocFreq, t, cell.id)
    for (const t of targetTokens) this.addInverted(this.targetInverted, this.targetDocFreq, t, cell.id)
  }

  removePair(cellId: string): void {
    const p = this.pairs.get(cellId)
    if (!p) return
    for (const t of p.sourceTokens) this.removeInverted(this.sourceInverted, this.sourceDocFreq, t, cellId)
    for (const t of p.targetTokens) this.removeInverted(this.targetInverted, this.targetDocFreq, t, cellId)
    this.pairs.delete(cellId)
  }

  size(): number { return this.pairs.size }
  hasToken(side: IndexSide, token: string): boolean {
    const ix = side === "source" ? this.sourceInverted : this.targetInverted
    const set = ix.get(token)
    return set ? set.size > 0 : false
  }

  searchPlainSource(query: string, limit: number): ScoredPair[] {
    return this.plainSearch(query, limit, "source")
  }

  searchPlainTarget(query: string, limit: number): ScoredPair[] {
    return this.plainSearch(query, limit, "target")
  }

  private plainSearch(query: string, limit: number, side: IndexSide): ScoredPair[] {
    const q = query.trim()
    if (!q) return []
    const queryTokens = new Set(tokenizeText(q))
    if (queryTokens.size === 0) return []

    const inv = side === "source" ? this.sourceInverted : this.targetInverted
    const df = side === "source" ? this.sourceDocFreq : this.targetDocFreq
    const docCount = this.pairs.size

    // Collect candidate cellIds via inverted index
    const candidates = new Set<string>()
    for (const t of queryTokens) {
      const bucket = inv.get(t)
      if (bucket) for (const id of bucket) candidates.add(id)
    }
    if (candidates.size === 0) return []

    type Scored = { pair: IndexedPair; score: number; matched: string[] }
    const scored: Scored[] = []
    for (const id of candidates) {
      const pair = this.pairs.get(id)
      if (!pair) continue
      const tokens = side === "source" ? pair.sourceTokens : pair.targetTokens
      const matched: string[] = []
      let idfSum = 0
      for (const t of queryTokens) {
        if (tokens.has(t)) {
          matched.push(t)
          const freq = df.get(t) ?? 1
          idfSum += Math.log((docCount + 1) / (freq + 1))
        }
      }
      if (matched.length === 0) continue
      const coverage = matched.length / queryTokens.size
      const score = 0.3 * coverage + 0.7 * (idfSum / Math.max(1, queryTokens.size))
      scored.push({ pair, score, matched })
    }

    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, limit)
    const maxScore = top[0]?.score ?? 1

    return top.map((s) => ({
      cellId: s.pair.cellId,
      fileId: s.pair.fileId,
      source: s.pair.source,
      target: s.pair.target,
      score: s.score,
      matchedTokens: s.matched,
      coverageWeight: maxScore > 0 ? s.score / maxScore : 0,
    }))
  }

  searchBranchingSource(query: string, limit: number): ScoredPair[] {
    return this.branchingSearch(query, limit, "source")
  }

  searchBranchingTarget(query: string, limit: number): ScoredPair[] {
    return this.branchingSearch(query, limit, "target")
  }

  private branchingSearch(query: string, limit: number, side: IndexSide): ScoredPair[] {
    const cleanQuery = query.trim()
    if (!cleanQuery) return []
    const queryAllTokens = tokenizeText(cleanQuery)
    const queryTotalTokens = queryAllTokens.length
    if (queryTotalTokens === 0) return []

    const MAX_RESTARTS = 2
    const MIN_SCORE = 0.15
    const results: ScoredPair[] = []
    const used = new Set<string>()
    const consumedQueryTokens = new Set<string>()
    let branches: string[] = [cleanQuery]
    let restarts = 0

    while (results.length < limit && restarts <= MAX_RESTARTS) {
      if (branches.length === 0) {
        restarts += 1
        if (restarts > MAX_RESTARTS) break
        branches = [cleanQuery]
        continue
      }

      let bestScore = -Infinity
      let best: { pair: IndexedPair; matched: string[]; branchIdx: number; branchQuery: string } | null = null

      for (let bi = 0; bi < branches.length; bi++) {
        const b = branches[bi].trim()
        if (!b) continue
        const bTokens = new Set(tokenizeText(b))
        if (bTokens.size === 0) continue

        const inv = side === "source" ? this.sourceInverted : this.targetInverted
        const candidates = new Set<string>()
        for (const t of bTokens) {
          const bucket = inv.get(t)
          if (bucket) for (const id of bucket) if (!used.has(id)) candidates.add(id)
        }

        for (const id of candidates) {
          const pair = this.pairs.get(id)
          if (!pair) continue
          const tokens = side === "source" ? pair.sourceTokens : pair.targetTokens
          const matched: string[] = []
          for (const t of bTokens) if (tokens.has(t)) matched.push(t)
          if (matched.length === 0) continue
          const coverage = matched.length / bTokens.size
          const score = (0.3 * coverage + 0.7 * coverage) * (1 + 0.5 * coverage)
          if (score > bestScore) {
            bestScore = score
            best = { pair, matched, branchIdx: bi, branchQuery: b }
          }
        }
      }

      if (!best || bestScore < MIN_SCORE) break

      const coveredText = this.findLongestCoveredSubstring(
        best.branchQuery,
        side === "source" ? best.pair.source : best.pair.target,
      )
      const coveredTokens = coveredText ? tokenizeText(coveredText) : best.matched
      // Only count tokens that haven't been attributed to a previous result
      const newlyCoveredCount = coveredTokens.filter(t => !consumedQueryTokens.has(t)).length
      const coverageWeight = queryTotalTokens > 0 ? newlyCoveredCount / queryTotalTokens : 0
      for (const t of coveredTokens) consumedQueryTokens.add(t)

      results.push({
        cellId: best.pair.cellId,
        fileId: best.pair.fileId,
        source: best.pair.source,
        target: best.pair.target,
        score: bestScore,
        matchedTokens: best.matched,
        coverageWeight,
      })
      used.add(best.pair.cellId)

      branches.splice(best.branchIdx, 1)
      if (coveredText) {
        for (const nb of this.removeSubstringAndSplit(best.branchQuery, coveredText)) {
          if (nb && nb !== best.branchQuery) branches.push(nb)
          if (branches.length >= 12) break
        }
      }
    }

    return results.slice(0, limit)
  }

  private findLongestCoveredSubstring(queryText: string, sourceText: string): string {
    const queryWords = tokenizeText(queryText)
    const sourceSet = new Set(tokenizeText(sourceText))
    let longest = ""
    for (let i = 0; i < queryWords.length; i++) {
      for (let j = i + 1; j <= queryWords.length; j++) {
        const slice = queryWords.slice(i, j)
        if (slice.every(w => sourceSet.has(w))) {
          const s = slice.join(" ")
          if (s.length > longest.length) longest = s
        }
      }
    }
    return longest
  }

  private removeSubstringAndSplit(queryText: string, coveredSubstring: string): string[] {
    if (!coveredSubstring) return []
    const q = tokenizeText(queryText).join(" ")
    const c = tokenizeText(coveredSubstring).join(" ")
    return (" " + q + " ").replace(` ${c} `, " | ").trim().split("|").map(s => s.trim()).filter(Boolean)
  }

  private addInverted(
    inv: Map<string, Set<string>>, df: Map<string, number>, token: string, cellId: string,
  ): void {
    let set = inv.get(token)
    if (!set) { set = new Set(); inv.set(token, set) }
    if (!set.has(cellId)) {
      set.add(cellId)
      df.set(token, (df.get(token) ?? 0) + 1)
    }
  }

  private removeInverted(
    inv: Map<string, Set<string>>, df: Map<string, number>, token: string, cellId: string,
  ): void {
    const set = inv.get(token)
    if (!set) return
    if (set.delete(cellId)) {
      const next = (df.get(token) ?? 1) - 1
      if (next <= 0) { df.delete(token); if (set.size === 0) inv.delete(token) }
      else df.set(token, next)
    }
  }
}
