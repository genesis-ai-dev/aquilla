// The per-cell voice panel that REPLACES a cell's source column when the editor
// is in Audio mode. In Text mode the left column shows source text (needed to
// translate); in Audio mode there's no need for source text, so the column
// instead carries the controls for *voicing* this line: which Cast character
// speaks it, generate/play for this one line, and "clone from this take" once
// the line has audio. The target (translation) column stays visible to the
// right; it's what we're voicing.
//
// Aesthetic over chunky: a character chip on top, then a quiet inline action
// row — a single primary Generate/Regenerate pill plus icon-only Play and Clone
// — not full-width buttons. Actions that can't run are hidden rather than shown
// disabled. Play reflects live play-queue state for THIS cell (Starting… while
// the queue loads it, Stop while it plays) so the wait between click and sound
// is visible.

import { useCallback } from "react"
import { Loader2, Pause, Play, Sparkles, UserPlus } from "lucide-react"
import { SpeakerChip } from "./SpeakerChip"
import { cn } from "@/lib/utils"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { useQueueState } from "@/lib/audio/play-queue"
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
  /** Open the character creator seeded with THIS cell's take (clone source). */
  onMakeCharacter: () => void
}

/** A quiet square icon button — used for the secondary Play / Clone actions. */
function IconAction({
  label, onClick, children, tone = "default",
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  tone?: "default" | "accent"
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-md border border-transparent text-muted-foreground transition-colors",
        "hover:border-border hover:bg-accent/50 hover:text-foreground",
        tone === "accent" && "text-violet-600 hover:text-violet-700 dark:text-violet-300",
      )}
    >
      {children}
    </button>
  )
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

  // Live play-queue state, scoped to THIS cell, so Play can show that playback
  // is starting (the queue fetches + decodes audio before sound begins).
  const queue = useQueueState()
  const isThisCell = "cellId" in queue && queue.cellId === cell.id
  const isStarting = isThisCell && queue.kind === "loading"
  const isPlaying = isThisCell && queue.kind === "playing"

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

  // Section breaks (paratext) aren't voiced — render nothing.
  if (isParatext) return null

  return (
    <div className="flex flex-col gap-1.5">
      {/* Who voices this line. */}
      <SpeakerChip voice={resolvedVoice} voices={voices} onAssign={onAssign} />

      {/* A quiet inline action row — primary Generate pill + icon actions. */}
      <div className="flex items-center gap-1.5">
        {canGenerate ? (
          <button
            type="button"
            onClick={() => void generate()}
            disabled={isVoicing}
            title={
              isVoicing ? "Voicing…"
                : hasTake ? "Regenerate this line"
                : "Generate this line"
            }
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors disabled:opacity-60",
              hasTake
                ? "border border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {isVoicing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {isVoicing ? "Voicing…" : hasTake ? "Regenerate" : "Generate"}
          </button>
        ) : (
          <span className="text-[11px] italic text-muted-foreground">Translate to voice this line</span>
        )}

        {/* Secondary actions only appear once there's a take to act on. */}
        {hasTake && (
          <>
            <IconAction
              label={isStarting ? "Starting…" : isPlaying ? "Stop" : "Play this line"}
              onClick={onPlay}
            >
              {isStarting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground" />
              ) : isPlaying ? (
                <Pause className="h-3.5 w-3.5 text-foreground" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </IconAction>
            <IconAction label="Clone a character from this take" onClick={onMakeCharacter} tone="accent">
              <UserPlus className="h-3.5 w-3.5" />
            </IconAction>
          </>
        )}

        {/* Tiny readiness dot, pushed to the right. */}
        <span className="ml-auto flex items-center gap-1 pr-0.5" title={isVoicing ? "Voicing…" : hasTake ? "Voiced" : "Not voiced"}>
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              isVoicing ? "animate-pulse bg-amber-400" : hasTake ? "bg-emerald-500" : "bg-muted-foreground/30",
            )}
          />
        </span>
      </div>
    </div>
  )
}
