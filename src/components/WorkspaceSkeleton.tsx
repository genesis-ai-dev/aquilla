import { LoadingOverlay } from "@/components/ui/loading-overlay"
import { LoadingCursor } from "@/components/ui/loading-cursor"
import { useT } from "@/lib/i18n/I18nProvider"

/** The cell-table placeholder. AQU-1325: ProjectWorkspace renders the
 *  real AppShell chrome (rail, account switcher, breadcrumb) around this while
 *  the project record loads. */
export function WorkspaceMainSkeleton() {
  const t = useT()
  return (
    <LoadingOverlay label={t("workspace.skeleton.loadingProject")} data-testid="workspace-loading">
      <div data-testid="workspace-loading-template" className="flex h-full min-h-0 flex-col p-3">
        <LoadingCursor className="text-xl" />
      </div>
    </LoadingOverlay>
  )
}
