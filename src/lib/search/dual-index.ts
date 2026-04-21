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
