/**
 * Ground-truth edit scripts for identity reconciliation. Each generated
 * revision knows exactly which previous unit every current unit descends from,
 * so precision and recall of reconcile() can be measured, not eyeballed.
 */
import fc from "fast-check"
import { sentence, unit } from "./helpers.ts"
import type { ContentUnit } from "../src/core/types.ts"

export type Op =
  | { kind: "modify"; at: number; word: number }
  | { kind: "insert"; at: number; seed: number }
  | { kind: "delete"; at: number }
  | { kind: "move"; from: number; to: number }
  | { kind: "split"; at: number }
  | { kind: "merge"; at: number }

export interface Truth {
  readonly text: string
  /** Ground-truth ancestors (previous ids). */
  readonly from: string[]
  readonly how: "unchanged" | "modified" | "inserted" | "moved" | "split" | "merged"
}

export const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("modify" as const), at: fc.nat(), word: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("insert" as const), at: fc.nat(), seed: fc.integer({ min: 10_000, max: 99_999 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("delete" as const), at: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("move" as const), from: fc.nat(), to: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("split" as const), at: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("merge" as const), at: fc.nat() }) },
)

const REPLACEMENTS = ["blue", "quiet", "golden", "northern", "ancient", "gentle"]

export const applyScript = (initial: readonly string[], ops: readonly Op[]): { prev: ContentUnit[]; truth: Truth[] } => {
  const prev = initial.map((t, i) => unit(t, i, { id: `p${i}` }))
  let cur: Truth[] = prev.map((u) => ({ text: u.tagged, from: [u.logicalId], how: "unchanged" }))
  const touched = new Set<number>()
  for (const op of ops) {
    if (cur.length === 0 && op.kind !== "insert") continue
    switch (op.kind) {
      case "modify": {
        const i = op.at % cur.length
        const t = cur[i]!
        const w = t.text.split(" ")
        const k = op.word % w.length
        w[k] = REPLACEMENTS[op.word % REPLACEMENTS.length]!
        const text = w.join(" ")
        if (text === t.text) break
        cur[i] = { text, from: t.from, how: t.how === "inserted" ? "inserted" : t.how === "split" || t.how === "merged" ? t.how : "modified" }
        break
      }
      case "insert":
        cur.splice(op.at % (cur.length + 1), 0, { text: sentence(op.seed), from: [], how: "inserted" })
        break
      case "delete":
        cur.splice(op.at % cur.length, 1)
        break
      case "move": {
        const [t] = cur.splice(op.from % cur.length, 1)
        cur.splice(op.to % (cur.length + 1), 0, { ...t!, how: t!.how === "unchanged" ? "moved" : t!.how })
        break
      }
      case "split": {
        const i = op.at % cur.length
        const t = cur[i]!
        const w = t.text.split(" ")
        if (w.length < 8 || t.how === "inserted") break
        const mid = Math.floor(w.length / 2)
        const a = { text: w.slice(0, mid).join(" "), from: t.from, how: "split" as const }
        const b = { text: w.slice(mid).join(" "), from: t.from, how: "split" as const }
        cur.splice(i, 1, a, b)
        break
      }
      case "merge": {
        const i = op.at % cur.length
        if (i + 1 >= cur.length) break
        const a = cur[i]!
        const b = cur[i + 1]!
        if (a.how === "inserted" || b.how === "inserted") break
        cur.splice(i, 2, { text: `${a.text} ${b.text}`, from: [...a.from, ...b.from], how: "merged" })
        break
      }
    }
    void touched
  }
  // De-duplicate identical texts (keeps the generator free of accidental duplicates).
  const seen = new Set<string>()
  cur = cur.filter((t) => (seen.has(t.text) ? false : (seen.add(t.text), true)))
  return { prev, truth: cur }
}
