import { Link } from "react-router-dom"
import { ArrowUpRight, Blocks, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu"
import { useT } from "@/lib/i18n/I18nProvider"
import { groupScopes, primaryMount, provenanceOf, sentenceCase, shortList } from "@/lib/tools/builder-model"
import type { ToolSummary } from "@/lib/tools/tools-api"
import { useScopeLabel } from "../scope-label"
import { MountIcon } from "./ExtensionFacts"

const WHERE = {
  editor: "extensions.where.editor",
  panel: "extensions.where.panel",
  inline: "extensions.where.inline",
  page: "extensions.where.page",
} as const

/** Extensions in this project: where each lives, who made it, what it may
 *  change — Open, and everything else behind "…". */
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
  const label = useScopeLabel()
  const provenance = (tool: ToolSummary): string => {
    const p = provenanceOf(tool)
    return p === "firstParty" ? t("extensions.firstParty.badge") : t(`extensions.provenance.${p}`)
  }
  return (
    <section aria-labelledby="installed-heading" className="flex flex-col gap-2.5">
      <h2 id="installed-heading" className="text-sm font-medium text-muted-foreground">{t("extensions.installed.heading")}</h2>
      {tools === null ? (
        <Spinner />
      ) : tools.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-center">
          <Blocks className="size-5 text-muted-foreground" aria-hidden />
          <p className="max-w-sm text-sm text-muted-foreground">{t("extensions.installed.empty")}</p>
        </div>
      ) : (
        <ul className="divide-y rounded-2xl border bg-card shadow-xs">
          {tools.map((tool) => {
            const changes = groupScopes(tool.manifest.scopes).changes
            return (
              <li key={tool.id} className="flex items-center gap-3 px-3.5 py-3" data-testid="installed-tool" data-tool-name={tool.name}>
                <MountIcon mounts={tool.manifest.mounts} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Link to={`/project/${projectId}/extensions/${tool.id}`} className="truncate text-sm font-medium hover:underline">
                      {tool.name}
                    </Link>
                    {tool.firstParty && (
                      <AppTooltip content={t("extensions.firstParty.badge")}>
                        <span data-testid="first-party-badge" aria-label={t("extensions.firstParty.badge")} className="inline-flex">
                          <ShieldCheck className="size-3.5 text-emerald-600" aria-hidden />
                        </span>
                      </AppTooltip>
                    )}
                    {tool.upstreamToolId && (
                      <span className="rounded bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">{t("extensions.review.badgeShort")}</span>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {t(WHERE[primaryMount(tool.manifest.mounts)])} · {provenance(tool)}
                    {changes.length > 0 && (
                      <span className="hidden sm:inline">
                        {" · "}
                        {sentenceCase(shortList(changes.map((s) => label(s))).shown.join(", "))}
                        {shortList(changes).more > 0 && ` ${t("extensions.installed.more", { count: shortList(changes).more })}`}
                      </span>
                    )}
                  </p>
                </div>
                <AppTooltip content={t("extensions.open")}>
                  <Button size="icon-sm" variant="ghost" aria-label={t("extensions.installed.open", { name: tool.name })} render={<Link to={`/project/${projectId}/extensions/${tool.id}`} />}>
                    <ArrowUpRight className="size-4" aria-hidden />
                  </Button>
                </AppTooltip>
                <OverflowMenu items={menuFor(tool)} ariaLabel={t("extensions.menu.label", { name: tool.name })} triggerSize="icon-sm" testId="tool-menu" />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
