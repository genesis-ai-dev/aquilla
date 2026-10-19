import type { ReactNode } from "react"
import { Link, useParams } from "react-router-dom"
import { Spinner } from "@/components/ui/spinner"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useT } from "@/lib/i18n/I18nProvider"
import { useSmartExtensionsEnabled } from "@/lib/tools/smart-extensions-enabled"

/** AQU-1937: the extensions pages exist only for projects with Smart
 *  Extensions switched on; otherwise they say so (and how to turn it on). */
export function SmartExtensionsGate({ children }: { children: ReactNode }) {
  const t = useT()
  const { id: projectId = "" } = useParams<{ id: string }>()
  const { session } = useFrontierSession()
  const enabled = useSmartExtensionsEnabled(session?.jwt ?? null, projectId)
  if (enabled === null) return <Spinner className="m-6" />
  if (!enabled) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-3 p-8 text-sm" data-testid="smart-extensions-off">
        <p>{t("extensions.flag.off")}</p>
        <Link className="text-primary underline underline-offset-2" to={`/project/${projectId}/editor`}>
          {t("extensions.backToEditor")}
        </Link>
      </div>
    )
  }
  return <>{children}</>
}
