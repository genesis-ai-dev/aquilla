// The per-cell voice player that REPLACES a cell's source column when the editor
// is in Audio mode. In Text mode the left column shows source text (needed to
// translate); in Audio mode there's no source to read, so the column carries a
// compact, Spotify-style player for *voicing* this one line.
//
// Anatomy (one row, left → right):
//   ( ● )            primary button. No take yet → a "magic" sparkle that
//                    GENERATES then plays. Generating/loading → spinner. Has a
//                    take → play / pause.
//   [Character ▾]    which cast member speaks this line.
//   ━━━●────── 0:03  a seekable scrubber + running time (only once there's audio).
//   [🔊]             volume, persisted per-cell (localStorage, client-owned).
//   [⋯]              overflow: regenerate, clone a character from this take.
//
// Playback is driven by useCellAudio (its own element) rather than the global
// play-queue, so each line gets an independent scrubber + volume; the app-wide
// audio-coordinator still guarantees only one source plays at a time.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Loader2, MoreHorizontal, Pause, Play, RefreshCw, Sparkles, UserPlus, Volume2, VolumeX,
} from "lucide-react"
import { SpeakerChip } from "./SpeakerChip"
import { CropButton } from "./CropEditor"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { useCellAudio } from "@/hooks/useCellAudio"
import { getCellPref, setCellPref } from "@/lib/store/audio-cell-prefs"
import type { CellData } from "@/hooks/useCells"
import type { CodexCell } from "@/lib/codex-editor/types"
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
  /** Retained for host compatibility; per-cell playback now runs locally. */
  onPlay?: () => void
  /** Open the character creator seeded with THIS cell's take (clone source). */
  onMakeCharacter: () => void
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0:00"
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, "0")}`
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** A thin, click-and-drag seek bar — the player's scrubber. */
function Scrubber({ fraction, onSeek }: { fraction: number; onSeek: (f: number) => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const fracFromClientX = (clientX: number): number => {
    const el = ref.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return clamp01((clientX - r.left) / Math.max(1, r.width))
  }
  const handleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    onSeek(fracFromClientX(e.clientX))
  }
  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return
    onSeek(fracFromClientX(e.clientX))
  }
  const pct = `${clamp01(fraction) * 100}%`
  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamp01(fraction) * 100)}
      tabIndex={0}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      className="group/scrub relative h-1.5 cursor-pointer touch-none rounded-full bg-muted/50"
    >
      <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: pct }} />
      <div
        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0 shadow transition-opacity group-hover/scrub:opacity-100"
        style={{ left: pct }}
      />
    </div>
  )
}

function VolumeButton({ volume, onChange }: { volume: number; onChange: (v: number) => void }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            title="Volume"
            aria-label="Volume"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            {volume === 0 ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>
        }
      />
      <PopoverContent align="end" side="top" className="w-44 p-2.5">
        <div className="flex items-center gap-2">
          <VolumeX className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => onChange(Number(e.target.value))}
            className="h-1 flex-1 accent-primary"
            aria-label="Volume level"
          />
          <Volume2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </div>
        <div className="mt-1.5 text-center text-[10px] tabular-nums text-muted-foreground">
          {Math.round(volume * 100)}%
        </div>
      </PopoverContent>
    </Popover>
  )
}

function OverflowMenu({
  hasTake, canGenerate, busy, onRegenerate, onMakeCharacter,
}: {
  hasTake: boolean
  canGenerate: boolean
  busy: boolean
  onRegenerate: () => void
  onMakeCharacter: () => void
}) {
  const [open, setOpen] = useState(false)
  if (!hasTake && !canGenerate) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title="More actions"
            aria-label="More actions"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        }
      />
      <PopoverContent align="end" side="bottom" className="w-48 p-1">
        {canGenerate && (
          <button
            type="button"
            disabled={busy}
            onClick={() => { setOpen(false); onRegenerate() }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50 disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">{hasTake ? "Regenerate" : "Generate"}</span>
          </button>
        )}
        {hasTake && (
          <button
            type="button"
            onClick={() => { setOpen(false); onMakeCharacter() }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50"
          >
            <UserPlus className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">Clone a character</span>
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function CellVoicePanel({
  cell,
  project,
  projectId,
  settings,
  voices,
  resolvedVoice,
  session,
  username,
  onAssign,
  onAfterGenerate,
  onMakeCharacter,
}: CellVoicePanelProps) {
  // `settings` is part of the contract (host resolves `resolvedVoice` from it);
  // referenced here so the resolved character + assignment stay in sync.
  void settings
  const sess = session as FrontierSession | null

  const status = useTtsStatus(ttsStatusKey(cell.id))
  const isVoicing = status.kind === "loading" || status.kind === "synthesizing"

  const isParatext = cell.type === "paratext"
  const canGenerate = Boolean(cell.translated?.trim()) && !isParatext

  // Preferred playable attachment: a real recording wins over generated voice.
  const playableId = useMemo(() => {
    for (const id of [cell.selectedAudioId, cell.selectedGeneratedVoiceAudioId]) {
      if (!id) continue
      const att = cell.attachments?.[id]
      if (!att || att.isDeleted) continue
      return id
    }
    return undefined
  }, [cell.selectedAudioId, cell.selectedGeneratedVoiceAudioId, cell.attachments])
  const hasTake = Boolean(playableId)

  // Minimal CodexCell for the audio hook — same shape EditorTable uses, but with
  // the *preferred* take selected so one controller plays whichever exists.
  const cellForAudio = useMemo(() => ({
    kind: 2 as const,
    languageId: "html",
    value: cell.translated ?? "",
    metadata: {
      id: cell.id,
      type: (cell.type ?? "text") as "text",
      attachments: cell.attachments,
      selectedAudioId: playableId,
    },
  } as unknown as CodexCell), [cell.id, cell.type, cell.translated, cell.attachments, playableId])

  const audio = useCellAudio(project, cellForAudio, cell.fileId)
  const { currentTime, duration, isPlaying, seek, play, pause, setVolume, setTrim, state: audioState } = audio

  // Per-cell volume, client-owned (localStorage). Push it into the controller.
  const [volume, setVolumeState] = useState(() => getCellPref(projectId, cell.id)?.volume ?? 1)
  useEffect(() => { setVolume(volume) }, [volume, setVolume])
  const changeVolume = useCallback((v: number) => {
    const clamped = clamp01(v)
    setVolumeState(clamped)
    setCellPref(projectId, cell.id, { volume: clamped })
  }, [projectId, cell.id])

  // Per-cell non-destructive crop, client-owned (localStorage). Push the window
  // into the controller; null bounds = no constraint.
  const [trim, setTrimState] = useState<{ start: number | null; end: number | null }>(() => {
    const p = getCellPref(projectId, cell.id)
    return { start: p?.trimStart ?? null, end: p?.trimEnd ?? null }
  })
  useEffect(() => { setTrim(trim.start, trim.end) }, [trim.start, trim.end, setTrim])
  const changeTrim = useCallback((start: number | null, end: number | null) => {
    setTrimState({ start, end })
    setCellPref(projectId, cell.id, { trimStart: start ?? undefined, trimEnd: end ?? undefined })
  }, [projectId, cell.id])

  // Generate → autoplay: when the magic button generates a fresh take, start
  // playback as soon as the attachment lands (a re-render flips `hasTake`).
  const autoplayRef = useRef(false)
  useEffect(() => {
    if (autoplayRef.current && hasTake) {
      autoplayRef.current = false
      void play()
    }
  }, [hasTake, play])

  const generate = useCallback(async (autoplay: boolean) => {
    if (isVoicing || !canGenerate) return
    if (autoplay) autoplayRef.current = true
    const ok = await generateCellVoice({ project, cell, session: sess, username, voiceId: resolvedVoice.id })
    if (ok) onAfterGenerate()
    else autoplayRef.current = false
  }, [isVoicing, canGenerate, project, cell, sess, username, resolvedVoice.id, onAfterGenerate])

  const onPrimary = useCallback(() => {
    if (isVoicing) return
    if (hasTake) {
      if (isPlaying) pause()
      else void play()
    } else if (canGenerate) {
      void generate(true)
    }
  }, [isVoicing, hasTake, isPlaying, pause, play, canGenerate, generate])

  // Section breaks (paratext) aren't voiced — render nothing.
  if (isParatext) return null

  // Nothing to voice yet (untranslated) — a quiet hint, no player chrome.
  if (!hasTake && !canGenerate) {
    return (
      <div className="px-1 py-2 text-[11px] italic text-muted-foreground">Translate to voice this line</div>
    )
  }

  const loading = isVoicing || audioState === "loading"
  // Scrubber maps over the cropped window (full clip when untrimmed).
  const effStart = trim.start ?? 0
  const effEnd = trim.end ?? duration
  const effDur = Math.max(0, effEnd - effStart)
  const effCurrent = Math.max(0, Math.min(currentTime - effStart, effDur))
  const fraction = effDur > 0 ? effCurrent / effDur : 0
  const primaryTitle = isVoicing
    ? "Voicing…"
    : !hasTake
      ? "Generate & play this line"
      : isPlaying
        ? "Pause"
        : "Play this line"

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-2 py-1.5" dir="ltr">
      {/* Primary: magic-generate when empty, play/pause once there's a take. */}
      <button
        type="button"
        onClick={onPrimary}
        title={primaryTitle}
        aria-label={primaryTitle}
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors",
          hasTake
            ? "bg-foreground text-background hover:opacity-90"
            : "bg-primary text-primary-foreground hover:bg-primary/90",
        )}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : !hasTake ? (
          <Sparkles className="h-4 w-4" />
        ) : isPlaying ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4 translate-x-[1px]" />
        )}
      </button>

      {/* Character + scrubber stack. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <SpeakerChip voice={resolvedVoice} voices={voices} onAssign={onAssign} />
          <span className="ml-auto pr-0.5 text-[10px] tabular-nums text-muted-foreground">
            {isVoicing
              ? "Voicing…"
              : hasTake
                ? `${fmtTime(effCurrent)} / ${effDur > 0 ? fmtTime(effDur) : "–:––"}`
                : "Tap ✦ to voice"}
          </span>
        </div>
        {hasTake ? (
          <Scrubber fraction={fraction} onSeek={(f) => seek(effStart + f * effDur)} />
        ) : (
          <div className="h-1.5 rounded-full bg-muted/40" />
        )}
      </div>

      {/* Crop + volume — only meaningful with audio to play. */}
      {hasTake && <CropButton controller={audio} trim={trim} onChange={changeTrim} />}
      {hasTake && <VolumeButton volume={volume} onChange={changeVolume} />}

      <OverflowMenu
        hasTake={hasTake}
        canGenerate={canGenerate}
        busy={isVoicing}
        onRegenerate={() => void generate(false)}
        onMakeCharacter={onMakeCharacter}
      />
    </div>
  )
}
