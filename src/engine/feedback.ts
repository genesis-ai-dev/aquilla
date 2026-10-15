/**
 * Bidirectional feedback (spec §3): people edit the *published target file*
 * in their own tool (InDesign, a text editor, a CMS). We detect those edits,
 * record them as human decisions, and suggest reusable corrections — so a fix
 * made once can propagate.
 */
import { shortHash } from "../core/hash.ts"
import { contentHashOf } from "../core/ledger.ts"
import type { PublishRecord } from "../core/ledger.ts"
import { reconcile } from "../core/reconcile.ts"
import { plainOf } from "../core/tagged.ts"
import type { ContentUnit } from "../core/types.ts"

export interface DetectedEdit {
  readonly logicalId: string
  readonly structuralPath: string
  readonly sourceHash: string
  readonly basedOn: string
  readonly before: string
  readonly after: string
}

export interface FeedbackResult {
  readonly edits: DetectedEdit[]
  /** Units in the edited target that could not be traced to a published unit (added by the editor). */
  readonly untraced: string[]
  /** Published units the editor removed. */
  readonly removed: string[]
  readonly aligned: "positional" | "reconciled"
}

/**
 * Compare the units of the published file (`baseUnits`, extracted from the
 * blob we published) with the units of the file as it is now.
 */
export const detectEdits = (publish: PublishRecord, baseUnits: readonly ContentUnit[], currentUnits: readonly ContentUnit[]): FeedbackResult => {
  const byPath = new Map(publish.units.map((u) => [u.structuralPath, u]))
  const edits: DetectedEdit[] = []
  const positional =
    baseUnits.length === currentUnits.length && baseUnits.every((u, i) => u.structuralPath === currentUnits[i]!.structuralPath)
  if (positional) {
    baseUnits.forEach((b, i) => {
      const c = currentUnits[i]!
      if (b.contentHash === c.contentHash) return
      const pub = byPath.get(b.structuralPath)
      if (!pub) return
      edits.push({ logicalId: pub.logicalId, structuralPath: b.structuralPath, sourceHash: pub.sourceHash, basedOn: pub.contentHash, before: b.tagged, after: c.tagged })
    })
    return { edits, untraced: [], removed: [], aligned: "positional" }
  }
  // The editor changed structure (added/removed paragraphs). Use the same
  // identity reconciliation we use for sources, keyed by structural path.
  const base = baseUnits.map((u) => ({ ...u, logicalId: u.structuralPath }))
  const mapping = reconcile(base, currentUnits, { salt: "target" })
  const untraced: string[] = []
  for (const m of mapping.matches) {
    const c = currentUnits[m.index]!
    const edited = m.status === "modified" || (m.status === "moved" && m.similarity < 1)
    if (edited) {
      const path = m.predecessors[0]!
      const pub = byPath.get(path)
      const b = base.find((x) => x.logicalId === path)
      if (pub && b) edits.push({ logicalId: pub.logicalId, structuralPath: path, sourceHash: pub.sourceHash, basedOn: pub.contentHash, before: b.tagged, after: c.tagged })
    } else if (m.status !== "unchanged" && m.status !== "moved") untraced.push(c.structuralPath)
  }
  return { edits, untraced, removed: mapping.deleted, aligned: "reconciled" }
}

export interface CorrectionSuggestion {
  readonly id: string
  readonly from: string
  readonly to: string
}

const words = (s: string): string[] => s.split(/\s+/).filter(Boolean)
const trimPunct = (s: string): string => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")

/**
 * If a human edit replaced one short phrase with another, suggest it as a
 * reusable correction for the locale. Larger rewrites are recorded as edits
 * only — guessing a rule from them would be noise.
 */
export const suggestCorrection = (locale: string, before: string, after: string): CorrectionSuggestion | undefined => {
  const a = words(plainOf(before))
  const b = words(plainOf(after))
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const from = trimPunct(a.slice(pre, a.length - suf).join(" "))
  const to = trimPunct(b.slice(pre, b.length - suf).join(" "))
  const fromN = words(from).length
  const toN = words(to).length
  if (!from || !to || from === to || fromN > 3 || toN > 4) return undefined
  return { id: `c${shortHash(`${locale}|${from}|${to}`).slice(0, 10)}`, from, to }
}

export const editHash = (content: string): string => contentHashOf(content)
