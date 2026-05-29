// The per-cell voice panel that REPLACES a cell's source column when the editor
// is in Audio mode. In Text mode the left column shows source text (needed to
// translate); in Audio mode there's no need for source text, so the column
// instead carries the controls for *voicing* this line: which Cast character
// speaks it, generate/play for this one line, and "create a character from this
// take" — turning this take into a reusable Cast member. The target
// (translation) column stays visible to the right; it's what we're voicing.
//
// The column is as wide as the target editor, so the controls spread across it:
// a character chip + status on top, a full-width primary Generate, and a
// secondary Play / Character row. Actions that can't do anything are HIDDEN
// rather than shown disabled — Play and Character only appear once the line has
// a take, and Generate is replaced by a short hint when there's nothing to
// voice — so what's on screen is always something you can actually do.

import { useCallback } from "react"
import { Loader2, Play, Sparkles, UserPlus } from "lucide-react"
import { SpeakerChip } from "./SpeakerChip"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord as Project, ProjectTtsSettings, Voice } from "@/lib/parsers/types"

interface CellVoicePanelProps {
  cell: CellData
  project: Project
  projectId: string
  /** Hydrated TTS settings — may be undefined before the user saves any. The
   *  host resolves `resolvedVoice` from it; the panel keeps them in sync. */
  settings?: ProjectTtsSettings
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
  /** Open the character creator seeded with THIS cell's take. */
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

  const isParatext = cell.type === "paratext"
  const hasTake = Boolean(cell.selectedAudioId) || Boolean(cell.selectedGeneratedVoiceAudioId)
  const canGenerate = Boolean(cell.translated?.trim()) && !isParatext

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

  // Section breaks (paratext) aren't voiced — leave their controls column empty
  // rather than showing controls that do nothing.
  if (isParatext) return null

  return (
    <div className="flex flex-col gap-2">
      {/* Header: character chip on the left, voicing status on the right, so
          the row spans the column instead of bunching up in the corner. */}
      <div className="flex items-center justify-between gap-2">
        <SpeakerChip voice={resolvedVoice} voices={voices} onAssign={onAssign} />
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              isVoicing
                ? "animate-pulse bg-amber-400"
                : hasTake
                  ? "bg-emerald-500"
                  : "bg-muted-foreground/30",
            )}
          />
          <span className="text-[11px] leading-none text-muted-foreground">
            {isVoicing ? "Voicing…" : hasTake ? "Ready" : "Not voiced"}
          </span>
        </span>
      </div>

      {/* Primary action: Generate / Regenerate, full width. When the line has
          no translation yet there's nothing to voice, so swap the button for a
          short hint instead of a dead, disabled button. */}
      {canGenerate ? (
        <Button
          variant={hasTake ? "outline" : "default"}
          size="sm"
          className="h-8 w-full justify-center gap-1.5"
          onClick={() => void generate()}
          disabled={isVoicing}
          title={
            isVoicing
              ? "Voicing…"
              : hasTake
                ? "Regenerate this line in the selected character's voice"
                : "Generate this line in the selected character's voice"
          }
        >
          {isVoicing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {isVoicing ? "Voicing…" : hasTake ? "Regenerate" : "Generate"}
        </Button>
      ) : (
        <p className="rounded-md border border-dashed px-2 py-2 text-center text-[11px] text-muted-foreground">
          Translate this line to voice it
        </p>
      )}

      {/* Secondary actions appear only once there's a take to act on, so a Play
          button is never shown when there's nothing to play. */}
      {hasTake && (
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 flex-1 justify-center gap-1.5"
            onClick={onPlay}
            title="Play this line"
          >
            <Play className="h-3.5 w-3.5" /> Play
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 flex-1 justify-center gap-1.5"
            onClick={onMakeCharacter}
            title="Create a character from this take"
          >
            <UserPlus className="h-3.5 w-3.5" /> Character
          </Button>
        </div>
      )}
    </div>
  )
}
