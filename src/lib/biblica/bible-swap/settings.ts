import { ANY_BIBLE_SWAP_LANGUAGE } from "./language-mappings"
import type { BibleSwapMode } from "./types"

/** "none" keeps the notes-only export; the other two select a swap engine. */
export type BibleSwapSelection = BibleSwapMode | "none"

export interface BibleSwapSettings {
  mode: BibleSwapSelection
  language: string
  bibleFile: File | null
}

export const DEFAULT_BIBLE_SWAP_SETTINGS: BibleSwapSettings = {
  mode: "none",
  language: ANY_BIBLE_SWAP_LANGUAGE,
  bibleFile: null,
}
