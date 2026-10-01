// The per-cell voice card that REPLACES a cell's source column when the editor
// is in Audio mode. In Text mode the left column shows source text (needed to
// translate); in Audio mode there's no source to read, so the column carries
// this line's audio.
//
// Anatomy (Sam, 2026-09-28):
//
//   ▶ ━━━━━━━━━━━━━━━━━━━  the take, drawn as its timeline chip, 56px tall, in
//   0:00 / 0:03 [Mary]     the file's track colour; play top-left, the running
//                          time bottom-left, the trim lines dragged right here
//   [N Narrator ⌄]   🎤 🔊 ⧉  the row: the line's voice (the Media view gutter's
//                          picker, opened from a field — picking only assigns),
//                          then the take's tools: the recorder, volume, clone
//
// The mic opens the recorder, which records over, uploads, generates again and
// switches takes — it replaced a Generate again button here. And since picking
// a voice only assigns it, a generated take can be in a voice the line no
// longer has: then a pill beside the time names the take's voice.
//
// Audio validation is not here: it lives in the validation column beside the
// text check. (For three days the voice sat in a gutter left of the row, as in
// the Media view, and this card was the waveform alone — a column of circles on
// the far left unbalanced the page, and in narration nearly every one was the
// Narrator.)
//
// A LINE WITH NO AUDIO is the timeline's empty slot — a dashed outline in the
// track colour, the same 56px — holding Generate (named for the line's voice)
// and Record, with the same row under it holding only the voice, so the card
// is the same height when audio arrives. Upload stays in the recorder. Explanations live in
// tooltips, not on the card.
//
// Playback uses the row's player when the host passes one, so the word
// highlight in the cell follows this play button. Without that, the panel
// keeps its own element. The app-wide audio-coordinator still guarantees
// only one source plays at a time.

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react"
import { CircleAlert, CopyPlus, Mic, Sparkles, Volume2, VolumeX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { TakeWaveform } from "@/components/audio/TakeWaveform"
import { WAVE_OVERLAY_CLASS } from "@/components/audio/chip-classes"
import { TakeTimeReadout } from "@/components/audio/TakeTimeReadout"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { assignedCastVoiceId, findVoice, resolveCastVoice } from "@/lib/audio/voices"
import { ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { useCellAudio, type UseCellAudioResult } from "@/hooks/useCellAudio"
import { setCellPref, useCellPref } from "@/lib/store/audio-cell-prefs"
import { persistTakeTrim, trimMs } from "@/lib/audio/persist-trim"
import { keptWindowSec } from "@/lib/audio/kept-window"
import { TRACK_DASH_CLASS } from "@/lib/timeline/track-colors"
import { takeTrackColor, takeTrackVars } from "@/lib/timeline/take-colors"
import { cn } from "@/lib/utils"
import type { CellData } from "@/hooks/useCells"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord as Project, ProjectTtsSettings } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"

interface CellVoicePanelProps {
  cell: CellData
  project: Project
  projectId: string
  /** Hydrated TTS settings — may be undefined before the user saves any. The
   *  panel resolves this line's active voice from it directly (see AQU-768). */
  settings?: ProjectTtsSettings
  session: unknown
  username: string
  /** May this person change the line's audio (generate, record, trim, clone)?
   *  False draws the card read-only. */
  canEdit?: boolean
  /** Open the recorder on this line. Absent hides Record and the mic. */
  onRecord?: () => void
  /** Why recording can't work in this browser, when it can't. */
  recordUnavailable?: string | null
  /** Called after a successful per-cell generate so the host can revalidate. */
  onAfterGenerate: () => void
  /** Retained for host compatibility; per-cell playback now runs locally. */
  onPlay?: () => void
  /**
   * The row's player for this line's recording (or generated voice). Play,
   * pause, and seek go through it so the cell highlight tracks this button.
   */
  controller?: UseCellAudioResult
  /** Open the character creator seeded with THIS cell's take (clone source). */
  onMakeCharacter: () => void
  /** AQU-1462: lane the member is working in. Omitted for the default lane. */
  targetLang?: string
  /** The line's voice picker, for the row under the waveform. The host owns
   *  it — it is the Media view gutter's picker, in its field form. */
  voicePicker?: ReactNode
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** Volume, with its slider in a popover. */
function VolumeButton({ volume, onChange }: { volume: number; onChange: (v: number) => void }) {
  const t = useT()
  return (
    <Popover>
      <AppTooltip content={t("common.volume")}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("common.volume")}
              data-testid="voice-card-volume"
              className="shrink-0 text-muted-foreground"
            >
              {volume === 0 ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </Button>
          }
        />
      </AppTooltip>
      <PopoverContent align="end" side="bottom" className="w-44 p-2.5">
        <div className="flex items-center gap-2">
          <VolumeX className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Slider
            min={0}
            max={1}
            step={0.01}
            value={[volume]}
            onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
            aria-label={t("editor.voice.volumeLevel")}
            className="flex-1"
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

export function CellVoicePanel({
  cell,
  project,
  projectId,
  settings,
  session,
  username,
  canEdit = true,
  onRecord,
  recordUnavailable = null,
  onAfterGenerate,
  onMakeCharacter,
  controller,
  targetLang,
  voicePicker,
}: CellVoicePanelProps) {
  const t = useT()
  const sess = session as FrontierSession | null

  // AQU-768: resolve THIS line's active voice from the saved cast assignment
  // here in the leaf that displays it, rather than trusting a pre-resolved prop
  // computed upstream. Same three-part rule the picker uses, so the card's
  // Generate names exactly the voice the picker shows.
  const active = useMemo(
    () => resolveCastVoice(settings, cell.id, cell.ttsSettings?.voiceId),
    [settings, cell.id, cell.ttsSettings?.voiceId],
  )
  // Nobody chose a character: Generate falls back to the default voice and
  // says so in its tooltip.
  const explicitVoice = useMemo(
    () => Boolean(findVoice(settings, assignedCastVoiceId(settings, cell.id) ?? cell.ttsSettings?.voiceId)),
    [settings, cell.id, cell.ttsSettings?.voiceId],
  )

  const status = useTtsStatus(ttsStatusKey(cell.id))
  const isVoicing = status.kind === "loading" || status.kind === "synthesizing"
  const failure = status.kind === "error" ? status.message : null

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

  const ownedAudio = useCellAudio(project, cellForAudio, cell.fileId)
  const audio = controller ?? ownedAudio
  const { currentTime, duration, play, setVolume } = audio

  // Volume is a per-device preference (localStorage), pushed into the player.
  const pref = useCellPref(projectId, cell.id)
  const volume = pref.volume ?? 1
  useEffect(() => { setVolume(volume) }, [volume, setVolume])
  const changeVolume = useCallback((v: number) => {
    setCellPref(projectId, cell.id, { volume: clamp01(v) })
  }, [projectId, cell.id])

  // The TRIM is not a preference (AQU-1217, 2026-09-25). It lives on the take
  // itself — the attachment's trimStartMs/trimEndMs, which the timeline chip
  // and the Recording tab read too. The shared SOURCE clip's window is its
  // section's timing (round 5), never a trim, and is not edited here — retime
  // the section on the timeline.
  const playableAtt = playableId ? cell.attachments?.[playableId] : undefined
  const kept = keptWindowSec(cell, playableId, playableAtt)
  const isSourceClip = kept.kind === "section"
  const isGenerated = Boolean(playableId && playableId === cell.selectedGeneratedVoiceAudioId && !isSourceClip)

  // Trimmed right on the card (Sam, 2026-09-25; the Crop popover is retired).
  // One event per finished drag or nudge.
  const commitTrim = useCallback((start: number | null, end: number | null) => {
    if (!playableId || isSourceClip) return
    const att = cell.attachments?.[playableId]
    if (!att) return
    void persistTakeTrim({
      projectId,
      fileId: cell.fileId,
      cellId: cell.id,
      audioId: playableId,
      att,
      selectedAudioId: cell.selectedAudioId,
      trimStartMs: trimMs(start),
      trimEndMs: trimMs(end),
      ...(targetLang ? { targetLang } : {}),
      author: username,
    })
  }, [playableId, isSourceClip, cell.attachments, cell.fileId, cell.id, cell.selectedAudioId, projectId, username, targetLang])

  // Generate → autoplay: when a fresh take lands, start playback (a re-render
  // flips `hasTake`, or swaps the playable id on a regenerate).
  const autoplayRef = useRef(false)
  useEffect(() => {
    if (autoplayRef.current && hasTake) {
      autoplayRef.current = false
      void play()
    }
  }, [hasTake, playableId, play])

  // Always in the line's own voice — the picker sets it; picking never
  // generates.
  const generate = useCallback(async () => {
    if (isVoicing || !canGenerate || !canEdit) return
    autoplayRef.current = true
    const ok = await generateCellVoice({
      project, cell, session: sess, username, voiceId: active.id,
      ...(targetLang ? { targetLang } : {}),
    })
    if (ok) onAfterGenerate()
    else autoplayRef.current = false
  }, [isVoicing, canGenerate, canEdit, project, cell, sess, username, active.id, onAfterGenerate, targetLang])

  // Section breaks (paratext) aren't voiced — render nothing.
  if (isParatext) return null

  const trackInput = {
    files: project.files,
    fileId: cell.fileId,
    slot: playableAtt?.slot,
    sourceSection: isSourceClip,
  }
  const trackVars = takeTrackVars(trackInput)

  // The row under the waveform (or the empty slot): the voice on the left,
  // the take's own tools on the right. Present in both states, so an empty
  // card and a full one are the same height.
  const row = (tools: ReactNode) => (
    <div data-slot="voice-card-row" className="mt-2 flex h-7 min-w-0 items-center gap-1">
      {voicePicker && <div className="flex min-w-0 shrink items-center">{voicePicker}</div>}
      {tools && <div className="ms-auto flex shrink-0 items-center">{tools}</div>}
    </div>
  )

  if (hasTake) {
    // The take's voice, when it isn't the line's (Sam, 2026-09-28). Picking a
    // voice only assigns it, so a generated take can outlive its voice; the
    // pill names the voice the take was made in until a take in the line's
    // voice is selected. Takes from before takes carried their voice have none
    // to compare, and show nothing.
    const takeVoiceId = isGenerated ? playableAtt?.voiceId : undefined
    const voiceDiffers = Boolean(takeVoiceId && takeVoiceId !== active.id)
    const takeVoiceName = voiceDiffers ? findVoice(settings, takeVoiceId)?.name : undefined
    const takeVoiceTip = takeVoiceName
      ? t("editor.voice.takeVoiceDiffers", { takeVoice: takeVoiceName, lineVoice: active.name })
      : t("editor.voice.takeVoiceRemoved", { lineVoice: active.name })
    // Amber, except on a file coloured amber, where it would sink into the
    // waveform: there it is blue.
    const pillOnAmber = takeTrackColor(trackInput) === "amber"
    return (
      <div className="min-w-0" dir="ltr" data-voice-card="">
        <TakeWaveform
          controller={audio}
          audioId={playableId}
          kept={kept}
          height={56}
          // A source section wears the lighter rung, as the source row's own
          // chips do; a take the dub track's (or its own track's) colour.
          kind={isSourceClip || isGenerated ? "generated" : "take"}
          trackVars={trackVars}
          strategy={project.audioMediaStrategy ?? "lazy"}
          trimEditable={!isSourceClip && canEdit}
          onCommitTrim={commitTrim}
          className="voice-card-wave"
          testId="voice-card-waveform"
        >
          <span className="pointer-events-none absolute bottom-1 left-2 z-10 flex items-center gap-1">
            <TakeTimeReadout currentTime={currentTime} duration={duration} kept={kept} testId="voice-card-time" />
            {voiceDiffers && (
              <AppTooltip content={takeVoiceTip}>
                <span
                  data-wave-overlay=""
                  data-testid="voice-card-take-voice"
                  data-tone={pillOnAmber ? "blue" : "amber"}
                  className={cn(
                    "pointer-events-auto flex h-4 items-center rounded px-1.5 text-[10px] font-semibold ring-1 ring-inset",
                    // A see-through fill, so the take shows through it (Sam).
                    pillOnAmber
                      ? "bg-blue-500/30 text-blue-800 ring-blue-600/60 dark:bg-blue-400/30 dark:text-blue-100 dark:ring-blue-400/60"
                      : "bg-amber-400/45 text-amber-800 ring-amber-600/60 dark:bg-amber-400/30 dark:text-amber-100 dark:ring-amber-400/60",
                    WAVE_OVERLAY_CLASS,
                  )}
                >
                  <span aria-hidden>{takeVoiceName ?? t("editor.voice.removedVoice")}</span>
                  <span className="sr-only">{takeVoiceTip}</span>
                </span>
              </AppTooltip>
            )}
          </span>
        </TakeWaveform>
        {row(
          <>
            {canEdit && onRecord && (
              <AppTooltip content={recordUnavailable ?? t("editor.audio.record")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("editor.audio.record")}
                  data-testid="voice-card-record"
                  aria-disabled={recordUnavailable ? true : undefined}
                  onClick={() => { if (!recordUnavailable) onRecord() }}
                  className={cn("shrink-0 text-muted-foreground", recordUnavailable && "cursor-not-allowed opacity-50")}
                >
                  <Mic className="h-3.5 w-3.5" />
                </Button>
              </AppTooltip>
            )}
            <VolumeButton volume={volume} onChange={changeVolume} />
            {canEdit && (
              <AppTooltip content={t("editor.voice.clone")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("editor.voice.clone")}
                  data-testid="voice-card-clone"
                  onClick={onMakeCharacter}
                  className="shrink-0 text-muted-foreground"
                >
                  <CopyPlus className="h-3.5 w-3.5" />
                </Button>
              </AppTooltip>
            )}
          </>,
        )}
      </div>
    )
  }

  // ── No audio yet: the timeline's empty slot, same height as a card ──────
  const slotClass = cn(
    "relative flex h-14 items-center justify-center gap-2 rounded-[6px] border",
    TRACK_DASH_CLASS,
  )
  if (!canEdit) {
    return (
      <div className="min-w-0" dir="ltr" data-voice-card="">
        <div data-testid="voice-card-empty" data-state="readonly" className={slotClass} style={trackVars}>
          <span className="text-xs text-muted-foreground">{t("editor.voice.noAudioYet")}</span>
        </div>
        {row(null)}
      </div>
    )
  }
  const recordButton = onRecord ? (
    <AppTooltip content={recordUnavailable ?? t("editor.audio.record")}>
      <Button
        type="button"
        variant="outline"
        size="xs"
        data-testid="voice-card-record"
        aria-disabled={recordUnavailable ? true : undefined}
        onClick={() => { if (!recordUnavailable) onRecord() }}
        className={cn(recordUnavailable && "cursor-not-allowed opacity-50")}
      >
        <Mic />
        {t("editor.voice.record")}
      </Button>
    </AppTooltip>
  ) : null

  const state = isVoicing ? "generating" : failure ? "failed" : !canGenerate ? "notext" : "ready"
  return (
    <div className="min-w-0" dir="ltr" data-voice-card="">
      <div data-testid="voice-card-empty" data-state={state} className={slotClass} style={trackVars}>
        {state === "generating" && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <Spinner className="size-3" />
            {t("editor.voice.generatingAs", { voice: active.name })}
          </span>
        )}
        {state === "failed" && (
          <AppTooltip content={t("editor.voice.failedTooltip", { reason: failure ?? "" })}>
            <Button type="button" variant="outline" size="xs" data-testid="voice-card-retry" onClick={() => void generate()}>
              <CircleAlert className="text-destructive" />
              {t("editor.voice.tryAgain")}
            </Button>
          </AppTooltip>
        )}
        {state === "notext" && (
          // A disabled button fires no pointer events, so its tooltip hangs on
          // a wrapper that does.
          <AppTooltip content={t("editor.voice.nothingToReadTooltip")}>
            <span tabIndex={0} className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Button type="button" variant="outline" size="xs" disabled data-testid="voice-card-generate">
                <Sparkles />
                {t("editor.voice.generateWith", { voice: active.name })}
              </Button>
            </span>
          </AppTooltip>
        )}
        {state === "ready" && (
          <AppTooltip content={t("editor.voice.generateDefaultTooltip")} disabled={explicitVoice}>
            <Button type="button" variant="outline" size="xs" data-testid="voice-card-generate" onClick={() => void generate()}>
              <Sparkles />
              {t("editor.voice.generateWith", { voice: active.name })}
            </Button>
          </AppTooltip>
        )}
        {recordButton}
      </div>
      {row(null)}
    </div>
  )
}
