// Virtual source cells — the pure core (spec:
// docs/superpowers/specs/2026-11-06-virtual-source-cells-file-revisions.md,
// decision docs/decisions/0007-file-revisions-and-derived-source-cells.md).
//
// A file's source side is DERIVED: an immutable artifact, a filter stamp, and a
// chain of revisions. Each revision is one parse of one blob, aligned against
// the previous revision so every unit carries a stable cell id (identity across
// revisions) and a content hash (what was translated). This module is the one
// place that decides what an upstream change *is* — equal, changed, moved,
// inserted or deleted — so re-import, link sync, DCS, Drive and git connectors
// all mean the same thing by it.
//
// Pure and dependency-free on purpose: it runs in the browser, the parse Web
// Worker and the sync-worker (which has no `uuid` dependency), so the SHA-1 /
// UUIDv5 it needs are implemented here and pinned against the `uuid` package
// in the test.

// ---------------------------------------------------------------------------
// Hashing primitives
// ---------------------------------------------------------------------------

/** SHA-1 of a UTF-8 string, as 20 bytes. Small, sync, no imports. */
export function sha1Bytes(input: Uint8Array): Uint8Array {
  const length = input.length
  const words: number[] = []
  for (let i = 0; i < length; i++) words[i >> 2] |= input[i] << (24 - (i % 4) * 8)
  words[length >> 2] |= 0x80 << (24 - (length % 4) * 8)
  words[(((length + 8) >> 6) << 4) + 15] = length * 8
  for (let i = 0; i < words.length; i++) words[i] = words[i] | 0

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Array<number>(80)
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[block + t] | 0
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]
      w[t] = (x << 1) | (x >>> 31)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let t = 0; t < 80; t++) {
      let f: number
      let k: number
      if (t < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (t < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) | 0
      e = d
      d = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = temp
    }
    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
  }
  const out = new Uint8Array(20)
  const view = new DataView(out.buffer)
  view.setInt32(0, h0)
  view.setInt32(4, h1)
  view.setInt32(8, h2)
  view.setInt32(12, h3)
  view.setInt32(16, h4)
  return out
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"))

function bytesToHex(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]]
  return s
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "")
  if (hex.length !== 32 || /[^0-9a-f]/i.test(hex)) throw new Error(`not a UUID: ${uuid}`)
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * RFC 4122 version-5 UUID (SHA-1 of namespace bytes + UTF-8 name), identical
 * to `uuid`'s `v5(name, namespace)`. Used for every derived id and hash here so
 * one primitive carries the whole scheme.
 */
export function uuidV5(name: string, namespace: string): string {
  const ns = uuidToBytes(namespace)
  const nameBytes = new TextEncoder().encode(name)
  const input = new Uint8Array(ns.length + nameBytes.length)
  input.set(ns, 0)
  input.set(nameBytes, ns.length)
  const digest = sha1Bytes(input).slice(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = bytesToHex(digest)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ---------------------------------------------------------------------------
// Filter stamps
// ---------------------------------------------------------------------------

/**
 * `<filterId>@<walk>` — the same shape as `files.meta.parserVersion`
 * (decision 0001) and `FormatSkeleton{formatId, walkVersion}`. Same stamp +
 * same bytes + same options ⇒ the same unit list, byte for byte.
 */
export interface FilterStamp {
  readonly filterId: string
  readonly walk: number
}

export function formatFilterStamp(stamp: FilterStamp): string {
  return `${stamp.filterId}@${stamp.walk}`
}

/** A stamp with no `@<n>` is walk 1 — the rule AQU-2382 fixed on the read side. */
export function parseFilterStamp(raw: string): FilterStamp {
  const at = raw.lastIndexOf("@")
  if (at < 0) return { filterId: raw, walk: 1 }
  const walk = Number(raw.slice(at + 1))
  if (!Number.isInteger(walk) || walk < 1) return { filterId: raw, walk: 1 }
  return { filterId: raw.slice(0, at), walk }
}

const OPTIONS_NS = "3f1a6b2e-8f1c-4a2e-9a0e-5c0c7a1d2b47"

/**
 * Stable hash of the parse options (cellUnit, partner profile, …). Key order
 * does not matter; `undefined` values are dropped so `{}` and
 * `{cellUnit: undefined}` hash the same.
 */
export function optionsHash(options: Readonly<Record<string, unknown>> | undefined): string {
  return uuidV5(stableJson(options ?? {}), OPTIONS_NS)
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`
}

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

const CONTENT_NS = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
const APOSTROPHE_VARIANTS = /[‘’ʼ´`]/g

/**
 * The normalization ICE matching already uses
 * (`sync-worker/src/events/import-content-match.ts::normalizeForMatch`): soft
 * hyphens out, apostrophes unified, whitespace collapsed. Two sources that
 * differ only this much were translated as the same thing.
 */
export function normalizeSourceText(value: string): string {
  return value.replace(/­/g, "").replace(APOSTROPHE_VARIANTS, "'").replace(/\s+/g, " ").trim()
}

/** What was translated: a 122-bit hash of the normalized source text. */
export function contentHashOf(text: string): string {
  return uuidV5(normalizeSourceText(text), CONTENT_NS)
}

// ---------------------------------------------------------------------------
// Units, manifests, ids
// ---------------------------------------------------------------------------

/** One parse output, before alignment has given it an identity. */
export interface RevisionUnitInput {
  /**
   * The locator-derived key (`aquillaImport.unitKey`): a scripture ref, a JSON
   * key path, an XLIFF trans-unit id, or for documents a structural path with
   * an occurrence suffix. Unique within one parse.
   */
  readonly unitKey: string
  /**
   * `true` when the key encodes position (paragraph 7 of member X) and so
   * cannot pair units across an insertion. Reference-addressed units pair by
   * key; positional units pair by alignment.
   */
  readonly positional: boolean
  readonly text: string
  readonly html?: string
  readonly type?: string
  readonly canonicalRef?: string
  readonly sequenceIndex: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** A unit that has been through alignment: it knows which cell it is. */
export interface RevisionUnit extends RevisionUnitInput {
  readonly cellId: string
  readonly contentHash: string
}

export interface RevisionManifest {
  readonly fileId: string
  readonly revisionN: number
  readonly parentRevisionN: number | null
  readonly stamp: string
  readonly optionsHash: string
  readonly artifactSha256: string
  /** In document order. */
  readonly units: readonly RevisionUnit[]
}

/**
 * Identity for a unit that has no ancestor: revision 1 derives it from the
 * unit key alone, a later revision folds the revision number in so an insert
 * can never collide with an id revision 1 minted for a unit that was later
 * deleted and re-added at the same key. The file id is the UUIDv5 namespace,
 * so ids are unique per file and cannot collide across projects.
 */
export function revisionCellId(fileId: string, revisionN: number, unitKey: string): string {
  return uuidV5(revisionN === 1 ? `cell:${unitKey}` : `cell:r${revisionN}:${unitKey}`, fileId)
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

export type UnitOutcome = "equal" | "changed" | "moved" | "inserted"

export interface AlignedUnit {
  readonly unit: RevisionUnit
  readonly outcome: UnitOutcome
  /** The parent unit this one continues, for everything but `inserted`. */
  readonly parent?: RevisionUnit
}

export interface RevisionDelta {
  /** Every next-revision unit, in document order, with its cell id. */
  readonly units: readonly AlignedUnit[]
  /** Parent units with no continuation. Tombstoned, never hard-deleted. */
  readonly deleted: readonly RevisionUnit[]
  readonly counts: Readonly<Record<UnitOutcome | "deleted", number>>
}

/** Below this token-Dice similarity an old/new pair in a gap is delete + insert. */
export const CHANGED_SIMILARITY_THRESHOLD = 0.6

/**
 * Align a new parse against the previous revision's manifest.
 *
 * 1. Reference-addressed units pair by `unitKey`.
 * 2. Positional units pair by longest common subsequence over `contentHash`
 *    (patience style: unique hashes anchor, LIS over parent order). In each
 *    gap, leftover old/new runs pair in order when similar enough → `changed`;
 *    an identical hash left over elsewhere → `moved`; the rest are
 *    `inserted` / `deleted`.
 *
 * Pure: the same `(parent, next)` always yields the same ids, so a revision
 * chain can be replayed.
 */
export function alignRevision(
  parent: RevisionManifest | null,
  next: readonly RevisionUnitInput[],
  target: { readonly fileId: string; readonly revisionN: number },
): RevisionDelta {
  assertUniqueKeys(next)
  const hashed = next.map((u) => ({ input: u, hash: contentHashOf(u.text) }))
  const continuation = new Map<number, { parent: RevisionUnit; outcome: UnitOutcome }>()
  const consumedParents = new Set<number>()
  const parentUnits = parent?.units ?? []

  if (parent) {
    // Step 1 — keyed units.
    const parentByKey = new Map<string, number>()
    parentUnits.forEach((p, i) => {
      if (!p.positional) parentByKey.set(p.unitKey, i)
    })
    hashed.forEach((h, i) => {
      if (h.input.positional) return
      const pi = parentByKey.get(h.input.unitKey)
      if (pi === undefined) return
      const p = parentUnits[pi]
      consumedParents.add(pi)
      continuation.set(i, { parent: p, outcome: p.contentHash === h.hash ? "equal" : "changed" })
    })

    // Step 2 — positional units.
    const oldIdx = parentUnits.map((_, i) => i).filter((i) => parentUnits[i].positional && !consumedParents.has(i))
    const newIdx = hashed.map((_, i) => i).filter((i) => hashed[i].input.positional && !continuation.has(i))
    const anchors = lcsByHash(
      oldIdx.map((i) => parentUnits[i].contentHash),
      newIdx.map((i) => hashed[i].hash),
    )
    for (const [o, n] of anchors) {
      consumedParents.add(oldIdx[o])
      continuation.set(newIdx[n], { parent: parentUnits[oldIdx[o]], outcome: "equal" })
    }

    // Gaps between consecutive anchors: pair in order by similarity.
    const bounds: Array<[number, number]> = [...anchors, [oldIdx.length, newIdx.length]]
    let prevO = -1
    let prevN = -1
    const leftoverOld: number[] = []
    const leftoverNew: number[] = []
    for (const [o, n] of bounds) {
      const gapOld = oldIdx.slice(prevO + 1, o)
      const gapNew = newIdx.slice(prevN + 1, n)
      const { unpairedOld, unpairedNew } = pairGap(gapOld, gapNew, parentUnits, hashed, continuation, consumedParents)
      leftoverOld.push(...unpairedOld)
      leftoverNew.push(...unpairedNew)
      prevO = o
      prevN = n
    }

    // Moves: a leftover old hash that reappears among leftover new units.
    const oldByHash = new Map<string, number[]>()
    for (const i of leftoverOld) {
      const list = oldByHash.get(parentUnits[i].contentHash) ?? []
      list.push(i)
      oldByHash.set(parentUnits[i].contentHash, list)
    }
    for (const ni of leftoverNew) {
      const list = oldByHash.get(hashed[ni].hash)
      const oi = list?.shift()
      if (oi === undefined) continue
      consumedParents.add(oi)
      continuation.set(ni, { parent: parentUnits[oi], outcome: "moved" })
    }
  }

  const counts: Record<UnitOutcome | "deleted", number> = { equal: 0, changed: 0, moved: 0, inserted: 0, deleted: 0 }
  const units: AlignedUnit[] = hashed.map((h, i) => {
    const cont = continuation.get(i)
    const cellId = cont ? cont.parent.cellId : revisionCellId(target.fileId, target.revisionN, h.input.unitKey)
    const outcome: UnitOutcome = cont ? cont.outcome : "inserted"
    counts[outcome]++
    const unit: RevisionUnit = { ...h.input, cellId, contentHash: h.hash }
    return cont ? { unit, outcome, parent: cont.parent } : { unit, outcome }
  })
  const deleted = parentUnits.filter((_, i) => !consumedParents.has(i))
  counts.deleted = deleted.length
  return { units, deleted, counts }
}

function assertUniqueKeys(units: readonly RevisionUnitInput[]): void {
  const seen = new Set<string>()
  for (const u of units) {
    if (seen.has(u.unitKey)) throw new Error(`duplicate unitKey in one parse: ${u.unitKey}`)
    seen.add(u.unitKey)
  }
}

function pairGap(
  gapOld: readonly number[],
  gapNew: readonly number[],
  parentUnits: readonly RevisionUnit[],
  hashed: ReadonlyArray<{ input: RevisionUnitInput; hash: string }>,
  continuation: Map<number, { parent: RevisionUnit; outcome: UnitOutcome }>,
  consumedParents: Set<number>,
): { unpairedOld: number[]; unpairedNew: number[] } {
  const unpairedOld: number[] = []
  const unpairedNew: number[] = []
  let oi = 0
  let ni = 0
  // Walk both runs in order. Pair when similar enough; otherwise advance the
  // side whose remaining run is longer so a lone insert does not swallow the
  // next old paragraph's continuation.
  while (oi < gapOld.length && ni < gapNew.length) {
    const p = parentUnits[gapOld[oi]]
    const q = hashed[gapNew[ni]]
    if (p.contentHash === q.hash || diceSimilarity(p.text, q.input.text) >= CHANGED_SIMILARITY_THRESHOLD) {
      consumedParents.add(gapOld[oi])
      continuation.set(gapNew[ni], { parent: p, outcome: p.contentHash === q.hash ? "equal" : "changed" })
      oi++
      ni++
      continue
    }
    if (gapOld.length - oi > gapNew.length - ni) unpairedOld.push(gapOld[oi++])
    else unpairedNew.push(gapNew[ni++])
  }
  while (oi < gapOld.length) unpairedOld.push(gapOld[oi++])
  while (ni < gapNew.length) unpairedNew.push(gapNew[ni++])
  return { unpairedOld, unpairedNew }
}

/**
 * Patience-style LCS over two hash sequences: hashes unique in both sides are
 * anchors; the longest increasing subsequence of their parent positions is the
 * alignment. O(n log n), and robust to the repeated short paragraphs ("Amen.")
 * that make a plain LCS pair the wrong twins.
 */
function lcsByHash(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const countA = new Map<string, number>()
  const countB = new Map<string, number>()
  for (const h of a) countA.set(h, (countA.get(h) ?? 0) + 1)
  for (const h of b) countB.set(h, (countB.get(h) ?? 0) + 1)
  const posA = new Map<string, number>()
  a.forEach((h, i) => {
    if (countA.get(h) === 1 && countB.get(h) === 1) posA.set(h, i)
  })
  const candidates: Array<[number, number]> = []
  b.forEach((h, j) => {
    const i = posA.get(h)
    if (i !== undefined) candidates.push([i, j])
  })
  // LIS over `i` (candidates are already ordered by `j`).
  const tails: number[] = []
  const tailIdx: number[] = []
  const prev = new Array<number>(candidates.length).fill(-1)
  candidates.forEach(([i], k) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < i) lo = mid + 1
      else hi = mid
    }
    tails[lo] = i
    tailIdx[lo] = k
    prev[k] = lo > 0 ? tailIdx[lo - 1] : -1
  })
  const out: Array<[number, number]> = []
  for (let k = tailIdx[tails.length - 1]; k !== undefined && k >= 0; k = prev[k]) out.push(candidates[k])
  return out.reverse()
}

/** Token Dice coefficient on normalized text; 1 for identical, 0 for disjoint. */
export function diceSimilarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 && tb.size === 0) return 1
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return (2 * shared) / (ta.size + tb.size)
}

function tokens(text: string): Set<string> {
  return new Set(
    normalizeSourceText(text)
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter(Boolean),
  )
}

// ---------------------------------------------------------------------------
// Staleness (the AD-9 pin, in pure form)
// ---------------------------------------------------------------------------

export type TargetStaleness = "fresh" | "stale" | "source-deleted"

/**
 * A target is stale when the source moved on past the revision it was pinned
 * to AND the unit's content actually changed. A unit whose text came back to
 * what the target was translated against is fresh again (Weblate's revert
 * rule), so a no-op upstream round trip never flags anything.
 */
export function classifyTargetStaleness(
  pinned: { readonly revisionN: number; readonly contentHash: string },
  head: { readonly revisionN: number; readonly contentHash: string | null },
): TargetStaleness {
  if (head.contentHash === null) return "source-deleted"
  if (head.revisionN <= pinned.revisionN) return "fresh"
  return head.contentHash === pinned.contentHash ? "fresh" : "stale"
}
