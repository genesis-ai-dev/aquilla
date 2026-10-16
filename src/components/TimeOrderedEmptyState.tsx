import type { ComponentProps } from "react"
import { Music } from "lucide-react"
import { EmptyState } from "@/components/ui/page"
import { useT } from "@/lib/i18n/I18nProvider"
import type { LinkedVideoEmptyState } from "@/lib/editor/linked-video-empty-state"
import { TimelineAddMedia } from "./TimelineAddMedia"
import { TimelineLinkedVideoEmpty } from "./TimelineLinkedVideoEmpty"

type LinkedProps = ComponentProps<typeof TimelineLinkedVideoEmpty>

/**
 * What an empty time-ordered file shows instead of rows — shared by the
 * built-in editor (EditorTable) and the Smart Extensions editor surface, so
 * both say the same thing (AQU-1565/1566).
 *
 * 2026-08-07: keyed on isTimeOrdered, not audioLens — the media lens renders
 * the table in text mode under the timeline now, and an empty time-ordered
 * file must still offer "attach a clip" there. AQU-1565: a linked video IS
 * media, so the attach-media prompt would be lying; that file wants captions.
 */
export function TimeOrderedEmptyState({
  linkedVideoEmptyState,
  placement,
  canEdit,
  onAttachMediaFile,
  onAttachMediaUrl,
  onOpenMediaView,
  onAttachCaptions,
  onUseCaptionTrackAsRows,
}: {
  linkedVideoEmptyState?: LinkedVideoEmptyState | null
  placement: LinkedProps["placement"]
  canEdit: boolean
  onAttachMediaFile?: LinkedProps["onAttachFile"]
  onAttachMediaUrl?: ComponentProps<typeof TimelineAddMedia>["onAttachUrl"]
  onOpenMediaView?: LinkedProps["onOpenMediaView"]
  onAttachCaptions?: LinkedProps["onAttachCaptions"]
  onUseCaptionTrackAsRows?: LinkedProps["onUseCaptionTrackAsRows"]
}) {
  const t = useT()
  if (linkedVideoEmptyState) {
    return (
      <div className="flex-1">
        <TimelineLinkedVideoEmpty
          isYouTube={linkedVideoEmptyState.isYouTube}
          captionTracks={linkedVideoEmptyState.captionTracks}
          placement={placement}
          onAttachFile={canEdit ? onAttachMediaFile : undefined}
          onOpenMediaView={onOpenMediaView}
          onAttachCaptions={canEdit ? onAttachCaptions : undefined}
          onUseCaptionTrackAsRows={canEdit ? onUseCaptionTrackAsRows : undefined}
        />
      </div>
    )
  }
  if (canEdit && onAttachMediaFile && onAttachMediaUrl) {
    return (
      <div className="flex-1">
        <TimelineAddMedia onAttachFile={onAttachMediaFile} onAttachUrl={onAttachMediaUrl} />
      </div>
    )
  }
  return (
    <div className="flex-1">
      <EmptyState
        variant="inline"
        className="h-full py-10"
        icon={Music}
        title={t("editor.empty.noMediaSegments")}
        // AQU-1565 follow-up: this branch is reached only by someone with no
        // upload (below Project Lead, or read-only), and a file with no rows
        // has nothing to record a take on, so "import or record" would send
        // them nowhere.
        description={t("editor.empty.mediaLayerWaiting")}
      />
    </div>
  )
}
