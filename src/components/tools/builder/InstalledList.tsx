import { Link } from "react-router-dom"
import { ShieldCheck } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu"
import { useT } from "@/lib/i18n/I18nProvider"
import { primaryMount, provenanceOf } from "@/lib/tools/builder-model"
import type { ToolSummary } from "@/lib/tools/tools-api"
import { MOUNT_LABEL, MountIcon } from "./ExtensionFacts"

/** Extensions in this project: one quiet row each; everything else behind "…". */
export function InstalledList({
  projectId,
  tools,
  menuFor,
}: {
  projectId: string
  tools: ToolSummary[] | null
  menuFor: (tool: ToolSummary) => OverflowMenuItem[]
}) {
  const t = useT()
  const provenance = (tool: ToolSummary): string => {
    const p = provenanceOf(tool)
    return p === "firstParty" ? t("extensions.firstParty.badge") : t(`extensions.provenance.${p}`)
  }
  return (
    <section aria-labelledby="installed-heading" className="flex flex-col gap-3">
      <h2 id="installed-heading" className="text-[13px] font-medium text-muted-foreground">
        {t("extensions.installed.heading")}
        {tools && tools.length > 0 && <span className="ms-1.5 tabular-nums text-muted-foreground/60">{tools.length}</span>}
      </h2>
      {tools === null ? (
        <Spinner />
      ) : tools.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">{t("extensions.installed.empty")}</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card dark:bg-transparent">
          {tools.map((tool) => (
            <li
              key={tool.id}
              className="group relative flex items-center gap-3 px-3 py-2.5 transition-colors duration-150 hover:bg-muted/40 dark:hover:bg-input/20"
              data-testid="installed-tool"
              data-tool-name={tool.name}
            >
              <MountIcon mounts={tool.manifest.mounts} className="size-8 rounded-lg" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <Link
                    to={`/project/${projectId}/extensions/${tool.id}`}
                    aria-label={t("extensions.installed.open", { name: tool.name })}
                    className="truncate text-sm font-medium after:absolute after:inset-0 focus-visible:outline-none"
                  >
                    {tool.name}
                  </Link>
                  {tool.firstParty && (
                    <AppTooltip content={t("extensions.firstParty.badge")}>
                      <span data-testid="first-party-badge" aria-label={t("extensions.firstParty.badge")} className="relative z-10 inline-flex">
                        <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                      </span>
                    </AppTooltip>
                  )}
                  {tool.upstreamToolId && (
                    <span className="relative z-10 rounded-full bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">{t("extensions.review.badgeShort")}</span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {t(MOUNT_LABEL[primaryMount(tool.manifest.mounts)])} · {provenance(tool)}
                </p>
              </div>
              <span className="relative z-10">
                <OverflowMenu items={menuFor(tool)} ariaLabel={t("extensions.menu.label", { name: tool.name })} triggerSize="icon-sm" testId="tool-menu" />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
