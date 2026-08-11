import { Pencil, FolderInput, Trash2, Download } from "lucide-react"
import {
  MenuGroup,
  MenuItem,
  MenuSeparator,
} from "@/components/ui/menu-parts"

interface FileActionMenuProps {
  onRename: () => void
  onMove: () => void
  /** AQU-271: Optional — only shown for project_lead+ (level >= 500). */
  onDelete?: () => void
  /** Optional. Present only for file types we can export back to source
   *  format with round-trip fidelity (USFM today). */
  onExportSource?: () => void
}

/**
 * The items of a sidebar file row's menu. Rendered inside a popup by `FileRow`,
 * once per way of opening it (row right-click, ⋯ button).
 */
export function FileActionMenu({
  onRename, onMove, onDelete, onExportSource,
}: FileActionMenuProps) {
  return (
    <>
      <MenuGroup>
        <MenuItem onClick={onRename}>
          <Pencil /> Rename
        </MenuItem>
        <MenuItem onClick={onMove}>
          <FolderInput /> Move to corpus…
        </MenuItem>
        {onExportSource && (
          <MenuItem onClick={onExportSource}>
            <Download /> Export source (.SFM)
          </MenuItem>
        )}
      </MenuGroup>
      {onDelete && (
        <>
          <MenuSeparator />
          <MenuGroup>
            <MenuItem variant="destructive" onClick={onDelete}>
              <Trash2 /> Delete
            </MenuItem>
          </MenuGroup>
        </>
      )}
    </>
  )
}
