import { useState } from "react"
import { Link } from "react-router-dom"
import { ArrowRightLeft, Folder } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { useT } from "@/lib/i18n/I18nProvider"
import { copyApp } from "@/lib/paratext-bridge/copies"
import type { MirrorLink } from "@/lib/paratext-bridge/store"
import { switchLiveCopy } from "@/lib/paratext-bridge/switch-copy"
import type { BridgeProject } from "@/lib/paratext-bridge/use-paratext-discovery"
import { paratextProjectPath } from "./ParatextProjectRow"

/**
 * Every folder on this computer holding the same Paratext project (copies.ts),
 * which one Aquilla writes to, and on another copy a way to write there
 * instead. `liveLink` is the mirror link of whichever copy is live, if any.
 */
export function ParatextCopiesCard({ project, others, liveLink, onMoved }: {
  project: BridgeProject
  others: readonly BridgeProject[]
  liveLink: MirrorLink | null
  onMoved: (link: MirrorLink) => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const appName = (path: string) => t(`paratextBridge.copies.app.${copyApp(path)}`)
  const copies = [project, ...others].sort((a, b) => a.path.localeCompare(b.path))
  const thisIsLive = liveLink?.projectPath === project.path

  const makeLive = async () => {
    if (!liveLink) return
    setBusy(true)
    try {
      const r = await switchLiveCopy(liveLink, project)
      if (r.kind === "moved") {
        toast.add({ type: "success", title: t("paratextBridge.copies.moved", { app: appName(project.path) }) })
        onMoved(r.link)
      } else {
        toast.add({ type: "error", title: t(`paratextBridge.copies.blocked.${r.block.kind}`, { books: r.block.books.join(", ") }) })
      }
    } catch (e) {
      toast.add({ type: "error", title: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border bg-card p-5" data-testid="paratext-copies-card">
      <h2 className="text-sm font-semibold">{t("paratextBridge.copies.title")}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("paratextBridge.copies.hint")}</p>
      <ul className="mt-4 divide-y rounded-md border">
        {copies.map((c) => {
          const here = c.path === project.path
          return (
            <li key={c.path} className="flex items-center gap-2 px-3 py-2 text-sm" data-testid="paratext-copy">
              <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="shrink-0 font-medium">{appName(c.path)}</span>
              {here ? (
                <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={c.path}>{c.path}</code>
              ) : (
                <Link to={paratextProjectPath(c)} className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground hover:underline" title={c.path}>{c.path}</Link>
              )}
              {here ? <Badge variant="outline">{t("paratextBridge.copies.thisCopy")}</Badge> : null}
              {liveLink?.projectPath === c.path ? <Badge variant="default">{t("paratextBridge.copies.live")}</Badge> : null}
            </li>
          )
        })}
      </ul>
      {liveLink && !thisIsLive ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm" data-testid="paratext-copy-not-live">
          <p className="text-muted-foreground">{t("paratextBridge.copies.notLive", { app: appName(liveLink.projectPath) })}</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void makeLive()} data-testid="paratext-copy-make-live">
            {busy ? <Spinner /> : <ArrowRightLeft />}{t("paratextBridge.copies.makeLive")}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
