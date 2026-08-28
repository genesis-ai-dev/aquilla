// "Hear it" button — plays the cell's generated voice attachment if one
// exists, else synthesizes on-demand via the cell's resolved voice.
//
// On-demand synth is cached per cell + voice + text. The cache key also
// includes the current generatedVoiceAudioId so that regenerating voice
// invalidates the speaker's cached blob (so the speaker stays in sync with
// the attached audio).

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, Pause, Volume2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { toast } from "@/components/ui/toast"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import { synthesizeForCell, setTtsStatus, ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { generateAndAttachCellVoice } from "@/lib/audio/generate-voice"
import { AiModelConsentDeniedError } from "@/lib/audio/ai-consent"
import { useModelStatus } from "@/lib/audio/prefetch"
import { fetchCellAudio, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { audioMimeForExt } from "@/lib/audio/mime"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type {
  CellTtsSettings, ProjectTtsSettings,
} from "@/lib/parsers/types"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import { resolveVoice, resolveCastVoice } from "@/lib/audio/voices"
import { normalizeVoiceForProvider, resolveTtsProvider, providerInfo } from "@/lib/audio/tts-providers"

interface Props {
  cellId: string
  /**
   * WHOSE CAST ASSIGNMENT PICKS THE VOICE — which is not always the cell the
   * clip is written to. (2026-08-27)
   *
   * Character voices are assigned on the SUBTITLE rows and stored by their cell
   * id, but on a file with an audio-cue sibling the clip must be written to the
   * heard line performing that subtitle. When `cellId` was redirected to the
   * cue and this did not exist, `castAssignments[cue]` was simply absent, the
   * lookup fell through to the project default, and every character's line was
   * generated — and durably attached — in the narrator's voice, while the
   * character gutter in the same row went on showing the right name. Absent ⇒
   * `cellId`, which is every arrangement without cues.
   */
  voiceCellId?: string
  text: string
  original?: string
  context?: string
  cellLabel?: string
  sourceLanguage?: string
  targetLanguage?: string
  projectTtsSettings?: ProjectTtsSettings
  cellTtsSettings?: CellTtsSettings
  /** If set, the speaker plays this attached audio instead of synthesizing fresh. */
  generatedVoiceAudioId?: string
  attachments?: Record<string, CodexCellAttachment>
  /**
   * AQU-646 stage 3f: the OTHER cells this line's voice also belongs on.
   *
   * One subtitle can be performed by several heard lines, and Sam's ruling
   * (2026-08-25) is that each gets the whole line so none is left silent. Only
   * `cellId` is played back — a button can only play one clip — but the rest are
   * generated alongside it rather than left for the user to notice.
   *
   * Each needs its OWN synth-and-upload: an audio id is seeded with the cell it
   * belongs to, so the same bytes cannot simply be attached twice.
   *
   * Empty or absent on every ordinary file, which is one clip as before.
   */
  alsoAttachTo?: readonly { cellId: string; fileId: string }[]
  /** Required for resolving attached audio via sync-worker R2. */
  projectId?: string
  /** Required for the sync-worker R2 audio key. */
  fileId?: string
  disabled?: boolean
  /** Play-only surfaces (e.g. the translate page) preview audio transiently
   *  and never durably attach — voice *production* lives in the Voice Studio.
   *  Existing attachments still play; cells without one synth a throwaway clip. */
  playOnly?: boolean
}

const MAX_CACHE_ENTRIES = 64
const cache = new Map<string, string>() // key = cellId+text+voice+attachId -> blob URL

function cacheKey(
  cellId: string,
  text: string,
  voiceSignature: string,
  provider: string,
  generatedAttachId: string | undefined,
): string {
  return `${cellId}::${provider}::${voiceSignature}::${generatedAttachId ?? ""}::${text}`
}

function voiceSignature(voice: ReturnType<typeof resolveVoice>): string {
  return [
    voice.id,
    voice.voiceName ?? "",
    voice.model ?? "",
    voice.prompt ?? "",
    voice.accent ?? "",
    voice.pronunciationReference ?? "",
  ].join("::")
}

function rememberUrl(key: string, url: string): void {
  const existing = cache.get(key)
  if (existing) URL.revokeObjectURL(existing)
  cache.delete(key)
  cache.set(key, url)
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) break
    const oldUrl = cache.get(oldest)
    cache.delete(oldest)
    if (oldUrl) URL.revokeObjectURL(oldUrl)
  }
}

export function CellTtsButton({
  cellId,
  voiceCellId,
  text,
  original,
  context,
  cellLabel,
  sourceLanguage,
  targetLanguage,
  projectTtsSettings,
  cellTtsSettings,
  generatedVoiceAudioId,
  attachments,
  alsoAttachTo,
  projectId,
  fileId,
  disabled,
  playOnly,
}: Props) {
  const t = useT()
  const trimmed = text.trim()
  const statusKey = ttsStatusKey(cellId)
  const status = useTtsStatus(statusKey)
  // AQU-646: honor persisted cast assignments (e.g. diarization's Speaker N →
  // cell mapping) so generate speaks in the assigned character's voice.
  // The VOICE follows the line the assignment was made on; the WRITE follows
  // `cellId`. The recorder and the bulk run have always carried these two
  // separately (`generateCellVoice`'s `voiceCellId`) — this button had one
  // prop doing both jobs.
  const baseVoice = resolveCastVoice(projectTtsSettings, voiceCellId ?? cellId, cellTtsSettings?.voiceId)
  const provider = baseVoice.provider ?? resolveTtsProvider(projectTtsSettings)
  const voice = normalizeVoiceForProvider(baseVoice, provider, { targetLanguage })
  const modelStatus = useModelStatus(provider === "mms" ? "mms" : "kokoro")
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const { session } = useFrontierSession()
  const [isPlaying, setIsPlaying] = useState(false)

  // The attached generated voice (if any) is the source of truth for playback.
  // We resolve it once per render so the cache key matches what we play.
  const generatedAttachment = generatedVoiceAudioId ? attachments?.[generatedVoiceAudioId] : undefined
  const generatedAttachmentUrl = generatedAttachment && !generatedAttachment.isDeleted
    ? generatedAttachment.url
    : undefined
  const playableAttachId = generatedAttachmentUrl ? generatedVoiceAudioId : undefined

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [cellId])

  // If text or the attached audio changes, drop the per-row audio element so
  // the next click reloads from the right source.
  useEffect(() => {
    setIsPlaying(false)
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
  }, [text, playableAttachId])

  const onClick = useCallback(async () => {
    if (!trimmed) return
    if (audioRef.current && isPlaying) {
      audioRef.current.pause()
      return
    }
    if (audioRef.current) {
      try { await audioRef.current.play() } catch (e) {
        setTtsStatus(statusKey, { kind: "idle" })
        console.error("[tts] play() rejected", e)
      }
      return
    }
    const key = cacheKey(cellId, trimmed, voiceSignature(voice), provider, playableAttachId)
    let url = cache.get(key)
    if (!url) {
      try {
        if (playableAttachId && generatedAttachmentUrl) {
          // Play the attached generated voice, fetching bytes from the audio
          // backend (or directly from the URL for non-frontier-audio:// URLs).
          setTtsStatus(statusKey, { kind: "loading", loaded: 0, total: 0, file: "" })
          const blob = await fetchAttachmentBlob({
            attachmentUrl: generatedAttachmentUrl,
            projectId,
            fileId,
            session,
          })
          url = URL.createObjectURL(blob)
          rememberUrl(key, url)
        } else {
          // No attached generated voice — synthesize on demand. With project/
          // file/session context we generate DURABLY (upload + cell.audio.attach,
          // and for clone voices re-voice the TTS through Seed-VC); otherwise we
          // fall back to a transient preview synth.
          setTtsStatus(statusKey, { kind: "loading", loaded: 0, total: 0, file: "" })
          const geminiContext = { sourceLanguage, targetLanguage, original, context, cellLabel }
          const onProgress: Parameters<typeof synthesizeForCell>[1]["onProgress"] = (p) => {
            setTtsStatus(statusKey, { kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
            if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
              setTtsStatus(statusKey, { kind: "synthesizing" })
            }
          }
          let blob: Blob
          if (!playOnly && projectId && fileId && session?.jwt) {
            const gen = await generateAndAttachCellVoice({
              projectId,
              fileId,
              cellId,
              text: trimmed,
              projectTtsSettings,
              cellVoiceId: baseVoice.id,
              geminiContext,
              session,
              username: session.username,
              onProgress,
            })
            blob = gen.blob
            // The other heard lines performing this same subtitle. Sequential,
            // not parallel: they share one synth backend and one progress slot,
            // and a second concurrent run would fight the first for both.
            //
            // AFTER the blob is in hand, and each one guarded — the clip the
            // user asked to hear must not be lost because a sibling failed.
            let alsoWritten = 0
            let alsoFailed = 0
            for (const also of alsoAttachTo ?? []) {
              try {
                await generateAndAttachCellVoice({
                  projectId,
                  fileId: also.fileId,
                  cellId: also.cellId,
                  text: trimmed,
                  projectTtsSettings,
                  cellVoiceId: baseVoice.id,
                  geminiContext,
                  session,
                  username: session.username,
                })
                alsoWritten += 1
              } catch (e) {
                // Still swallowed on purpose — the clip the user asked to hear
                // must not be lost because a sibling failed — but no longer
                // SILENT. Until 2026-08-27 this was the whole handler, and
                // because the success toast below counts only what landed, a
                // run where every sibling failed produced no toast at all:
                // indistinguishable from an ordinary one-clip success, with
                // the other heard lines left silent in the dub and nothing on
                // screen saying so.
                alsoFailed += 1
                console.error("[tts] sibling attach failed", also.cellId, e)
              }
            }
            // AQU-646 stage 3g: ONE PRESS, MORE THAN ONE CLIP — say so.
            //
            // A subtitle performed by several heard lines gets voiced onto each
            // of them (Sam, 2026-08-25, so none is left silent), but only one
            // can be played back, so without this the rest are invisible work.
            // Measured at ~8% of lines, which is rare enough to be worth a toast
            // and far too common to leave unsaid.
            //
            // COUNTS WHAT LANDED, not what was attempted: the loop above
            // swallows a failing sibling on purpose, and a toast claiming three
            // when two exist would be its own small lie. `toast.add`
            // de-duplicates by content, so pressing twice does not stack.
            if (alsoWritten > 0) {
              toast.add({
                type: "success",
                title: t("audio.tts.voicedSeveral", { count: alsoWritten + 1 }),
                description: t("audio.tts.voicedSeveralDetail"),
              })
            }
            if (alsoFailed > 0) {
              toast.add({
                type: "error",
                title: t("audio.tts.siblingFailed", { count: alsoFailed }),
                description: t("audio.tts.siblingFailedDetail"),
              })
            }
          } else if (provider === "omnivoice") {
            // OmniVoice has no client-side synth — there's nothing to preview
            // until the cell has durably-generated audio. Guide the user
            // instead of surfacing the internal server-only guard error.
            setTtsStatus(statusKey, {
              kind: "error",
              message: "Generate audio on this line first to hear OmniVoice.",
            })
            return
          } else {
            blob = await synthesizeForCell(trimmed, {
              projectTtsSettings,
              cellVoiceId: baseVoice.id,
              geminiContext,
              onProgress,
            })
          }
          url = URL.createObjectURL(blob)
          rememberUrl(key, url)
        }
      } catch (e) {
        if (e instanceof AiModelConsentDeniedError) {
          setTtsStatus(statusKey, { kind: "idle" })
          return
        }
        setTtsStatus(statusKey, { kind: "error", message: e instanceof Error ? e.message : String(e) })
        return
      }
    }
    const audio = new Audio(url)
    audio.onplay = () => { setIsPlaying(true); setTtsStatus(statusKey, { kind: "playing" }) }
    audio.onpause = () => { setIsPlaying(false); setTtsStatus(statusKey, { kind: "idle" }) }
    audio.onended = () => { setIsPlaying(false); setTtsStatus(statusKey, { kind: "idle" }) }
    audio.onerror = () => {
      setIsPlaying(false)
      setTtsStatus(statusKey, { kind: "error", message: "Audio failed to load" })
    }
    audioRef.current = audio
    try { await audio.play() } catch (e) {
      if (audioRef.current === audio) audioRef.current = null
      setIsPlaying(false)
      setTtsStatus(statusKey, { kind: "idle" })
      console.error("[tts] initial play() rejected", e)
    }
  }, [
    trimmed,
    isPlaying,
    cellId,
    statusKey,
    voice,
    provider,
    playableAttachId,
    generatedAttachmentUrl,
    projectId,
    fileId,
    session,
    projectTtsSettings,
    cellTtsSettings?.voiceId,
    sourceLanguage,
    targetLanguage,
    original,
    context,
    cellLabel,
    playOnly,
    alsoAttachTo,
    t,
  ])

  // Round 5: an untranslated cell shows the button DISABLED with the reason
  // instead of vanishing — a disappearing control read as a bug in QA.
  const noText = !trimmed

  const isLocalModel = provider === "mms" || provider === "kokoro"
  const downloadingModel = !playableAttachId && isLocalModel && modelStatus.kind === "downloading" && status.kind !== "idle"
  const isLoadingModel = status.kind === "loading" || downloadingModel
  const isSynthesizing = status.kind === "synthesizing"
  const isError = status.kind === "error"
  const dlLoaded = downloadingModel ? modelStatus.loaded : (status.kind === "loading" ? status.loaded : 0)
  const dlTotal = downloadingModel ? modelStatus.total : (status.kind === "loading" ? status.total : 0)
  const pct = isLoadingModel && dlTotal > 0
    ? Math.round((dlLoaded / dlTotal) * 100)
    : null

  // A3: when no audio exists the button will GENERATE (not play), so the label
  // must say so. "Hear translation" falsely implies existing audio is ready.
  // AQU-360: name the ENGINE that will actually run, not just the voice —
  // `provider` above is the same voice.provider ?? resolveTtsProvider(...)
  // resolution generateAndAttachCellVoice/synthesizeForCell use, so the label
  // can't drift from the real synthesis path.
  const engineName = providerInfo(provider).shortTitle
  const tooltip = noText
    ? "Translate this line first to generate voice"
    : isError
      ? `TTS failed — ${status.message}`
      : isLoadingModel
        ? pct != null ? `Downloading voice model (${pct}%)…` : "Loading voice model…"
        : isSynthesizing
          ? "Synthesizing speech…"
          : isPlaying
            ? "Pause"
            : playableAttachId
              ? `Play generated voice (${voice.name})`
              : `Generate & play (${voice.name} — ${engineName})`

  const button = (
    <Button
      type="button"
      variant="ghost"
      size={isLoadingModel ? "xs" : "icon-xs"}
      onClick={onClick}
      disabled={disabled || noText || isLoadingModel || isSynthesizing}
      aria-label={tooltip}
      className={cn(
        isError
          ? "text-destructive hover:text-destructive/80"
          : isPlaying
            ? "text-primary"
            : isLoadingModel
              ? "text-amber-600 dark:text-amber-400"
              : noText || disabled
                // SUB-35: can't-run state stays washed out…
                ? "text-muted-foreground/40"
                // …but READY must look ready — the old muted/50 idle tint made a
                // working button read as disabled.
                : "text-sky-600 hover:text-sky-500 dark:text-sky-400",
        isSynthesizing && "animate-pulse",
      )}
    >
      {isError ? <AlertCircle /> :
       isLoadingModel || isSynthesizing ? <Spinner className="size-3" /> :
       isPlaying ? <Pause /> :
       <Volume2 />}
      {isLoadingModel && pct != null && (
        <span className="tabular-nums text-[9px] font-medium leading-none">{pct}%</span>
      )}
    </Button>
  )

  return (
    <AppTooltip content={tooltip}>
      {button}
    </AppTooltip>
  )
}

async function fetchAttachmentBlob(args: {
  attachmentUrl: string
  projectId: string | undefined
  fileId: string | undefined
  session: ReturnType<typeof useFrontierSession>["session"]
}): Promise<Blob> {
  const frontier = parseFrontierAudioUrl(args.attachmentUrl)
  if (frontier && args.projectId && args.fileId && args.session?.jwt) {
    const bytes = await fetchCellAudio({
      projectId: args.projectId,
      fileId: args.fileId,
      audioId: frontier.audioId,
      ext: frontier.ext,
      getSyncToken: audioSyncTokenFetcherForSession(args.session),
    })
    // Fortify pass: type the blob by its REAL container — generations are
    // webm/opus now; Safari/Firefox reject mislabeled bytes with a bare
    // onerror (Chromium sniffs, which masked this in Chrome-only testing).
    return new Blob([bytes as BlobPart], { type: audioMimeForExt(frontier.ext) })
  }
  // Fallback for direct URLs (e.g. blob:, http:). Legacy LFS attachments
  // aren't supported anymore — their bytes are no longer reachable.
  const res = await fetch(args.attachmentUrl)
  if (!res.ok) throw new Error(`Failed to fetch attached audio (${res.status})`)
  return res.blob()
}
