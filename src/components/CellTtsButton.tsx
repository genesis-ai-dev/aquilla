// "Hear it" button — plays the cell's generated voice attachment if one
// exists, else synthesizes on-demand via the cell's resolved voice.
//
// On-demand synth is cached per cell + voice + text. The cache key also
// includes the current generatedVoiceAudioId so that regenerating voice
// invalidates the speaker's cached blob (so the speaker stays in sync with
// the attached audio).

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, Loader2, Pause, Volume2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { synthesizeForCell, setTtsStatus, ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { AiModelConsentDeniedError } from "@/lib/audio/ai-consent"
import { useModelStatus } from "@/lib/audio/prefetch"
import { fetchCellAudio, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type {
  CellTtsSettings, ProjectTtsSettings,
} from "@/lib/parsers/types"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import { resolveVoice } from "@/lib/audio/voices"
import { normalizeVoiceForProvider, resolveTtsProvider } from "@/lib/audio/tts-providers"

interface Props {
  cellId: string
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
  /** Used when fetching attachments for non-git projects. */
  projectId?: string
  disabled?: boolean
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
  projectId,
  disabled,
}: Props) {
  const trimmed = text.trim()
  const statusKey = ttsStatusKey(cellId)
  const status = useTtsStatus(statusKey)
  const baseVoice = resolveVoice(projectTtsSettings, cellTtsSettings?.voiceId)
  const provider = resolveTtsProvider(projectTtsSettings)
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
            session,
          })
          url = URL.createObjectURL(blob)
          rememberUrl(key, url)
        } else {
          // No attached generated voice — synth on demand using the resolved voice.
          setTtsStatus(statusKey, { kind: "loading", loaded: 0, total: 0, file: "" })
          const blob = await synthesizeForCell(trimmed, {
            projectTtsSettings,
            cellVoiceId: cellTtsSettings?.voiceId,
            geminiContext: {
              sourceLanguage,
              targetLanguage,
              original,
              context,
              cellLabel,
            },
            onProgress: (p) => {
              setTtsStatus(statusKey, { kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
              if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
                setTtsStatus(statusKey, { kind: "synthesizing" })
              }
            },
          })
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
    session,
    projectTtsSettings,
    cellTtsSettings?.voiceId,
    sourceLanguage,
    targetLanguage,
    original,
    context,
    cellLabel,
  ])

  if (!trimmed) return null

  const downloadingModel = !playableAttachId && provider !== "gemini" && modelStatus.kind === "downloading" && status.kind !== "idle"
  const isLoadingModel = status.kind === "loading" || downloadingModel
  const isSynthesizing = status.kind === "synthesizing"
  const isError = status.kind === "error"
  const dlLoaded = downloadingModel ? modelStatus.loaded : (status.kind === "loading" ? status.loaded : 0)
  const dlTotal = downloadingModel ? modelStatus.total : (status.kind === "loading" ? status.total : 0)
  const pct = isLoadingModel && dlTotal > 0
    ? Math.round((dlLoaded / dlTotal) * 100)
    : null

  const tooltip = isError
    ? `TTS failed — ${status.message}`
    : isLoadingModel
      ? pct != null ? `Downloading voice model (${pct}%)…` : "Loading voice model…"
      : isSynthesizing
        ? "Synthesizing speech…"
        : isPlaying
          ? "Pause"
          : playableAttachId
            ? `Play generated voice (${voice.name})`
            : `Hear translation (${voice.name})`

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isLoadingModel || isSynthesizing}
      title={tooltip}
      aria-label={tooltip}
      className={cn(
        "flex h-5 items-center justify-center gap-1 rounded transition-[transform,color] duration-150 ease-out active:scale-[0.92] hover:bg-muted/60",
        isLoadingModel ? "w-auto px-1" : "w-5",
        isError
          ? "text-destructive hover:text-destructive/80"
          : isPlaying
            ? "text-primary"
            : isLoadingModel
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground/50 hover:text-foreground",
        isSynthesizing && "animate-pulse",
      )}
    >
      {isError ? <AlertCircle className="h-3 w-3" /> :
       isLoadingModel || isSynthesizing ? <Loader2 className="h-3 w-3 animate-spin" /> :
       isPlaying ? <Pause className="h-3 w-3" /> :
       <Volume2 className="h-3 w-3" />}
      {isLoadingModel && pct != null && (
        <span className="tabular-nums text-[9px] font-medium leading-none">{pct}%</span>
      )}
    </button>
  )
}

async function fetchAttachmentBlob(args: {
  attachmentUrl: string
  projectId: string | undefined
  session: ReturnType<typeof useFrontierSession>["session"]
}): Promise<Blob> {
  const frontier = parseFrontierAudioUrl(args.attachmentUrl)
  if (frontier && args.projectId && args.session?.jwt) {
    const bytes = await fetchCellAudio({
      session: args.session,
      projectId: args.projectId,
      audioId: frontier.audioId,
      ext: frontier.ext,
    })
    return new Blob([bytes as BlobPart], { type: "audio/wav" })
  }
  // Fallback for direct URLs (e.g. blob:, http:). Git/LFS attachments aren't
  // supported here yet — those projects already disable AI voice generation.
  const res = await fetch(args.attachmentUrl)
  if (!res.ok) throw new Error(`Failed to fetch attached audio (${res.status})`)
  return res.blob()
}
