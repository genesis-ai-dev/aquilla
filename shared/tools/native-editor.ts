/**
 * Smart Extensions apiRev 8 — native editor integration contract.
 *
 * Instead of forcing extensions to reimplement Aquilla's editor inside an
 * iframe, extensions plug into the real native `EditorTable`:
 *   1. Active-cell sync (`editor.activeCell` + `editor.reveal`) so side panels
 *      follow the cell the translator is editing and can jump the editor.
 *   2. Declarative per-cell annotations (`editor.annotate` / `clearAnnotations`):
 *      row badges, source/target text span highlights with optional one-click
 *      target fixes, and read-only extension column values — all rendered
 *      natively by `EditorTable` with zero iframes per row.
 *   3. Cell-menu and source-selection actions (`where: ["cell" | "selection"]`).
 *   4. Declarative read-only columns (`manifest.columns`).
 */

export type AnnotationTone = "neutral" | "info" | "warn" | "error" | "success"

export const ANNOTATION_TONES: readonly AnnotationTone[] = ["neutral", "info", "warn", "error", "success"]

export interface NativeActiveCell {
  fileId: string
  cellId: string
  ref: string | null
  source: string
  target: string
}

export interface ExtensionCellBadge {
  id?: string
  label: string
  tone?: AnnotationTone
  tooltip?: string
  /** Clicking the badge runs this manifest action on this cell. */
  actionId?: string
  /** Clicking the badge opens this extension's side panel with this cell active. */
  openPanel?: boolean
}

export interface ExtensionSpanFix {
  label: string
  /** Replacement text for [start..end] on target spans (or full target text on source spans). */
  replacement: string
}

export interface ExtensionCellSpan {
  id?: string
  side: "source" | "target"
  start: number
  end: number
  tone?: AnnotationTone
  label?: string
  message: string
  fix?: ExtensionSpanFix
  openPanel?: boolean
}

export interface ExtensionColumnCell {
  text: string
  badge?: string
  tone?: AnnotationTone
  dir?: "ltr" | "rtl" | "auto"
}

export interface ExtensionCellAnnotation {
  badges?: ExtensionCellBadge[]
  spans?: ExtensionCellSpan[]
  /** Values keyed by column id declared in `manifest.columns`. */
  columns?: Record<string, ExtensionColumnCell>
}

export interface ExtensionAnnotateInput {
  fileId: string
  /** Namespace so one extension can maintain independent layers (default "default"). */
  layer: string
  cells: Record<string, ExtensionCellAnnotation>
}

export const MAX_ANNOTATE_CELLS = 2000
export const MAX_BADGES_PER_CELL = 4
export const MAX_SPANS_PER_CELL = 12
export const MAX_COLUMNS_PER_CELL = 4
export const MAX_BADGE_LABEL_CHARS = 48
export const MAX_MESSAGE_CHARS = 500
export const MAX_COLUMN_TEXT_CHARS = 2000
export const MAX_FIX_CHARS = 2000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asTone(v: unknown, fallback: AnnotationTone = "neutral"): AnnotationTone {
  return typeof v === "string" && (ANNOTATION_TONES as readonly string[]).includes(v) ? (v as AnnotationTone) : fallback
}

function asDir(v: unknown): "ltr" | "rtl" | "auto" | undefined {
  return v === "ltr" || v === "rtl" || v === "auto" ? v : undefined
}

/** Validate and clamp `aquilla.editor.annotate` params. Returns an error string on invalid shape. */
export function parseAnnotateInput(params: unknown): { ok: true; value: ExtensionAnnotateInput } | { ok: false; error: string } {
  if (!isRecord(params)) return { ok: false, error: "params must be an object" }
  const fileId = typeof params.fileId === "string" ? params.fileId.trim() : ""
  if (!fileId || fileId.length > 200) return { ok: false, error: "fileId must be a non-empty string" }
  const rawLayer = typeof params.layer === "string" && params.layer.trim() ? params.layer.trim() : "default"
  if (rawLayer.length > 64) return { ok: false, error: "layer exceeds 64 characters" }
  if (!isRecord(params.cells)) return { ok: false, error: "cells must be an object mapping cellId to annotations" }
  const entries = Object.entries(params.cells)
  if (entries.length > MAX_ANNOTATE_CELLS) return { ok: false, error: `at most ${MAX_ANNOTATE_CELLS} cells per annotate call` }

  const cells: Record<string, ExtensionCellAnnotation> = {}
  for (const [cellId, raw] of entries) {
    if (!cellId || cellId.length > 200) return { ok: false, error: "cellId must be a non-empty string" }
    if (!isRecord(raw)) return { ok: false, error: `cells[${cellId}] must be an object` }
    const out: ExtensionCellAnnotation = {}

    if (raw.badges !== undefined) {
      if (!Array.isArray(raw.badges)) return { ok: false, error: `cells[${cellId}].badges must be an array` }
      const badges: ExtensionCellBadge[] = []
      for (const b of raw.badges.slice(0, MAX_BADGES_PER_CELL)) {
        if (!isRecord(b)) return { ok: false, error: `cells[${cellId}].badges entries must be objects` }
        const label = typeof b.label === "string" ? b.label.trim().slice(0, MAX_BADGE_LABEL_CHARS) : ""
        if (!label) return { ok: false, error: `cells[${cellId}].badges[].label must be non-empty` }
        const badge: ExtensionCellBadge = { label, tone: asTone(b.tone, "neutral") }
        if (typeof b.id === "string" && b.id.trim()) badge.id = b.id.trim().slice(0, 64)
        if (typeof b.tooltip === "string" && b.tooltip.trim()) badge.tooltip = b.tooltip.trim().slice(0, MAX_MESSAGE_CHARS)
        if (typeof b.actionId === "string" && b.actionId.trim()) badge.actionId = b.actionId.trim().slice(0, 64)
        if (b.openPanel === true) badge.openPanel = true
        badges.push(badge)
      }
      if (badges.length > 0) out.badges = badges
    }

    if (raw.spans !== undefined) {
      if (!Array.isArray(raw.spans)) return { ok: false, error: `cells[${cellId}].spans must be an array` }
      const spans: ExtensionCellSpan[] = []
      for (const s of raw.spans.slice(0, MAX_SPANS_PER_CELL)) {
        if (!isRecord(s)) return { ok: false, error: `cells[${cellId}].spans entries must be objects` }
        const side = s.side === "source" || s.side === "target" ? s.side : null
        if (!side) return { ok: false, error: `cells[${cellId}].spans[].side must be "source" or "target"` }
        const start = typeof s.start === "number" && Number.isFinite(s.start) ? Math.floor(s.start) : -1
        const end = typeof s.end === "number" && Number.isFinite(s.end) ? Math.floor(s.end) : -1
        if (start < 0 || end <= start) return { ok: false, error: `cells[${cellId}].spans[] requires 0 <= start < end` }
        const message = typeof s.message === "string" ? s.message.trim().slice(0, MAX_MESSAGE_CHARS) : ""
        if (!message) return { ok: false, error: `cells[${cellId}].spans[].message must be non-empty` }
        const span: ExtensionCellSpan = { side, start, end, tone: asTone(s.tone, "info"), message }
        if (typeof s.id === "string" && s.id.trim()) span.id = s.id.trim().slice(0, 64)
        if (typeof s.label === "string" && s.label.trim()) span.label = s.label.trim().slice(0, 64)
        if (s.openPanel === true) span.openPanel = true
        if (isRecord(s.fix)) {
          const fixLabel = typeof s.fix.label === "string" ? s.fix.label.trim().slice(0, 80) : ""
          const replacement = typeof s.fix.replacement === "string" ? s.fix.replacement.slice(0, MAX_FIX_CHARS) : null
          if (fixLabel && replacement !== null) span.fix = { label: fixLabel, replacement }
        }
        spans.push(span)
      }
      if (spans.length > 0) out.spans = spans
    }

    if (raw.columns !== undefined) {
      if (!isRecord(raw.columns)) return { ok: false, error: `cells[${cellId}].columns must be an object` }
      const cols: Record<string, ExtensionColumnCell> = {}
      for (const [colId, val] of Object.entries(raw.columns).slice(0, MAX_COLUMNS_PER_CELL)) {
        if (!colId || colId.length > 64) return { ok: false, error: `cells[${cellId}].columns key must be a short id` }
        if (typeof val === "string") {
          cols[colId] = { text: val.slice(0, MAX_COLUMN_TEXT_CHARS) }
        } else if (isRecord(val) && typeof val.text === "string") {
          const cell: ExtensionColumnCell = { text: val.text.slice(0, MAX_COLUMN_TEXT_CHARS) }
          if (typeof val.badge === "string" && val.badge.trim()) cell.badge = val.badge.trim().slice(0, MAX_BADGE_LABEL_CHARS)
          if (val.tone !== undefined) cell.tone = asTone(val.tone, "neutral")
          const dir = asDir(val.dir)
          if (dir) cell.dir = dir
          cols[colId] = cell
        } else {
          return { ok: false, error: `cells[${cellId}].columns[${colId}] must be a string or { text }` }
        }
      }
      if (Object.keys(cols).length > 0) out.columns = cols
    }

    cells[cellId] = out
  }

  return { ok: true, value: { fileId, layer: rawLayer, cells } }
}

/** Apply a span quick-fix cleanly onto a plain-text target string. */
export function applySpanFix(targetText: string, span: ExtensionCellSpan): string | null {
  if (!span.fix) return null
  if (span.side === "target") {
    const start = Math.max(0, Math.min(span.start, targetText.length))
    const end = Math.max(start, Math.min(span.end, targetText.length))
    return targetText.slice(0, start) + span.fix.replacement + targetText.slice(end)
  }
  // For a source-side span with a fix, replacement is the suggested full target text.
  return span.fix.replacement
}
