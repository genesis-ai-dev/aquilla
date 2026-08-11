import { Pencil, FolderInput, Trash2, Download, Info } from "lucide-react"
import {
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"

interface FileActionMenuProps {
  /** Opens the FileDetailsModal (metadata + permission-aware actions). */
  onShowDetails?: () => void
  onRename: () => void
  onMove: () => void
  /** AQU-271: Optional — only shown for project_lead+ (level >= 500). */
  onDelete?: () => void
  /** Optional. Present only for file types we can export back to source
   *  format with round-trip fidelity (USFM today). */
  onExportSource?: () => void
}

/**
 * Context-menu content for a sidebar file row. Must be rendered as a child of
 * `<ContextMenu>` (alongside a `<ContextMenuTrigger>`).
 */
export function FileActionMenu({
  onShowDetails, onRename, onMove, onDelete, onExportSource,
}: FileActionMenuProps) {
  return (
    <ContextMenuContent side="bottom" align="start" alignOffset={0} sideOffset={4} className="w-44">
      <ContextMenuGroup>
        {onShowDetails && (
          <ContextMenuItem onClick={onShowDetails}>
            <Info /> File details
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={onRename}>
          <Pencil /> Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={onMove}>
          <FolderInput /> Move to corpus…
        </ContextMenuItem>
        {onExportSource && (
          <ContextMenuItem onClick={onExportSource}>
            <Download /> Export source (.SFM)
          </ContextMenuItem>
        )}
      </ContextMenuGroup>
      {onDelete && (
        <>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 /> Delete
            </ContextMenuItem>
          </ContextMenuGroup>
        </>
      )}
    </ContextMenuContent>
  )
}
