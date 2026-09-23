// AQU-777: the row of attachment links that renders at the bottom of a cell.
//
// Deliberately links, not thumbnails. This strip sits under the target text in
// a table the translator scrolls through all day, and a grid of image previews
// there would push the next cell off-screen and make the row height depend on
// what someone attached. The preview lives in the drawer, one click away —
// which is also what makes the drawer worth having.
//
// Presentation only: it renders what it is given and calls back on click. The
// workspace owns the drawer state and the data.

import { Paperclip } from "lucide-react"
import { cn } from "@/lib/utils"
import type { CellAttachmentRecord } from "@/lib/sync/cell-attachments-read-types"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  attachments: readonly CellAttachmentRecord[]
  /** Opens the attachments drawer, scrolled to this attachment. */
  onOpen: (attachmentId: string) => void
  className?: string
}

export function CellAttachmentLinks({ attachments, onOpen, className }: Props) {
  const t = useT()
  if (attachments.length === 0) return null

  return (
    <div
      className={cn("mt-1 flex flex-wrap items-center gap-x-3 gap-y-1", className)}
      data-slot="cell-attachment-links"
    >
      {attachments.map((attachment) => (
        <button
          key={attachment.attachmentId}
          type="button"
          data-attachment-id={attachment.attachmentId}
          // The row's own click handler starts a target edit, so a click meant
          // for this link must not also put the caret in the editor.
          onClick={(e) => {
            e.stopPropagation()
            onOpen(attachment.attachmentId)
          }}
          title={attachment.name}
          aria-label={`${attachment.name} — ${t("editor.attachments.openInDrawer")}`}
          className="inline-flex max-w-[16rem] items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"
        >
          <Paperclip className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{attachment.name}</span>
        </button>
      ))}
    </div>
  )
}
