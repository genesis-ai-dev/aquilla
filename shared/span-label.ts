/**
 * Autopilot passage labels for humans: verse refs, spreadsheet tags, cue
 * times, or 1-based cell ordinals. Never opaque cell/span UUIDs.
 *
 * A span is a contiguous run of cells. Display it as a range
 * (`GEN 1:1–GEN 1:8`, `1–12`), not as a list of every member.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TRUNCATED_UUID_RANGE_RE = /^[0-9a-f]{8}[.…·-]{1,3}[0-9a-f]{8}$/i
const UUID_PREFIX_RE = /^[0-9a-f]{8}$/i

export interface CellDisplayFields {
  canonicalRef?: string | null
  sequenceIndex?: number | null
  metadata?: Record<string, unknown> | null
  startMs?: number | null
  endMs?: number | null
  /** 1-based document position; used when no ref/tag/cue exists. */
  ordinal?: number | null
}

export function isOpaqueId(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  if (UUID_RE.test(trimmed) || TRUNCATED_UUID_RANGE_RE.test(trimmed)) return true
  const parts = trimmed.split(/[\s,;·]+/).filter(Boolean)
  if (parts.length > 1 && parts.every((part) => UUID_RE.test(part) || UUID_PREFIX_RE.test(part))) {
    return true
  }
  const rangeParts = trimmed.split(/\s*(?:…|\.{2,}|–)\s*/).filter(Boolean)
  if (rangeParts.length >= 2 && rangeParts.every((part) => UUID_RE.test(part) || UUID_PREFIX_RE.test(part))) {
    return true
  }
  return false
}

export function humanPassageLabel(label: string | null | undefined): string | null {
  if (typeof label !== "string") return null
  const trimmed = label.trim()
  if (!trimmed || isOpaqueId(trimmed)) return null
  return trimmed
}

export function formatRange(start: string, end: string): string {
  if (!start) return end
  if (!end || start === end) return start
  return `${start}–${end}`
}

function metadataTag(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null
  for (const key of ["spreadsheetLabel", "cellLabel", "label", "tag"]) {
    const value = metadata[key]
    if (typeof value === "string") {
      const tag = humanPassageLabel(value)
      if (tag) return tag
    }
  }
  return null
}

function formatCue(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

function ordinalTag(fields: CellDisplayFields): string | null {
  if (fields.ordinal != null && Number.isFinite(fields.ordinal) && fields.ordinal > 0) {
    return String(Math.floor(fields.ordinal))
  }
  if (fields.sequenceIndex != null && Number.isFinite(fields.sequenceIndex)) {
    const index = Number(fields.sequenceIndex)
    return String(Math.floor(index) >= 0 ? Math.floor(index) + 1 : index)
  }
  return null
}

export function cellDisplayTag(fields: CellDisplayFields | null | undefined): string | null {
  if (!fields) return null
  const ref = humanPassageLabel(fields.canonicalRef ?? null)
  if (ref) return ref
  const tagged = metadataTag(fields.metadata)
  if (tagged) return tagged
  if (fields.startMs != null && Number.isFinite(fields.startMs)) {
    return formatCue(fields.startMs)
  }
  return ordinalTag(fields)
}

export function formatSpanRange(
  start: CellDisplayFields | null | undefined,
  end: CellDisplayFields | null | undefined,
): string | null {
  if (!start && !end) return null
  const startCue = start?.startMs
  const endCue = end?.endMs ?? end?.startMs
  const startHasRef = Boolean(humanPassageLabel(start?.canonicalRef ?? null) || metadataTag(start?.metadata))
  const endHasRef = Boolean(humanPassageLabel(end?.canonicalRef ?? null) || metadataTag(end?.metadata))
  if (!startHasRef && !endHasRef && startCue != null && endCue != null) {
    return formatRange(formatCue(startCue), formatCue(endCue))
  }
  const startTag = cellDisplayTag(start)
  const endTag = cellDisplayTag(end)
  if (!startTag && !endTag) return null
  return formatRange(startTag ?? endTag ?? "", endTag ?? startTag ?? "")
}

/** Collapse a list of cell tags or opaque ids to `first–last`. */
export function collapseListToRange(values: unknown): string | null {
  if (!Array.isArray(values) || values.length === 0) return null
  const strings = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  if (strings.length === 0) return null
  const tags = strings.map((value) => humanPassageLabel(value)).filter((tag): tag is string => tag !== null)
  if (tags.length > 0) return formatRange(tags[0], tags[tags.length - 1])
  return strings.length === 1 ? "1" : `1–${strings.length}`
}

export function joinPassageLabels(labels: Array<string | null | undefined>): string | null {
  const unique = [...new Set(labels.map((label) => humanPassageLabel(label)).filter((label): label is string => Boolean(label)))]
  if (unique.length === 0) return null
  if (unique.length === 1) return unique[0]
  const alreadyRanged = unique.every((label) => /[–-]/.test(label))
  if (alreadyRanged) return unique.join(" · ")
  return formatRange(unique[0], unique[unique.length - 1])
}
