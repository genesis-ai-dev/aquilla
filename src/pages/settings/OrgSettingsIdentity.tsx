import { useState } from "react"
import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { OrgRenameDialog } from "@/components/org/OrgRenameDialog"
import { useActiveOrg } from "@/context/OrgContext"
import { ORG_SETTINGS_SECTION_DESCRIPTIONS, ORG_SETTINGS_SECTION_TITLES } from "./constants"
import { OrgSettingsDetailPage } from "./OrgSettingsDetailPage"

export function OrgSettingsIdentity() {
  const { activeOrg, activeOrgId, refresh } = useActiveOrg()
  const canRename = (activeOrg?.role.level ?? 0) >= 600
  const [renameOpen, setRenameOpen] = useState(false)

  return (
    <OrgSettingsDetailPage
      title={ORG_SETTINGS_SECTION_TITLES.identity}
      description={ORG_SETTINGS_SECTION_DESCRIPTIONS.identity}
    >
      <SettingsGroup label="Organization">
        <SettingsRow
          label="Organization name"
          description="Shown across the workspace."
          control={
            <div className="flex items-center gap-1.5">
              <span className="max-w-48 truncate text-sm font-medium text-foreground sm:max-w-xs">
                {activeOrg?.name ?? "Untitled organization"}
              </span>
              {canRename ? (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="size-8 shrink-0"
                  onClick={() => setRenameOpen(true)}
                  aria-label="Rename organization"
                >
                  <Pencil className="size-4" />
                </Button>
              ) : null}
            </div>
          }
        />
      </SettingsGroup>

      {activeOrgId != null ? (
        <OrgRenameDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          orgId={activeOrgId}
          currentName={activeOrg?.name ?? ""}
          onRenamed={refresh}
        />
      ) : null}
    </OrgSettingsDetailPage>
  )
}
