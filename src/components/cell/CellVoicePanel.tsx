// The per-cell voice player that REPLACES a cell's source column when the editor
// is in Audio mode. In Text mode the left column shows source text (needed to
// translate); in Audio mode there's no source to read, so the column carries a
// compact, Spotify-style player for *voicing* this one line.
//
// Anatomy (a small card):
//   ━━●━━ ( ▶ ) 0:03   once voiced: a waveform with a centered play/pause +
//                       running time (hover reveals crop / volume / clone).
//   [N Narrator] [T Elder] [M Mary] →   the whole cast as a scrollable chip
//                       strip. Clicking a chip INSTANTLY (re)generates THIS line
//                       with that voice — no "pick then generate", no dropdown.
//                       The active voice's chip is highlighted.
//
// Playback is driven by useCellAudio (its own element) rather than the global
// play-queue, so each line gets an independent scrubber + volume; the app-wide
// audio-coordinator still guarantees only one source plays at a time.

import { useCallback, useEffect, useMemo, useRef } from "react"
import {
  Pause, Play, UserPlus, Volume2, VolumeX,
} from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import { CropButton } from "./CropEditor"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { useCellAudio } from "@/hooks/useCellAudio"
import { setCellPref, useCellPref } from "@/lib/store/audio-cell-prefs"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"
import { notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"
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

// Deterministic bar heights (%) seeded off the cell id, so a line's waveform is
// stable across renders. Purely decorative — the real clip isn't decoded; the
// strip doubles as the seek surface. Heights are taller toward the middle.
function buildBars(seed: string, n: number): number[] {
  let s = 0
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0
    const r = (s % 1000) / 1000
    const env = Math.sin((i / Math.max(1, n - 1)) * Math.PI) // 0 → 1 → 0
    out.push(Math.round(22 + (30 + r * 48) * (0.45 + 0.55 * env)))
  }
  return out
}

/** A waveform-styled seek surface: decorative bars that fill as the clip plays
 *  and seek on click/drag. Keeps slider semantics for a11y. */
function WaveScrubber({ fraction, onSeek, seed }: { fraction: number; onSeek: (f: number) => void; seed: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const bars = useMemo(() => buildBars(seed, 56), [seed])
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
  const active = clamp01(fraction)
  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(active * 100)}
      tabIndex={0}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      className="flex h-full cursor-pointer touch-none items-center gap-px"
    >
      {bars.map((h, i) => {
        const on = (i + 0.5) / bars.length <= active
        return (
          <span
            key={i}
            className={cn("flex-1 rounded-full transition-colors", on ? "bg-primary" : "bg-muted-foreground/25")}
            style={{ height: `${h}%` }}
          />
        )
      })}
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

/** A small, square secondary control in the card header (regenerate, clone). */
function HeaderIconButton({
  title, onClick, disabled, children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <AppTooltip content={title}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={title}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-40"
      >
        {children}
      </button>
    </AppTooltip>
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

  // Per-cell volume + non-destructive crop, client-owned (localStorage) and
  // reactive — a write from here OR from "voice together" (which writes slices
  // across many cells at once) updates this player live. Pushed into the
  // controller; null trim bounds = no constraint.
  const pref = useCellPref(projectId, cell.id)
  const volume = pref.volume ?? 1
  const trimStart = pref.trimStart ?? null
  const trimEnd = pref.trimEnd ?? null
  useEffect(() => { setVolume(volume) }, [volume, setVolume])
  useEffect(() => { setTrim(trimStart, trimEnd) }, [trimStart, trimEnd, setTrim])
  const changeVolume = useCallback((v: number) => {
    setCellPref(projectId, cell.id, { volume: clamp01(v) })
  }, [projectId, cell.id])
  // Persist a manual crop server-side by re-attaching the selected clip with
  // the new trim (ms). Debounced so dragging the handles doesn't spam events;
  // localStorage (above) updates live for instant feedback.
  const trimEmitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistTrimToServer = useCallback((start: number | null, end: number | null) => {
    if (!playableId) return
    const att = cell.attachments?.[playableId]
    if (!att) return
    const slot = playableId === cell.selectedAudioId ? "recording" : "generatedVoice"
    void emitCellAudioAttach({
      projectId,
      fileId: cell.fileId,
      cellId: cell.id,
      audioId: playableId,
      url: att.url,
      slot,
      ...(att.type ? { mimeType: att.type } : {}),
      ...(att.voiceId ? { voiceId: att.voiceId } : {}),
      ...(att.referenceAudioId ? { referenceAudioId: att.referenceAudioId } : {}),
      ...(att.durationMs != null ? { durationMs: att.durationMs } : {}),
      trimStartMs: start != null ? Math.round(start * 1000) : undefined,
      trimEndMs: end != null ? Math.round(end * 1000) : undefined,
      author: username,
    })
    notifyAudioAttachmentsChanged(cell.fileId)
  }, [playableId, cell.attachments, cell.selectedAudioId, cell.id, cell.fileId, projectId, username])

  const changeTrim = useCallback((start: number | null, end: number | null) => {
    setCellPref(projectId, cell.id, { trimStart: start ?? undefined, trimEnd: end ?? undefined })
    if (trimEmitTimer.current) clearTimeout(trimEmitTimer.current)
    trimEmitTimer.current = setTimeout(() => persistTrimToServer(start, end), 500)
  }, [projectId, cell.id, persistTrimToServer])

  // Generate → autoplay: when the magic button generates a fresh take, start
  // playback as soon as the attachment lands (a re-render flips `hasTake`).
  const autoplayRef = useRef(false)
  useEffect(() => {
    if (autoplayRef.current && hasTake) {
      autoplayRef.current = false
      void play()
    }
  }, [hasTake, play])

  const generate = useCallback(async (autoplay: boolean, voiceId?: string) => {
    if (isVoicing || !canGenerate) return
    if (autoplay) autoplayRef.current = true
    const ok = await generateCellVoice({ project, cell, session: sess, username, voiceId: voiceId ?? resolvedVoice.id })
    if (ok) onAfterGenerate()
    else autoplayRef.current = false
  }, [isVoicing, canGenerate, project, cell, sess, username, resolvedVoice.id, onAfterGenerate])

  // Clicking a voice chip IS the generate action: assign the line to that voice
  // and voice it immediately (autoplay when the take lands).
  const generateWith = useCallback((voiceId: string) => {
    if (isVoicing || !canGenerate) return
    onAssign(voiceId)
    void generate(true, voiceId)
  }, [isVoicing, canGenerate, onAssign, generate])

  // The play/pause button only appears once a line is voiced.
  const onPrimary = useCallback(() => {
    if (isVoicing || !hasTake) return
    if (isPlaying) pause()
    else void play()
  }, [isVoicing, hasTake, isPlaying, pause, play])

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
  const effStart = trimStart ?? 0
  const effEnd = trimEnd ?? duration
  const effDur = Math.max(0, effEnd - effStart)
  const effCurrent = Math.max(0, Math.min(currentTime - effStart, effDur))
  const fraction = effDur > 0 ? effCurrent / effDur : 0
  const primaryTitle = isPlaying ? "Pause" : "Play this line"

  return (
    <div
      className="group/voice relative rounded-xl border bg-card/50 p-2.5 transition-colors hover:border-primary/30"
      dir="ltr"
    >
      {/* Voiced: waveform with a centered play/pause + running time. Hover the
          card to reveal crop / volume / clone. */}
      {hasTake && (
        <>
          <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/voice:opacity-100">
            <CropButton controller={audio} trim={{ start: trimStart, end: trimEnd }} onChange={changeTrim} />
            <VolumeButton volume={volume} onChange={changeVolume} />
            <HeaderIconButton title="Clone a voice from this take" onClick={onMakeCharacter}>
              <UserPlus className="h-3.5 w-3.5" />
            </HeaderIconButton>
          </div>
          <div className="relative mb-2 h-12">
            <WaveScrubber fraction={fraction} onSeek={(f) => seek(effStart + f * effDur)} seed={cell.id} />
            <AppTooltip content={primaryTitle}>
              <button
                type="button"
                onClick={onPrimary}
                aria-label={primaryTitle}
                className="absolute left-1/2 top-1/2 grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-primary text-primary-foreground shadow-md ring-4 ring-background transition-transform hover:scale-105"
              >
                {loading ? <Spinner /> : isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-[1px]" />}
              </button>
            </AppTooltip>
            <span className="pointer-events-none absolute bottom-0 left-0 rounded bg-background/70 px-1 text-[10px] tabular-nums text-muted-foreground">
              {isVoicing ? "Voicing…" : `${fmtTime(effCurrent)} / ${effDur > 0 ? fmtTime(effDur) : "–:––"}`}
            </span>
          </div>
        </>
      )}

      {/* Unvoiced: a quiet hint above the cast strip. */}
      {!hasTake && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {isVoicing ? (
            <>
              <Spinner className="h-3 w-3" /> Voicing…
            </>
          ) : (
            "Click a voice to generate"
          )}
        </div>
      )}

      {/* The whole cast — clicking a chip instantly (re)voices this line with
          that voice. Scrolls horizontally when there are many. */}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5">
        {voices.map((v) => (
          <VoiceChip
            key={v.id}
            voice={v}
            active={v.id === resolvedVoice.id}
            busy={isVoicing}
            onClick={() => generateWith(v.id)}
          />
        ))}
      </div>
    </div>
  )
}

/** A cast chip: avatar + name. Clicking (re)generates the line with this voice;
 *  the active voice is highlighted and shows a spinner while voicing. */
function VoiceChip({
  voice, active, busy, onClick,
}: {
  voice: Voice
  active: boolean
  busy: boolean
  onClick: () => void
}) {
  return (
    <AppTooltip content={`Generate with ${voice.name}`}>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-pressed={active}
        className={cn(
          "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-60",
          active
            ? "border-primary bg-primary/10 font-medium text-foreground"
            : "border-border hover:bg-accent/50",
        )}
      >
        <span className="relative">
          <VoiceAvatar voice={voice} size={18} />
          {busy && active && (
            <span className="absolute inset-0 grid place-items-center rounded-full bg-background/75">
              <Spinner className="h-3 w-3" />
            </span>
          )}
        </span>
        <span className="max-w-[8rem] truncate">{voice.name}</span>
      </button>
    </AppTooltip>
  )
}
