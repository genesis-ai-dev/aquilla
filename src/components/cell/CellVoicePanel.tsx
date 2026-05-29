// The per-cell voice panel that REPLACES a cell's source column when the editor
// is in Audio mode. In Text mode the left column shows source text (needed to
// translate); in Audio mode there's no need for source text, so the column
// instead carries the controls for *voicing* this line: which Cast character
// speaks it, generate/play for this one line, and "create a character from this
// take" — turning this take into a reusable Cast member. The target
// (translation) column stays visible to the right; it's what we're voicing.
//
// Compact: a character chip on top, then a single tight row of icon-sized
// buttons (Generate / Play / +) and a tiny status dot. Per-cell generate runs
// through generateCellVoice (the same helper batch flows use) and play goes
// through the shared play-queue, so a single line behaves exactly like a batch
// action scoped to one cell.

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

const ICON_BTN = "h-7 w-7"

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

  const hasTake = Boolean(cell.selectedAudioId) || Boolean(cell.selectedGeneratedVoiceAudioId)
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

  const generateTitle = !canGenerate
    ? "Translate this line first"
    : isVoicing
      ? "Voicing…"
      : "Generate this line in the selected character's voice"

  return (
    <div className="flex flex-col gap-1.5">
      {/* Character picker — which Cast member voices this line. */}
      <SpeakerChip voice={resolvedVoice} voices={voices} onAssign={onAssign} />

      {/* One tight row of icon-sized actions. */}
      <div className="flex items-center gap-1">
        {/* Generate / Regenerate this one line. */}
        <Button
          variant="default"
          size="icon"
          className={ICON_BTN}
          onClick={() => void generate()}
          disabled={isVoicing || !canGenerate}
          title={generateTitle}
          aria-label="Generate voice"
        >
          {isVoicing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
        </Button>

        {/* Play this one line. */}
        <Button
          variant="ghost"
          size="icon"
          className={ICON_BTN}
          onClick={onPlay}
          disabled={!hasTake}
          title={hasTake ? "Play this line" : "No audio yet"}
          aria-label="Play take"
        >
          <Play className="h-3.5 w-3.5" />
        </Button>

        {/* Turn this line's take into a reusable Cast character. */}
        <Button
          variant="ghost"
          size="icon"
          className={ICON_BTN}
          onClick={onMakeCharacter}
          disabled={!hasTake}
          title={hasTake ? "Create a character from this take" : "No take yet"}
          aria-label="Create character from this take"
        >
          <UserPlus className="h-3.5 w-3.5" />
        </Button>

        {/* Tiny status: dot + 11px label. */}
        <span className="ml-auto flex items-center gap-1 pr-0.5">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              isVoicing
                ? "bg-amber-400 animate-pulse"
                : hasTake
                  ? "bg-emerald-500"
                  : "bg-muted-foreground/40",
            )}
          />
          <span className="text-[11px] leading-none text-muted-foreground">
            {isVoicing ? "Voicing…" : hasTake ? "Ready" : "—"}
          </span>
        </span>
      </div>
    </div>
  )
}
