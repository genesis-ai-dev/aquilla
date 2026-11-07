// On a cloud project overview: says the project mirrors a Paratext project on
// this computer and leads to its page there. Desktop only; renders nothing in
// the browser, or on a device that holds no link for the project.

import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { BookOpen } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n/I18nProvider"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { bridgeStore, type MirrorLink } from "@/lib/paratext-bridge/store"
import { paratextProjectPath } from "./ParatextProjectRow"

export function ParatextLinkBadge({ projectId }: { projectId: string | undefined }) {
  const t = useT()
  const [link, setLink] = useState<MirrorLink | null>(null)
  useEffect(() => {
    if (!projectId || !isTauriRuntime()) return
    let cancelled = false
    void bridgeStore.linkForProject(projectId).then((l) => { if (!cancelled) setLink(l) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [projectId])
  if (!link) return null
  return (
    <Badge variant="secondary" className="shrink-0" data-testid="paratext-link-badge-cloud" render={<Link to={paratextProjectPath({ path: link.projectPath })} />}>
      <BookOpen className="size-3" aria-hidden />
      {t("paratextBridge.project.fromParatext")}
    </Badge>
  )
}
