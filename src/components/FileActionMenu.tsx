import { Pencil, FolderInput, Trash2, Download } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"

interface FileActionMenuProps {
  x: number
  y: number
  onClose: () => void
  onRename: () => void
  onMove: () => void
  /** FRO-271: Optional — only shown for project_lead+ (level >= 500). */
  onDelete?: () => void
  /** Optional. Present only for file types we can export back to source
   *  format with round-trip fidelity (USFM today). */
  onExportSource?: () => void
}

export function FileActionMenu({
  x, y, onClose, onRename, onMove, onDelete, onExportSource,
}: FileActionMenuProps) {
  // Always-open menu anchored to the click coordinates; the caller unmounts
  // us via onClose (fired on Escape, outside click, or item selection).
  return (
    <DropdownMenu open onOpenChange={(open) => { if (!open) onClose() }}>
      <DropdownMenuContent
        anchor={{
          getBoundingClientRect: () =>
            new DOMRect(x, y, 0, 0),
        }}
        align="start"
        sideOffset={0}
        className="w-44"
      >
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => { onRename(); onClose() }}>
            <Pencil className="h-3.5 w-3.5" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => { onMove(); onClose() }}>
            <FolderInput className="h-3.5 w-3.5" /> Move to corpus…
          </DropdownMenuItem>
          {onExportSource && (
            <DropdownMenuItem onClick={() => { onExportSource(); onClose() }}>
              <Download className="h-3.5 w-3.5" /> Export source (.SFM)
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => { onDelete(); onClose() }}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
