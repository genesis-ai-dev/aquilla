// Who's Who on the target column (AQU-1694): tints drawn with the CSS Custom
// Highlight API.
//
// The target column renders through several paths (plain text with rule
// marks and term chips, USFM segments, rich HTML), and its words cannot
// become buttons. So a target tint changes no DOM: each rendered row
// registers which runs of its tokens refer to which participant, and this
// layer paints them as `::highlight()` ranges (src/index.css). Hover lights a
// participant through the same MentionHighlightStore as the source column,
// without re-rendering a single row.
//
// A run is placed only when the rendered text tokenizes exactly as the text
// the bridges aligned (same `tokenize` tokens, in order). A row whose
// rendering adds or drops words (a footnote chip, an inline marker) gets no
// tints rather than tints on the wrong words. Browsers without the API draw
// nothing; the source column still has every mention.

import { tokenSpans } from "@/lib/completion/tokenize"
import type { BkpEntityId } from "@/lib/bible-data/pack-types"
import type { MentionHighlightStore } from "./mention-highlight-store"

/** A participant on a run of the target's tokens. */
export interface TintRun {
  firstToken: number
  lastToken: number
  entity: BkpEntityId
  /** Thread colour 1–6 for "always" mode; null for a neutral tint. */
  slot: number | null
  approximate: boolean
}

export interface TintRegistration {
  root: HTMLElement
  /** `tokenize(targetText)`: what the rendered text must read as. */
  tokens: readonly string[]
  runs: readonly TintRun[]
  store: MentionHighlightStore
  /** "Always" highlight mode: every run tinted in its thread colour. */
  always: boolean
}

interface HighlightRegistry {
  set(name: string, highlight: unknown): void
  delete(name: string): boolean
}
type HighlightCtor = new (...ranges: Range[]) => unknown

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight
  return css?.highlights && Highlight ? { registry: css.highlights, Highlight } : null
}

/** The names `src/index.css` styles. */
export function highlightName(kind: "lit" | number, approximate: boolean): string {
  const base = kind === "lit" ? "aq-mention-lit" : `aq-mention-slot-${kind}`
  return approximate ? `${base}-approx` : base
}

const registrations = new Map<string, TintRegistration>()
const storeSubscriptions = new Map<MentionHighlightStore, { count: number; unsubscribe: () => void }>()
const painted = new Set<string>()
let scheduled = false

/** The root's visible text, and where each character sits in the DOM. */
function textOf(root: HTMLElement): { text: string; at: (offset: number) => { node: Text; offset: number } | null } {
  const nodes: Text[] = []
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("[data-presence-ignore]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  const text = nodes.map((node) => node.data).join("")
  return {
    text,
    at(offset) {
      let remaining = offset
      for (const node of nodes) {
        if (remaining <= node.data.length) return { node, offset: remaining }
        remaining -= node.data.length
      }
      return null
    },
  }
}

/** The ranges each highlight name should hold now. */
export function collectRanges(all: Iterable<TintRegistration>): Map<string, Range[]> {
  const out = new Map<string, Range[]>()
  const add = (name: string, range: Range) => {
    const list = out.get(name)
    if (list) list.push(range)
    else out.set(name, [range])
  }
  for (const registration of all) {
    if (!registration.root.isConnected) continue
    const lit = registration.store.lit()
    const runs = registration.runs.filter((run) => registration.always || run.entity === lit)
    if (runs.length === 0) continue
    const dom = textOf(registration.root)
    const tokens = tokenSpans(dom.text)
    if (tokens.length !== registration.tokens.length || tokens.some((token, k) => token.token !== registration.tokens[k])) continue
    for (const run of runs) {
      const first = tokens[run.firstToken]
      const last = tokens[run.lastToken]
      const start = first ? dom.at(first.start) : null
      const end = last ? dom.at(last.end) : null
      if (!start || !end) continue
      const range = registration.root.ownerDocument.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      add(highlightName(run.entity === lit ? "lit" : (run.slot ?? 0), run.approximate), range)
    }
  }
  return out
}

function paint(): void {
  scheduled = false
  const api = highlightApi()
  if (!api) return
  const ranges = collectRanges(registrations.values())
  for (const name of painted) if (!ranges.has(name)) api.registry.delete(name)
  painted.clear()
  for (const [name, list] of ranges) {
    api.registry.set(name, new api.Highlight(...list))
    painted.add(name)
  }
}

/** Repaint on the next frame (many rows register in one render). */
export function scheduleTintPaint(): void {
  if (scheduled || !highlightApi()) return
  scheduled = true
  const raf = globalThis.requestAnimationFrame ?? ((callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
  raf(() => paint())
}

/** Show a row's target tints until the returned function is called. */
export function registerTargetTints(key: string, registration: TintRegistration): () => void {
  registrations.set(key, registration)
  const held = storeSubscriptions.get(registration.store)
  if (held) held.count++
  else storeSubscriptions.set(registration.store, { count: 1, unsubscribe: registration.store.subscribe(scheduleTintPaint) })
  scheduleTintPaint()
  return () => {
    if (registrations.get(key) === registration) registrations.delete(key)
    const subscription = storeSubscriptions.get(registration.store)
    if (subscription && --subscription.count === 0) {
      subscription.unsubscribe()
      storeSubscriptions.delete(registration.store)
    }
    scheduleTintPaint()
  }
}
