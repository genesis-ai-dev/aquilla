// The editor reconstructs anchor order locally. Transport pages use immutable
// identity, not mutable sequence_index/anchor positions, so concurrent deletes
// cannot shift an unchanged row behind the cursor. Inserts behind it are
// recovered by the delta from the FIRST page's safe watermark.
export interface CellsScanCursor {
  version: 1
  scope: string
  after: [string, string, string]
  seq: number
  epoch: number
  rebuiltSeq: number
  total: number
}

export function encodeCellsScanCursor(cursor: CellsScanCursor): string {
  return btoa(encodeURIComponent(JSON.stringify(cursor)))
}

export function decodeCellsScanCursor(value: string, scope: string): CellsScanCursor | null {
  try {
    if (value.length > 16_384) return null
    const c = JSON.parse(decodeURIComponent(atob(value))) as CellsScanCursor
    if (c.version !== 1 || c.scope !== scope || !Array.isArray(c.after) || c.after.length !== 3
      || !c.after.every((part) => typeof part === "string")
      || ![c.seq, c.epoch, c.rebuiltSeq, c.total].every((n) => Number.isSafeInteger(n) && n >= 0)) return null
    return c
  } catch {
    return null
  }
}
