/**
 * IDML story model: turn one Stories/*.xml member into translatable units, and
 * write translated units back into it without touching any other byte.
 *
 * A unit is an InDesign paragraph: the text between paragraph breaks (<Br/>)
 * or ParagraphStyleRange boundaries. Inside a unit:
 *
 *   - every text run inside a <Content> element is a *slot* we may rewrite;
 *   - every element or processing instruction that sits between slots (anchored
 *     frames, variables, cross-references, tables, footnotes, special-character
 *     PIs…) is a protected *token* (<xN/>) that we never move or rewrite;
 *   - each distinct formatting context (CharacterStyleRange × hyperlink ×
 *     XML tag) is a *run* (<gN>…</gN>).
 *
 * Tables cells and footnotes are separate scopes with their own units; their
 * host paragraph sees them as tokens.
 *
 * Write-back is purely surgical: we only replace the raw bytes of slots. If a
 * translation reorders runs or tokens so that it cannot be expressed by slot
 * replacement, we keep the native structure, place the text as faithfully as
 * possible, and report a `FORMATTING_SIMPLIFIED` warning for review.
 */
import { shortHash } from "../../core/hash.ts"
import { hasTagLikeText, hasTranslatableText, parseTagged } from "../../core/tagged.ts"
import type { ContentUnit, Diagnostic } from "../../core/types.ts"
import { encodeText, parseXml, splice } from "../xml.ts"
import type { XmlElement, XmlNode } from "../xml.ts"

interface Slot {
  readonly kind: "slot"
  readonly start: number
  readonly end: number
  readonly text: string
  readonly runKey: string
}
interface Token {
  readonly kind: "token"
  readonly label: string
  readonly start: number
  readonly end: number
}
type Piece = Slot | Token

export interface StoryUnit {
  readonly unit: ContentUnit
  readonly pieces: readonly Piece[]
  /** runKey → g number */
  readonly runIds: ReadonlyMap<string, number>
  readonly multiRun: boolean
}

export interface ExtractedStory {
  readonly storyId: string
  readonly units: StoryUnit[]
  readonly diagnostics: Diagnostic[]
  /** Every slot range in the member, translatable or not — used for text-masked skeletons. */
  readonly allSlots: ReadonlyArray<{ start: number; end: number }>
}

/** Elements that never carry text and are ignored for unit composition. */
const IGNORED = new Set(["Properties", "StoryPreference", "InCopyExportOption", "XMLAttribute", "XMLComment", "XMLInstruction"])
/** Containers that are transparent for text flow and define formatting runs. */
const RUN_CONTAINERS = new Set(["CharacterStyleRange", "HyperlinkTextSource", "XMLElement"])
/** Inline elements whose content is a nested translatable scope. */
const NESTED_SCOPES: Record<string, string> = { Footnote: "footnote", EndnoteRange: "endnote", Endnote: "endnote" }
/** Inline elements we keep as tokens and do not descend into for translation. */
const OPAQUE_WITH_TEXT = new Set(["Note", "Change", "CrossReferenceSource"])

export const extractStory = (memberPath: string, xml: string, kindHint: (storyId: string) => string = () => "paragraph"): ExtractedStory => {
  const doc = parseXml(xml)
  const story = findStory(doc.root)
  const diagnostics: Diagnostic[] = []
  if (!story) {
    diagnostics.push({ code: "MISSING_STORY", severity: "error", message: `${memberPath} has no <Story> element`, path: memberPath })
    return { storyId: "", units: [], diagnostics, allSlots: [] }
  }
  const storyId = story.attrs.Self ?? memberPath
  const units: StoryUnit[] = []
  const allSlots: Array<{ start: number; end: number }> = []
  const ordinals = new Map<string, number>()

  interface Builder {
    scope: string
    kind: string
    pieces: Piece[]
    psr?: XmlElement
    psrUnits: number[]
    meta: Record<string, string | number>
  }

  const flush = (b: Builder): void => {
    const pieces = b.pieces
    b.pieces = []
    const text = pieces.map((p) => (p.kind === "slot" ? p.text : "")).join("")
    if (!hasTranslatableText(text)) return
    const ordinal = ordinals.get(b.scope) ?? 0
    ordinals.set(b.scope, ordinal + 1)
    const runIds = new Map<string, number>()
    for (const p of pieces) if (p.kind === "slot" && p.text.length > 0 && !runIds.has(p.runKey)) runIds.set(p.runKey, runIds.size + 1)
    const multiRun = runIds.size > 1
    let tokenNo = 0
    let open: number | undefined
    let tagged = ""
    for (const p of pieces) {
      if (p.kind === "token") {
        tagged += `<x${++tokenNo}/>`
        continue
      }
      if (p.text.length === 0) continue
      if (multiRun) {
        const g = runIds.get(p.runKey)!
        if (open !== g) {
          if (open !== undefined) tagged += `</g${open}>`
          tagged += `<g${g}>`
          open = g
        }
      }
      tagged += p.text
    }
    if (open !== undefined) tagged += `</g${open}>`
    if (hasTagLikeText(text)) {
      diagnostics.push({ code: "TAG_LIKE_TEXT", severity: "warning", message: `paragraph contains literal text that looks like an inline tag`, path: memberPath })
    }
    const psrSelf = b.psr?.attrs.Self
    const unit: ContentUnit = {
      logicalId: "",
      scope: b.scope,
      ...(psrSelf ? { nativeAnchor: `psr:${psrSelf}` } : {}),
      structuralPath: `${memberPath}#${b.scope}#${ordinal}`,
      ordinal,
      kind: b.kind,
      tagged,
      plain: text,
      contentHash: shortHash(tagged),
      meta: { ...b.meta, member: memberPath, story: storyId },
    }
    if (b.psr) b.psrUnits.push(units.length)
    units.push({ unit, pieces, runIds, multiRun })
  }

  const visit = (nodes: readonly XmlNode[], b: Builder, runKey: string): void => {
    for (const node of nodes) {
      if (node.type !== "element") {
        if (node.type === "pi") b.pieces.push({ kind: "token", label: `?${node.target} ${node.data}`, start: node.start, end: node.end })
        else if (node.type === "cdata") b.pieces.push({ kind: "token", label: "cdata", start: node.start, end: node.end })
        continue
      }
      const el = node
      if (IGNORED.has(el.name)) continue
      if (el.name === "Content") {
        contentSlots(el, runKey, b)
        continue
      }
      if (el.name === "Br") {
        flush(b)
        continue
      }
      if (el.name === "ParagraphStyleRange") {
        flush(b)
        const saved = { psr: b.psr, list: b.psrUnits, meta: b.meta }
        b.psr = el
        b.psrUnits = []
        b.meta = { ...b.meta, ...styleMeta(el, "paragraphStyle", "AppliedParagraphStyle") }
        visit(el.children, b, `${runKey}/psr@${el.start}`)
        flush(b)
        // A PSR id is a trustworthy paragraph anchor only when the PSR holds exactly one paragraph.
        if (b.psrUnits.length !== 1) {
          for (const k of b.psrUnits) {
            const su = units[k]!
            const { nativeAnchor: _drop, ...rest } = su.unit
            units[k] = { ...su, unit: rest }
          }
        }
        b.psr = saved.psr
        b.psrUnits = saved.list
        b.meta = saved.meta
        continue
      }
      if (RUN_CONTAINERS.has(el.name)) {
        const saved = b.meta
        if (el.name === "CharacterStyleRange") b.meta = { ...b.meta, ...styleMeta(el, "characterStyle", "AppliedCharacterStyle") }
        visit(el.children, b, `${runKey}/${runSignature(el, xml)}`)
        b.meta = saved
        continue
      }
      if (el.name === "Table") {
        b.pieces.push({ kind: "token", label: "Table", start: el.start, end: el.end })
        let c = 0
        for (const cell of descendants(el, "Cell")) {
          const scope = `cell:${cell.attrs.Self ?? `${b.scope}/table@${el.start}/${c}`}`
          c++
          const inner: Builder = { scope, kind: "table-cell", pieces: [], psrUnits: [], meta: { ...b.meta } }
          visit(cell.children, inner, `cell@${cell.start}`)
          flush(inner)
        }
        continue
      }
      const nestedKind = NESTED_SCOPES[el.name]
      if (nestedKind) {
        b.pieces.push({ kind: "token", label: el.name, start: el.start, end: el.end })
        const inner: Builder = { scope: `${nestedKind}:${el.attrs.Self ?? `${b.scope}@${el.start}`}`, kind: nestedKind, pieces: [], psrUnits: [], meta: { ...b.meta } }
        visit(el.children, inner, `${nestedKind}@${el.start}`)
        flush(inner)
        continue
      }
      // Any other inline element is a protected token.
      b.pieces.push({ kind: "token", label: el.name, start: el.start, end: el.end })
      if (OPAQUE_WITH_TEXT.has(el.name) || hasContentDescendant(el)) {
        if (el.name === "Note") {
          diagnostics.push({ code: "NOTE_PRESERVED", severity: "info", message: `editorial <Note> ${el.attrs.Self ?? ""} kept untranslated`, path: memberPath })
        } else if (el.name === "CrossReferenceSource") {
          diagnostics.push({ code: "XREF_PRESERVED", severity: "info", message: `cross-reference text ${el.attrs.Self ?? ""} is generated by InDesign and kept as-is`, path: memberPath })
        } else if (hasContentDescendant(el)) {
          diagnostics.push({
            code: el.name === "Change" ? "TRACKED_CHANGE" : "UNSUPPORTED_LITERAL",
            severity: "warning",
            message: `<${el.name}> ${el.attrs.Self ?? ""} contains literal text that is preserved but not translated`,
            path: memberPath,
          })
        }
      }
    }
  }

  const contentSlots = (el: XmlElement, runKey: string, b: Builder): void => {
    // <Content/> has no writable text position; leave it alone.
    if (el.selfClosing) return
    let cursor = el.openEnd
    let text = ""
    let rawStart = el.openEnd
    const pushSlot = (end: number): void => {
      b.pieces.push({ kind: "slot", start: rawStart, end, text, runKey })
      allSlots.push({ start: rawStart, end })
      text = ""
    }
    for (const c of el.children) {
      if (c.type === "text") {
        text += c.text
        cursor = c.end
      } else if (c.type === "cdata") {
        text += c.text
        cursor = c.end
      } else {
        pushSlot(c.start)
        b.pieces.push({ kind: "token", label: c.type === "pi" ? `?${c.target} ${c.data}` : c.type === "element" ? c.name : c.type, start: c.start, end: c.end })
        rawStart = c.end
        cursor = c.end
      }
    }
    void cursor
    pushSlot(el.closeStart)
  }

  const root: Builder = { scope: `story:${storyId}`, kind: kindHint(storyId), pieces: [], psrUnits: [], meta: {} }
  visit(story.children, root, "story")
  flush(root)
  return { storyId, units, diagnostics, allSlots }
}

/**
 * Formatting identity of a run container. Two CharacterStyleRanges with the
 * same attributes and local properties format text identically, so they share
 * a run id even when separated — translators then see `<g1>…</g1><g2>…</g2><g1>…</g1>`
 * instead of three unrelated runs. Hyperlink sources and XML elements carry
 * identity (a specific link/tag), so their Self id is part of the signature.
 */
const runSignature = (el: XmlElement, xml: string): string => {
  const keepSelf = el.name !== "CharacterStyleRange"
  const attrs = Object.entries(el.attrs)
    .filter(([k]) => keepSelf || k !== "Self")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join(";")
  const props = el.children.find((c): c is XmlElement => c.type === "element" && c.name === "Properties")
  return `${el.name}(${attrs})${props ? xml.slice(props.start, props.end).replace(/\s+/g, " ") : ""}`
}

const findStory = (root: XmlElement): XmlElement | undefined => {
  if (root.name === "Story") return root
  for (const c of root.children) if (c.type === "element" && c.name === "Story") return c
  return undefined
}

function* descendants(el: XmlElement, name: string): Generator<XmlElement> {
  for (const c of el.children) {
    if (c.type !== "element") continue
    if (c.name === name) yield c
    else if (c.name !== "Table") yield* descendants(c, name)
  }
}

const hasContentDescendant = (el: XmlElement): boolean =>
  el.children.some((c) => c.type === "element" && (c.name === "Content" || hasContentDescendant(c)))

const styleMeta = (el: XmlElement, key: string, attr: string): Record<string, string | number> => {
  const out: Record<string, string | number> = {}
  const v = el.attrs[attr]
  if (v) out[key] = v
  const ps = Number(el.attrs.PointSize)
  if (Number.isFinite(ps) && ps > 0) out.pointSize = ps
  return out
}

// ── Write-back ──────────────────────────────────────────────────────────────

export interface RenderOutcome {
  readonly xml: string
  readonly diagnostics: Diagnostic[]
}

/**
 * Write translations into a story member. `translations` maps structuralPath →
 * translated tagged text. Units without a translation are left untouched.
 */
export const renderStory = (
  memberPath: string,
  xml: string,
  extracted: ExtractedStory,
  translations: ReadonlyMap<string, string>,
): RenderOutcome => {
  const edits: Array<{ start: number; end: number; text: string }> = []
  const diagnostics: Diagnostic[] = []
  for (const su of extracted.units) {
    const t = translations.get(su.unit.structuralPath)
    if (t === undefined || t === su.unit.tagged) continue
    const { assignments, simplified } = distribute(su, t)
    if (simplified) {
      diagnostics.push({
        code: "FORMATTING_SIMPLIFIED",
        severity: "warning",
        message: `translation reorders formatting runs or inline objects; text was placed in source order — review formatting`,
        unitId: su.unit.logicalId || su.unit.structuralPath,
        path: memberPath,
      })
    }
    for (const [slot, text] of assignments) {
      const raw = encodeText(text)
      if (xml.slice(slot.start, slot.end) === raw) continue
      edits.push({ start: slot.start, end: slot.end, text: raw })
    }
  }
  return { xml: edits.length ? splice(xml, edits) : xml, diagnostics }
}

/**
 * Map translated tagged text onto the unit's slots.
 *
 * Stretches are the slot groups between tokens. The translation's text is cut
 * at its tokens; stretch k of the translation goes to stretch k of the source
 * (tokens never move). Inside a stretch, run segments go to the first slot of
 * the matching run when run order is preserved.
 */
const distribute = (su: StoryUnit, tagged: string): { assignments: Map<Slot, string>; simplified: boolean } => {
  const assignments = new Map<Slot, string>()
  let simplified = false
  // Source stretches.
  const srcStretches: Slot[][] = [[]]
  const srcTokenOrder: number[] = []
  let tokenNo = 0
  for (const p of su.pieces) {
    if (p.kind === "token") {
      srcTokenOrder.push(++tokenNo)
      srcStretches.push([])
    } else srcStretches.at(-1)!.push(p)
  }
  // Translation stretches: list of (runId|undefined, text) segments.
  type Seg = { run: number | undefined; text: string }
  const tgtStretches: Seg[][] = [[]]
  const tgtTokenOrder: number[] = []
  for (const p of parseTagged(tagged)) {
    if (p.kind === "token") {
      tgtTokenOrder.push(p.id)
      tgtStretches.push([])
    } else if (p.kind === "text") {
      const run = p.runs.at(-1)
      const cur = tgtStretches.at(-1)!
      const last = cur.at(-1)
      if (last && last.run === run) last.text += p.text
      else cur.push({ run, text: p.text })
    }
  }
  if (tgtTokenOrder.join(",") !== srcTokenOrder.join(",")) simplified = true
  const runOfKey = (s: Slot): number | undefined => (su.multiRun ? su.runIds.get(s.runKey) : undefined)

  // Text the translation places where the source has no writable slot (e.g.
  // before an anchored object that opens the paragraph) is carried to the
  // nearest stretch that has one, keeping reading order.
  let carry = ""
  for (let k = 0; k < srcStretches.length; k++) {
    const slots = srcStretches[k]!
    // With reordered tokens we still map stretch k → stretch k: text stays in reading order.
    let segs = tgtStretches[k] ?? []
    for (const s of slots) assignments.set(s, "")
    if (slots.length === 0) {
      if (segs.length === 0) continue
      const text = segs.map((x) => x.text).join("")
      const prev = srcStretches.slice(0, k).reverse().find((x) => x.length > 0)
      if (prev) {
        const host = prev.at(-1)!
        assignments.set(host, (assignments.get(host) ?? "") + text)
      } else carry += text
      simplified = true
      continue
    }
    if (carry) {
      segs = [{ run: segs[0]?.run, text: carry }, ...segs]
      carry = ""
    }
    if (segs.length === 0) continue
    if (!su.multiRun) {
      assignments.set(slots[0]!, segs.map((x) => x.text).join(""))
      continue
    }
    // Collapse source slots into run groups in order.
    const groups: Array<{ run: number | undefined; slots: Slot[] }> = []
    for (const s of slots) {
      const r = runOfKey(s)
      const last = groups.at(-1)
      if (s.text.length === 0 && last) {
        last.slots.push(s)
        continue
      }
      if (last && last.run === r) last.slots.push(s)
      else groups.push({ run: r, slots: [s] })
    }
    // Greedy in-order matching of translation segments to groups.
    let g = 0
    let ok = true
    const plan: Array<[number, string]> = []
    for (const seg of segs) {
      const run = seg.run
      if (run === undefined) {
        // Untagged text joins the current group (or the first one).
        plan.push([Math.min(g, groups.length - 1), seg.text])
        continue
      }
      let found = -1
      for (let j = g; j < groups.length; j++) {
        if (groups[j]!.run === run) {
          found = j
          break
        }
      }
      if (found < 0) {
        ok = false
        break
      }
      plan.push([found, seg.text])
      g = found
    }
    if (ok) {
      for (const [gi, text] of plan) {
        const slot = groups[gi]!.slots[0]!
        assignments.set(slot, (assignments.get(slot) ?? "") + text)
      }
    } else {
      simplified = true
      // Fallback: each segment goes to the first slot of its run anywhere in the stretch, in translation order;
      // segments of unknown runs go to the first slot.
      for (const seg of segs) {
        const grp = groups.find((x) => x.run === seg.run) ?? groups[0]!
        const slot = grp.slots[0]!
        assignments.set(slot, (assignments.get(slot) ?? "") + seg.text)
      }
    }
  }
  return { assignments, simplified }
}

/** Story text with every slot emptied: equal skeletons mean only text differs. */
export const storySkeleton = (xml: string, extracted: ExtractedStory): string =>
  splice(
    xml,
    extracted.allSlots.map((s) => ({ ...s, text: "" })),
  )
