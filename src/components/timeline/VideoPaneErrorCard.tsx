// What the video column shows when the source will not load — a stated reason
// and the address, rather than a black rectangle.
//
// Extracted from MediaVideoPane 2026-08-11, no behaviour change.

import { Film } from "lucide-react"

import { Button } from "@/components/ui/button"
import { VideoPaneHeader } from "./VideoPaneHeader"

export interface VideoPaneErrorCardProps {
  src: string
  onRetry(): void
  onChangeVideo?: () => void
}

export function VideoPaneErrorCard({ src, onRetry, onChangeVideo }: VideoPaneErrorCardProps) {
  return (
    <div
      data-testid="tl-video-pane"
      data-video-state="error"
      className="flex h-full min-h-0 flex-col overflow-hidden border-r border-border"
    >
      <VideoPaneHeader src={src} />
      <div className="m-2 flex min-h-0 flex-col items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 p-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Film className="h-3.5 w-3.5 shrink-0" />
          This video could not be loaded
        </div>
        <p className="break-all text-[11px] leading-snug text-muted-foreground">{src}</p>
        <div className="flex flex-wrap gap-2">
          {/* Re-saving the same URL cannot clear this by itself — the address
              is unchanged, so nothing about the element would differ. The
              usual reason it now works is that the source was fixed at the
              other end, so offer the retry directly. */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            data-testid="video-pane-retry"
            onClick={onRetry}
          >
            Try again
          </Button>
          {onChangeVideo && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onChangeVideo}>
              Change video
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
