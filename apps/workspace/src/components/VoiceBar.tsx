// Phase 2c-gamma: VoiceBar drove TTS playback + synth-and-attach into the
// per-file Y.Doc. With the Y.Doc rip the synth writeback is gone; the bar is
// disabled in this build. The exported names (`VOICE_DRAG_MIME`,
// `openVoiceModalFromAnywhere`, `handleVoiceDropOnCell`) stay so existing
// imports keep type-checking — they degrade to no-ops at runtime.

import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { EditorTableHandle } from "./EditorTable"

export const VOICE_DRAG_MIME = "application/x-frontier-voice-id"

export function openVoiceModalFromAnywhere(_focus?: "apiKey"): void {
  // Voice modal is gone in Phase 2c-gamma. No-op.
}

export async function handleVoiceDropOnCell(_cellId: string, _voiceId: string): Promise<void> {
  // synth-and-attach wrote to Y.Doc; the writeback path is disabled in
  // this build. The drop is silently ignored until the audio-attachment
  // event grammar lands.
}

interface Props {
  project: ProjectRecord
  cells: CellData[]
  username: string
  session: FrontierSession | null
  editorRef: React.RefObject<EditorTableHandle | null>
  onProjectChanged: () => void
  onCompleteSingle?: (cell: CellData) => Promise<void> | void
  onHide?: () => void
}

export function VoiceBar(_props: Props) {
  // The voice bar is hidden in this build (see CLAUDE.md "Residual Y.Doc rip").
  return null
}
