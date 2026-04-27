// "Hear it" button — synthesizes the cell's translated text via in-browser
// Kokoro and plays it back. Lives in the gutter alongside Play/Mic.
//
// First click on the page downloads ~80MB of model weights (cached
// permanently after that); subsequent clicks for the same cell are instant
// because we keep the synthesized blob URL in module-local state until the
// cell or its text changes.

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, Loader2, Pause, Volume2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { synthesizeToWavBlob, setTtsStatus, useTtsStatus } from "@/lib/audio/tts"
import { AiModelConsentDeniedError } from "@/lib/audio/ai-consent"
import { useModelStatus } from "@/lib/audio/prefetch"

interface Props {
  cellId: string
  text: string
  disabled?: boolean
}

const cache = new Map<string, string>() // key = cellId+text → blob URL

function cacheKey(cellId: string, text: string): string {
  return `${cellId}::${text}`
}

export function CellTtsButton({ cellId, text, disabled }: Props) {
  const trimmed = text.trim()
  const status = useTtsStatus(cellId)
  const modelStatus = useModelStatus("kokoro")
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [cellId])

  // If text changes, drop the cached audio so we don't replay stale synthesis.
  useEffect(() => {
    setIsPlaying(false)
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
  }, [text])

  const onClick = useCallback(async () => {
    if (!trimmed) return
    if (audioRef.current && isPlaying) {
      audioRef.current.pause()
      return
    }
    if (audioRef.current) {
      try { await audioRef.current.play() } catch (e) { console.error("[tts] play() rejected", e) }
      return
    }
    const key = cacheKey(cellId, trimmed)
    let url = cache.get(key)
    if (!url) {
      try {
        setTtsStatus(cellId, { kind: "loading", loaded: 0, total: 0, file: "" })
        const blob = await synthesizeToWavBlob(trimmed, {
          onProgress: (p) => {
            setTtsStatus(cellId, { kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
            if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
              setTtsStatus(cellId, { kind: "synthesizing" })
            }
          },
        })
        url = URL.createObjectURL(blob)
        cache.set(key, url)
      } catch (e) {
        if (e instanceof AiModelConsentDeniedError) {
          setTtsStatus(cellId, { kind: "idle" })
          return
        }
        setTtsStatus(cellId, { kind: "error", message: e instanceof Error ? e.message : String(e) })
        return
      }
    }
    const audio = new Audio(url)
    audio.onplay = () => { setIsPlaying(true); setTtsStatus(cellId, { kind: "playing" }) }
    audio.onpause = () => { setIsPlaying(false); setTtsStatus(cellId, { kind: "idle" }) }
    audio.onended = () => { setIsPlaying(false); setTtsStatus(cellId, { kind: "idle" }) }
    audioRef.current = audio
    try { await audio.play() } catch (e) { console.error("[tts] initial play() rejected", e) }
  }, [trimmed, isPlaying, cellId])

  if (!trimmed) return null

  // Treat both per-cell synth status AND the global Kokoro download status as
  // "loading" so the button can show a download % even when the user clicked
  // TTS while a background prefetch is mid-flight.
  const downloadingModel = modelStatus.kind === "downloading" && status.kind !== "idle"
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
          ? "Pause TTS"
          : "Hear translation (in-browser TTS)"

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
