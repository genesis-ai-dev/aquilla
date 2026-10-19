// The structure leg of knowledge-base indexing (spec §"Data model"): markdown
// headings when a document has them, else paragraph blocks. Deterministic and
// local; index-doc.ts adds the summaries.
//
// AQU-2033: the tree is capped at MAX_NODES, and the cap used to truncate.
// Blocks stayed ~BLOCK_TARGET chars and headings were taken in order, so on a
// document past the cap the last node ran to the end of the text. On dev, a
// 1.9M-char Arabic Old Testament got 199 blocks of Genesis and Exodus, and
// node 200 held the other 83%. The model reads only each node's opening, so
// the doc summary described two books, and kb_read of that node returned
// 1.5M chars. A document past the cap is now cut at evenly spaced points, so
// its nodes tile the whole text at comparable lengths.
import type { KnowledgeNode } from "../../../../db/shared/knowledge"

export const MAX_NODES = 200
const MAX_DEPTH = 3
const BLOCK_TARGET = 2000

const HEADING_RE = /^(#{1,3})\s+(.+)$/gm

/** Where a headingless block may end, best first. */
const BREAKS = ["\n\n", "\n", " "] as const

interface Heading {
  level: number
  title: string
  start: number
}

interface FlatNode {
  level: number
  title: string
  charStart: number
  charEnd: number
}

export function segmentText(text: string): KnowledgeNode[] {
  const headings: Heading[] = []
  for (const m of text.matchAll(HEADING_RE)) {
    headings.push({ level: m[1].length, title: m[2].trim(), start: m.index ?? 0 })
  }
  return nest(headings.length >= 2 ? headingNodes(text, headings) : blockNodes(text))
}

/** One node per heading, running to the next one. Past MAX_NODES, runs of
 *  consecutive headings merge into groups of about equal length. */
function headingNodes(text: string, headings: Heading[]): FlatNode[] {
  const sections: FlatNode[] = headings.map((h, i) => ({
    level: Math.min(h.level, MAX_DEPTH),
    title: h.title,
    charStart: h.start,
    charEnd: i + 1 < headings.length ? headings[i + 1].start : text.length,
  }))
  // Preamble before the first heading becomes its own node.
  if (headings[0].start > 0) {
    sections.unshift({ level: 1, title: "Introduction", charStart: 0, charEnd: headings[0].start })
  }
  if (sections.length <= MAX_NODES) return sections

  // A group can only start at a heading. Within reach of each cut, the
  // highest-level heading wins (a book over a chapter), so the groups follow
  // the document's outline: a heading is passed over only when another of
  // its level is nearer the same cut. Any heading may follow the last cut,
  // since a group is whole sections and can never be a sliver.
  const cuts = new Set(evenCuts(text.length, MAX_NODES, 1, (ideal, lo, hi) => {
    let best: FlatNode | null = null
    for (let i = firstStartingAt(sections, lo); i < sections.length && sections[i].charStart <= hi; i++) {
      const s = sections[i]
      if (
        !best ||
        s.level < best.level ||
        (s.level === best.level && Math.abs(s.charStart - ideal) < Math.abs(best.charStart - ideal))
      ) best = s
    }
    return best?.charStart ?? null
  }))
  const groups: FlatNode[][] = []
  for (const s of sections) {
    if (groups.length && !cuts.has(s.charStart)) groups[groups.length - 1].push(s)
    else groups.push([s])
  }
  return groups.map((group) => {
    const first = group[0]
    const last = group[group.length - 1]
    return {
      // A group sits in the outline where its first heading does.
      level: first.level,
      title: group.length > 1 ? `${first.title} – ${last.title}` : first.title,
      charStart: first.charStart,
      charEnd: last.charEnd,
    }
  })
}

/** Index of the first section starting at or after `pos`. */
function firstStartingAt(sections: FlatNode[], pos: number): number {
  let lo = 0
  let hi = sections.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sections[mid].charStart < pos) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Headingless text: paragraph blocks of about BLOCK_TARGET chars, or of
 *  length / MAX_NODES once the text is too long for that. The blocks tile the
 *  full text with no gaps. */
function blockNodes(text: string): FlatNode[] {
  if (!text.length) return []
  const count = Math.min(MAX_NODES, Math.ceil(text.length / BLOCK_TARGET))
  // A quarter span apart at least, so a run of blank lines can't make a
  // block of whitespace between two cuts.
  const minLength = text.length / count / 4
  const cuts = evenCuts(text.length, count, minLength, (ideal, lo, hi) => nearestBreak(text, ideal, lo, hi))
  const bounds = [0, ...cuts, text.length]
  return bounds.slice(1).map((end, i) => {
    const start = bounds[i]
    const firstLine = text.slice(start, end).trimStart().split("\n", 1)[0]
    return { level: 1, title: firstLine.slice(0, 80) || `Part ${i + 1}`, charStart: start, charEnd: end }
  })
}

/** Cut points that split [0, length) into at most `count` spans of about
 *  length / count chars. Cut i is chosen by `pick` from [lo, hi]: within half
 *  a span of its ideal position i × span, and at least `minLength` past the
 *  cut before it. `pick` returns null when nothing in reach will do, which
 *  merges that span into its neighbour. When every cut is made, no span is
 *  longer than twice the average. */
function evenCuts(
  length: number,
  count: number,
  minLength: number,
  pick: (ideal: number, lo: number, hi: number) => number | null,
): number[] {
  const span = length / count
  const cuts: number[] = []
  let prev = 0
  for (let i = 1; i < count; i++) {
    const ideal = Math.round(i * span)
    const lo = Math.ceil(Math.max(ideal - span / 2, prev + minLength))
    const hi = Math.min(Math.floor(ideal + span / 2), length - 1)
    if (lo > hi) continue
    const cut = pick(ideal, lo, hi)
    if (cut === null) continue
    cuts.push(cut)
    prev = cut
  }
  return cuts
}

/** The cut in [lo, hi] nearest `ideal`: just after a paragraph break if one
 *  is in reach, else after a line break, else after a space, else at `ideal`
 *  itself. Cutting after the separator means the next block opens on text. */
function nearestBreak(text: string, ideal: number, lo: number, hi: number): number {
  for (const sep of BREAKS) {
    // Searched within the window, so a text without this separator costs one
    // window per cut rather than a scan to its end.
    const from = Math.max(0, lo - sep.length)
    const window = text.slice(from, hi)
    let best = -1
    for (let p = window.indexOf(sep); p >= 0; p = window.indexOf(sep, p + 1)) {
      const cut = from + p + sep.length
      if (cut < lo) continue
      if (best < 0 || Math.abs(cut - ideal) < Math.abs(best - ideal)) best = cut
      // Every later cut is farther from `ideal`.
      if (cut >= ideal) break
    }
    if (best >= 0) return best
  }
  return ideal
}

/** Nest by heading level (stack-based) and assign hierarchical ids n1, n1.1, … */
function nest(flat: FlatNode[]): KnowledgeNode[] {
  const roots: KnowledgeNode[] = []
  const stack: { node: KnowledgeNode; level: number }[] = []
  for (const f of flat) {
    const node: KnowledgeNode = { id: "", title: f.title, charStart: f.charStart, charEnd: f.charEnd }
    while (stack.length && stack[stack.length - 1].level >= f.level) stack.pop()
    if (!stack.length) {
      node.id = `n${roots.length + 1}`
      roots.push(node)
    } else {
      const parent = stack[stack.length - 1].node
      parent.children = parent.children ?? []
      node.id = `${parent.id}.${parent.children.length + 1}`
      parent.children.push(node)
      // A parent's range must cover its children.
      parent.charEnd = Math.max(parent.charEnd, node.charEnd)
    }
    stack.push({ node, level: f.level })
  }
  return roots
}
