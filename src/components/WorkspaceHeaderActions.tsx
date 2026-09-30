import { Plus, Settings } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { AppTooltip } from "@/components/ui/tooltip"
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu"
import { useT } from "@/lib/i18n/I18nProvider"

interface WorkspaceHeaderActionsProps {
  onImport: () => void
  onSettings?: () => void
  menuItems: OverflowMenuItem[]
  /**
   * AQU-481: why Import is unavailable to this caller, or null/undefined when
   * it is allowed. Set for roles below the `file.create` floor (PROJECT_LEAD),
   * which the server refuses anyway — the button then renders disabled with
   * this as its tooltip instead of opening a type-picker whose every importer
   * would 403. Read-only-with-tooltip, the same affordance pattern as
   * `RoleGatedStep` and VoiceLibraryPanel's "New voice", never a hidden control
   * and never a silent no-op.
   */
  importDisabledReason?: string | null
}

/** Header right-side actions: Import + ⋯ overflow grouped, Settings cog beside. */
export function WorkspaceHeaderActions({
  onImport,
  onSettings,
  menuItems,
  importDisabledReason,
}: WorkspaceHeaderActionsProps) {
  const t = useT()
  return (
    <div className="flex items-center gap-1">
      <ButtonGroup className="shadow-xs">
        <AppTooltip content={importDisabledReason ?? undefined}>
          <Button
            type="button"
            variant="outline"
            size="default"
            className="bg-card"
            disabled={!!importDisabledReason}
            onClick={onImport}
            data-testid="workspace-import-button"
          >
            <Plus data-icon="inline-start" />
            {t("nav.workspaceActions.import")}
          </Button>
        </AppTooltip>
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
