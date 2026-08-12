import { Plus, Settings } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu"

interface WorkspaceHeaderActionsProps {
  onImport: () => void
  onSettings?: () => void
  menuItems: OverflowMenuItem[]
}

/** Header right-side actions: Import + Settings cog, then ⋯ overflow for the rest. */
export function WorkspaceHeaderActions({
  onImport,
  onSettings,
  menuItems,
}: WorkspaceHeaderActionsProps) {
  return (
    <ButtonGroup className="shadow-xs">
      <Button
        type="button"
        variant="outline"
        size="default"
        className="bg-card"
        onClick={onImport}
        data-testid="workspace-import-button"
      >
        <Plus data-icon="inline-start" />
        Import
      </Button>
      {onSettings ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="bg-card"
          onClick={onSettings}
          aria-label="Settings"
          data-testid="workspace-settings-button"
        >
          <Settings className="h-4 w-4" />
        </Button>
      ) : null}
      {menuItems.length > 0 ? (
        <OverflowMenu
          items={menuItems}
          triggerVariant="outline"
          triggerSize="icon"
          triggerClassName="bg-card"
          ariaLabel="More"
          testId="workspace-more-menu"
        />
      ) : null}
    </ButtonGroup>
  )
}
