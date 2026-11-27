// AQU-2426: what the import's last step needs to know about transcribing —
// whether this person may, what it will cost, and the Credits line. The
// workspace knows the person's role, the org's floor and credits, the session
// and the source language; the import dialog's panels only know files. So the
// workspace provides this, and a panel asks it once it has the recordings'
// lengths. Without a provider (a test, a dialog opened elsewhere) the cost is
// worked out from the person's own Preferences and nothing is blocked.

import { createContext } from "react"
import type { TranscribeBlock } from "@/lib/audio/transcribe-access"
import { estimateTranscriptionCost, type TranscriptionCost } from "@/lib/audio/transcription-cost"
import { getTranscriptionModel } from "@/lib/audio/transcription-model"
import { getTranscriptionProvider } from "@/lib/audio/transcription-preference"

export interface TranscribeChoiceInfo {
  block: TranscribeBlock | null
  cost: TranscriptionCost
  /** The Credits line, when it could be worked out. */
  credits: string | null
  languageTag?: string
}

export type PrepareTranscribeChoice = (durationsMs: readonly (number | undefined)[]) => Promise<TranscribeChoiceInfo>

export const TranscribeChoiceContext = createContext<PrepareTranscribeChoice | null>(null)

/** The choice with nothing known but this browser's Preferences. */
export function localTranscribeChoice(username: string | undefined, durationsMs: readonly (number | undefined)[], languageTag?: string): TranscribeChoiceInfo {
  return {
    block: null,
    cost: estimateTranscriptionCost({
      durationsMs,
      chosenModel: getTranscriptionModel(username),
      languageTag,
      onDevice: getTranscriptionProvider(username) === "local",
    }),
    credits: null,
    ...(languageTag ? { languageTag } : {}),
  }
}
