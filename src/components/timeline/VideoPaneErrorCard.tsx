// What the video column shows when the source will not load — a stated reason,
// rather than a black rectangle.
//
// Extracted from MediaVideoPane 2026-08-11, no behaviour change.
//
// Import map X-D-youtube-film-card (Nov 2): it printed the raw address under
// "This film could not be loaded" and said nothing anyone could act on — for a
// YouTube film the watch address, for an uploaded film a signed address with
// its token. It now says what kind of film failed and, for YouTube, what the
// player said, in a sentence; YouTube gets a link to try the video there.

import { Film } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

/** Which film failed: a YouTube film (with the player's error code, when it
 *  gave one), one uploaded with this file, or one at a link. */
export type FilmFailure =
  | { kind: "youtube"; code: number | null; watchUrl: string }
  | { kind: "upload" }
  | { kind: "link"; host: string }

export interface VideoPaneErrorCardProps {
  failure: FilmFailure
  onRetry(): void
  onChangeVideo?: () => void
}

/** The YouTube iframe player's error codes
 *  (developers.google.com/youtube/iframe_api_reference#onError). */
export function youTubeFailureKey(code: number | null): MessageKey {
  if (code === 100) return "editor.timeline.videoPaneErrorYouTubeMissing"
  if (code === 101 || code === 150) return "editor.timeline.videoPaneErrorYouTubeNoEmbed"
  if (code === 2) return "editor.timeline.videoPaneErrorYouTubeBadLink"
  return "editor.timeline.videoPaneErrorYouTube"
}

export function VideoPaneErrorCard({ failure, onRetry, onChangeVideo }: VideoPaneErrorCardProps) {
  const t = useT()
  const reason = failure.kind === "youtube"
    ? t(youTubeFailureKey(failure.code))
    : failure.kind === "upload"
      ? t("editor.timeline.videoPaneErrorUpload")
      : t("editor.timeline.videoPaneErrorLink", { host: failure.host })
  return (
    <div
      data-testid="tl-video-pane"
      data-video-state="error"
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div className="m-2 flex min-h-0 flex-col items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 p-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Film className="h-3.5 w-3.5 shrink-0" />
          {t("editor.timeline.videoPaneErrorTitle")}
        </div>
        <p data-testid="video-pane-error-reason" className="text-[11px] leading-snug text-muted-foreground">{reason}</p>
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
            {/* `common.retry` rather than a twin of it — the catalog already
                carries this word, and rewording English to dodge the duplicate
                scan is the mistake it made once and reverted. */}
            {t("common.retry")}
          </Button>
          {onChangeVideo && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onChangeVideo}>
              {t("editor.timeline.changeVideo")}
            </Button>
          )}
          {failure.kind === "youtube" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              nativeButton={false}
              data-testid="video-pane-open-youtube"
              render={<a href={failure.watchUrl} target="_blank" rel="noopener noreferrer" />}
            >
              {t("editor.timeline.videoPaneOpenOnYouTube")}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
