// Inline-tag protection ladder (AQU-2385).
//
// Shared by every drafting path: the in-app single/batch completion
// (`src/lib/completion/tag-protection.ts`) and the server-side agent draft
// tool that backs the Agent API's `prepare_draft_cells`
// (`auth-worker/src/lib/agent/tools/draft.ts`). Pure functions, no I/O, no
// DOM — so the same rules hold wherever a model is asked to translate text
// that carries inline formatting tokens.
//
// The ladder, in order (lesson from patois-labs/localization-os decision
// 0068; the LLM-repair rung is deliberately NOT implemented here — see
// AQU-2385's "out of scope"):
//
//   1. PREVENT — `maskInlineTags` swaps every inline tag for an opaque
//      sentinel carrying a per-call nonce, so the model never sees markup it
//      could "translate", reflow or helpfully reformat.
//   2. DETECT  — `verifyInlineTags` compares the restored target against the
//      source: same tag multiset, balanced pairs, and the same ORDER for
//      tokens whose order is meaningful. No leaked sentinel.
//   3. REPAIR  — `repairInlineTags` fixes exactly two cheap, deterministic
//      shapes: surplus duplicates, and point-token order. It returns a
//      candidate only when that candidate re-verifies; paired tags are never
//      reordered and damaged pairs are refused outright.
//   4. QUARANTINE — anything still unverified keeps the existing fidelity
//      warning and lands as an unvalidated draft for a human to review. A
//      repair can promote a quarantine to a clean commit; it can never lower
//      the guarantee.
//
// Order rules (localization convention): NAMED placeholders carry their own
// identity (`{name}`, `{0}`, `%1$s`, `%(name)s`, `<x id="1"/>`), so a
// translator — human or model — may move them freely. UNNAMED ones (`%s`,
// `%@`, `{}`) are positional: their relative order IS their meaning, so a
// reorder is a defect.
//
// What this module deliberately does NOT touch: `originalHtml`,
// `translatedHtml`, or the IDML style catalog. Masking sits only around the
// model call. The IDML/Biblica protected-markup path has its own anchor
// contract (`normalizeProtectedCompletionWithRepair`) and opts out of
// masking entirely rather than having two protection schemes fight.

export type InlineTagKind =
  | "paired-open"
  | "paired-close"
  /** A point token: `<br/>`, `<img …>` — carries no identity, keeps its order. */
  | "self-closing"
  /** Carries its own identity, so it may move: `{name}`, `%1$s`, `<x id="1"/>`. */
  | "named-placeholder"
  /** Positional, so it may not move: `%s`, `%@`, `{}`. */
  | "ordered-placeholder"

export interface InlineTagToken {
  raw: string
  kind: InlineTagKind
  /** Element or placeholder name; `""` for unnamed placeholders. */
  name: string
  /** Offset of `raw` in the text it was extracted from. */
  index: number
}

// ─── grammar ────────────────────────────────────────────────────────────────

// A superset of `src/lib/qa/checks.ts`'s TAG_RE: that one is frozen by the
// Matecat parity suite, this one additionally recognises `%(name)s`, `{0}`
// and the empty `{}` (all three are named in AQU-2385's acceptance criteria).
// Alternation order matters — the longer forms must come first.
const TAG_SOURCE = [
  "<\\/?[a-zA-Z][^<>]*>", // XML-ish element: open, close or self-closing
  "\\{\\{[^{}\\s]*\\}\\}", // {{mustache}}
  "\\{[^{}\\s]*\\}", // {curly}, {0} and the empty {}
  "%\\([A-Za-z_]\\w*\\)[a-zA-Z@]", // %(name)s  (python named)
  "%\\d+\\$[a-zA-Z@]", // %1$s      (positional index)
  "%[sdifuxoeg@]", // %s %d %@  (unnamed)
].join("|")

/** Build a fresh matcher — a shared `g`-flagged regex would carry lastIndex. */
const tagMatcher = (): RegExp => new RegExp(TAG_SOURCE, "g")

/** HTML elements that never have a closing tag, so they are point tokens. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
])

/** XLIFF point elements whose `id` makes them a *named* placeholder. */
const XLIFF_POINTS = new Set(["x", "ph", "bx", "ex"])

const elementName = (raw: string): string =>
  /^<\/?\s*([a-zA-Z][\w:.-]*)/.exec(raw)?.[1] ?? raw

const hasIdentity = (raw: string): boolean => /\b(?:id|name)\s*=/i.test(raw)

function classifyElement(raw: string): { kind: InlineTagKind; name: string } {
  const name = elementName(raw)
  if (raw.startsWith("</")) return { kind: "paired-close", name }
  const selfClosing = raw.endsWith("/>") || VOID_ELEMENTS.has(name.toLowerCase())
  const point = selfClosing || XLIFF_POINTS.has(name.toLowerCase())
  if (point) {
    return { kind: hasIdentity(raw) ? "named-placeholder" : "self-closing", name }
  }
  return { kind: "paired-open", name }
}

/** Classify one already-matched inline tag. */
export function classifyInlineTag(raw: string): { kind: InlineTagKind; name: string } {
  if (raw.startsWith("<")) return classifyElement(raw)
  if (raw.startsWith("{")) {
    const inner = raw.startsWith("{{") ? raw.slice(2, -2) : raw.slice(1, -1)
    // `{}` has nothing to identify it, so it is positional. `{0}` carries its
    // own index, exactly like `%1$s`, so it may move.
    if (inner === "") return { kind: "ordered-placeholder", name: "" }
    return { kind: "named-placeholder", name: inner }
  }
  // %-forms. `%(name)s` and `%1$s` identify themselves; bare `%s` does not.
  if (/^%\(/.test(raw)) return { kind: "named-placeholder", name: raw.slice(2, raw.indexOf(")")) }
  if (/^%\d+\$/.test(raw)) return { kind: "named-placeholder", name: raw.slice(1, raw.indexOf("$")) }
  return { kind: "ordered-placeholder", name: "" }
}

/** Every inline tag in `text`, in document order. */
export function extractInlineTags(text: string): InlineTagToken[] {
  const re = tagMatcher()
  const out: InlineTagToken[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ raw: m[0], index: m.index, ...classifyInlineTag(m[0]) })
  }
  return out
}

/** Tokens whose relative order is part of the meaning. */
const isOrderBearing = (t: InlineTagToken): boolean => t.kind !== "named-placeholder"

const isPlaceholder = (t: InlineTagToken): boolean =>
  t.kind === "named-placeholder" || t.kind === "ordered-placeholder"

/**
 * A cell that is nothing but tags, with at most one placeholder, has nothing
 * to translate: copy the source to the target and never spend a model call
 * on it (AQU-2385).
 */
export function isTagsOnlyText(text: string): boolean {
  const tags = extractInlineTags(text)
  if (tags.length === 0) return false
  if (/[\p{L}\p{N}]/u.test(text.replace(tagMatcher(), ""))) return false
  return tags.filter(isPlaceholder).length <= 1
}

// ─── 1. prevent: mask / restore ─────────────────────────────────────────────

export interface TagMask {
  /** Fresh per model call, so a sentinel from an earlier call can never alias. */
  nonce: string
  /** sentinel → the original tag it stands for. */
  map: Map<string, string>
  /** Next free sentinel ordinal; lets one mask span a whole batch prompt. */
  nextIndex: number
}

export interface MaskedText {
  masked: string
  mask: TagMask
}

const NONCE_LEN = 6

function randomNonce(): string {
  const bytes = new Uint8Array(3)
  // `crypto` is present in the browser, in Workers and in Node ≥ 19.
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, NONCE_LEN)
}

/** `[#<nonce><n>#]` — no `<>`, `{}` or `%`, so it is not itself a tag, and a
 *  leaked one stays recognisable as a sentinel rather than as markup. */
export const sentinelFor = (nonce: string, index: number): string => `[#${nonce}${index}#]`

export function createTagMask(nonce: string = randomNonce()): TagMask {
  return { nonce, map: new Map(), nextIndex: 0 }
}

/**
 * Replace every inline tag with an opaque sentinel.
 *
 * Pass an existing mask to keep masking into it — one batch prompt carrying
 * many cells shares a single nonce and one ordinal sequence, so no two cells
 * can mint the same sentinel.
 */
export function maskInlineTags(text: string, existing?: TagMask): MaskedText {
  const mask = existing ?? createTagMask()
  const masked = text.replace(tagMatcher(), (raw) => {
    const sentinel = sentinelFor(mask.nonce, mask.nextIndex++)
    mask.map.set(sentinel, raw)
    return sentinel
  })
  return { masked, mask }
}

/** Tolerant sentinel matcher for one nonce — models like to add spaces. */
const sentinelMatcher = (nonce: string): RegExp =>
  new RegExp(`\\[\\s*#\\s*${nonce}\\s*(\\d+)\\s*#\\s*\\]`, "g")

/** Sentinel-shaped text with any nonce, for detecting residue after restore. */
const ANY_SENTINEL = `\\[\\s*#\\s*[0-9a-f]{${NONCE_LEN}}\\s*\\d+\\s*#\\s*\\]`

/** Put the real tags back. Unknown ordinals are left alone so `verify` sees them. */
export function restoreInlineTags(masked: string, mask: TagMask): string {
  return masked.replace(sentinelMatcher(mask.nonce), (whole, n: string) =>
    mask.map.get(sentinelFor(mask.nonce, Number(n))) ?? whole,
  )
}

/**
 * Sentinel residue in `text` — the mask's own nonce when known (which also
 * catches a sentinel the model mangled beyond the restore matcher), plus any
 * generically sentinel-shaped run.
 */
export function leakedSentinels(text: string, mask?: TagMask): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(new RegExp(ANY_SENTINEL, "g"))) found.add(m[0])
  if (mask && text.includes(mask.nonce)) found.add(mask.nonce)
  return [...found]
}

// ─── 2. detect ──────────────────────────────────────────────────────────────

export type TagFailure =
  | "sentinel-leaked"
  | "tag-missing"
  | "tag-extra"
  | "paired-unbalanced"
  | "order-changed"

export type TagVerdict =
  | { ok: true }
  | { ok: false; reason: TagFailure; detail: string }

const multiset = (raws: readonly string[]): Map<string, number> => {
  const m = new Map<string, number>()
  for (const r of raws) m.set(r, (m.get(r) ?? 0) + 1)
  return m
}

/** True when the target's paired tags nest correctly. */
function pairsBalanced(tags: readonly InlineTagToken[]): boolean {
  const stack: string[] = []
  for (const t of tags) {
    if (t.kind === "paired-open") stack.push(t.name)
    else if (t.kind === "paired-close") {
      if (stack.pop() !== t.name) return false
    }
  }
  return stack.length === 0
}

const diffMultiset = (a: Map<string, number>, b: Map<string, number>): string[] => {
  const out: string[] = []
  for (const [raw, n] of a) {
    const have = b.get(raw) ?? 0
    if (have < n) out.push(raw)
  }
  return out
}

/**
 * Does `target` carry the same inline tags as `source`?
 *
 * Same multiset, balanced pairs, same order for every order-bearing token,
 * and no sentinel residue. Named placeholders may appear in any order.
 */
export function verifyInlineTags(source: string, target: string, mask?: TagMask): TagVerdict {
  const leaked = leakedSentinels(target, mask)
  if (leaked.length > 0) {
    return { ok: false, reason: "sentinel-leaked", detail: leaked.slice(0, 3).join(" ") }
  }
  const src = extractInlineTags(source)
  const tgt = extractInlineTags(target)
  const srcSet = multiset(src.map((t) => t.raw))
  const tgtSet = multiset(tgt.map((t) => t.raw))
  const missing = diffMultiset(srcSet, tgtSet)
  if (missing.length > 0) {
    return { ok: false, reason: "tag-missing", detail: missing.slice(0, 5).join(" ") }
  }
  const extra = diffMultiset(tgtSet, srcSet)
  if (extra.length > 0) {
    return { ok: false, reason: "tag-extra", detail: extra.slice(0, 5).join(" ") }
  }
  if (!pairsBalanced(tgt)) {
    return { ok: false, reason: "paired-unbalanced", detail: tgt.map((t) => t.raw).join(" ") }
  }
  const srcOrder = src.filter(isOrderBearing).map((t) => t.raw)
  const tgtOrder = tgt.filter(isOrderBearing).map((t) => t.raw)
  if (srcOrder.join("\u0000") !== tgtOrder.join("\u0000")) {
    return { ok: false, reason: "order-changed", detail: `${srcOrder.join(" ")} vs ${tgtOrder.join(" ")}` }
  }
  return { ok: true }
}

// ─── 3. repair (deterministic only) ─────────────────────────────────────────

/**
 * Rewrite `text` by replacing the given token occurrences, right to left so
 * earlier offsets stay valid. `null` as a replacement deletes the token.
 *
 * A deletion also absorbs ONE adjacent space when removing the token would
 * otherwise leave a double space or a dangling space at either end — the
 * surplus token the model emitted came with its own separator, and leaving it
 * behind would put a visible wart in a draft that is otherwise clean. Only a
 * plain space is ever absorbed, and only when a space survives on the other
 * side (or the token sat at an edge), so a script that does not space its
 * words is untouched.
 */
function rewriteTokens(
  text: string,
  edits: readonly { token: InlineTagToken; to: string | null }[],
): string {
  let out = text
  for (const { token, to } of [...edits].sort((a, b) => b.token.index - a.token.index)) {
    let start = token.index
    let end = token.index + token.raw.length
    if (to === null) {
      const before = start > 0 ? out[start - 1] : ""
      const after = end < out.length ? out[end] : ""
      if (after === " " && (before === " " || start === 0)) end += 1
      else if (before === " " && (after === " " || end === out.length)) start -= 1
    }
    out = out.slice(0, start) + (to ?? "") + out.slice(end)
  }
  return out
}

/** Drop surplus copies of tags the target repeats more often than the source. */
function dropSurplusDuplicates(source: string, target: string): string | null {
  const src = multiset(extractInlineTags(source).map((t) => t.raw))
  const tgt = extractInlineTags(target)
  const seen = new Map<string, number>()
  const edits: { token: InlineTagToken; to: string | null }[] = []
  for (const token of tgt) {
    const allowed = src.get(token.raw) ?? 0
    const used = seen.get(token.raw) ?? 0
    if (used < allowed) {
      seen.set(token.raw, used + 1)
      continue
    }
    // A surplus PAIRED tag cannot be dropped blind — removing one half of a
    // pair rewrites the nesting. Paired damage is a refusal, not a repair.
    if (token.kind === "paired-open" || token.kind === "paired-close") return null
    edits.push({ token, to: null })
  }
  if (edits.length === 0) return null
  return rewriteTokens(target, edits)
}

/**
 * Restore the source's order for POINT tokens while keeping the positions the
 * model chose: walk the target's order-bearing slots and write the source's
 * order-bearing sequence into them. Refuses the moment a paired tag is in
 * that sequence — paired tags are never reordered.
 */
function reorderPointTokens(source: string, target: string): string | null {
  const srcOrder = extractInlineTags(source).filter(isOrderBearing)
  const tgtOrder = extractInlineTags(target).filter(isOrderBearing)
  if (srcOrder.length !== tgtOrder.length) return null
  if (srcOrder.some((t) => t.kind === "paired-open" || t.kind === "paired-close")) return null
  if (tgtOrder.some((t) => t.kind === "paired-open" || t.kind === "paired-close")) return null
  const edits = tgtOrder.map((token, i) => ({ token, to: srcOrder[i].raw }))
  if (edits.every((e) => e.token.raw === e.to)) return null
  return rewriteTokens(target, edits)
}

/**
 * Cheap deterministic repair. Returns a candidate ONLY when that candidate
 * re-verifies against the source; otherwise `null`, and the caller keeps the
 * quarantine. Handles exactly two shapes — surplus duplicates and point-token
 * order — and refuses sentinel leaks and paired-tag damage outright.
 */
export function repairInlineTags(source: string, target: string, mask?: TagMask): string | null {
  if (leakedSentinels(target, mask).length > 0) return null
  const verdict = verifyInlineTags(source, target, mask)
  if (verdict.ok) return null
  if (verdict.reason === "paired-unbalanced" || verdict.reason === "tag-missing") return null

  let candidate: string = target
  if (verdict.reason === "tag-extra") {
    const deduped = dropSurplusDuplicates(source, candidate)
    if (deduped === null) return null
    candidate = deduped
  }
  if (verifyInlineTags(source, candidate, mask).ok) return candidate

  const reordered = reorderPointTokens(source, candidate)
  if (reordered === null) return null
  return verifyInlineTags(source, reordered, mask).ok ? reordered : null
}

// ─── 4. the ladder, as one call ─────────────────────────────────────────────

export type TagLadderStatus = "clean" | "repaired" | "unverified"

export interface TagLadderResult {
  status: TagLadderStatus
  /** The text to commit. Always the restored target — a draft is never dropped
   *  for a tag defect; an unverified one is flagged and reviewed. */
  value: string
  /** Set unless `status === "clean"`: what detection found. */
  reason?: TagFailure
  detail?: string
}

/**
 * Run detect → repair → quarantine over one model reply.
 *
 * `mask` is the mask used for THIS reply (omit it when masking is switched
 * off — detection and repair still run, which is the point of the setting).
 */
export function settleTagLadder(source: string, rawTarget: string, mask?: TagMask): TagLadderResult {
  const value = mask ? restoreInlineTags(rawTarget, mask) : rawTarget
  const verdict = verifyInlineTags(source, value, mask)
  if (verdict.ok) return { status: "clean", value }
  const repaired = repairInlineTags(source, value, mask)
  if (repaired !== null) {
    return { status: "repaired", value: repaired, reason: verdict.reason, detail: verdict.detail }
  }
  return { status: "unverified", value, reason: verdict.reason, detail: verdict.detail }
}

/** One-line, English-only operator detail for logs and the fidelity report. */
export function describeTagFailure(reason: TagFailure, detail: string | undefined): string {
  const suffix = detail ? ` (${detail})` : ""
  switch (reason) {
    case "sentinel-leaked":
      return `the model left an inline-tag placeholder in the translation${suffix}`
    case "tag-missing":
      return `the translation is missing source inline tag(s)${suffix}`
    case "tag-extra":
      return `the translation has inline tag(s) not in the source${suffix}`
    case "paired-unbalanced":
      return `the translation's paired inline tags do not nest${suffix}`
    case "order-changed":
      return `the translation reorders positional inline tags${suffix}`
  }
}
