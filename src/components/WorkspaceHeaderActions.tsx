import { Plus, Settings } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu"
import { useT } from "@/lib/i18n/I18nProvider"

interface WorkspaceHeaderActionsProps {
  onImport: () => void
  onSettings?: () => void
  menuItems: OverflowMenuItem[]
}

/** Header right-side actions: Import + ⋯ overflow grouped, Settings cog beside. */
export function WorkspaceHeaderActions({
  onImport,
  onSettings,
  menuItems,
}: WorkspaceHeaderActionsProps) {
  const t = useT()
  return (
    <div className="flex items-center gap-1">
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
          {t("nav.workspaceActions.import")}
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
      {onSettings ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="bg-card shadow-xs"
          onClick={onSettings}
          aria-label={t("nav.settings")}
          data-testid="workspace-settings-button"
        >
          <Settings className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  )
}
