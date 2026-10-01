// The per-cell voice player that REPLACES a cell's source column when the editor
// is in Audio mode. In Text mode the left column shows source text (needed to
// translate); in Audio mode there's no source to read, so the column carries a
// compact, Spotify-style player for *voicing* this one line.
//
// Anatomy (a small card):
//   ━━●━━ ( ▶ ) 0:03   once voiced: a waveform with a centered play/pause +
//                       running time. The waveform is the seek surface — no
//                       chrome sits on top of it.
//   [M Mary ⌄] [✂ 🔊 ⧉] the cast combobox, with crop / volume / clone on the
//                       same row, right-aligned. Picking a voice INSTANTLY
//                       (re)generates THIS line with it. Recently-used voices
//                       float to the top of the list.
//
// Playback uses the row's player when the host passes one, so the word
// highlight in the cell follows this play button. Without that, the panel
// keeps its own element. The app-wide audio-coordinator still guarantees
// only one source plays at a time.

import { useCallback, useEffect, useMemo, useRef } from "react"
import { CopyPlus, Volume2, VolumeX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useVoiceRecency, touchVoice } from "@/lib/store/voice-recency"
import { TakeWaveform } from "@/components/audio/TakeWaveform"
import { takeBadgeState } from "./audio-validation-state"
import { VoiceCombobox } from "@/components/voice/VoiceCombobox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { resolveCastVoice } from "@/lib/audio/voices"
import { projectTargetLaneLanguages, showVoiceLanguageBadge } from "@/lib/audio/inworld-voices"
import { ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { useCellAudio, type UseCellAudioResult } from "@/hooks/useCellAudio"
import { setCellPref, useCellPref } from "@/lib/store/audio-cell-prefs"
import { persistTakeTrim, trimMs } from "@/lib/audio/persist-trim"
import { keptWindowSec } from "@/lib/audio/kept-window"
import { takeTrackVars } from "@/lib/timeline/take-colors"
import type { CellData } from "@/hooks/useCells"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord as Project, ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ProjectRecord } from "@/lib/parsers/types"
import { AudioValidationControl } from "./AudioValidationControl"
import { useAudioValidation } from "@/hooks/useAudioValidation"

interface CellVoicePanelProps {
  cell: CellData
  project: Project
  projectId: string
  /** Hydrated TTS settings — may be undefined before the user saves any. The
   *  panel resolves this line's active voice from it directly (see AQU-768). */
  settings?: ProjectTtsSettings
  /** The Cast — every character voice available to assign to this line. */
  voices: Voice[]
  session: unknown
  username: string
  /** Reassign this line to a different Cast character. */
  onAssign: (voiceId: string) => void
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
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0:00"
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, "0")}`
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))


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
              className="shrink-0"
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
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onClick}
        disabled={disabled}
        aria-label={title}
        className="shrink-0"
      >
        {children}
      </Button>
    </AppTooltip>
  )
}

export function CellVoicePanel({
  cell,
  project,
  projectId,
  settings,
  voices,
  session,
  username,
  onAssign,
  onAfterGenerate,
  onMakeCharacter,
  controller,
  targetLang,
}: CellVoicePanelProps) {
  const t = useT()
  const sess = session as FrontierSession | null
  const languageBadge = showVoiceLanguageBadge(projectTargetLaneLanguages(project))

  // AQU-768: resolve THIS line's active voice from the saved cast assignment
  // here in the leaf that displays it, rather than trusting a pre-resolved prop
  // computed upstream. The upstream resolve lived inside a JSX IIFE deep in the
  // (huge) EditorRow; the React Compiler could serve a stale result there, so a
  // freshly-picked voice wouldn't stick in the trigger. A direct `useMemo` over
  // the `settings` prop the panel already receives is tracked reliably, so the
  // trigger + checkmark follow the assignment the moment it changes.
  const active = useMemo(
    () => resolveCastVoice(settings, cell.id),
    [settings, cell.id],
  )

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
  // and the Recording tab read too. It used to be copied into a per-device,
  // per-LINE preference, so switching the line to another take carried the old
  // take's trim across. The shared SOURCE clip's window is its section's
  // timing (round 5), never a trim, and is not edited here — retime the
  // section on the timeline.
  const playableAtt = playableId ? cell.attachments?.[playableId] : undefined
  const kept = keptWindowSec(cell, playableId, playableAtt)
  const isSourceClip = kept.kind === "section"

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
    const ok = await generateCellVoice({
      project, cell, session: sess, username, voiceId: voiceId ?? active.id,
      ...(targetLang ? { targetLang } : {}),
    })
    if (ok) onAfterGenerate()
    else autoplayRef.current = false
  }, [isVoicing, canGenerate, project, cell, sess, username, active.id, onAfterGenerate, targetLang])

  // Clicking a voice chip IS the generate action: assign the line to that voice
  // and voice it immediately (autoplay when the take lands). Record it as
  // most-recently-used so the cast strip keeps the voices you reach for up front.
  const generateWith = useCallback((voiceId: string) => {
    if (isVoicing || !canGenerate) return
    touchVoice(projectId, voiceId)
    onAssign(voiceId)
    void generate(true, voiceId)
  }, [isVoicing, canGenerate, projectId, onAssign, generate])


  // Order the cast for the combobox list: most-recently-used voices first so the
  // ones you reach for are right at the top. The whole cast (60+ voices) lives
  // behind one searchable trigger, so a large cast never clogs the row. (Hooks
  // must run before the paratext/untranslated early-returns.)
  const recency = useVoiceRecency(projectId)
  const ordered = useMemo(() => {
    const rank = (id: string) => {
      const i = recency.indexOf(id)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    return [...voices].sort((a, b) => rank(a.id) - rank(b.id))
  }, [voices, recency])

  // Section breaks (paratext) aren't voiced — render nothing.
  // AQU-490. The source clip is excluded by the adapter (role 'source'), so a
  // media line whose only audio is the shared programme track shows no control
  // here — which is right: nobody validates the film's own soundtrack.
  const audioValidation = useAudioValidation({
    project: project as unknown as ProjectRecord,
    fileId: cell.fileId,
    cellId: cell.id,
    username,
    jwt: sess?.jwt ?? null,
    ...(targetLang ? { targetLang } : {}),
  })
  const voiceValidationTakes = audioValidation.takeFor(cell, playableId)
  const cardBadge = playableAtt ? takeBadgeState(playableAtt, username, audioValidation.validationRequirement) : null

  if (isParatext) return null

  // Nothing to voice yet (untranslated) — a quiet hint, no player chrome.
  if (!hasTake && !canGenerate) {
    return (
      <div className="px-1 py-2 text-[11px] italic text-muted-foreground">{t("editor.voice.translateFirst")}</div>
    )
  }

  // The running time is over the part that plays (the whole clip untrimmed).
  const effStart = kept.start ?? 0
  const effEnd = kept.end ?? duration
  const effDur = Math.max(0, effEnd - effStart)
  const effCurrent = Math.max(0, Math.min(currentTime - effStart, effDur))

  const takeTools = hasTake ? (
    <div data-slot="voice-take-tools" className="flex shrink-0 items-center">
      {voiceValidationTakes.length > 0 && (
        <AudioValidationControl
          cellRef={cell.context?.trim() || cell.id}
          takes={voiceValidationTakes}
          currentUsername={username}
          validationRequirement={audioValidation.validationRequirement}
          canValidate={audioValidation.canValidate}
          onValidationChange={audioValidation.onValidationChange}
          variant="inline"
        />
      )}
      <VolumeButton volume={volume} onChange={changeVolume} />
      <HeaderIconButton title={t("editor.voice.clone")} onClick={onMakeCharacter}>
        <CopyPlus className="h-3.5 w-3.5" />
      </HeaderIconButton>
    </div>
  ) : null

  return (
    <div
      className="rounded-lg border bg-card/50 p-2.5 transition-colors hover:border-primary/30"
      dir="ltr"
    >
      {/* Voiced: the real recording, drawn as its timeline chip (AQU-1217 —
          these bars used to be generated from the cell id, the same whatever
          was recorded). Play from its corner, trim by dragging its lines, the
          running time bottom-left. Volume / clone live on the cast row below. */}
      {hasTake && (
        <TakeWaveform
          controller={audio}
          audioId={playableId}
          kept={kept}
          height={48}
          // A source section wears the lighter rung, as the source row's own
          // chips do; a take the dub track's (or its own track's) colour.
          kind={isSourceClip || playableId === cell.selectedGeneratedVoiceAudioId ? "generated" : "take"}
          trackVars={takeTrackVars({
            files: project.files,
            fileId: cell.fileId,
            slot: playableAtt?.slot,
            sourceSection: isSourceClip,
          })}
          strategy={project.audioMediaStrategy ?? "lazy"}
          trimEditable={!isSourceClip}
          onCommitTrim={commitTrim}
          validation={cardBadge === "self" || cardBadge === "full" ? cardBadge : null}
          className="mb-2"
          testId="voice-card-waveform"
        >
          <span className="pointer-events-none absolute bottom-1 left-2 z-10 rounded bg-background/70 px-1 text-[10px] tabular-nums text-muted-foreground">
            {`${fmtTime(effCurrent)} / ${effDur > 0 ? fmtTime(effDur) : "–:––"}`}
          </span>
        </TakeWaveform>
      )}

      {/* Unvoiced: a quiet hint above the cast strip (hidden while voicing —
          the combobox spinner is the sole busy indicator). */}
      {!hasTake && !isVoicing && (
        <div className="mb-1.5 text-[11px] text-muted-foreground">
          {t("editor.voice.clickVoiceToGenerate")}
        </div>
      )}

      {/* The cast — a searchable combobox. Once voiced, crop / volume / clone
          sit on the same row, right-aligned, so the waveform stays fully
          visible and seekable. */}
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <VoiceCombobox
            voices={ordered}
            active={active}
            busy={isVoicing}
            showLanguageBadge={languageBadge}
            onPick={generateWith}
          />
        </div>
        {takeTools}
      </div>
    </div>
  )
}

// Round 6: VoiceCombobox moved to src/components/voice/VoiceCombobox.tsx so
// the timeline's source cards can reuse the picker (SUB-38).
