import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu"

interface WorkspaceHeaderActionsProps {
  onImport: () => void
  menuItems: OverflowMenuItem[]
}

/** Header right-side actions: prominent Import + ⋯ overflow for the rest. */
export function WorkspaceHeaderActions({
  onImport,
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
