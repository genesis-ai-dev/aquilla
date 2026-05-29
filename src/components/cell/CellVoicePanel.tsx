// The per-cell voice panel that REPLACES a cell's source column when the editor
// is in Audio mode. In Text mode the left column shows source text (needed to
// translate); in Audio mode there's no need for source text, so the column
// instead carries the controls for *voicing* this line: which Cast character
// speaks it, generate/play for this one line, and "Make a character from this
// voice" — turning this take into a reusable Cast member. The target
// (translation) column stays visible to the right; it's what we're voicing.
//
// Compact + vertical: this lives in a narrow source-width column. Per-cell
// generate runs through generateCellVoice (the same helper batch flows use)
// and play goes through the shared play-queue, so a single line behaves
// exactly like a batch action scoped to one cell.

import { useCallback } from "react"
import { CheckCircle2, Loader2, Play, Sparkles, UserPlus } from "lucide-react"
import { SpeakerChip } from "./SpeakerChip"
import { Button } from "@/components/ui/button"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord as Project, ProjectTtsSettings, Voice } from "@/lib/parsers/types"

interface CellVoicePanelProps {
  cell: CellData
  project: Project
  projectId: string
  settings: ProjectTtsSettings
  /** The Cast — every character voice available to assign to this line. */
  voices: Voice[]
  /** The character currently voicing this cell, resolved by the host. */
  resolvedVoice: Voice
  session: unknown
  username: string
  /** Reassign this line to a different Cast character. */
  onAssign: (voiceId: string) => void
  /** Called after a successful per-cell generate so the host can revalidate. */
  onAfterGenerate: () => void
  /** Host plays just this cell via the shared play-queue. */
  onPlay: () => void
  /** Open "make a character from this voice" for THIS cell's take. */
  onMakeCharacter: () => void
}

export function CellVoicePanel({
  cell,
  project,
  settings,
  voices,
  resolvedVoice,
  session,
  username,
  onAssign,
  onAfterGenerate,
  onPlay,
  onMakeCharacter,
}: CellVoicePanelProps) {
  // `settings` is part of the contract (host resolves `resolvedVoice` from it);
  // referenced here so the resolved character + assignment stay in sync.
  void settings
  const sess = session as FrontierSession | null

  const status = useTtsStatus(ttsStatusKey(cell.id))
  const isVoicing = status.kind === "loading" || status.kind === "synthesizing"

  const hasGenerated = Boolean(cell.selectedGeneratedVoiceAudioId)
  const hasTake = Boolean(cell.selectedAudioId) || hasGenerated
  const canGenerate = Boolean(cell.translated?.trim()) && cell.type !== "paratext"

  const generate = useCallback(async () => {
    if (isVoicing || !canGenerate) return
    const ok = await generateCellVoice({
      project,
      cell,
      session: sess,
      username,
      voiceId: resolvedVoice.id,
    })
    if (ok) onAfterGenerate()
  }, [isVoicing, canGenerate, project, cell, sess, username, resolvedVoice.id, onAfterGenerate])

  return (
    <div className="flex w-full flex-col gap-1.5">
      {/* Character picker — which Cast member voices this line. */}
      <SpeakerChip voice={resolvedVoice} voices={voices} onAssign={onAssign} />

      {/* Generate / Regenerate this one line. */}
      <Button
        variant="default"
        size="sm"
        className="h-7 justify-start text-xs"
        onClick={() => void generate()}
        disabled={isVoicing || !canGenerate}
        title={canGenerate ? "Generate this line in the selected character's voice" : "Translate this line first"}
      >
        {isVoicing ? (
          <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
        ) : (
          <Sparkles className="mr-1.5 h-3 w-3" />
        )}
        {hasGenerated ? "Regenerate" : "Generate"}
      </Button>

      <div className="flex gap-1.5">
        {/* Play this one line. */}
        <Button
          variant="outline"
          size="sm"
          className="h-7 flex-1 justify-center text-xs"
          onClick={onPlay}
          disabled={!hasTake}
          title={hasTake ? "Play this line" : "No audio yet"}
        >
          <Play className="mr-1 h-3 w-3" /> Play
        </Button>

        {/* Turn this line's take into a reusable Cast character. */}
        <Button
          variant="outline"
          size="sm"
          className="h-7 flex-1 justify-center text-xs"
          onClick={onMakeCharacter}
          disabled={!hasTake}
          title="Make a character from this voice — turn this take into a reusable Cast character you can assign to other lines"
        >
          <UserPlus className="mr-1 h-3 w-3" /> Character
        </Button>
      </div>

      {/* Minimal status line. */}
      <div className="text-[11px]">
        {isVoicing ? (
          <span className="inline-flex items-center gap-1 text-primary">
            <Loader2 className="h-2.5 w-2.5 animate-spin" /> Voicing…
          </span>
        ) : hasTake ? (
          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-2.5 w-2.5" /> Ready
          </span>
        ) : (
          <span className="text-muted-foreground/60">No audio yet</span>
        )}
      </div>
    </div>
  )
}
