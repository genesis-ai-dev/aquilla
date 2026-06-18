import type { ExtractedFootnote } from "./extract"

export type FootnoteViewMode = "off" | "inline" | "tray"

export interface VisibleFootnoteEntry {
  cellId: string
  cellLabel: string
  cellRef: string
  rowIndex: number
  sourceFootnotes: ExtractedFootnote[]
  targetFootnotes: ExtractedFootnote[]
  activeFootnoteIndex: number | null
  isDocx: boolean
  numberOffset: number
}
