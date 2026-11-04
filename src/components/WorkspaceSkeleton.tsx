import { LoadingOverlay } from "@/components/ui/loading-overlay"
import { LoadingCursor, LoadingLine, LoadingLines } from "@/components/ui/loading-cursor"
import { useT } from "@/lib/i18n/I18nProvider"

const ROWS = 7

/** The cell-table placeholder. AQU-1325: ProjectWorkspace renders the
 *  real AppShell chrome (rail, account switcher, breadcrumb) around this while
 *  the project record loads. */
export function WorkspaceMainSkeleton() {
  const t = useT()
  return (
    <LoadingOverlay label={t("workspace.skeleton.loadingProject")} data-testid="workspace-loading">
      <div data-testid="workspace-loading-template" className="flex h-full min-h-0 flex-col p-3">
        <LoadingLine className="mb-3 h-9 text-lg font-semibold" />
        <div className="flex flex-col gap-2 overflow-hidden">
          {Array.from({ length: ROWS }).map((_, index) => (
            <div
              key={index}
              className="grid grid-cols-[56px_1fr_1fr_56px] gap-3 rounded-lg bg-card px-4 py-3"
            >
              <LoadingCursor className="text-xs" />
              <LoadingLines count={2} className="min-h-16" />
              <LoadingLines count={2} className="min-h-16" />
              <span />
            </div>
          ))}
        </div>
      </div>
    </LoadingOverlay>
  )
}
