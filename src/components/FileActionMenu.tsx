import { Pencil, FolderInput, Trash2, Download, Info } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  MenuGroup,
  MenuItem,
  MenuSeparator,
} from "@/components/ui/menu-parts"

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
 * The items of a sidebar file row's menu. Rendered inside a popup by `FileRow`,
 * once per way of opening it (row right-click, ⋯ button).
 */
export function FileActionMenu({
  onShowDetails, onRename, onMove, onDelete, onExportSource,
}: FileActionMenuProps) {
  const t = useT()
  return (
    <>
      <MenuGroup>
        {onShowDetails && (
          <MenuItem onClick={onShowDetails}>
            <Info /> {t("fileDetails.menuItem")}
          </MenuItem>
        )}
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
