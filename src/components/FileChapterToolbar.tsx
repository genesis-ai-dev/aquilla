import type { RefObject, ReactNode } from "react"
import { ButtonGroup } from "@/components/ui/button-group"
import { CheckFileButton } from "@/components/CheckFileButton"
import { EditorModeToggle, type EditorLens } from "@/components/EditorModeToggle"
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu"
import type { CheckRunResult } from "@/lib/check/deterministic-check"

interface FileChapterToolbarProps {
  lens: EditorLens
  onLensChange: (lens: EditorLens) => void
  timeOrdered?: boolean
  checkOpen: boolean
  checkRunning: boolean
  checkResult: CheckRunResult | null
  onCheckToggle: () => void
  menuItems: OverflowMenuItem[]
  fileOptionsAnchorRef?: RefObject<HTMLButtonElement | null>
  viewSettingsMenu?: ReactNode
}

/** Chapter-row right-side controls: lens switch, file check, and overflow menu. */
export function FileChapterToolbar({
  lens,
  onLensChange,
  timeOrdered = false,
  checkOpen,
  checkRunning,
  checkResult,
  onCheckToggle,
  menuItems,
  fileOptionsAnchorRef,
  viewSettingsMenu,
}: FileChapterToolbarProps) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <EditorModeToggle
        lens={lens}
        onChange={onLensChange}
        timeOrdered={timeOrdered}
      />
      <ButtonGroup className="shadow-xs">
        <CheckFileButton
          grouped
          checkOpen={checkOpen}
          checkRunning={checkRunning}
          checkResult={checkResult}
          onToggle={onCheckToggle}
        />
        <OverflowMenu
          inButtonGroup
          items={menuItems}
          triggerRef={fileOptionsAnchorRef}
          triggerVariant="outline"
          triggerSize="icon"
          triggerClassName="bg-card"
          tooltip="File options"
          ariaLabel="File options"
          testId="file-options-menu"
        />
      </ButtonGroup>
      {viewSettingsMenu}
    </div>
  )
}
