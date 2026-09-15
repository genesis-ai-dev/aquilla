import { Pencil, FolderInput, Trash2, Download, Info, UserCheck, SplitSquareVertical } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  MenuGroup,
  MenuItem,
  MenuSeparator,
} from "@/components/ui/menu-parts"

interface FileActionMenuProps {
  /** Opens the FileDetailsModal (metadata only). */
  onShowDetails?: () => void
  onRename: () => void
  onMove: () => void
  /** Opens the Export dialog for this file. Always shown — the dialog
   *  explains the block when org policy forbids export (AQU-253). */
  onExport?: () => void
  /** Optional. Present only for file types we can export back to source
   *  format with round-trip fidelity (USFM today). */
  onExportSource?: () => void
  /** AQU-656: mint a token on click, then download the imported bytes. */
  onDownloadOriginal?: () => void
  /** Opens Assign work scoped to this file. Hidden when the caller
   *  cannot open the assign UI. */
  onAssignWork?: () => void
  /** Opens the Segmentation dialog for this file. Shown to every role — the
   *  dialog itself is read-only below Project Lead and says so, which is more
   *  useful than hiding how the file is divided. */
  onSegmentation?: () => void
  /** AQU-271: Optional — only shown for project_lead+ (level >= 500). */
  onDelete?: () => void
}

/**
 * The items of a sidebar file row's menu. Rendered inside a popup by `FileRow`,
 * once per way of opening it (row right-click, ⋯ button).
 */
export function FileActionMenu({
  onShowDetails, onRename, onMove, onExport, onExportSource, onDownloadOriginal, onAssignWork,
  onSegmentation, onDelete,
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
          <Pencil /> {t("fileDetails.rename")}
        </MenuItem>
        <MenuItem onClick={onMove}>
          <FolderInput /> {t("fileDetails.moveToCorpus")}
        </MenuItem>
        {onAssignWork && (
          <MenuItem onClick={onAssignWork}>
            <UserCheck /> {t("dialog.assign.title")}
          </MenuItem>
        )}
        {onSegmentation && (
          <MenuItem onClick={onSegmentation}>
            <SplitSquareVertical /> {t("segmentation.menuItem")}
          </MenuItem>
        )}
        {onExport && (
          <MenuItem onClick={onExport}>
            <Download /> {t("nav.workspaceActions.export")}
          </MenuItem>
        )}
        {onExportSource && (
          <MenuItem onClick={onExportSource}>
            <Download /> {t("fileDetails.exportSource")}
          </MenuItem>
        )}
        {onDownloadOriginal && (
          <MenuItem onClick={onDownloadOriginal}>
            <Download /> {t("fileDetails.downloadOriginal")}
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
