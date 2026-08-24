import type { AquillaDb } from "../../../../db/shim/postgres"
import { orderPairs, type CellPair } from "../agent/tools/select-cells"
import {
  cellDisplayTag,
  collapseListToRange,
  formatSpanRange,
  humanPassageLabel,
  type CellDisplayFields,
} from "../../../../shared/span-label"

export interface CellDisplayRow extends CellDisplayFields {
  cellId: string
}

export class CellDisplayIndex {
  private readonly byId: Map<string, CellDisplayRow>

  constructor(rows: CellDisplayRow[]) {
    this.byId = new Map(rows.map((row) => [row.cellId, row]))
  }

  get(cellId: string | null | undefined): CellDisplayRow | undefined {
    if (!cellId) return undefined
    return this.byId.get(cellId)
  }

  tag(cellId: string | null | undefined): string | null {
    return cellDisplayTag(this.get(cellId))
  }

  range(startCellId: string | null | undefined, endCellId: string | null | undefined): string | null {
    return formatSpanRange(this.get(startCellId), this.get(endCellId))
  }

  listRange(cellIds: unknown): string | null {
    if (!Array.isArray(cellIds) || cellIds.length === 0) return null
    const tags = cellIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => this.tag(id))
      .filter((tag): tag is string => Boolean(tag))
    if (tags.length > 0) {
      return tags[0] === tags[tags.length - 1]
        ? tags[0]
        : `${tags[0]}–${tags[tags.length - 1]}`
    }
    return collapseListToRange(cellIds)
  }
}

function asMetadata(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}

interface CellLabelRow {
  cell_id: string
  canonical_ref: string | null
  sequence_index: number | string | null
  anchor_cell_id: string | null
  metadata: unknown
  start_ms: number | string | null
  end_ms: number | string | null
}

function emptyPair(row: CellLabelRow): CellPair {
  return {
    cellId: row.cell_id,
    canonicalRef: row.canonical_ref,
    sequenceIndex: row.sequence_index === null ? null : Number(row.sequence_index),
    anchorCellId: row.anchor_cell_id,
    source: "",
    target: "",
    validated: false,
    aiDrafted: false,
    sourceHead: null,
    targetBasedOn: null,
    hasTargetRow: false,
  }
}

export function indexFromRows(rows: CellLabelRow[]): CellDisplayIndex {
  const ordered = orderPairs(rows.map(emptyPair))
  const byId = new Map(rows.map((row) => [row.cell_id, row]))
  return new CellDisplayIndex(ordered.map((pair, index) => {
    const row = byId.get(pair.cellId)
    return {
      cellId: pair.cellId,
      canonicalRef: pair.canonicalRef,
      sequenceIndex: pair.sequenceIndex,
      metadata: asMetadata(row?.metadata),
      startMs: row?.start_ms == null ? null : Number(row.start_ms),
      endMs: row?.end_ms == null ? null : Number(row.end_ms),
      ordinal: index + 1,
    }
  }))
}

export async function loadCellDisplayIndex(
  db: AquillaDb,
  projectId: string,
  fileId: string,
): Promise<CellDisplayIndex> {
  const { results } = await db
    .prepare(
      `SELECT cell_id, canonical_ref, sequence_index, anchor_cell_id, metadata, start_ms, end_ms
         FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'source' AND target_lang = ''`,
    )
    .bind(projectId, fileId)
    .all<CellLabelRow>()
  return indexFromRows(results)
}

export interface LabelledActivity<
  TEvent extends { spanLabel?: string | null; details?: { cellIds?: unknown } },
  TBrief extends {
    id?: string
    startCellId?: string
    endCellId?: string
    spanLabel?: string | null
    provenance?: { spanLabel?: unknown; windowCellIds?: unknown } | null
  },
  TDraft extends {
    cellId?: string
    cellLabel?: string | null
    spanLabel?: string | null
    sceneBriefId?: string | null
    provenance?: { spanLabel?: unknown } | null
  },
> {
  events: TEvent[]
  sceneBriefs: TBrief[]
  drafts: TDraft[]
}

function provenanceSpanLabel(provenance: { spanLabel?: unknown } | null | undefined): string | null {
  if (!provenance) return null
  return humanPassageLabel(typeof provenance.spanLabel === "string" ? provenance.spanLabel : null)
}

export function decorateActivityLabels<
  TEvent extends { spanLabel?: string | null; details?: { cellIds?: unknown } },
  TBrief extends {
    id?: string
    startCellId?: string
    endCellId?: string
    spanLabel?: string | null
    provenance?: { spanLabel?: unknown; windowCellIds?: unknown } | null
  },
  TDraft extends {
    cellId?: string
    cellLabel?: string | null
    spanLabel?: string | null
    sceneBriefId?: string | null
    provenance?: { spanLabel?: unknown } | null
  },
>(
  activity: LabelledActivity<TEvent, TBrief, TDraft>,
  index: CellDisplayIndex,
): LabelledActivity<
  TEvent & { spanLabel: string | null },
  TBrief & { spanLabel: string | null },
  TDraft & { cellLabel?: string | null; spanLabel?: string | null }
> {
  const sceneBriefs = activity.sceneBriefs.map((brief) => {
    const fromCells = index.range(brief.startCellId, brief.endCellId)
    const existing = humanPassageLabel(brief.spanLabel)
    const fromProvenance = provenanceSpanLabel(brief.provenance)
    const windowIds = brief.provenance && Array.isArray(brief.provenance.windowCellIds)
      ? index.listRange(brief.provenance.windowCellIds)
      : null
    return {
      ...brief,
      spanLabel: fromCells ?? existing ?? fromProvenance ?? windowIds ?? null,
    }
  })
  const briefLabel = new Map(
    sceneBriefs
      .filter((brief) => brief.id && humanPassageLabel(brief.spanLabel))
      .map((brief) => [brief.id as string, brief.spanLabel as string]),
  )
  const drafts = activity.drafts.map((draft) => {
    const cellLabel = index.tag(draft.cellId)
    const spanLabel = (draft.sceneBriefId ? briefLabel.get(draft.sceneBriefId) : null)
      ?? provenanceSpanLabel(draft.provenance)
      ?? humanPassageLabel(draft.spanLabel)
    return {
      ...draft,
      ...(cellLabel ? { cellLabel } : {}),
      ...(spanLabel ? { spanLabel } : {}),
    }
  })
  const events = activity.events.map((event) => {
    const existing = humanPassageLabel(event.spanLabel)
    const fromDetails = event.details && Array.isArray(event.details.cellIds)
      ? index.listRange(event.details.cellIds)
      : null
    return {
      ...event,
      spanLabel: existing ?? fromDetails ?? null,
    }
  })
  return { events, sceneBriefs, drafts }
}
