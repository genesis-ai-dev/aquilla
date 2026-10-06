// Voices in the editor (AQU-1687): what EditorTable hands each row.
//
// One context value per file view, built by `useBibleVoices`. It changes only
// when the pack, the cells' refs, the names or the person's view options
// change, never on a keystroke, so every row reading it stays memoized.
// Each row works out its own chip and rail segment from it: there is no
// cross-row overlay, which keeps the virtualized list honest.

import { createContext, useContext, useMemo } from "react"
import type { BkpEntity, BkpEntityId, BkpRef } from "@/lib/bible-data/pack-types"
import { railSegments, type RailSegment } from "@/lib/bible-data/speech-rails"
import {
  cellVoicesFor,
  voiceChipModel,
  type CellVoices,
  type VoiceChipModel,
  type VoiceIndex,
} from "@/lib/bible-data/voice-index"
import type { VoiceLabel } from "@/lib/bible-data/voice-labels"

export interface BibleVoicesContextValue {
  index: VoiceIndex
  /** Verses that more than one cell of the file covers: their voices are approximate. */
  shared: ReadonlySet<BkpRef>
  /** The name to show for an entity, through the label chain; null when the pack has none. */
  labelFor: (entityId: BkpEntityId) => VoiceLabel | null
  showChips: boolean
  showRails: boolean
  /** Filter the editor to the cells where `speaker` speaks. */
  showLinesBy: (speaker: BkpEntityId) => void
  /** AQU-1692: the book's participants (the pack's `people` layer), for a maintainer's picker. */
  entities: Readonly<Record<BkpEntityId, BkpEntity>>
  /** AQU-1692: what a maintainer may do from the voice details; null for everyone else. */
  maintainer: VoiceMaintainerActions | null
}

/** AQU-1692: a maintainer's actions on the voices. Stable callbacks, so rows stay memoized. */
export interface VoiceMaintainerActions {
  /** Open the correction dialog for one speech. */
  correct: (speechId: string) => void
}

export const BibleVoicesContext = createContext<BibleVoicesContextValue | null>(null)

export interface CellVoiceView {
  context: BibleVoicesContextValue
  voices: CellVoices
  /** What the voice chip shows; null when voice chips are off. */
  chip: VoiceChipModel | null
  /** One segment per open quote level; empty when speech rails are off. */
  rails: readonly RailSegment[]
}

/** One row's voices, or null when Voices shows nothing for this cell. */
export function useCellVoices(ref: string, type: string): CellVoiceView | null {
  const context = useContext(BibleVoicesContext)
  return useMemo(() => {
    if (!context) return null
    const voices = cellVoicesFor(context.index, { ref, type }, context.shared)
    if (!voices) return null
    const chip = context.showChips ? voiceChipModel(context.index, voices) : null
    const rails = context.showRails ? railSegments(context.index, voices) : []
    if (!chip && rails.length === 0) return null
    return { context, voices, chip, rails }
  }, [context, ref, type])
}
