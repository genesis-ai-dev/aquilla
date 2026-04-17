import { tokenizeText } from "./tokenizer"

export interface BM25Doc {
  cellId: string
  source: string
  target: string
  fileId: string
}

export interface BM25Candidate extends BM25Doc {
  score: number
}

interface IndexedDoc extends BM25Doc {
  tokens: string[]
  tokenSet: Set<string>
  tf: Map<string, number>
  length: number
}

const K1 = 1.5
const B = 0.75

export class BM25Index {
  private docs: Map<string, IndexedDoc> = new Map()
  private docFreq: Map<string, number> = new Map()
  private totalLength = 0

  get size(): number {
    return this.docs.size
  }

  clear(): void {
    this.docs.clear()
    this.docFreq.clear()
    this.totalLength = 0
  }

  addDoc(doc: BM25Doc): void {
    this.removeDoc(doc.cellId)
    const tokens = tokenizeText(doc.source)
    const tokenSet = new Set(tokens)
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
    const indexed: IndexedDoc = {
      ...doc,
      tokens,
      tokenSet,
      tf,
      length: tokens.length,
    }
    this.docs.set(doc.cellId, indexed)
    this.totalLength += tokens.length
    for (const t of tokenSet) {
      this.docFreq.set(t, (this.docFreq.get(t) || 0) + 1)
    }
  }

  removeDoc(cellId: string): void {
    const existing = this.docs.get(cellId)
    if (!existing) return
    this.totalLength -= existing.length
    for (const t of existing.tokenSet) {
      const count = this.docFreq.get(t) || 1
      if (count <= 1) this.docFreq.delete(t)
      else this.docFreq.set(t, count - 1)
    }
    this.docs.delete(cellId)
  }

  getDoc(cellId: string): BM25Doc | undefined {
    const d = this.docs.get(cellId)
    if (!d) return undefined
    return { cellId: d.cellId, source: d.source, target: d.target, fileId: d.fileId }
  }

  search(query: string, limit: number): BM25Candidate[] {
    if (this.docs.size === 0) return []
    const queryTokens = Array.from(new Set(tokenizeText(query)))
    if (queryTokens.length === 0) return []

    const avgdl = this.totalLength / this.docs.size
    const N = this.docs.size

    const idf = new Map<string, number>()
    for (const t of queryTokens) {
      const df = this.docFreq.get(t) || 0
      // Standard BM25+ IDF — floor at 0 so common words don't subtract score
      idf.set(t, Math.max(0, Math.log((N - df + 0.5) / (df + 0.5) + 1)))
    }

    const results: BM25Candidate[] = []
    for (const doc of this.docs.values()) {
      let score = 0
      const lenNorm = 1 - B + B * (doc.length / (avgdl || 1))
      for (const t of queryTokens) {
        const tf = doc.tf.get(t)
        if (!tf) continue
        const w = idf.get(t) || 0
        if (w === 0) continue
        score += w * ((tf * (K1 + 1)) / (tf + K1 * lenNorm))
      }
      if (score > 0) {
        results.push({
          cellId: doc.cellId,
          source: doc.source,
          target: doc.target,
          fileId: doc.fileId,
          score,
        })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }
}
