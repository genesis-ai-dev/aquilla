// PageIndex-style indexing (spec §"Data model"): structure comes from
// heuristics (markdown headings, else paragraph blocks), the LLM only writes
// summaries — one Haiku call per document, made async from the upload route
// via ctx.waitUntil. Failure is non-fatal: docs stay string-searchable.
import type { AquillaDb } from "../../../../db/shim/postgres"
import {
  getDocText, setIndexResult, type KnowledgeNode,
} from "../../../../db/shared/knowledge"

export interface KbIndexEnv {
  OPENROUTER_API_KEY?: string
  OPENROUTER_BASE_URL?: string
  KB_INDEX_MODEL?: string
}

const MAX_NODES = 200
const MAX_DEPTH = 3
const BLOCK_TARGET = 2000
export const DEFAULT_KB_INDEX_MODEL = "anthropic/claude-haiku-4-5"

const HEADING_RE = /^(#{1,3})\s+(.+)$/gm

export function segmentText(text: string): KnowledgeNode[] {
  const headings: { level: number; title: string; start: number }[] = []
  for (const m of text.matchAll(HEADING_RE)) {
    headings.push({ level: m[1].length, title: m[2].trim(), start: m.index ?? 0 })
  }
  let flat: { level: number; title: string; charStart: number; charEnd: number }[]
  if (headings.length >= 2) {
    flat = headings.slice(0, MAX_NODES).map((h, i, arr) => ({
      level: Math.min(h.level, MAX_DEPTH),
      title: h.title,
      charStart: h.start,
      charEnd: i + 1 < arr.length ? arr[i + 1].start : text.length,
    }))
    // Preamble before the first heading becomes its own node.
    if (headings[0].start > 0) {
      flat.unshift({ level: 1, title: "Introduction", charStart: 0, charEnd: headings[0].start })
    }
  } else {
    // Headingless: greedy paragraph blocks of ~BLOCK_TARGET chars, tiling
    // the full text with no gaps (each block's charEnd == next block's
    // charStart, and the very first/last ranges touch the text bounds).
    flat = []
    let start = 0
    while (start < text.length) {
      const isLast = flat.length === MAX_NODES - 1
      let end = Math.min(start + BLOCK_TARGET, text.length)
      if (!isLast && end < text.length) {
        const brk = text.indexOf("\n\n", start)
        if (brk >= 0 && brk < end) {
          // Prefer breaking at the *last* paragraph boundary before `end`.
          let lastBrk = brk
          let next = text.indexOf("\n\n", brk + 2)
          while (next >= 0 && next < end) {
            lastBrk = next
            next = text.indexOf("\n\n", next + 2)
          }
          end = lastBrk + 2
        }
      }
      if (isLast) end = text.length
      const firstLine = text.slice(start, end).trimStart().split("\n", 1)[0]
      flat.push({ level: 1, title: firstLine.slice(0, 80) || `Part ${flat.length + 1}`, charStart: start, charEnd: end })
      start = end
    }
    if (flat.length) flat[flat.length - 1].charEnd = text.length
  }
  // Nest by heading level (stack-based), assign hierarchical ids n1, n1.1, …
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

export function buildEnrichmentPrompt(docName: string, text: string, nodes: KnowledgeNode[]): string {
  const flat: string[] = []
  const walk = (ns: KnowledgeNode[]) => {
    for (const n of ns) {
      flat.push(`${n.id}: "${n.title}"\n${text.slice(n.charStart, Math.min(n.charEnd, n.charStart + 1200))}`)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return [
    `Document: ${docName}. Below are its sections (id, title, opening text).`,
    `Return ONLY JSON: {"docSummary": "<2-3 sentence summary of the whole document>",`,
    ` "nodes": [{"id": "<section id>", "summary": "<1-2 sentence section summary>"}]}.`,
    `Cover every section id exactly once.`,
    "",
    flat.join("\n---\n"),
  ].join("\n")
}

export function applyEnrichment(
  nodes: KnowledgeNode[], raw: string,
): { tree: KnowledgeNode[]; docSummary: string | null } {
  // Models sometimes wrap JSON in a code fence — strip it before parsing.
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
  const parsed = JSON.parse(cleaned) as { docSummary?: string; nodes?: { id: string; summary?: string }[] }
  const byId = new Map((parsed.nodes ?? []).map((n) => [n.id, n.summary]))
  const walk = (ns: KnowledgeNode[]) => {
    for (const n of ns) {
      const s = byId.get(n.id)
      if (s) n.summary = s
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return { tree: nodes, docSummary: parsed.docSummary?.trim() || null }
}

function openRouterUrl(env: KbIndexEnv): string {
  return env.OPENROUTER_BASE_URL
    ? `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions"
}

/** Build + persist the index for one doc. Never throws — any failure lands as
 *  index_status='failed' (the doc remains string-searchable, spec §Error handling). */
export async function indexKnowledgeDoc(env: KbIndexEnv, db: AquillaDb, docId: string): Promise<void> {
  try {
    const doc = await getDocText(db, docId)
    if (!doc) return
    const nodes = segmentText(doc.text)
    if (!env.OPENROUTER_API_KEY) throw new Error("no OPENROUTER_API_KEY")
    const res = await fetch(openRouterUrl(env), {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.KB_INDEX_MODEL || DEFAULT_KB_INDEX_MODEL,
        messages: [{ role: "user", content: buildEnrichmentPrompt(doc.meta.name, doc.text, nodes) }],
        response_format: { type: "json_object" },
      }),
    })
    if (!res.ok) throw new Error(`openrouter ${res.status}`)
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const content = body.choices?.[0]?.message?.content ?? ""
    const { tree, docSummary } = applyEnrichment(nodes, content)
    await setIndexResult(db, docId, "ready", tree, docSummary)
  } catch {
    await setIndexResult(db, docId, "failed", null, null).catch(() => {})
  }
}
