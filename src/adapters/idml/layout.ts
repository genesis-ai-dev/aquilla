/**
 * Layout assurance for IDML (spec §5, Phase 3) — the honest version.
 *
 * True overset detection needs InDesign's composer (fonts, kerning, hyphenation,
 * wrap, grids). This module provides a *calibrated estimate* that is good
 * enough to catch the defects that matter most in translation — a story whose
 * text grows past its threaded frames — and is explicit about being an
 * estimate. A real oracle (InDesign Server running a UXP script) can be slotted
 * in behind the same LayoutFinding interface; see docs/LAYOUT.md.
 *
 * Method: compute each story's frame capacity (threaded frames, columns,
 * insets) and estimate the text's vertical demand per paragraph from point
 * size, leading, column width and per-script average glyph widths. Because
 * the source document is known to fit, the target's estimated fill is scaled
 * by the same calibration factor that makes the source fit.
 */
import { parseXml, walk } from "../xml.ts"
import type { XmlElement } from "../xml.ts"
import type { LayoutFinding } from "../adapter.ts"
import type { IdmlPackage } from "./package.ts"
import { memberText } from "./package.ts"

export interface Frame {
  readonly id: string
  readonly story: string
  readonly width: number
  readonly height: number
  readonly columns: number
  readonly gutter: number
  readonly insets: readonly [number, number, number, number]
  readonly spread: string
}

const parseNums = (s: string | undefined): number[] => (s ? s.trim().split(/\s+/).map(Number) : [])

const frameFrom = (el: XmlElement, spread: string): Frame | undefined => {
  const story = el.attrs.ParentStory
  if (!story || el.name !== "TextFrame") return undefined
  const xs: number[] = []
  const ys: number[] = []
  let columns = 1
  let gutter = 12
  let insets: [number, number, number, number] = [0, 0, 0, 0]
  for (const c of walk(el)) {
    if (c.name === "PathPointType" && c.attrs.Anchor) {
      const [x, y] = parseNums(c.attrs.Anchor)
      if (Number.isFinite(x) && Number.isFinite(y)) {
        xs.push(x!)
        ys.push(y!)
      }
    }
    if (c.name === "TextFramePreference") {
      const n = Number(c.attrs.TextColumnCount)
      if (n > 0) columns = n
      const g = Number(c.attrs.TextColumnGutter)
      if (g >= 0) gutter = g
      const ins = parseNums(c.attrs.InsetSpacing)
      if (ins.length === 4 && ins.every(Number.isFinite)) insets = ins as [number, number, number, number]
    }
  }
  // Some generators write GeometricBounds (top left bottom right) instead of path points.
  if (xs.length === 0 && el.attrs.GeometricBounds) {
    const [t, l, b, r] = parseNums(el.attrs.GeometricBounds)
    if ([t, l, b, r].every((v) => Number.isFinite(v))) {
      xs.push(l!, r!)
      ys.push(t!, b!)
    }
  }
  if (xs.length === 0) return undefined
  const [a = 1, , , d = 1] = parseNums(el.attrs.ItemTransform)
  const width = (Math.max(...xs) - Math.min(...xs)) * Math.abs(a || 1)
  const height = (Math.max(...ys) - Math.min(...ys)) * Math.abs(d || 1)
  return { id: el.attrs.Self ?? "", story, width, height, columns, gutter, insets, spread }
}

export const framesOf = (pkg: IdmlPackage): Frame[] => {
  const out: Frame[] = []
  for (const s of [...pkg.spreads, ...pkg.masterSpreads]) {
    for (const el of walk(parseXml(memberText(pkg, s)).root)) {
      const f = frameFrom(el, s)
      if (f) out.push(f)
    }
  }
  return out
}

/** Paragraph style point sizes / leading from Resources/Styles.xml (with BasedOn inheritance). */
export const paragraphStyleMetrics = (pkg: IdmlPackage): Map<string, { size: number; leading: number }> => {
  const out = new Map<string, { size: number; leading: number }>()
  const name = [...pkg.byName.keys()].find((n) => /(^|\/)Styles\.xml$/.test(n))
  if (!name) return out
  const raw = new Map<string, { size?: number; leading?: number; basedOn?: string }>()
  for (const el of walk(parseXml(memberText(pkg, name)).root)) {
    if (el.name !== "ParagraphStyle" || !el.attrs.Self) continue
    let basedOn: string | undefined
    for (const c of walk(el)) if (c.name === "BasedOn") basedOn = c.children.map((x) => (x.type === "text" ? x.text : "")).join("").trim()
    const size = Number(el.attrs.PointSize)
    const leading = Number(el.attrs.Leading)
    raw.set(el.attrs.Self, {
      ...(size > 0 ? { size } : {}),
      ...(leading > 0 ? { leading } : {}),
      ...(basedOn ? { basedOn } : {}),
    })
  }
  const resolve = (id: string, depth = 0): { size: number; leading: number } => {
    const r = raw.get(id)
    const parent = r?.basedOn && depth < 10 ? resolve(r.basedOn, depth + 1) : { size: 12, leading: 14.4 }
    const size = r?.size ?? parent.size
    return { size, leading: r?.leading ?? (r?.size ? size * 1.2 : parent.leading) }
  }
  for (const id of raw.keys()) out.set(id, resolve(id))
  return out
}

/** Average advance width in ems for a string, by script. */
export const emWidth = (text: string): number => {
  let w = 0
  for (const ch of text) {
    if (/\s/.test(ch)) w += 0.25
    else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) w += 1
    else if (/\p{Lu}/u.test(ch)) w += 0.62
    else if (/\p{M}/u.test(ch)) w += 0
    else w += 0.5
  }
  return w
}

export interface StoryText {
  readonly story: string
  readonly paragraphs: ReadonlyArray<{ text: string; size: number; leading: number }>
}

const demand = (paras: StoryText["paragraphs"], colWidth: number): number =>
  paras.reduce((h, p) => {
    const lineEms = colWidth / p.size
    const lines = Math.max(1, Math.ceil(emWidth(p.text) / Math.max(lineEms, 1)))
    return h + lines * p.leading
  }, 0)

export interface FitPolicy {
  /** Most negative tracking (1/1000 em) the repair may apply. */
  readonly minTracking: number
  /** Smallest horizontal scale (%) the repair may apply. */
  readonly minHorizontalScale: number
}

export const DEFAULT_FIT_POLICY: FitPolicy = { minTracking: -20, minHorizontalScale: 96 }

/** Estimate fit for each placed story, source vs target. */
export const estimateFit = (
  frames: readonly Frame[],
  source: ReadonlyArray<StoryText>,
  target: ReadonlyArray<StoryText>,
  policy: FitPolicy = DEFAULT_FIT_POLICY,
): LayoutFinding[] => {
  const byStory = new Map<string, Frame[]>()
  for (const f of frames) byStory.set(f.story, [...(byStory.get(f.story) ?? []), f])
  const tgt = new Map(target.map((t) => [t.story, t]))
  const findings: LayoutFinding[] = []
  for (const src of source) {
    const fs = byStory.get(src.story)
    const t = tgt.get(src.story)
    if (!fs || fs.length === 0 || !t) continue
    let capacity = 0
    let widthSum = 0
    for (const f of fs) {
      const innerW = Math.max(1, f.width - f.insets[1] - f.insets[3])
      const innerH = Math.max(1, f.height - f.insets[0] - f.insets[2])
      const colW = Math.max(1, (innerW - f.gutter * (f.columns - 1)) / f.columns)
      capacity += innerH * f.columns
      widthSum += colW
    }
    const colWidth = widthSum / fs.length
    const sDemand = demand(src.paragraphs, colWidth)
    const tDemand = demand(t.paragraphs, colWidth)
    const sourceFill = sDemand / capacity
    // Calibrate: the source is known to fit, so if our estimate says it overflows, scale down.
    const cal = sourceFill > 0.97 ? 0.97 / sourceFill : 1
    const targetFill = (tDemand / capacity) * cal
    const sChars = src.paragraphs.reduce((n, p) => n + emWidth(p.text), 0)
    const tChars = t.paragraphs.reduce((n, p) => n + emWidth(p.text), 0)
    const expansion = sChars > 0 ? tChars / sChars : 1
    const severity = targetFill > 1 ? "overset" : targetFill > 0.95 ? "tight" : "ok"
    let repair: string | undefined
    if (severity === "overset") {
      const needed = 1 - 1 / targetFill
      const trackingGain = (-policy.minTracking / 1000) / 0.5
      const scaleGain = 1 - policy.minHorizontalScale / 100
      if (needed <= trackingGain) repair = `tracking ${Math.ceil((needed * 0.5 * 1000) / 5) * -5}`
      else if (needed <= trackingGain + scaleGain) {
        const scale = Math.max(policy.minHorizontalScale, Math.floor(100 * (1 - (needed - trackingGain))))
        repair = `tracking ${policy.minTracking}, horizontal scale ${scale}%`
      } else repair = "beyond automatic limits — shorten copy, enlarge or add a threaded frame"
    }
    findings.push({
      scope: `story:${src.story}`,
      severity,
      sourceFill: round(sourceFill * cal),
      targetFill: round(targetFill),
      expansion: round(expansion),
      detail: `${fs.length} frame(s); estimated fill ${pct(sourceFill * cal)} → ${pct(targetFill)} (text ×${expansion.toFixed(2)})`,
      ...(repair ? { repair } : {}),
    })
  }
  return findings
}

const round = (n: number): number => Math.round(n * 1000) / 1000
const pct = (n: number): string => `${Math.round(n * 100)}%`
