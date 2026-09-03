import type { ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { buttonVariants } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import { loginPath } from "@/lib/navigation/login-path"
import { cn } from "@/lib/utils"
import { OrgSidebar } from "./OrgSidebar"

interface SignedOutWorkspaceProps {
  header: ReactNode
}

/** Canonical signed-out state for every workspace-shaped route. */
export function SignedOutWorkspace({ header }: SignedOutWorkspaceProps) {
  const t = useT()
  const location = useLocation()
  const next = location.pathname + location.search

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={header}
      statusBar={null}
      main={
        <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-lg font-medium">{t("org.orgHome.signedOut.heading")}</p>
          <p className="max-w-xs text-sm text-muted-foreground">
            {t("org.orgHome.signedOut.description")}
          </p>
          <Link to={loginPath({ next })} className={cn(buttonVariants())}>
            {t("auth.login.submitDefault")}
          </Link>
        </div>
      }
    />
  )
}
