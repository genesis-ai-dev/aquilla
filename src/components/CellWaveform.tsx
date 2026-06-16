// Per-cell waveform strip rendered under the translated text. Click anywhere
// to seek; the playhead updates while audio plays. Peaks are decoded once on
// first render and cached in OPFS, so repeat renders for the same audio are
// instant.

import { useEffect, useMemo, useRef, useState } from "react"
import { Download, RotateCw } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { UseCellAudioResult } from "@/hooks/useCellAudio"
import type { AudioMediaStrategy } from "@/lib/parsers/types"

interface Props {
  controller: UseCellAudioResult
  bins?: number
  height?: number
  className?: string
  /** Project-level setting that decides whether to auto-fetch the waveform
   *  on mount, or wait for an explicit user click. Default: "lazy". */
  strategy?: AudioMediaStrategy
}

const AUTO_LOAD_STRATEGIES: ReadonlySet<AudioMediaStrategy> = new Set(["lazy", "eager"])

export function CellWaveform({
  controller, bins = 320, height = 28, className, strategy = "lazy",
}: Props) {
  const { peaks, peaksState, currentTime, duration, isPlaying, seek, requestPeaks } = controller
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [userTriggered, setUserTriggered] = useState(false)

  const shouldAutoLoad = AUTO_LOAD_STRATEGIES.has(strategy) || userTriggered

  useEffect(() => {
    if (!shouldAutoLoad) return
    void requestPeaks(bins)
  }, [requestPeaks, bins, shouldAutoLoad])

  // Static layer: the bars themselves. Only redraws when peaks change.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const cssW = canvas.clientWidth || 200
    const cssH = height
    canvas.width = Math.max(1, Math.floor(cssW * dpr))
    canvas.height = Math.max(1, Math.floor(cssH * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const styles = getComputedStyle(canvas)
    const bar = styles.getPropertyValue("--waveform-bar").trim() || "currentColor"
    ctx.fillStyle = bar

    const data = peaks
    if (!data || data.length === 0) {
      // Loading shimmer: a flat baseline.
      ctx.fillRect(0, cssH / 2 - 0.5, cssW, 1)
      return
    }

    const binCount = data.length
    const barW = cssW / binCount
    const barGap = barW > 2 ? 1 : 0
    const drawW = Math.max(1, barW - barGap)
    const mid = cssH / 2

    for (let i = 0; i < binCount; i++) {
      const v = data[i]
      const h = Math.max(1, v * (cssH - 2))
      const x = Math.floor(i * barW)
      ctx.fillRect(x, mid - h / 2, drawW, h)
    }
  }, [peaks, height])

  const playheadPct = useMemo(() => {
    if (!duration || duration <= 0) return 0
    return Math.max(0, Math.min(1, currentTime / duration))
  }, [currentTime, duration])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const pct = Math.max(0, Math.min(1, x / rect.width))
    seek(pct * duration)
  }

  const isLoading = peaksState === "loading"
  const hasPeaks = peaksState === "ready" && peaks && peaks.length > 0
  const needsUserAction = !shouldAutoLoad && peaksState === "idle"

  const handleLoadClick = () => {
    setUserTriggered(true)
  }

  const handleRetryClick = () => {
    setUserTriggered(true)
    void requestPeaks(bins, { force: true })
  }

  const waveformTooltip =
    peaksState === "error"
      ? "Couldn't decode the waveform; click retry"
      : isLoading
        ? "Loading waveform..."
        : needsUserAction
          ? "Click to download and decode this clip's waveform"
          : "Click to seek"

  return (
    <AppTooltip content={waveformTooltip} disabled={peaksState === "error"}>
      <div
        className={cn(
          "group/wf neu-inset relative w-full select-none rounded-xl transition-shadow",
          hasPeaks ? "cursor-pointer" : "cursor-default",
          peaksState === "error" && "ring-1 ring-amber-500/30 ring-inset",
          className,
        )}
        style={{ height, ["--waveform-bar" as string]: "var(--color-muted-foreground, #888)" } as React.CSSProperties}
        onPointerDown={hasPeaks ? onPointerDown : undefined}
        role={hasPeaks ? "slider" : undefined}
        aria-label="Audio scrubber"
        aria-valuemin={0}
        aria-valuemax={duration || 0}
        aria-valuenow={currentTime}
      >
      <canvas
        ref={canvasRef}
        className={cn(
          "block h-full w-full text-muted-foreground/50",
          isPlaying && "text-foreground/70",
          isLoading && "animate-pulse text-muted-foreground/30",
          (needsUserAction || peaksState === "error") && "opacity-0",
        )}
      />
      {hasPeaks && duration > 0 && (
        <div
          className="pointer-events-none absolute top-0 h-full w-px bg-primary"
          style={{ left: `${playheadPct * 100}%` }}
          aria-hidden
        />
      )}
      {needsUserAction && (
        <button
          type="button"
          onClick={handleLoadClick}
          className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-xl text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
        >
          <Download className="h-3 w-3" />
          <span>Load waveform</span>
        </button>
      )}
      {peaksState === "error" && (
        <AppTooltip content="Couldn't load this clip's waveform; click to retry">
          <button
            type="button"
            onClick={handleRetryClick}
            aria-label="Retry waveform"
            className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-xl text-[10px] font-medium text-amber-700 dark:text-amber-300 transition-colors hover:bg-amber-500/10"
          >
            <RotateCw className="h-3 w-3" />
            <span>Retry waveform</span>
          </button>
        </AppTooltip>
      )}
      </div>
    </AppTooltip>
  )
}
