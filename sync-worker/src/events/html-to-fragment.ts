// Minimal HTML → Y.XmlFragment parser for Phase 4d hydration.
//
// The worker has no DOM, and the input is constrained (HTML produced by
// the TipTap editor or a similar trusted source). We support exactly the
// shape `getFragmentHtml` in src/lib/richtext/translated-xml.ts emits:
//
//   - <p>…</p> paragraphs (top-level content wraps in one if absent)
//   - inline marks: <b>/<strong>, <i>/<em>, <u>, <s>/<strike>/<del>, <code>
//   - <br/> hard breaks
//   - HTML entities: &amp; &lt; &gt; &quot; &apos; &#39;
//
// Anything we don't recognize is dropped at the wrapper level (children
// kept). Malformed input falls back to plain text inside one paragraph,
// which matches what a naive `setPlainText` call would have produced.

import * as Y from 'yjs'

interface Mark {
  bold?: true
  italic?: true
  underline?: true
  strike?: true
  code?: true
}

type Op =
  | { kind: 'text'; text: string; marks: Mark }
  | { kind: 'br' }

interface Paragraph {
  ops: Op[]
}

const VOID_TAGS = new Set(['br', 'hr', 'img'])

const MARK_FOR_TAG: Record<string, keyof Mark> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'underline',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
  code: 'code',
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
}

function decodeEntities(text: string): string {
  return text.replace(/&([a-zA-Z]+|#\d+);/g, (whole, name: string) => {
    if (name in ENTITIES) return ENTITIES[name]
    if (name.startsWith('#')) {
      const code = parseInt(name.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code < 0x110000) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return whole
        }
      }
    }
    return whole
  })
}

interface Token {
  type: 'open' | 'close' | 'self-close' | 'text'
  /** Lowercased tag name for open/close/self-close; raw text for `text`. */
  payload: string
}

/**
 * Lossy HTML tokenizer. Recognizes opening tags (`<tag>`), closing tags
 * (`</tag>`), self-closing tags (`<tag/>`, `<br>`), and runs of text in
 * between. Attributes inside tags are dropped. Comments and processing
 * instructions are stripped. Whitespace inside tags is tolerated.
 */
function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = html.length

  while (i < n) {
    const ch = html[i]
    if (ch !== '<') {
      // Text run until the next '<' or end.
      const start = i
      while (i < n && html[i] !== '<') i++
      const raw = html.slice(start, i)
      if (raw.length > 0) {
        tokens.push({ type: 'text', payload: decodeEntities(raw) })
      }
      continue
    }

    // Skip comment.
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      i = end === -1 ? n : end + 3
      continue
    }

    // Skip declarations and processing instructions (<! …>, <? …>).
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i + 2)
      i = end === -1 ? n : end + 1
      continue
    }

    // Closing tag.
    if (html.startsWith('</', i)) {
      const end = html.indexOf('>', i + 2)
      if (end === -1) {
        // Malformed; treat the rest as text.
        tokens.push({ type: 'text', payload: decodeEntities(html.slice(i)) })
        i = n
        break
      }
      const name = html.slice(i + 2, end).trim().toLowerCase().split(/\s+/)[0]
      if (name) tokens.push({ type: 'close', payload: name })
      i = end + 1
      continue
    }

    // Opening or self-closing tag.
    const end = html.indexOf('>', i + 1)
    if (end === -1) {
      tokens.push({ type: 'text', payload: decodeEntities(html.slice(i)) })
      i = n
      break
    }
    const inner = html.slice(i + 1, end).trim()
    const selfClose = inner.endsWith('/')
    const head = selfClose ? inner.slice(0, -1).trim() : inner
    const name = head.split(/\s+/)[0]?.toLowerCase() ?? ''
    if (name) {
      if (selfClose || VOID_TAGS.has(name)) {
        tokens.push({ type: 'self-close', payload: name })
      } else {
        tokens.push({ type: 'open', payload: name })
      }
    }
    i = end + 1
  }

  return tokens
}

/** Walk tokens with a mark stack and produce paragraph ops. */
function buildParagraphs(tokens: Token[]): Paragraph[] {
  const paragraphs: Paragraph[] = []
  let current: Paragraph = { ops: [] }
  let inParagraph = false
  const markStack: Array<keyof Mark> = []

  function ensureParagraph(): void {
    if (!inParagraph) {
      // Implicit paragraph for top-level inline content (e.g. raw text or
      // bare `<b>` without a wrapping `<p>`).
      paragraphs.push(current)
      inParagraph = true
    }
  }

  function currentMarks(): Mark {
    const out: Mark = {}
    for (const m of markStack) out[m] = true
    return out
  }

  function endParagraph(): void {
    if (inParagraph) {
      current = { ops: [] }
      inParagraph = false
    }
  }

  for (const tok of tokens) {
    if (tok.type === 'text') {
      if (!tok.payload) continue
      ensureParagraph()
      current.ops.push({ kind: 'text', text: tok.payload, marks: currentMarks() })
      continue
    }

    if (tok.type === 'self-close') {
      if (tok.payload === 'br') {
        ensureParagraph()
        current.ops.push({ kind: 'br' })
      }
      // Other void tags (img, hr) are dropped.
      continue
    }

    if (tok.type === 'open') {
      const tag = tok.payload
      if (tag === 'p' || tag === 'div') {
        // Flush any open paragraph and start a new one.
        endParagraph()
        current = { ops: [] }
        paragraphs.push(current)
        inParagraph = true
        continue
      }
      const mark = MARK_FOR_TAG[tag]
      if (mark) {
        markStack.push(mark)
      }
      // Unknown wrappers: silently kept; their children land at the same
      // mark level (matches client `appendDomContent` behavior).
      continue
    }

    if (tok.type === 'close') {
      const tag = tok.payload
      if (tag === 'p' || tag === 'div') {
        endParagraph()
        continue
      }
      const mark = MARK_FOR_TAG[tag]
      if (mark) {
        // Pop the matching mark off the stack. If unbalanced, just pop the
        // last instance of `mark` so we don't unwind unrelated marks.
        const idx = markStack.lastIndexOf(mark)
        if (idx >= 0) markStack.splice(idx, 1)
      }
      continue
    }
  }

  return paragraphs.filter((p) => p === current ? p.ops.length > 0 : true)
    .filter((p, i, arr) => p.ops.length > 0 || arr.length === 1)
}

/**
 * Build a fresh Y.XmlFragment from HTML and return it. The returned fragment
 * is detached (not yet attached to any doc); callers attach via
 * `cell.set('translatedXml', frag)`. Attaching MUST happen before any further
 * mutation.
 *
 * Empty / whitespace-only HTML produces a fragment with one empty paragraph
 * (matches `setPlainText('')` shape so the editor doesn't trip on missing
 * paragraphs).
 */
export function htmlToFragment(html: string): Y.XmlFragment {
  const tokens = tokenize(html)
  const paragraphs = buildParagraphs(tokens)

  const frag = new Y.XmlFragment()
  if (paragraphs.length === 0) {
    frag.insert(0, [new Y.XmlElement('paragraph')])
    return frag
  }

  for (const para of paragraphs) {
    const el = new Y.XmlElement('paragraph')
    frag.push([el])
    for (const op of para.ops) {
      if (op.kind === 'br') {
        el.push([new Y.XmlElement('hardBreak')])
      } else if (op.text.length > 0) {
        const t = new Y.XmlText()
        el.push([t])
        const hasMarks = Object.keys(op.marks).length > 0
        t.insert(0, op.text, hasMarks ? op.marks as Record<string, true> : undefined)
      }
    }
  }
  return frag
}

/**
 * Plain-text fallback fragment — what the previous Phase 4d hydration code
 * produced. Kept exposed so the hydrator can fall back when valueHtml is
 * absent (most legacy events) or when HTML parsing produced no content.
 */
export function plainTextToFragment(text: string): Y.XmlFragment {
  const frag = new Y.XmlFragment()
  const p = new Y.XmlElement('paragraph')
  if (text.length > 0) {
    p.insert(0, [new Y.XmlText(text)])
  }
  frag.insert(0, [p])
  return frag
}
