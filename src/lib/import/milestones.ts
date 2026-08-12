import { getBookName } from "@/lib/file-labeling/bible-book-names"
import type { FileType, TranslatableString } from "@/lib/parsers/types"
import type {
  ImportAddress,
  ImportMilestone,
  ImportSourceLocator,
  ImportUnitKind,
} from "../../../shared/import-contract"

export const FALLBACK_MILESTONE_SIZE = 50
export const TIMELINE_MILESTONE_MS = 5 * 60 * 1000

export interface MilestonePlanUnit {
  unitKey: string
  kind: ImportUnitKind
  canonicalRef?: string
  address: ImportAddress
  sourceLocator: ImportSourceLocator
  sourceText: string
  startMs?: number
  endMs?: number
  metadata?: Record<string, unknown>
}

export interface MilestonePlanOptions {
  fileName: string
  fileType: FileType
  profileId: string
}

/**
 * Assign one stable navigation milestone to every normalized unit.
 *
 * Specialized semantic hints win, followed by Scripture identity, native
 * document structure, timeline buckets, and finally deterministic 50-cell
 * parts. The result is positional (one entry per unit) so callers cannot
 * accidentally leave a content cell unassigned.
 */
export function planImportMilestones(
  units: readonly MilestonePlanUnit[],
  sources: readonly TranslatableString[],
  options: MilestonePlanOptions,
): ImportMilestone[] {
  if (units.length === 0) return []

  const biblicaProfile = options.profileId.startsWith("builtin:biblica-study")
  const explicit = units.map((_, index) => (
    sources[index]?.milestone
    ?? (biblicaProfile ? biblicaMilestone(sources[index]?.metadata) : undefined)
  ))
  if (explicit.some(Boolean)) {
    return fillPartialMilestones(explicit, fallbackMilestones(units))
  }

  if (options.fileType === "obs") return scriptureMilestones(units, true)
  if (units.some((unit) => (
    unit.address.scheme === "scripture" || unit.address.scheme === "scripture-structure"
  ))) {
    return scriptureMilestones(units, false)
  }

  if (isTimelineFile(options.fileType) || units.some((unit) => unit.address.scheme === "timeline")) {
    return timelineMilestones(units)
  }

  if (options.fileType === "pptx") {
    const milestones = documentMemberMilestones(units, "slide")
    if (milestones) return milestones
  }

  if (options.fileType === "idml") {
    const milestones = idmlStoryMilestones(units)
    if (milestones) return milestones
  }

  if (options.fileType === "xlsx") {
    return worksheetMilestones(units, options.fileName)
  }

  if (options.fileType === "md" || options.fileType === "docx" || options.fileType === "html") {
    const milestones = headingMilestones(units)
    if (milestones) return milestones
  }

  if (options.fileType === "json") {
    const milestones = jsonMilestones(units, sources)
    if (milestones) return milestones
  }

  if (options.fileType === "properties") {
    const milestones = propertiesMilestones(units, sources)
    if (milestones) return milestones
  }

  if (options.fileType === "po") {
    const milestones = poMilestones(units, sources)
    if (milestones) return milestones
  }

  if (options.fileType === "xliff") {
    const milestones = xliffMilestones(units, sources)
    if (milestones) return milestones
  }

  if (options.fileType === "csv" || options.fileType === "tsv" || options.fileType === "custom") {
    const milestones = headingMilestones(units)
    if (milestones) return milestones
  }

  return fallbackMilestones(units)
}

function biblicaMilestone(metadata: Record<string, unknown> | undefined): ImportMilestone | undefined {
  const value = record(metadata?.biblica)
  if (!value) return undefined

  // A front/back-matter volume marks no chapters; its sections are the volume's
  // own headings ("A", "B", … in the Bible Dictionary).
  const sectionLabel = string(value.sectionLabel)
  if (sectionLabel) {
    return {
      key: `biblica:front-matter:${sectionLabel}`,
      kind: "section",
      label: sectionLabel,
      shortLabel: sectionLabel.length <= 8 ? sectionLabel : `${sectionLabel.slice(0, 7)}…`,
    }
  }

  const rawChapter = string(value.chapterLabel)
  if (!rawChapter) return undefined
  const bookCode = string(value.bookCode)?.toUpperCase()
  const bookName = bookCode ? getBookName(bookCode) ?? bookCode : undefined
  const shortLabel = rawChapter === "Preface" ? "P" : rawChapter.replace("-", "–")
  const chapterLabel = rawChapter === "Preface" ? "Preface" : rawChapter.replace("-", "–")
  const kind = rawChapter === "Preface"
    ? "preface"
    : rawChapter.includes("-")
      ? "chapter-range"
      : "chapter"
  return {
    key: `biblica:${bookCode ?? "unknown"}:${rawChapter}`,
    kind,
    label: bookName ? `${bookName} ${chapterLabel}` : chapterLabel,
    shortLabel,
  }
}

function fillPartialMilestones(
  explicit: readonly (ImportMilestone | undefined)[],
  fallback: readonly ImportMilestone[],
): ImportMilestone[] {
  const nextExplicit: (ImportMilestone | undefined)[] = new Array(explicit.length)
  let next: ImportMilestone | undefined
  for (let index = explicit.length - 1; index >= 0; index -= 1) {
    if (explicit[index]) next = explicit[index]
    nextExplicit[index] = next
  }

  let current: ImportMilestone | undefined
  return explicit.map((value, index) => {
    if (value) current = value
    return current ?? nextExplicit[index] ?? fallback[index]!
  })
}

function scriptureMilestones(
  units: readonly MilestonePlanUnit[],
  obs: boolean,
): ImportMilestone[] {
  const direct = units.map((unit): ImportMilestone | undefined => {
    const address = unit.address
    if (address.scheme !== "scripture" && address.scheme !== "scripture-structure") return undefined
    if (address.chapter === null) return undefined
    if (obs || address.book.toUpperCase() === "OBS") {
      return {
        key: `story:OBS:${address.chapter}`,
        kind: "story",
        label: `Story ${address.chapter}`,
        shortLabel: String(address.chapter),
      }
    }
    const book = address.book.toUpperCase()
    const bookName = getBookName(book) ?? book
    return {
      key: `scripture:${book}:${address.chapter}`,
      kind: "chapter",
      label: `${bookName} ${address.chapter}`,
      shortLabel: String(address.chapter),
    }
  })

  const nextDirect: (ImportMilestone | undefined)[] = new Array(units.length)
  let next: ImportMilestone | undefined
  for (let index = units.length - 1; index >= 0; index -= 1) {
    if (direct[index]) next = direct[index]
    nextDirect[index] = next
  }

  let previous: ImportMilestone | undefined
  const fallback = fallbackMilestones(units)
  return units.map((unit, index) => {
    if (direct[index]) previous = direct[index]
    // Structural rows normally introduce the following chapter. Content rows
    // without a ref inherit the chapter already in effect.
    if (unit.kind === "heading" || unit.kind === "paratext") {
      return direct[index] ?? nextDirect[index] ?? previous ?? fallback[index]!
    }
    return direct[index] ?? previous ?? nextDirect[index] ?? fallback[index]!
  })
}

function headingMilestones(
  units: readonly MilestonePlanUnit[],
): ImportMilestone[] | null {
  if (!units.some((unit) => unit.kind === "heading")) return null
  let sectionNumber = 0
  let current: ImportMilestone = {
    key: "section:start",
    kind: "section",
    label: "Start",
    shortLabel: "S",
  }
  return units.map((unit) => {
    if (unit.kind === "heading") {
      sectionNumber += 1
      const label = compactLabel(unit.sourceText) || `Section ${sectionNumber}`
      current = {
        key: `section:${unit.unitKey}`,
        kind: "section",
        label,
        shortLabel: String(sectionNumber),
      }
    }
    return current
  })
}

function documentMemberMilestones(
  units: readonly MilestonePlanUnit[],
  kind: "slide" | "group",
): ImportMilestone[] | null {
  const members = units.map((unit) => (
    unit.address.scheme === "document" ? unit.address.memberPath : undefined
  ))
  if (!members.some(Boolean)) return null

  const titles = new Map<string, string>()
  for (const unit of units) {
    if (unit.kind !== "heading" || unit.address.scheme !== "document") continue
    if (!titles.has(unit.address.memberPath)) {
      const label = compactLabel(unit.sourceText)
      if (label) titles.set(unit.address.memberPath, label)
    }
  }

  const ordinals = ordinalByFirstAppearance(members)
  const fallback = fallbackMilestones(units)
  return members.map((member, index) => {
    if (!member) return index > 0 ? fallback[index - 1]! : fallback[index]!
    const ordinal = ordinals.get(member) ?? 1
    const slideNumber = member.match(/slide(\d+)\.xml/i)?.[1]
    const shortLabel = slideNumber ?? String(ordinal)
    const base = kind === "slide" ? `Slide ${shortLabel}` : friendlyMemberLabel(member, ordinal)
    const title = titles.get(member)
    return {
      key: `${kind}:${member}`,
      kind,
      label: title && title !== base ? `${base}: ${title}` : title ?? base,
      shortLabel,
    }
  })
}

function worksheetMilestones(
  units: readonly MilestonePlanUnit[],
  fileName: string,
): ImportMilestone[] {
  const sheetLabel = worksheetLabel(fileName)
  const sheet: ImportMilestone = {
    key: `group:worksheet:${units[0]?.unitKey ?? sheetLabel}`,
    kind: "group",
    label: sheetLabel,
    shortLabel: "1",
  }
  if (!units.some((unit) => unit.kind === "heading")) {
    return units.map(() => sheet)
  }

  let sectionNumber = 0
  let current = sheet
  return units.map((unit) => {
    if (unit.kind === "heading") {
      sectionNumber += 1
      current = {
        key: `section:${unit.unitKey}`,
        kind: "section",
        label: compactLabel(unit.sourceText) || `Section ${sectionNumber}`,
        shortLabel: String(sectionNumber),
      }
    }
    return current
  })
}

function idmlStoryMilestones(
  units: readonly MilestonePlanUnit[],
): ImportMilestone[] | null {
  const stories = units.map((unit) => (
    unit.sourceLocator.kind === "idml"
      ? `${unit.sourceLocator.memberPath}:${unit.sourceLocator.storyId ?? unit.sourceLocator.elementPath}`
      : undefined
  ))
  if (!stories.some(Boolean)) return null
  const ordinals = ordinalByFirstAppearance(stories)
  const fallback = fallbackMilestones(units)
  return stories.map((story, index) => {
    if (!story) return index > 0 ? fallback[index - 1]! : fallback[index]!
    const ordinal = ordinals.get(story) ?? 1
    return {
      key: `story:${story}`,
      kind: "story",
      label: `Story ${ordinal}`,
      shortLabel: String(ordinal),
    }
  })
}

function jsonMilestones(
  units: readonly MilestonePlanUnit[],
  sources: readonly TranslatableString[],
): ImportMilestone[] | null {
  return semanticGroupMilestones(
    units,
    sources.map((source) => {
      const path = string(source?.context) ?? string(source?.group)
      if (!path || path.startsWith("[")) return undefined
      const firstSegment = path.match(/^([^.[\]]+)/)?.[1]?.trim()
      return firstSegment ? { identity: firstSegment, label: firstSegment } : undefined
    }),
    "json",
  )
}

function propertiesMilestones(
  units: readonly MilestonePlanUnit[],
  sources: readonly TranslatableString[],
): ImportMilestone[] | null {
  return semanticGroupMilestones(
    units,
    sources.map((source) => {
      const key = string(source?.context) ?? string(source?.group)
      const prefix = key?.includes(".") ? key.slice(0, key.indexOf(".")).trim() : undefined
      return prefix ? { identity: prefix, label: prefix } : undefined
    }),
    "properties",
  )
}

function poMilestones(
  units: readonly MilestonePlanUnit[],
  sources: readonly TranslatableString[],
): ImportMilestone[] | null {
  return semanticGroupMilestones(
    units,
    sources.map((source) => {
      const po = record(source?.metadata?.po)
      const context = string(po?.msgctxt)
      if (context) return { identity: `context:${context}`, label: context }
      const reference = sourceReferenceFile(string(po?.sourceReference))
      return reference ? { identity: `reference:${reference}`, label: reference } : undefined
    }),
    "po",
  )
}

function xliffMilestones(
  units: readonly MilestonePlanUnit[],
  sources: readonly TranslatableString[],
): ImportMilestone[] | null {
  return semanticGroupMilestones(
    units,
    sources.map((source) => {
      const xliff = record(source?.metadata?.xliff)
      const fileId = string(xliff?.fileId)
      const groupId = string(xliff?.groupId)
      if (!fileId && !groupId) return undefined
      const identity = [fileId, groupId].filter(Boolean).join("/")
      return {
        identity,
        label: groupId ? `${fileId ? `${fileId}: ` : ""}${groupId}` : fileId!,
      }
    }),
    "xliff",
  )
}

function semanticGroupMilestones(
  units: readonly MilestonePlanUnit[],
  groups: readonly ({ identity: string; label: string } | undefined)[],
  namespace: string,
): ImportMilestone[] | null {
  if (!groups.some(Boolean)) return null
  const milestones = new Map<string, ImportMilestone>()
  const fallback = fallbackMilestones(units)
  return groups.map((group, index) => {
    if (!group) return fallback[index]!
    const existing = milestones.get(group.identity)
    if (existing) return existing
    const value: ImportMilestone = {
      key: `group:${namespace}:${group.identity}`,
      kind: "group",
      label: compactLabel(group.label) || `Group ${milestones.size + 1}`,
      shortLabel: String(milestones.size + 1),
    }
    milestones.set(group.identity, value)
    return value
  })
}

function timelineMilestones(units: readonly MilestonePlanUnit[]): ImportMilestone[] {
  return units.map((unit) => {
    const startMs = unit.startMs ?? (
      unit.address.scheme === "timeline" ? unit.address.startMs : undefined
    )
    if (startMs === undefined) {
      return {
        key: "time:untimed",
        kind: "time-range",
        label: "Untimed",
        shortLabel: "—",
      }
    }
    const bucketStart = Math.floor(startMs / TIMELINE_MILESTONE_MS) * TIMELINE_MILESTONE_MS
    const bucketEnd = bucketStart + TIMELINE_MILESTONE_MS
    return {
      key: `time:${bucketStart}`,
      kind: "time-range",
      label: `${formatClock(bucketStart)}–${formatClock(bucketEnd)}`,
      shortLabel: `${Math.floor(bucketStart / 60_000)}–${Math.floor(bucketEnd / 60_000)}m`,
    }
  })
}

function fallbackMilestones(units: readonly MilestonePlanUnit[]): ImportMilestone[] {
  const result: ImportMilestone[] = []
  for (let index = 0; index < units.length; index += FALLBACK_MILESTONE_SIZE) {
    const part = Math.floor(index / FALLBACK_MILESTONE_SIZE) + 1
    const milestone: ImportMilestone = {
      key: `part:${units[index]?.unitKey ?? part}`,
      kind: "part",
      label: `Part ${part}`,
      shortLabel: String(part),
    }
    for (
      let member = index;
      member < Math.min(index + FALLBACK_MILESTONE_SIZE, units.length);
      member += 1
    ) {
      result[member] = milestone
    }
  }
  return result
}

function worksheetLabel(fileName: string): string {
  const divider = fileName.lastIndexOf(" — ")
  const selectedSheet = divider >= 0 ? fileName.slice(divider + 3).trim() : ""
  return selectedSheet || fileName.replace(/\.xlsx$/i, "").trim() || "Worksheet"
}

function sourceReferenceFile(value: string | undefined): string | undefined {
  if (!value) return undefined
  const first = value.trim().split(/\s+/)[0]
  return first?.replace(/:\d+(?::\d+)?$/, "") || undefined
}

function ordinalByFirstAppearance(
  values: readonly (string | undefined)[],
): Map<string, number> {
  const result = new Map<string, number>()
  for (const value of values) {
    if (value && !result.has(value)) result.set(value, result.size + 1)
  }
  return result
}

function friendlyMemberLabel(member: string, ordinal: number): string {
  const tail = member.split("/").filter(Boolean).at(-1)
  const withoutExtension = tail?.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim()
  return withoutExtension || `Group ${ordinal}`
}

function compactLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length > 80 ? `${normalized.slice(0, 77).trimEnd()}…` : normalized
}

function formatClock(valueMs: number): string {
  const totalSeconds = Math.floor(valueMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function isTimelineFile(fileType: FileType): boolean {
  return fileType === "vtt"
    || fileType === "srt"
    || fileType === "sbv"
    || fileType === "audio"
    || fileType === "video"
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
