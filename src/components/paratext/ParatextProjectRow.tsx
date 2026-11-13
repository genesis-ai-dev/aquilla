import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { BookOpen, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n/I18nProvider"
import { bridgeStore } from "@/lib/paratext-bridge/store"
import type { BridgeProject } from "@/lib/paratext-bridge/use-paratext-discovery"

export const paratextProjectPath = (project: Pick<BridgeProject, "path">) =>
  `/paratext/project?${new URLSearchParams({ project: project.path }).toString()}`

/** State ids of the project folders already mirrored into Aquilla (this
 *  device's links). Per folder: a second copy of a mirrored project is not. */
export function useLinkedProjects(projects: readonly BridgeProject[]): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set())
  const key = projects.map((p) => p.stateId).join("|")
  useEffect(() => {
    let cancelled = false
    void Promise.all(projects.map(async (p) => ((await bridgeStore.link(p.stateId).catch(() => null)) ? p.stateId : null)))
      .then((found) => { if (!cancelled) setIds(new Set(found.filter((g) => g !== null))) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return ids
}

/** One Paratext project on this computer, as a row that opens its page. */
export function ParatextProjectRow({ project: p, linked, testId = "paratext-project" }: { project: BridgeProject; linked: boolean; testId?: string }) {
  const t = useT()
  return (
    <li data-testid={testId}>
      <Link to={paratextProjectPath(p)} className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50">
        <BookOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{p.settings.fullName}</span>
            <Badge variant="outline">{p.settings.name}</Badge>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {t("paratextBridge.booksCount", { count: p.books.length })}
            {p.settings.language ? ` · ${p.settings.language}` : ""}
            {!p.utf8 ? ` · ${t("paratextBridge.notUtf8")}` : ""}
          </div>
        </div>
        <Badge variant={linked ? "default" : "outline"}>
          {linked ? t("paratextBridge.project.inAquilla") : t("paratextBridge.project.notInAquilla")}
        </Badge>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  )
}
